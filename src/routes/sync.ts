import { Router } from 'express';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/connection';
import {
  locations,
  gardens,
  sections,
  cropInstances,
  cropStages,
  tasks,
  taskCompletions,
  notes,
} from '../db/schema';
import { asyncHandler } from '../lib/asyncHandler';
import { requireAuth } from '../middleware/requireAuth';
import { checkSubscription } from '../middleware/checkSubscription';

const router = Router();

// Wire format mirrors the iOS SQLite column names exactly (snake_case) so
// the client can round-trip pull → SQLite insert without remapping keys.

router.get(
  '/pull',
  requireAuth,
  checkSubscription,
  asyncHandler(async (req, res) => {
    // requireAuth sets req.userId; this guard satisfies the type narrowing.
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const [
      locationsRows,
      gardensRows,
      sectionsRows,
      cropInstancesRows,
      cropStagesRows,
      tasksRows,
      taskCompletionsRows,
      notesRows,
    ] = await Promise.all([
      db
        .select({
          user_id: locations.userId,
          id: locations.id,
          name: locations.name,
          order_index: locations.orderIndex,
        })
        .from(locations)
        .where(eq(locations.userId, userId)),
      db
        .select({
          user_id: gardens.userId,
          id: gardens.id,
          location_id: gardens.locationId,
          name: gardens.name,
          record_type: gardens.recordType,
          order_index: gardens.orderIndex,
        })
        .from(gardens)
        .where(eq(gardens.userId, userId)),
      db
        .select({
          user_id: sections.userId,
          id: sections.id,
          garden_id: sections.gardenId,
          name: sections.name,
          order_index: sections.orderIndex,
        })
        .from(sections)
        .where(eq(sections.userId, userId)),
      db
        .select({
          user_id: cropInstances.userId,
          id: cropInstances.id,
          section_id: cropInstances.sectionId,
          name: cropInstances.name,
          plant_count: cropInstances.plantCount,
          start_date: cropInstances.startDate,
          record_type: cropInstances.recordType,
          archived: cropInstances.archived,
          notes: cropInstances.notes,
          created_at: cropInstances.createdAt,
          updated_at: cropInstances.updatedAt,
        })
        .from(cropInstances)
        .where(eq(cropInstances.userId, userId)),
      db
        .select({
          user_id: cropStages.userId,
          id: cropStages.id,
          crop_instance_id: cropStages.cropInstanceId,
          stage_definition_id: cropStages.stageDefinitionId,
          duration_weeks: cropStages.durationWeeks,
          order_index: cropStages.orderIndex,
        })
        .from(cropStages)
        .where(eq(cropStages.userId, userId)),
      db
        .select({
          user_id: tasks.userId,
          id: tasks.id,
          crop_instance_id: tasks.cropInstanceId,
          task_type_id: tasks.taskTypeId,
          day_of_week: tasks.dayOfWeek,
          frequency_weeks: tasks.frequencyWeeks,
          start_offset_weeks: tasks.startOffsetWeeks,
          created_at: tasks.createdAt,
        })
        .from(tasks)
        .where(eq(tasks.userId, userId)),
      db
        .select({
          user_id: taskCompletions.userId,
          id: taskCompletions.id,
          task_id: taskCompletions.taskId,
          completed_date: taskCompletions.completedDate,
        })
        .from(taskCompletions)
        .where(eq(taskCompletions.userId, userId)),
      db
        .select({
          user_id: notes.userId,
          id: notes.id,
          entity_type: notes.entityType,
          entity_id: notes.entityId,
          week_date: notes.weekDate,
          crop_instance_id: notes.cropInstanceId,
          content: notes.content,
          created_at: notes.createdAt,
          updated_at: notes.updatedAt,
        })
        .from(notes)
        .where(eq(notes.userId, userId)),
    ]);

    res.status(200).json({
      locations: locationsRows,
      gardens: gardensRows,
      sections: sectionsRows,
      crop_instances: cropInstancesRows,
      crop_stages: cropStagesRows,
      tasks: tasksRows,
      task_completions: taskCompletionsRows,
      notes: notesRows,
    });
  }),
);

// /sync/push — accepts `{ changed: [{ table, rows }] }` in the same wire
// format /pull produces. Tables are processed in dependency order so a fresh
// user can push their entire local SQLite in one call (the iOS app does this
// once after sign-up). Any `user_id` sent by the client is ignored — rows are
// always written under the authenticated session's user.
//
// Tables with `updated_at` (crop_instances, notes) use last-write-wins: an
// incoming row only overwrites the server row if its `updated_at` is strictly
// newer. Other tables overwrite on conflict — they're cheap reference data
// with no merge ambiguity.

const PUSH_TABLE_ORDER = [
  'locations',
  'gardens',
  'sections',
  'crop_instances',
  'crop_stages',
  'tasks',
  'task_completions',
  'notes',
] as const;
type PushTableName = (typeof PUSH_TABLE_ORDER)[number];
const KNOWN_TABLE_NAMES = new Set<string>(PUSH_TABLE_ORDER);

interface ChangeEntry {
  table: PushTableName;
  rows: Record<string, unknown>[];
}

interface PushResult {
  accepted: number;
  skipped: number;
}

class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function asInt(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new BadRequestError(`Expected integer for "${field}"`);
  }
  return v;
}

function asIntOr(v: unknown, field: string, fallback: number): number {
  if (v == null) return fallback;
  return asInt(v, field);
}

function asIntOrNull(v: unknown, field: string): number | null {
  if (v == null) return null;
  return asInt(v, field);
}

function asString(v: unknown, field: string): string {
  if (typeof v !== 'string') throw new BadRequestError(`Expected string for "${field}"`);
  return v;
}

function asStringOr(v: unknown, field: string, fallback: string): string {
  if (v == null) return fallback;
  return asString(v, field);
}

function asStringOrNull(v: unknown, field: string): string | null {
  if (v == null) return null;
  return asString(v, field);
}

type ValidationResult = { ok: true; changes: ChangeEntry[] } | { ok: false; error: string };

function validateChanges(body: unknown): ValidationResult {
  if (!isObject(body)) return { ok: false, error: 'Invalid body' };
  const changed = body.changed;
  if (!Array.isArray(changed)) {
    return { ok: false, error: 'Invalid body: expected `changed` array' };
  }

  const result: ChangeEntry[] = [];
  for (const entry of changed) {
    if (!isObject(entry)) return { ok: false, error: 'Invalid change entry' };
    if (typeof entry.table !== 'string') {
      return { ok: false, error: 'Change entry missing `table` string' };
    }
    if (!KNOWN_TABLE_NAMES.has(entry.table)) {
      return { ok: false, error: `Unknown table: ${entry.table}` };
    }
    if (!Array.isArray(entry.rows)) {
      return { ok: false, error: 'Change entry missing `rows` array' };
    }
    const rows: Record<string, unknown>[] = [];
    for (const row of entry.rows) {
      if (!isObject(row)) {
        return { ok: false, error: `Invalid row in table ${entry.table}` };
      }
      if (typeof row.id !== 'number' || !Number.isFinite(row.id)) {
        return { ok: false, error: `Row in ${entry.table} missing numeric \`id\`` };
      }
      rows.push(row);
    }
    result.push({ table: entry.table as PushTableName, rows });
  }
  return { ok: true, changes: result };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type PushHandler = (tx: Tx, userId: string, rows: Record<string, unknown>[]) => Promise<PushResult>;

const pushHandlers: Record<PushTableName, PushHandler> = {
  locations: async (tx, userId, rows) => {
    const values = rows.map((r) => ({
      userId,
      id: asInt(r.id, 'locations.id'),
      name: asString(r.name, 'locations.name'),
      orderIndex: asIntOr(r.order_index, 'locations.order_index', 0),
    }));
    await tx
      .insert(locations)
      .values(values)
      .onConflictDoUpdate({
        target: [locations.userId, locations.id],
        set: {
          name: sql`excluded.name`,
          orderIndex: sql`excluded.order_index`,
        },
      });
    return { accepted: values.length, skipped: 0 };
  },

  gardens: async (tx, userId, rows) => {
    const values = rows.map((r) => ({
      userId,
      id: asInt(r.id, 'gardens.id'),
      locationId: asInt(r.location_id, 'gardens.location_id'),
      name: asString(r.name, 'gardens.name'),
      recordType: asStringOr(r.record_type, 'gardens.record_type', 'plant'),
      orderIndex: asIntOr(r.order_index, 'gardens.order_index', 0),
    }));
    await tx
      .insert(gardens)
      .values(values)
      .onConflictDoUpdate({
        target: [gardens.userId, gardens.id],
        set: {
          locationId: sql`excluded.location_id`,
          name: sql`excluded.name`,
          recordType: sql`excluded.record_type`,
          orderIndex: sql`excluded.order_index`,
        },
      });
    return { accepted: values.length, skipped: 0 };
  },

  sections: async (tx, userId, rows) => {
    const values = rows.map((r) => ({
      userId,
      id: asInt(r.id, 'sections.id'),
      gardenId: asInt(r.garden_id, 'sections.garden_id'),
      name: asString(r.name, 'sections.name'),
      orderIndex: asIntOr(r.order_index, 'sections.order_index', 0),
    }));
    await tx
      .insert(sections)
      .values(values)
      .onConflictDoUpdate({
        target: [sections.userId, sections.id],
        set: {
          gardenId: sql`excluded.garden_id`,
          name: sql`excluded.name`,
          orderIndex: sql`excluded.order_index`,
        },
      });
    return { accepted: values.length, skipped: 0 };
  },

  crop_instances: async (tx, userId, rows) => {
    const values = rows.map((r) => ({
      userId,
      id: asInt(r.id, 'crop_instances.id'),
      sectionId: asInt(r.section_id, 'crop_instances.section_id'),
      name: asString(r.name, 'crop_instances.name'),
      plantCount: asIntOr(r.plant_count, 'crop_instances.plant_count', 1),
      startDate: asString(r.start_date, 'crop_instances.start_date'),
      recordType: asStringOr(r.record_type, 'crop_instances.record_type', 'plant'),
      archived: asIntOr(r.archived, 'crop_instances.archived', 0),
      notes: asStringOrNull(r.notes, 'crop_instances.notes'),
      createdAt: asString(r.created_at, 'crop_instances.created_at'),
      updatedAt: asString(r.updated_at, 'crop_instances.updated_at'),
    }));

    const ids = values.map((v) => v.id);
    const existing = await tx
      .select({ id: cropInstances.id, updatedAt: cropInstances.updatedAt })
      .from(cropInstances)
      .where(and(eq(cropInstances.userId, userId), inArray(cropInstances.id, ids)));
    const existingMap = new Map<number, string>(existing.map((r) => [r.id, r.updatedAt]));

    const toApply: typeof values = [];
    let skipped = 0;
    for (const v of values) {
      const existingTs = existingMap.get(v.id);
      if (existingTs !== undefined && v.updatedAt <= existingTs) {
        skipped++;
      } else {
        toApply.push(v);
      }
    }

    if (toApply.length > 0) {
      await tx
        .insert(cropInstances)
        .values(toApply)
        .onConflictDoUpdate({
          target: [cropInstances.userId, cropInstances.id],
          set: {
            sectionId: sql`excluded.section_id`,
            name: sql`excluded.name`,
            plantCount: sql`excluded.plant_count`,
            startDate: sql`excluded.start_date`,
            recordType: sql`excluded.record_type`,
            archived: sql`excluded.archived`,
            notes: sql`excluded.notes`,
            createdAt: sql`excluded.created_at`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }

    return { accepted: toApply.length, skipped };
  },

  crop_stages: async (tx, userId, rows) => {
    const values = rows.map((r) => ({
      userId,
      id: asInt(r.id, 'crop_stages.id'),
      cropInstanceId: asInt(r.crop_instance_id, 'crop_stages.crop_instance_id'),
      stageDefinitionId: asInt(r.stage_definition_id, 'crop_stages.stage_definition_id'),
      durationWeeks: asInt(r.duration_weeks, 'crop_stages.duration_weeks'),
      orderIndex: asIntOr(r.order_index, 'crop_stages.order_index', 0),
    }));
    await tx
      .insert(cropStages)
      .values(values)
      .onConflictDoUpdate({
        target: [cropStages.userId, cropStages.id],
        set: {
          cropInstanceId: sql`excluded.crop_instance_id`,
          stageDefinitionId: sql`excluded.stage_definition_id`,
          durationWeeks: sql`excluded.duration_weeks`,
          orderIndex: sql`excluded.order_index`,
        },
      });
    return { accepted: values.length, skipped: 0 };
  },

  tasks: async (tx, userId, rows) => {
    const values = rows.map((r) => ({
      userId,
      id: asInt(r.id, 'tasks.id'),
      cropInstanceId: asInt(r.crop_instance_id, 'tasks.crop_instance_id'),
      taskTypeId: asInt(r.task_type_id, 'tasks.task_type_id'),
      dayOfWeek: asInt(r.day_of_week, 'tasks.day_of_week'),
      frequencyWeeks: asIntOr(r.frequency_weeks, 'tasks.frequency_weeks', 1),
      startOffsetWeeks: asIntOr(r.start_offset_weeks, 'tasks.start_offset_weeks', 0),
      createdAt: asString(r.created_at, 'tasks.created_at'),
    }));
    await tx
      .insert(tasks)
      .values(values)
      .onConflictDoUpdate({
        target: [tasks.userId, tasks.id],
        set: {
          cropInstanceId: sql`excluded.crop_instance_id`,
          taskTypeId: sql`excluded.task_type_id`,
          dayOfWeek: sql`excluded.day_of_week`,
          frequencyWeeks: sql`excluded.frequency_weeks`,
          startOffsetWeeks: sql`excluded.start_offset_weeks`,
          createdAt: sql`excluded.created_at`,
        },
      });
    return { accepted: values.length, skipped: 0 };
  },

  task_completions: async (tx, userId, rows) => {
    const values = rows.map((r) => ({
      userId,
      id: asInt(r.id, 'task_completions.id'),
      taskId: asInt(r.task_id, 'task_completions.task_id'),
      completedDate: asString(r.completed_date, 'task_completions.completed_date'),
    }));
    await tx
      .insert(taskCompletions)
      .values(values)
      .onConflictDoUpdate({
        target: [taskCompletions.userId, taskCompletions.id],
        set: {
          taskId: sql`excluded.task_id`,
          completedDate: sql`excluded.completed_date`,
        },
      });
    return { accepted: values.length, skipped: 0 };
  },

  notes: async (tx, userId, rows) => {
    const values = rows.map((r) => ({
      userId,
      id: asInt(r.id, 'notes.id'),
      entityType: asString(r.entity_type, 'notes.entity_type'),
      entityId: asIntOrNull(r.entity_id, 'notes.entity_id'),
      weekDate: asStringOrNull(r.week_date, 'notes.week_date'),
      cropInstanceId: asIntOrNull(r.crop_instance_id, 'notes.crop_instance_id'),
      content: asString(r.content, 'notes.content'),
      createdAt: asString(r.created_at, 'notes.created_at'),
      updatedAt: asString(r.updated_at, 'notes.updated_at'),
    }));

    const ids = values.map((v) => v.id);
    const existing = await tx
      .select({ id: notes.id, updatedAt: notes.updatedAt })
      .from(notes)
      .where(and(eq(notes.userId, userId), inArray(notes.id, ids)));
    const existingMap = new Map<number, string>(existing.map((r) => [r.id, r.updatedAt]));

    const toApply: typeof values = [];
    let skipped = 0;
    for (const v of values) {
      const existingTs = existingMap.get(v.id);
      if (existingTs !== undefined && v.updatedAt <= existingTs) {
        skipped++;
      } else {
        toApply.push(v);
      }
    }

    if (toApply.length > 0) {
      await tx
        .insert(notes)
        .values(toApply)
        .onConflictDoUpdate({
          target: [notes.userId, notes.id],
          set: {
            entityType: sql`excluded.entity_type`,
            entityId: sql`excluded.entity_id`,
            weekDate: sql`excluded.week_date`,
            cropInstanceId: sql`excluded.crop_instance_id`,
            content: sql`excluded.content`,
            createdAt: sql`excluded.created_at`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }

    return { accepted: toApply.length, skipped };
  },
};

router.post(
  '/push',
  requireAuth,
  checkSubscription,
  asyncHandler(async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const validated = validateChanges(req.body);
    if (!validated.ok) {
      res.status(400).json({ error: validated.error });
      return;
    }

    let accepted = 0;
    let skipped = 0;

    try {
      await db.transaction(async (tx) => {
        for (const tableName of PUSH_TABLE_ORDER) {
          const change = validated.changes.find((c) => c.table === tableName);
          if (!change || change.rows.length === 0) continue;
          const result = await pushHandlers[tableName](tx, userId, change.rows);
          accepted += result.accepted;
          skipped += result.skipped;
        }
      });
    } catch (err) {
      if (err instanceof BadRequestError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    res.status(200).json({ accepted, skipped });
  }),
);

export default router;

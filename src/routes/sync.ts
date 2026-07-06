import { Router } from 'express';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
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
  noteImages,
} from '../db/schema';
import { asyncHandler } from '../lib/asyncHandler';
import { requireAuth } from '../middleware/requireAuth';
import { checkSubscription } from '../middleware/checkSubscription';
import {
  CONTENT_TYPE_EXT,
  MAX_IMAGE_BYTES,
  buildImageKey,
  buildImageKeyPrefix,
  createUploadUrl,
  createDownloadUrl,
  deleteImageObject,
} from '../lib/s3';

const router = Router();

// Wire format mirrors the iOS SQLite column names exactly (snake_case) so the
// client can round-trip pull → SQLite without remapping keys. Synced rows are
// keyed globally by `uuid`; foreign keys travel as the parent's `uuid`. The
// server never stores or returns the device-local integer id.

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

    // Pull returns active rows only — soft-deleted rows are absent (not echoed
    // with a tombstone flag); the client drops any previously-synced local row
    // missing from the response.
    const [
      locationRows,
      gardenRows,
      sectionRows,
      cropInstanceRows,
      cropStageRows,
      taskRows,
      taskCompletionRows,
      noteRows,
      noteImageRows,
    ] = await Promise.all([
      db
        .select({
          uuid: locations.uuid,
          name: locations.name,
          order_index: locations.orderIndex,
          updated_at: locations.updatedAt,
        })
        .from(locations)
        .where(and(eq(locations.userId, userId), isNull(locations.deletedAt))),
      db
        .select({
          uuid: gardens.uuid,
          location_uuid: gardens.locationUuid,
          name: gardens.name,
          record_type: gardens.recordType,
          order_index: gardens.orderIndex,
          updated_at: gardens.updatedAt,
        })
        .from(gardens)
        .where(and(eq(gardens.userId, userId), isNull(gardens.deletedAt))),
      db
        .select({
          uuid: sections.uuid,
          garden_uuid: sections.gardenUuid,
          name: sections.name,
          order_index: sections.orderIndex,
          updated_at: sections.updatedAt,
        })
        .from(sections)
        .where(and(eq(sections.userId, userId), isNull(sections.deletedAt))),
      db
        .select({
          uuid: cropInstances.uuid,
          section_uuid: cropInstances.sectionUuid,
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
        .where(and(eq(cropInstances.userId, userId), isNull(cropInstances.deletedAt))),
      db
        .select({
          uuid: cropStages.uuid,
          crop_instance_uuid: cropStages.cropInstanceUuid,
          stage_definition_id: cropStages.stageDefinitionId,
          duration_weeks: cropStages.durationWeeks,
          order_index: cropStages.orderIndex,
          updated_at: cropStages.updatedAt,
        })
        .from(cropStages)
        .where(and(eq(cropStages.userId, userId), isNull(cropStages.deletedAt))),
      db
        .select({
          uuid: tasks.uuid,
          crop_instance_uuid: tasks.cropInstanceUuid,
          task_type_id: tasks.taskTypeId,
          day_of_week: tasks.dayOfWeek,
          frequency_weeks: tasks.frequencyWeeks,
          start_offset_weeks: tasks.startOffsetWeeks,
          created_at: tasks.createdAt,
          updated_at: tasks.updatedAt,
        })
        .from(tasks)
        .where(and(eq(tasks.userId, userId), isNull(tasks.deletedAt))),
      db
        .select({
          uuid: taskCompletions.uuid,
          task_uuid: taskCompletions.taskUuid,
          completed_date: taskCompletions.completedDate,
          updated_at: taskCompletions.updatedAt,
        })
        .from(taskCompletions)
        .where(and(eq(taskCompletions.userId, userId), isNull(taskCompletions.deletedAt))),
      db
        .select({
          uuid: notes.uuid,
          entity_type: notes.entityType,
          week_date: notes.weekDate,
          crop_instance_uuid: notes.cropInstanceUuid,
          content: notes.content,
          created_at: notes.createdAt,
          updated_at: notes.updatedAt,
        })
        .from(notes)
        .where(and(eq(notes.userId, userId), isNull(notes.deletedAt))),
      db
        .select({
          uuid: noteImages.uuid,
          note_uuid: noteImages.noteUuid,
          s3_key: noteImages.s3Key,
          created_at: noteImages.createdAt,
          updated_at: noteImages.updatedAt,
        })
        .from(noteImages)
        .where(and(eq(noteImages.userId, userId), isNull(noteImages.deletedAt))),
    ]);

    res.status(200).json({
      locations: locationRows,
      gardens: gardenRows,
      sections: sectionRows,
      crop_instances: cropInstanceRows,
      crop_stages: cropStageRows,
      tasks: taskRows,
      task_completions: taskCompletionRows,
      notes: noteRows,
      note_images: noteImageRows,
      last_sync_at: new Date().toISOString(),
    });
  }),
);

// /sync/push — accepts `{ changed: [{ table, rows }] }` in the same wire format
// /pull produces. Tables are processed in dependency order so a fresh user can
// push their entire local SQLite in one call (the iOS app does this once after
// sign-up). Any `user_id` sent by the client is ignored — rows are always
// written under the authenticated session's user.
//
// Every table uses uniform last-write-wins on `updated_at`: an incoming row
// only overwrites the server row if its `updated_at` is strictly newer (string
// comparison; iOS emits a sortable millisecond `datetime`-style string). This
// rule applies identically to edits and to soft-deletes — a tombstone is just a
// full row carrying a non-null `deleted_at`; a stale tombstone loses last-write-
// wins and deletes nothing. `created_at` is pinned on first insert, never reset.

const PUSH_TABLE_ORDER = [
  'locations',
  'gardens',
  'sections',
  'crop_instances',
  'crop_stages',
  'tasks',
  'task_completions',
  'notes',
  'note_images',
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
  // Only note_images sets this: the s3_keys of tombstones that won last-write-
  // wins this push. Their S3 objects are deleted after the transaction commits.
  tombstonedKeys?: string[];
}

class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new BadRequestError(`Expected integer for "${field}"`);
  }
  return value;
}

function asIntOr(value: unknown, field: string, fallback: number): number {
  if (value == null) return fallback;
  return asInt(value, field);
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new BadRequestError(`Expected string for "${field}"`);
  return value;
}

function asStringOr(value: unknown, field: string, fallback: string): string {
  if (value == null) return fallback;
  return asString(value, field);
}

function asStringOrNull(value: unknown, field: string): string | null {
  if (value == null) return null;
  return asString(value, field);
}

function asUuid(value: unknown, field: string): string {
  const parsed = asString(value, field);
  if (parsed.length === 0) throw new BadRequestError(`Expected non-empty uuid for "${field}"`);
  return parsed;
}

type ValidationResult = { ok: true; changes: ChangeEntry[] } | { ok: false; error: string };

function validateChanges(body: unknown): ValidationResult {
  if (!isObject(body)) return { ok: false, error: 'Invalid body' };
  const changed = body.changed;
  if (!Array.isArray(changed)) {
    return { ok: false, error: 'Invalid body: expected `changed` array' };
  }

  const changes: ChangeEntry[] = [];
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
      if (typeof row.uuid !== 'string' || row.uuid.length === 0) {
        return { ok: false, error: `Row in ${entry.table} missing non-empty \`uuid\`` };
      }
      rows.push(row);
    }
    changes.push({ table: entry.table as PushTableName, rows });
  }
  return { ok: true, changes };
}

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type PushHandler = (
  transaction: DatabaseTransaction,
  userId: string,
  rows: Record<string, unknown>[],
) => Promise<PushResult>;

// Splits incoming rows into the ones that win last-write-wins (no existing row,
// or a strictly newer `updated_at`) and a count of those skipped as stale/equal.
function partitionByLastWriteWins<RowValues extends { uuid: string; updatedAt: string }>(
  incomingRows: RowValues[],
  existingUpdatedAtByUuid: Map<string, string>,
): { toApply: RowValues[]; skipped: number } {
  const toApply: RowValues[] = [];
  let skipped = 0;
  for (const incomingRow of incomingRows) {
    const existingUpdatedAt = existingUpdatedAtByUuid.get(incomingRow.uuid);
    if (existingUpdatedAt !== undefined && incomingRow.updatedAt <= existingUpdatedAt) {
      skipped++;
    } else {
      toApply.push(incomingRow);
    }
  }
  return { toApply, skipped };
}

const pushHandlers: Record<PushTableName, PushHandler> = {
  locations: async (transaction, userId, rows) => {
    const values = rows.map((row) => ({
      userId,
      uuid: asUuid(row.uuid, 'locations.uuid'),
      name: asString(row.name, 'locations.name'),
      orderIndex: asIntOr(row.order_index, 'locations.order_index', 0),
      updatedAt: asString(row.updated_at, 'locations.updated_at'),
      deletedAt: asStringOrNull(row.deleted_at, 'locations.deleted_at'),
    }));
    const existingRows = await transaction
      .select({ uuid: locations.uuid, updatedAt: locations.updatedAt })
      .from(locations)
      .where(
        and(
          eq(locations.userId, userId),
          inArray(
            locations.uuid,
            values.map((value) => value.uuid),
          ),
        ),
      );
    const { toApply, skipped } = partitionByLastWriteWins(
      values,
      new Map(existingRows.map((existingRow) => [existingRow.uuid, existingRow.updatedAt])),
    );
    if (toApply.length > 0) {
      await transaction
        .insert(locations)
        .values(toApply)
        .onConflictDoUpdate({
          target: [locations.userId, locations.uuid],
          set: {
            name: sql`excluded.name`,
            orderIndex: sql`excluded.order_index`,
            updatedAt: sql`excluded.updated_at`,
            deletedAt: sql`excluded.deleted_at`,
          },
        });
    }
    return { accepted: toApply.length, skipped };
  },

  gardens: async (transaction, userId, rows) => {
    const values = rows.map((row) => ({
      userId,
      uuid: asUuid(row.uuid, 'gardens.uuid'),
      locationUuid: asUuid(row.location_uuid, 'gardens.location_uuid'),
      name: asString(row.name, 'gardens.name'),
      recordType: asStringOr(row.record_type, 'gardens.record_type', 'plant'),
      orderIndex: asIntOr(row.order_index, 'gardens.order_index', 0),
      updatedAt: asString(row.updated_at, 'gardens.updated_at'),
      deletedAt: asStringOrNull(row.deleted_at, 'gardens.deleted_at'),
    }));
    const existingRows = await transaction
      .select({ uuid: gardens.uuid, updatedAt: gardens.updatedAt })
      .from(gardens)
      .where(
        and(
          eq(gardens.userId, userId),
          inArray(
            gardens.uuid,
            values.map((value) => value.uuid),
          ),
        ),
      );
    const { toApply, skipped } = partitionByLastWriteWins(
      values,
      new Map(existingRows.map((existingRow) => [existingRow.uuid, existingRow.updatedAt])),
    );
    if (toApply.length > 0) {
      await transaction
        .insert(gardens)
        .values(toApply)
        .onConflictDoUpdate({
          target: [gardens.userId, gardens.uuid],
          set: {
            locationUuid: sql`excluded.location_uuid`,
            name: sql`excluded.name`,
            recordType: sql`excluded.record_type`,
            orderIndex: sql`excluded.order_index`,
            updatedAt: sql`excluded.updated_at`,
            deletedAt: sql`excluded.deleted_at`,
          },
        });
    }
    return { accepted: toApply.length, skipped };
  },

  sections: async (transaction, userId, rows) => {
    const values = rows.map((row) => ({
      userId,
      uuid: asUuid(row.uuid, 'sections.uuid'),
      gardenUuid: asUuid(row.garden_uuid, 'sections.garden_uuid'),
      name: asString(row.name, 'sections.name'),
      orderIndex: asIntOr(row.order_index, 'sections.order_index', 0),
      updatedAt: asString(row.updated_at, 'sections.updated_at'),
      deletedAt: asStringOrNull(row.deleted_at, 'sections.deleted_at'),
    }));
    const existingRows = await transaction
      .select({ uuid: sections.uuid, updatedAt: sections.updatedAt })
      .from(sections)
      .where(
        and(
          eq(sections.userId, userId),
          inArray(
            sections.uuid,
            values.map((value) => value.uuid),
          ),
        ),
      );
    const { toApply, skipped } = partitionByLastWriteWins(
      values,
      new Map(existingRows.map((existingRow) => [existingRow.uuid, existingRow.updatedAt])),
    );
    if (toApply.length > 0) {
      await transaction
        .insert(sections)
        .values(toApply)
        .onConflictDoUpdate({
          target: [sections.userId, sections.uuid],
          set: {
            gardenUuid: sql`excluded.garden_uuid`,
            name: sql`excluded.name`,
            orderIndex: sql`excluded.order_index`,
            updatedAt: sql`excluded.updated_at`,
            deletedAt: sql`excluded.deleted_at`,
          },
        });
    }
    return { accepted: toApply.length, skipped };
  },

  crop_instances: async (transaction, userId, rows) => {
    const values = rows.map((row) => ({
      userId,
      uuid: asUuid(row.uuid, 'crop_instances.uuid'),
      sectionUuid: asUuid(row.section_uuid, 'crop_instances.section_uuid'),
      name: asString(row.name, 'crop_instances.name'),
      plantCount: asIntOr(row.plant_count, 'crop_instances.plant_count', 1),
      startDate: asString(row.start_date, 'crop_instances.start_date'),
      recordType: asStringOr(row.record_type, 'crop_instances.record_type', 'plant'),
      archived: asIntOr(row.archived, 'crop_instances.archived', 0),
      notes: asStringOrNull(row.notes, 'crop_instances.notes'),
      createdAt: asString(row.created_at, 'crop_instances.created_at'),
      updatedAt: asString(row.updated_at, 'crop_instances.updated_at'),
      deletedAt: asStringOrNull(row.deleted_at, 'crop_instances.deleted_at'),
    }));
    const existingRows = await transaction
      .select({ uuid: cropInstances.uuid, updatedAt: cropInstances.updatedAt })
      .from(cropInstances)
      .where(
        and(
          eq(cropInstances.userId, userId),
          inArray(
            cropInstances.uuid,
            values.map((value) => value.uuid),
          ),
        ),
      );
    const { toApply, skipped } = partitionByLastWriteWins(
      values,
      new Map(existingRows.map((existingRow) => [existingRow.uuid, existingRow.updatedAt])),
    );
    if (toApply.length > 0) {
      await transaction
        .insert(cropInstances)
        .values(toApply)
        .onConflictDoUpdate({
          target: [cropInstances.userId, cropInstances.uuid],
          set: {
            sectionUuid: sql`excluded.section_uuid`,
            name: sql`excluded.name`,
            plantCount: sql`excluded.plant_count`,
            startDate: sql`excluded.start_date`,
            recordType: sql`excluded.record_type`,
            archived: sql`excluded.archived`,
            notes: sql`excluded.notes`,
            // created_at is pinned — never overwritten on re-push.
            updatedAt: sql`excluded.updated_at`,
            deletedAt: sql`excluded.deleted_at`,
          },
        });
    }
    return { accepted: toApply.length, skipped };
  },

  crop_stages: async (transaction, userId, rows) => {
    const values = rows.map((row) => ({
      userId,
      uuid: asUuid(row.uuid, 'crop_stages.uuid'),
      cropInstanceUuid: asUuid(row.crop_instance_uuid, 'crop_stages.crop_instance_uuid'),
      stageDefinitionId: asInt(row.stage_definition_id, 'crop_stages.stage_definition_id'),
      durationWeeks: asInt(row.duration_weeks, 'crop_stages.duration_weeks'),
      orderIndex: asIntOr(row.order_index, 'crop_stages.order_index', 0),
      updatedAt: asString(row.updated_at, 'crop_stages.updated_at'),
      deletedAt: asStringOrNull(row.deleted_at, 'crop_stages.deleted_at'),
    }));
    const existingRows = await transaction
      .select({ uuid: cropStages.uuid, updatedAt: cropStages.updatedAt })
      .from(cropStages)
      .where(
        and(
          eq(cropStages.userId, userId),
          inArray(
            cropStages.uuid,
            values.map((value) => value.uuid),
          ),
        ),
      );
    const { toApply, skipped } = partitionByLastWriteWins(
      values,
      new Map(existingRows.map((existingRow) => [existingRow.uuid, existingRow.updatedAt])),
    );
    if (toApply.length > 0) {
      await transaction
        .insert(cropStages)
        .values(toApply)
        .onConflictDoUpdate({
          target: [cropStages.userId, cropStages.uuid],
          set: {
            cropInstanceUuid: sql`excluded.crop_instance_uuid`,
            stageDefinitionId: sql`excluded.stage_definition_id`,
            durationWeeks: sql`excluded.duration_weeks`,
            orderIndex: sql`excluded.order_index`,
            updatedAt: sql`excluded.updated_at`,
            deletedAt: sql`excluded.deleted_at`,
          },
        });
    }
    return { accepted: toApply.length, skipped };
  },

  tasks: async (transaction, userId, rows) => {
    const values = rows.map((row) => ({
      userId,
      uuid: asUuid(row.uuid, 'tasks.uuid'),
      cropInstanceUuid: asUuid(row.crop_instance_uuid, 'tasks.crop_instance_uuid'),
      taskTypeId: asInt(row.task_type_id, 'tasks.task_type_id'),
      dayOfWeek: asInt(row.day_of_week, 'tasks.day_of_week'),
      frequencyWeeks: asIntOr(row.frequency_weeks, 'tasks.frequency_weeks', 1),
      startOffsetWeeks: asIntOr(row.start_offset_weeks, 'tasks.start_offset_weeks', 0),
      createdAt: asString(row.created_at, 'tasks.created_at'),
      updatedAt: asString(row.updated_at, 'tasks.updated_at'),
      deletedAt: asStringOrNull(row.deleted_at, 'tasks.deleted_at'),
    }));
    const existingRows = await transaction
      .select({ uuid: tasks.uuid, updatedAt: tasks.updatedAt })
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          inArray(
            tasks.uuid,
            values.map((value) => value.uuid),
          ),
        ),
      );
    const { toApply, skipped } = partitionByLastWriteWins(
      values,
      new Map(existingRows.map((existingRow) => [existingRow.uuid, existingRow.updatedAt])),
    );
    if (toApply.length > 0) {
      await transaction
        .insert(tasks)
        .values(toApply)
        .onConflictDoUpdate({
          target: [tasks.userId, tasks.uuid],
          set: {
            cropInstanceUuid: sql`excluded.crop_instance_uuid`,
            taskTypeId: sql`excluded.task_type_id`,
            dayOfWeek: sql`excluded.day_of_week`,
            frequencyWeeks: sql`excluded.frequency_weeks`,
            startOffsetWeeks: sql`excluded.start_offset_weeks`,
            // created_at is pinned — never overwritten on re-push.
            updatedAt: sql`excluded.updated_at`,
            deletedAt: sql`excluded.deleted_at`,
          },
        });
    }
    return { accepted: toApply.length, skipped };
  },

  task_completions: async (transaction, userId, rows) => {
    const values = rows.map((row) => ({
      userId,
      uuid: asUuid(row.uuid, 'task_completions.uuid'),
      taskUuid: asUuid(row.task_uuid, 'task_completions.task_uuid'),
      completedDate: asString(row.completed_date, 'task_completions.completed_date'),
      updatedAt: asString(row.updated_at, 'task_completions.updated_at'),
      deletedAt: asStringOrNull(row.deleted_at, 'task_completions.deleted_at'),
    }));
    const existingRows = await transaction
      .select({ uuid: taskCompletions.uuid, updatedAt: taskCompletions.updatedAt })
      .from(taskCompletions)
      .where(
        and(
          eq(taskCompletions.userId, userId),
          inArray(
            taskCompletions.uuid,
            values.map((value) => value.uuid),
          ),
        ),
      );
    const { toApply, skipped } = partitionByLastWriteWins(
      values,
      new Map(existingRows.map((existingRow) => [existingRow.uuid, existingRow.updatedAt])),
    );
    if (toApply.length > 0) {
      await transaction
        .insert(taskCompletions)
        .values(toApply)
        .onConflictDoUpdate({
          target: [taskCompletions.userId, taskCompletions.uuid],
          set: {
            taskUuid: sql`excluded.task_uuid`,
            completedDate: sql`excluded.completed_date`,
            updatedAt: sql`excluded.updated_at`,
            deletedAt: sql`excluded.deleted_at`,
          },
        });
    }
    return { accepted: toApply.length, skipped };
  },

  notes: async (transaction, userId, rows) => {
    const values = rows.map((row) => ({
      userId,
      uuid: asUuid(row.uuid, 'notes.uuid'),
      entityType: asString(row.entity_type, 'notes.entity_type'),
      weekDate: asStringOrNull(row.week_date, 'notes.week_date'),
      cropInstanceUuid: asStringOrNull(row.crop_instance_uuid, 'notes.crop_instance_uuid'),
      content: asString(row.content, 'notes.content'),
      createdAt: asString(row.created_at, 'notes.created_at'),
      updatedAt: asString(row.updated_at, 'notes.updated_at'),
      deletedAt: asStringOrNull(row.deleted_at, 'notes.deleted_at'),
    }));
    const existingRows = await transaction
      .select({ uuid: notes.uuid, updatedAt: notes.updatedAt })
      .from(notes)
      .where(
        and(
          eq(notes.userId, userId),
          inArray(
            notes.uuid,
            values.map((value) => value.uuid),
          ),
        ),
      );
    const { toApply, skipped } = partitionByLastWriteWins(
      values,
      new Map(existingRows.map((existingRow) => [existingRow.uuid, existingRow.updatedAt])),
    );
    if (toApply.length > 0) {
      await transaction
        .insert(notes)
        .values(toApply)
        .onConflictDoUpdate({
          target: [notes.userId, notes.uuid],
          set: {
            entityType: sql`excluded.entity_type`,
            weekDate: sql`excluded.week_date`,
            cropInstanceUuid: sql`excluded.crop_instance_uuid`,
            content: sql`excluded.content`,
            // created_at is pinned — never overwritten on re-push.
            updatedAt: sql`excluded.updated_at`,
            deletedAt: sql`excluded.deleted_at`,
          },
        });
    }
    return { accepted: toApply.length, skipped };
  },

  note_images: async (transaction, userId, rows) => {
    // s3_key is the one synced value the client supplies that later reaches S3
    // (a winning tombstone triggers DeleteObject on it). Enforce that every key
    // sits under the caller's own prefix — otherwise a caller could store, and
    // then tombstone-delete, another user's object. Mirrors the download-url
    // gate below.
    const ownedPrefix = buildImageKeyPrefix(userId);
    const values = rows.map((row) => {
      const s3Key = asString(row.s3_key, 'note_images.s3_key');
      if (!s3Key.startsWith(ownedPrefix)) {
        throw new BadRequestError('note_images.s3_key is outside the caller prefix');
      }
      return {
        userId,
        uuid: asUuid(row.uuid, 'note_images.uuid'),
        noteUuid: asUuid(row.note_uuid, 'note_images.note_uuid'),
        s3Key,
        createdAt: asString(row.created_at, 'note_images.created_at'),
        updatedAt: asString(row.updated_at, 'note_images.updated_at'),
        deletedAt: asStringOrNull(row.deleted_at, 'note_images.deleted_at'),
      };
    });
    const existingRows = await transaction
      .select({ uuid: noteImages.uuid, updatedAt: noteImages.updatedAt })
      .from(noteImages)
      .where(
        and(
          eq(noteImages.userId, userId),
          inArray(
            noteImages.uuid,
            values.map((value) => value.uuid),
          ),
        ),
      );
    const { toApply, skipped } = partitionByLastWriteWins(
      values,
      new Map(existingRows.map((existingRow) => [existingRow.uuid, existingRow.updatedAt])),
    );
    if (toApply.length > 0) {
      await transaction
        .insert(noteImages)
        .values(toApply)
        .onConflictDoUpdate({
          target: [noteImages.userId, noteImages.uuid],
          set: {
            noteUuid: sql`excluded.note_uuid`,
            s3Key: sql`excluded.s3_key`,
            // created_at is pinned — never overwritten on re-push.
            updatedAt: sql`excluded.updated_at`,
            deletedAt: sql`excluded.deleted_at`,
          },
        });
    }
    // A winning tombstone (deleted_at set on a row that won LWW) means the S3
    // object should be garbage-collected after the transaction commits.
    const tombstonedKeys = toApply
      .filter((value) => value.deletedAt !== null)
      .map((value) => value.s3Key);
    return { accepted: toApply.length, skipped, tombstonedKeys };
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
    const keysToDeleteFromS3: string[] = [];

    try {
      await db.transaction(async (transaction) => {
        for (const tableName of PUSH_TABLE_ORDER) {
          const change = validated.changes.find((candidate) => candidate.table === tableName);
          if (!change || change.rows.length === 0) continue;
          const result = await pushHandlers[tableName](transaction, userId, change.rows);
          accepted += result.accepted;
          skipped += result.skipped;
          if (result.tombstonedKeys) keysToDeleteFromS3.push(...result.tombstonedKeys);
        }
      });
    } catch (error) {
      if (error instanceof BadRequestError) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }

    // Delete-on-tombstone GC runs only after the transaction commits. A failed
    // S3 delete never fails the push — it just leaves an orphan object; the DB
    // row stays tombstoned so a stale re-push can't resurrect it.
    for (const key of keysToDeleteFromS3) {
      try {
        await deleteImageObject(key);
      } catch (error) {
        console.error(`Failed to delete tombstoned S3 object "${key}":`, error);
      }
    }

    res.status(200).json({ accepted, skipped });
  }),
);

// Image transfer uses presigned S3 URLs: the binary never rides push/pull, only
// the `s3_key` reference does. Both endpoints share the /sync auth + active-
// subscription gate. The server constructs the user-scoped key so a caller can
// only ever touch objects under their own `note-images/{userId}/` prefix.

router.post(
  '/image/upload-url',
  requireAuth,
  checkSubscription,
  asyncHandler(async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const body = req.body as { uuid?: unknown; content_type?: unknown; content_length?: unknown };
    if (typeof body.uuid !== 'string' || body.uuid.length === 0) {
      res.status(400).json({ error: 'Expected non-empty `uuid`' });
      return;
    }
    const contentType = typeof body.content_type === 'string' ? body.content_type : '';
    const ext = CONTENT_TYPE_EXT[contentType];
    if (ext === undefined) {
      res.status(400).json({ error: 'Unsupported `content_type`' });
      return;
    }
    // The client declares the exact byte length; it is signed into the PUT
    // (see createUploadUrl) so S3 rejects a body that doesn't match.
    const contentLength = body.content_length;
    if (
      typeof contentLength !== 'number' ||
      !Number.isInteger(contentLength) ||
      contentLength < 1
    ) {
      res.status(400).json({ error: 'Expected positive integer `content_length`' });
      return;
    }
    if (contentLength > MAX_IMAGE_BYTES) {
      res.status(400).json({
        error: `Image exceeds the maximum size of ${MAX_IMAGE_BYTES.toString()} bytes`,
        code: 'IMAGE_TOO_LARGE',
        max_bytes: MAX_IMAGE_BYTES,
      });
      return;
    }

    const s3Key = buildImageKey(userId, body.uuid, ext);
    const uploadUrl = await createUploadUrl(s3Key, contentType, contentLength);

    res.status(200).json({ upload_url: uploadUrl, s3_key: s3Key });
  }),
);

router.post(
  '/image/download-url',
  requireAuth,
  checkSubscription,
  asyncHandler(async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const body = req.body as { s3_key?: unknown };
    if (typeof body.s3_key !== 'string' || body.s3_key.length === 0) {
      res.status(400).json({ error: 'Expected non-empty `s3_key`' });
      return;
    }
    // Ownership gate: a caller may only download keys under their own prefix.
    // No S3 call is needed to reject.
    if (!body.s3_key.startsWith(buildImageKeyPrefix(userId))) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const downloadUrl = await createDownloadUrl(body.s3_key);
    res.status(200).json({ download_url: downloadUrl });
  }),
);

export default router;

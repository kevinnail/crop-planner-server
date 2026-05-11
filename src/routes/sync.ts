import { Router } from 'express';
import { eq } from 'drizzle-orm';
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

export default router;

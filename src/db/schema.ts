import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  timestamp,
  boolean,
  varchar,
  uuid,
  integer,
  index,
  primaryKey,
  foreignKey,
  check,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// better-auth tables
export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: text('image'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [index('session_user_id_idx').on(table.userId)],
);

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at'),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('account_user_id_idx').on(table.userId)],
);

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
);

// App tables
export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  rcUserId: text('rc_user_id').notNull().unique(),
  userId: text('user_id').references(() => user.id),
  status: varchar('status', { length: 20 }).notNull(),
  productId: varchar('product_id', { length: 255 }),
  expiresAt: timestamp('expires_at'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Sync tables — mirror the iOS app's SQLite schema, scoped per user.
//
// Each synced row's global identity is (user_id, uuid): the client mints a
// UUID at creation and the server namespaces it by user. The server stores NO
// local integer id — that's a device-local concern. Foreign keys travel as the
// parent's UUID. `updated_at` is the last-write-wins comparator (a millisecond
// string in the iOS `strftime('%Y-%m-%d %H:%M:%f','now')` format). `deleted_at`
// is a nullable tombstone — non-NULL means the row is soft-deleted.

export const locations = pgTable(
  'locations',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    uuid: text('uuid').notNull(),
    name: text('name').notNull(),
    orderIndex: integer('order_index').notNull().default(0),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (table) => [primaryKey({ columns: [table.userId, table.uuid] })],
);

export const gardens = pgTable(
  'gardens',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    uuid: text('uuid').notNull(),
    locationUuid: text('location_uuid').notNull(),
    name: text('name').notNull(),
    recordType: text('record_type').notNull().default('plant'),
    orderIndex: integer('order_index').notNull().default(0),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.uuid] }),
    foreignKey({
      columns: [table.userId, table.locationUuid],
      foreignColumns: [locations.userId, locations.uuid],
      name: 'gardens_location_fk',
    }).onDelete('cascade'),
  ],
);

export const sections = pgTable(
  'sections',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    uuid: text('uuid').notNull(),
    gardenUuid: text('garden_uuid').notNull(),
    name: text('name').notNull(),
    orderIndex: integer('order_index').notNull().default(0),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.uuid] }),
    foreignKey({
      columns: [table.userId, table.gardenUuid],
      foreignColumns: [gardens.userId, gardens.uuid],
      name: 'sections_garden_fk',
    }).onDelete('cascade'),
  ],
);

export const cropInstances = pgTable(
  'crop_instances',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    uuid: text('uuid').notNull(),
    sectionUuid: text('section_uuid').notNull(),
    name: text('name').notNull(),
    plantCount: integer('plant_count').notNull().default(1),
    startDate: text('start_date').notNull(),
    recordType: text('record_type').notNull().default('plant'),
    archived: integer('archived').notNull().default(0),
    notes: text('notes'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.uuid] }),
    foreignKey({
      columns: [table.userId, table.sectionUuid],
      foreignColumns: [sections.userId, sections.uuid],
      name: 'crop_instances_section_fk',
    }).onDelete('cascade'),
    check('crop_instances_plant_count_check', sql`${table.plantCount} > 0`),
  ],
);

export const cropStages = pgTable(
  'crop_stages',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    uuid: text('uuid').notNull(),
    cropInstanceUuid: text('crop_instance_uuid').notNull(),
    // No FK: stage_definitions live on the device as deterministic seed data.
    stageDefinitionId: integer('stage_definition_id').notNull(),
    durationWeeks: integer('duration_weeks').notNull(),
    orderIndex: integer('order_index').notNull().default(0),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.uuid] }),
    foreignKey({
      columns: [table.userId, table.cropInstanceUuid],
      foreignColumns: [cropInstances.userId, cropInstances.uuid],
      name: 'crop_stages_crop_instance_fk',
    }).onDelete('cascade'),
    check('crop_stages_duration_weeks_check', sql`${table.durationWeeks} > 0`),
  ],
);

export const tasks = pgTable(
  'tasks',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    uuid: text('uuid').notNull(),
    cropInstanceUuid: text('crop_instance_uuid').notNull(),
    // No FK: task_types live on the device as deterministic seed data.
    taskTypeId: integer('task_type_id').notNull(),
    dayOfWeek: integer('day_of_week').notNull(),
    frequencyWeeks: integer('frequency_weeks').notNull().default(1),
    startOffsetWeeks: integer('start_offset_weeks').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.uuid] }),
    foreignKey({
      columns: [table.userId, table.cropInstanceUuid],
      foreignColumns: [cropInstances.userId, cropInstances.uuid],
      name: 'tasks_crop_instance_fk',
    }).onDelete('cascade'),
    check('tasks_day_of_week_check', sql`${table.dayOfWeek} BETWEEN 0 AND 6`),
    check('tasks_frequency_weeks_check', sql`${table.frequencyWeeks} > 0`),
    check('tasks_start_offset_weeks_check', sql`${table.startOffsetWeeks} >= 0`),
  ],
);

export const taskCompletions = pgTable(
  'task_completions',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    uuid: text('uuid').notNull(),
    taskUuid: text('task_uuid').notNull(),
    completedDate: text('completed_date').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.uuid] }),
    foreignKey({
      columns: [table.userId, table.taskUuid],
      foreignColumns: [tasks.userId, tasks.uuid],
      name: 'task_completions_task_fk',
    }).onDelete('cascade'),
    uniqueIndex('task_completions_task_date_unique').on(
      table.userId,
      table.taskUuid,
      table.completedDate,
    ),
  ],
);

export const notes = pgTable(
  'notes',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    uuid: text('uuid').notNull(),
    // entity_type is always 'week_cell' today; kept for the unique index and
    // to leave room for future note kinds. entity_id was dropped — it was a
    // dead polymorphic local integer that can't survive cross-device (iOS
    // confirmed no writer). Identity is (crop_instance_uuid, week_date).
    entityType: text('entity_type').notNull(),
    weekDate: text('week_date'),
    cropInstanceUuid: text('crop_instance_uuid'),
    content: text('content').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.uuid] }),
    foreignKey({
      columns: [table.userId, table.cropInstanceUuid],
      foreignColumns: [cropInstances.userId, cropInstances.uuid],
      name: 'notes_crop_instance_fk',
    }).onDelete('cascade'),
    uniqueIndex('notes_week_cell_unique')
      .on(table.userId, table.entityType, table.cropInstanceUuid, table.weekDate)
      .where(
        sql`entity_type = 'week_cell' AND crop_instance_uuid IS NOT NULL AND week_date IS NOT NULL`,
      ),
  ],
);

// note_images — the 9th synced table. Images are attachments belonging to a
// note; the binary lives in a private S3 bucket and only its `s3_key` reference
// rides the sync wire. Same (user_id, uuid) / LWW / full-row-tombstone contract
// as the other synced tables. A winning tombstone triggers a best-effort S3
// DeleteObject after the push transaction commits (see routes/sync.ts).
export const noteImages = pgTable(
  'note_images',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    uuid: text('uuid').notNull(),
    noteUuid: text('note_uuid').notNull(),
    s3Key: text('s3_key').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.uuid] }),
    foreignKey({
      columns: [table.userId, table.noteUuid],
      foreignColumns: [notes.userId, notes.uuid],
      name: 'note_images_note_fk',
    }).onDelete('cascade'),
  ],
);

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
// Every row's identity is (user_id, id): the client supplies `id` from its
// local SQLite AUTOINCREMENT, and the server namespaces it by user.

export const locations = pgTable(
  'locations',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    id: integer('id').notNull(),
    name: text('name').notNull(),
    orderIndex: integer('order_index').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.id] })],
);

export const gardens = pgTable(
  'gardens',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    id: integer('id').notNull(),
    locationId: integer('location_id').notNull(),
    name: text('name').notNull(),
    recordType: text('record_type').notNull().default('plant'),
    orderIndex: integer('order_index').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    foreignKey({
      columns: [t.userId, t.locationId],
      foreignColumns: [locations.userId, locations.id],
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
    id: integer('id').notNull(),
    gardenId: integer('garden_id').notNull(),
    name: text('name').notNull(),
    orderIndex: integer('order_index').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    foreignKey({
      columns: [t.userId, t.gardenId],
      foreignColumns: [gardens.userId, gardens.id],
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
    id: integer('id').notNull(),
    sectionId: integer('section_id').notNull(),
    name: text('name').notNull(),
    plantCount: integer('plant_count').notNull().default(1),
    startDate: text('start_date').notNull(),
    recordType: text('record_type').notNull().default('plant'),
    archived: integer('archived').notNull().default(0),
    notes: text('notes'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    foreignKey({
      columns: [t.userId, t.sectionId],
      foreignColumns: [sections.userId, sections.id],
      name: 'crop_instances_section_fk',
    }).onDelete('cascade'),
    check('crop_instances_plant_count_check', sql`${t.plantCount} > 0`),
  ],
);

export const cropStages = pgTable(
  'crop_stages',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    id: integer('id').notNull(),
    cropInstanceId: integer('crop_instance_id').notNull(),
    // No FK: stage_definitions live on the device as deterministic seed data.
    stageDefinitionId: integer('stage_definition_id').notNull(),
    durationWeeks: integer('duration_weeks').notNull(),
    orderIndex: integer('order_index').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    foreignKey({
      columns: [t.userId, t.cropInstanceId],
      foreignColumns: [cropInstances.userId, cropInstances.id],
      name: 'crop_stages_crop_instance_fk',
    }).onDelete('cascade'),
    check('crop_stages_duration_weeks_check', sql`${t.durationWeeks} > 0`),
  ],
);

export const tasks = pgTable(
  'tasks',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    id: integer('id').notNull(),
    cropInstanceId: integer('crop_instance_id').notNull(),
    // No FK: task_types live on the device as deterministic seed data.
    taskTypeId: integer('task_type_id').notNull(),
    dayOfWeek: integer('day_of_week').notNull(),
    frequencyWeeks: integer('frequency_weeks').notNull().default(1),
    startOffsetWeeks: integer('start_offset_weeks').notNull().default(0),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    foreignKey({
      columns: [t.userId, t.cropInstanceId],
      foreignColumns: [cropInstances.userId, cropInstances.id],
      name: 'tasks_crop_instance_fk',
    }).onDelete('cascade'),
    check('tasks_day_of_week_check', sql`${t.dayOfWeek} BETWEEN 0 AND 6`),
    check('tasks_frequency_weeks_check', sql`${t.frequencyWeeks} > 0`),
    check('tasks_start_offset_weeks_check', sql`${t.startOffsetWeeks} >= 0`),
  ],
);

export const taskCompletions = pgTable(
  'task_completions',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    id: integer('id').notNull(),
    taskId: integer('task_id').notNull(),
    completedDate: text('completed_date').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    foreignKey({
      columns: [t.userId, t.taskId],
      foreignColumns: [tasks.userId, tasks.id],
      name: 'task_completions_task_fk',
    }).onDelete('cascade'),
    uniqueIndex('task_completions_task_date_unique').on(t.userId, t.taskId, t.completedDate),
  ],
);

export const notes = pgTable(
  'notes',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    id: integer('id').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: integer('entity_id'),
    weekDate: text('week_date'),
    cropInstanceId: integer('crop_instance_id'),
    content: text('content').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    foreignKey({
      columns: [t.userId, t.cropInstanceId],
      foreignColumns: [cropInstances.userId, cropInstances.id],
      name: 'notes_crop_instance_fk',
    }).onDelete('cascade'),
    uniqueIndex('notes_week_cell_unique')
      .on(t.userId, t.entityType, t.cropInstanceId, t.weekDate)
      .where(
        sql`entity_type = 'week_cell' AND crop_instance_id IS NOT NULL AND week_date IS NOT NULL`,
      ),
  ],
);

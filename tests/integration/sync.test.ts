import { describe, it, expect, beforeEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';

vi.mock('resend', () => ({
  Resend: vi.fn(() => ({
    emails: { send: vi.fn().mockResolvedValue({ data: { id: 'msg_test' }, error: null }) },
  })),
}));

import app from '../../src/app';
import { db } from '../../src/db/connection';
import {
  user,
  subscriptions,
  locations,
  gardens,
  sections,
  cropInstances,
  cropStages,
  tasks,
  taskCompletions,
  notes,
} from '../../src/db/schema';
import { resetDb } from '../helpers/db';

interface SignUpResponse {
  user: { id: string; email: string; name: string };
  token: string;
}

interface ErrorResponse {
  error: string;
}

interface SyncPullResponse {
  locations: { user_id: string; id: number; name: string; order_index: number }[];
  gardens: {
    user_id: string;
    id: number;
    location_id: number;
    name: string;
    record_type: string;
    order_index: number;
  }[];
  sections: {
    user_id: string;
    id: number;
    garden_id: number;
    name: string;
    order_index: number;
  }[];
  crop_instances: {
    user_id: string;
    id: number;
    section_id: number;
    name: string;
    plant_count: number;
    start_date: string;
    record_type: string;
    archived: number;
    notes: string | null;
    created_at: string;
    updated_at: string;
  }[];
  crop_stages: {
    user_id: string;
    id: number;
    crop_instance_id: number;
    stage_definition_id: number;
    duration_weeks: number;
    order_index: number;
  }[];
  tasks: {
    user_id: string;
    id: number;
    crop_instance_id: number;
    task_type_id: number;
    day_of_week: number;
    frequency_weeks: number;
    start_offset_weeks: number;
    created_at: string;
  }[];
  task_completions: {
    user_id: string;
    id: number;
    task_id: number;
    completed_date: string;
  }[];
  notes: {
    user_id: string;
    id: number;
    entity_type: string;
    entity_id: number | null;
    week_date: string | null;
    crop_instance_id: number | null;
    content: string;
    created_at: string;
    updated_at: string;
  }[];
}

async function signUp(opts: {
  email: string;
  name?: string;
  password?: string;
}): Promise<{ userId: string; cookies: string[] }> {
  const res = await request(app)
    .post('/api/auth/sign-up/email')
    .send({
      name: opts.name ?? 'Sync Test',
      email: opts.email,
      password: opts.password ?? 'password1234',
    });
  if (res.status !== 200) throw new Error(`sign-up failed: ${String(res.status)}`);
  const body = res.body as SignUpResponse;
  const raw = res.headers['set-cookie'];
  const cookies = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
  return { userId: body.user.id, cookies };
}

function cookieHeader(cookies: string[]): string {
  return cookies.map((c) => c.split(';')[0]).join('; ');
}

async function makeActiveSubscription(userId: string, rcSuffix = userId): Promise<void> {
  await db.insert(subscriptions).values({
    rcUserId: `rc_${rcSuffix}`,
    userId,
    status: 'active',
    productId: 'com.kevinnail.gardentracker.premium_yearly',
    expiresAt: new Date(Date.UTC(2099, 0, 1)),
  });
}

async function seedFullDataset(userId: string, idBase = 0): Promise<void> {
  const ts = '2026-05-10 12:00:00';
  await db.insert(locations).values({ userId, id: idBase + 1, name: 'Backyard', orderIndex: 0 });
  await db.insert(gardens).values({
    userId,
    id: idBase + 1,
    locationId: idBase + 1,
    name: 'Raised Bed A',
    recordType: 'plant',
    orderIndex: 0,
  });
  await db
    .insert(sections)
    .values({ userId, id: idBase + 1, gardenId: idBase + 1, name: 'North', orderIndex: 0 });
  await db.insert(cropInstances).values({
    userId,
    id: idBase + 1,
    sectionId: idBase + 1,
    name: 'Tomato',
    plantCount: 3,
    startDate: '2026-04-01',
    recordType: 'plant',
    archived: 0,
    notes: null,
    createdAt: ts,
    updatedAt: ts,
  });
  await db.insert(cropStages).values({
    userId,
    id: idBase + 1,
    cropInstanceId: idBase + 1,
    stageDefinitionId: 2,
    durationWeeks: 4,
    orderIndex: 0,
  });
  await db.insert(tasks).values({
    userId,
    id: idBase + 1,
    cropInstanceId: idBase + 1,
    taskTypeId: 1,
    dayOfWeek: 3,
    frequencyWeeks: 1,
    startOffsetWeeks: 0,
    createdAt: ts,
  });
  await db.insert(taskCompletions).values({
    userId,
    id: idBase + 1,
    taskId: idBase + 1,
    completedDate: '2026-05-07',
  });
  await db.insert(notes).values({
    userId,
    id: idBase + 1,
    entityType: 'week_cell',
    entityId: null,
    weekDate: '2026-05-04',
    cropInstanceId: idBase + 1,
    content: 'Yellowing leaves',
    createdAt: ts,
    updatedAt: ts,
  });
}

beforeEach(async () => {
  await resetDb();
});

describe('GET /sync/pull', () => {
  describe('auth and subscription gates', () => {
    it('returns 401 when no session cookie is present', async () => {
      const res = await request(app).get('/sync/pull');

      expect(res.status).toBe(401);
      const body = res.body as ErrorResponse;
      expect(body.error).toBe('Unauthorized');
    });

    it('returns 403 when authenticated but with no active subscription', async () => {
      const { cookies } = await signUp({ email: 'no-sub@example.com' });

      const res = await request(app).get('/sync/pull').set('Cookie', cookieHeader(cookies));

      expect(res.status).toBe(403);
      const body = res.body as ErrorResponse;
      expect(body.error).toBe('Subscription required');
    });
  });

  describe('happy path', () => {
    it('returns 200 with empty arrays for a subscribed user with no data', async () => {
      const { userId, cookies } = await signUp({ email: 'empty@example.com' });
      await makeActiveSubscription(userId);

      const res = await request(app).get('/sync/pull').set('Cookie', cookieHeader(cookies));

      expect(res.status).toBe(200);
      const body = res.body as SyncPullResponse;
      expect(body).toEqual({
        locations: [],
        gardens: [],
        sections: [],
        crop_instances: [],
        crop_stages: [],
        tasks: [],
        task_completions: [],
        notes: [],
      });
    });

    it("returns the subscribed user's seeded rows with the expected shape", async () => {
      const { userId, cookies } = await signUp({ email: 'seeded@example.com' });
      await makeActiveSubscription(userId);
      await seedFullDataset(userId);

      const res = await request(app).get('/sync/pull').set('Cookie', cookieHeader(cookies));

      expect(res.status).toBe(200);
      const body = res.body as SyncPullResponse;

      expect(body.locations).toEqual([
        { user_id: userId, id: 1, name: 'Backyard', order_index: 0 },
      ]);
      expect(body.gardens).toEqual([
        {
          user_id: userId,
          id: 1,
          location_id: 1,
          name: 'Raised Bed A',
          record_type: 'plant',
          order_index: 0,
        },
      ]);
      expect(body.sections).toEqual([
        { user_id: userId, id: 1, garden_id: 1, name: 'North', order_index: 0 },
      ]);
      expect(body.crop_instances).toEqual([
        {
          user_id: userId,
          id: 1,
          section_id: 1,
          name: 'Tomato',
          plant_count: 3,
          start_date: '2026-04-01',
          record_type: 'plant',
          archived: 0,
          notes: null,
          created_at: '2026-05-10 12:00:00',
          updated_at: '2026-05-10 12:00:00',
        },
      ]);
      expect(body.crop_stages).toEqual([
        {
          user_id: userId,
          id: 1,
          crop_instance_id: 1,
          stage_definition_id: 2,
          duration_weeks: 4,
          order_index: 0,
        },
      ]);
      expect(body.tasks).toEqual([
        {
          user_id: userId,
          id: 1,
          crop_instance_id: 1,
          task_type_id: 1,
          day_of_week: 3,
          frequency_weeks: 1,
          start_offset_weeks: 0,
          created_at: '2026-05-10 12:00:00',
        },
      ]);
      expect(body.task_completions).toEqual([
        { user_id: userId, id: 1, task_id: 1, completed_date: '2026-05-07' },
      ]);
      expect(body.notes).toEqual([
        {
          user_id: userId,
          id: 1,
          entity_type: 'week_cell',
          entity_id: null,
          week_date: '2026-05-04',
          crop_instance_id: 1,
          content: 'Yellowing leaves',
          created_at: '2026-05-10 12:00:00',
          updated_at: '2026-05-10 12:00:00',
        },
      ]);
    });
  });

  describe('user scoping', () => {
    it("does not return another user's rows", async () => {
      const caller = await signUp({ email: 'caller@example.com', name: 'Caller' });
      await makeActiveSubscription(caller.userId, 'caller');

      const otherId = 'user_other_sync_001';
      await db.insert(user).values({
        id: otherId,
        name: 'Other',
        email: 'other-sync@example.com',
      });
      await seedFullDataset(otherId);

      const res = await request(app).get('/sync/pull').set('Cookie', cookieHeader(caller.cookies));

      expect(res.status).toBe(200);
      const body = res.body as SyncPullResponse;
      expect(body.locations).toEqual([]);
      expect(body.gardens).toEqual([]);
      expect(body.sections).toEqual([]);
      expect(body.crop_instances).toEqual([]);
      expect(body.crop_stages).toEqual([]);
      expect(body.tasks).toEqual([]);
      expect(body.task_completions).toEqual([]);
      expect(body.notes).toEqual([]);
    });
  });
});

interface PushResponse {
  accepted: number;
  skipped: number;
}

describe('POST /sync/push', () => {
  describe('auth and subscription gates', () => {
    it('returns 401 when no session cookie is present', async () => {
      const res = await request(app).post('/sync/push').send({ changed: [] });

      expect(res.status).toBe(401);
      const body = res.body as ErrorResponse;
      expect(body.error).toBe('Unauthorized');
    });

    it('returns 403 when authenticated but with no active subscription', async () => {
      const { cookies } = await signUp({ email: 'no-sub-push@example.com' });

      const res = await request(app)
        .post('/sync/push')
        .set('Cookie', cookieHeader(cookies))
        .send({ changed: [] });

      expect(res.status).toBe(403);
      const body = res.body as ErrorResponse;
      expect(body.error).toBe('Subscription required');
    });
  });

  describe('validation', () => {
    async function makeSubscribedCaller(email: string): Promise<{ cookies: string[] }> {
      const { userId, cookies } = await signUp({ email });
      await makeActiveSubscription(userId);
      return { cookies };
    }

    it('returns 400 when body is missing the `changed` array', async () => {
      const { cookies } = await makeSubscribedCaller('val-1@example.com');

      const res = await request(app)
        .post('/sync/push')
        .set('Cookie', cookieHeader(cookies))
        .send({});

      expect(res.status).toBe(400);
      const body = res.body as ErrorResponse;
      expect(body.error).toBe('Invalid body: expected `changed` array');
    });

    it('returns 400 when a change entry references an unknown table', async () => {
      const { cookies } = await makeSubscribedCaller('val-2@example.com');

      const res = await request(app)
        .post('/sync/push')
        .set('Cookie', cookieHeader(cookies))
        .send({ changed: [{ table: 'nonexistent', rows: [] }] });

      expect(res.status).toBe(400);
      const body = res.body as ErrorResponse;
      expect(body.error).toBe('Unknown table: nonexistent');
    });

    it('returns 400 when a row is missing a numeric `id`', async () => {
      const { cookies } = await makeSubscribedCaller('val-3@example.com');

      const res = await request(app)
        .post('/sync/push')
        .set('Cookie', cookieHeader(cookies))
        .send({
          changed: [{ table: 'locations', rows: [{ name: 'No ID', order_index: 0 }] }],
        });

      expect(res.status).toBe(400);
      const body = res.body as ErrorResponse;
      expect(body.error).toBe('Row in locations missing numeric `id`');
    });

    it('rolls back all writes when a later row fails per-field validation', async () => {
      const { userId, cookies } = await signUp({ email: 'rollback@example.com' });
      await makeActiveSubscription(userId);

      // First table validates fine and would write; second table has a row
      // with a non-string `name`, which our per-field validator rejects.
      const res = await request(app)
        .post('/sync/push')
        .set('Cookie', cookieHeader(cookies))
        .send({
          changed: [
            { table: 'locations', rows: [{ id: 1, name: 'Backyard', order_index: 0 }] },
            {
              table: 'gardens',
              rows: [
                {
                  id: 1,
                  location_id: 1,
                  name: 123, // invalid — should be a string
                  record_type: 'plant',
                  order_index: 0,
                },
              ],
            },
          ],
        });

      expect(res.status).toBe(400);
      const body = res.body as ErrorResponse;
      expect(body.error).toBe('Expected string for "gardens.name"');

      // The locations row from the first change entry must not have been
      // committed — the whole push runs inside one transaction.
      const rows = await db.select().from(locations).where(eq(locations.userId, userId));
      expect(rows).toHaveLength(0);
    });

    it('rolls back all writes when a later row fails foreign-key constraints', async () => {
      const { userId, cookies } = await signUp({ email: 'rollback-fk@example.com' });
      await makeActiveSubscription(userId);

      const res = await request(app)
        .post('/sync/push')
        .set('Cookie', cookieHeader(cookies))
        .send({
          changed: [
            { table: 'locations', rows: [{ id: 1, name: 'Backyard', order_index: 0 }] },
            {
              table: 'gardens',
              rows: [
                {
                  id: 1,
                  location_id: 999, // invalid FK: no matching locations.id for this user
                  name: 'Raised Bed A',
                  record_type: 'plant',
                  order_index: 0,
                },
              ],
            },
          ],
        });

      expect(res.status).toBe(500);
      const body = res.body as ErrorResponse;
      expect(body.error).toBe('Internal Server Error');

      const rows = await db.select().from(locations).where(eq(locations.userId, userId));
      expect(rows).toHaveLength(0);
    });
  });

  describe('happy path', () => {
    it('upserts a new crop_instance and /sync/pull returns it', async () => {
      const { userId, cookies } = await signUp({ email: 'push-new@example.com' });
      await makeActiveSubscription(userId);

      const ts = '2026-05-10 12:00:00';
      const pushRes = await request(app)
        .post('/sync/push')
        .set('Cookie', cookieHeader(cookies))
        .send({
          changed: [
            {
              table: 'locations',
              rows: [{ id: 1, name: 'Backyard', order_index: 0 }],
            },
            {
              table: 'gardens',
              rows: [
                {
                  id: 1,
                  location_id: 1,
                  name: 'Raised Bed A',
                  record_type: 'plant',
                  order_index: 0,
                },
              ],
            },
            {
              table: 'sections',
              rows: [{ id: 1, garden_id: 1, name: 'North', order_index: 0 }],
            },
            {
              table: 'crop_instances',
              rows: [
                {
                  id: 1,
                  section_id: 1,
                  name: 'Tomato',
                  plant_count: 3,
                  start_date: '2026-04-01',
                  record_type: 'plant',
                  archived: 0,
                  notes: null,
                  created_at: ts,
                  updated_at: ts,
                },
              ],
            },
          ],
        });

      expect(pushRes.status).toBe(200);
      const pushBody = pushRes.body as PushResponse;
      expect(pushBody).toEqual({ accepted: 4, skipped: 0 });

      const pullRes = await request(app).get('/sync/pull').set('Cookie', cookieHeader(cookies));
      expect(pullRes.status).toBe(200);
      const pullBody = pullRes.body as SyncPullResponse;
      expect(pullBody.crop_instances).toEqual([
        {
          user_id: userId,
          id: 1,
          section_id: 1,
          name: 'Tomato',
          plant_count: 3,
          start_date: '2026-04-01',
          record_type: 'plant',
          archived: 0,
          notes: null,
          created_at: ts,
          updated_at: ts,
        },
      ]);
    });

    it('updates an existing crop_instance when incoming updated_at is newer', async () => {
      const { userId, cookies } = await signUp({ email: 'push-newer@example.com' });
      await makeActiveSubscription(userId);
      await seedFullDataset(userId); // crop_instance id=1, updated_at='2026-05-10 12:00:00'

      const newer = '2026-05-11 09:00:00';
      const pushRes = await request(app)
        .post('/sync/push')
        .set('Cookie', cookieHeader(cookies))
        .send({
          changed: [
            {
              table: 'crop_instances',
              rows: [
                {
                  id: 1,
                  section_id: 1,
                  name: 'Tomato (renamed)',
                  plant_count: 5,
                  start_date: '2026-04-01',
                  record_type: 'plant',
                  archived: 0,
                  notes: 'now with more plants',
                  created_at: '2026-05-10 12:00:00',
                  updated_at: newer,
                },
              ],
            },
          ],
        });

      expect(pushRes.status).toBe(200);
      expect(pushRes.body).toEqual({ accepted: 1, skipped: 0 });

      const row = await db
        .select()
        .from(cropInstances)
        .where(and(eq(cropInstances.userId, userId), eq(cropInstances.id, 1)));
      expect(row[0]?.name).toBe('Tomato (renamed)');
      expect(row[0]?.plantCount).toBe(5);
      expect(row[0]?.notes).toBe('now with more plants');
      expect(row[0]?.updatedAt).toBe(newer);
    });

    it('keeps the server version when incoming updated_at is stale', async () => {
      const { userId, cookies } = await signUp({ email: 'push-stale@example.com' });
      await makeActiveSubscription(userId);
      await seedFullDataset(userId); // crop_instance id=1, updated_at='2026-05-10 12:00:00'

      const older = '2026-05-09 09:00:00';
      const pushRes = await request(app)
        .post('/sync/push')
        .set('Cookie', cookieHeader(cookies))
        .send({
          changed: [
            {
              table: 'crop_instances',
              rows: [
                {
                  id: 1,
                  section_id: 1,
                  name: 'Stale name',
                  plant_count: 99,
                  start_date: '2026-04-01',
                  record_type: 'plant',
                  archived: 0,
                  notes: 'stale',
                  created_at: '2026-05-10 12:00:00',
                  updated_at: older,
                },
              ],
            },
          ],
        });

      expect(pushRes.status).toBe(200);
      expect(pushRes.body).toEqual({ accepted: 0, skipped: 1 });

      const row = await db
        .select()
        .from(cropInstances)
        .where(and(eq(cropInstances.userId, userId), eq(cropInstances.id, 1)));
      expect(row[0]?.name).toBe('Tomato');
      expect(row[0]?.plantCount).toBe(3);
      expect(row[0]?.notes).toBeNull();
      expect(row[0]?.updatedAt).toBe('2026-05-10 12:00:00');
    });
  });

  describe('bulk upload', () => {
    it('accepts a full local DB across all 8 tables', async () => {
      const { userId, cookies } = await signUp({ email: 'bulk@example.com' });
      await makeActiveSubscription(userId);

      const ts = '2026-05-10 12:00:00';
      const N = 30; // 30 rows per table × 8 tables = 240 rows
      const locationsRows = Array.from({ length: N }, (_, i) => ({
        id: i + 1,
        name: `Location ${String(i + 1)}`,
        order_index: i,
      }));
      const gardensRows = Array.from({ length: N }, (_, i) => ({
        id: i + 1,
        location_id: i + 1,
        name: `Garden ${String(i + 1)}`,
        record_type: 'plant',
        order_index: i,
      }));
      const sectionsRows = Array.from({ length: N }, (_, i) => ({
        id: i + 1,
        garden_id: i + 1,
        name: `Section ${String(i + 1)}`,
        order_index: i,
      }));
      const cropInstancesRows = Array.from({ length: N }, (_, i) => ({
        id: i + 1,
        section_id: i + 1,
        name: `Crop ${String(i + 1)}`,
        plant_count: 1,
        start_date: '2026-04-01',
        record_type: 'plant',
        archived: 0,
        notes: null,
        created_at: ts,
        updated_at: ts,
      }));
      const cropStagesRows = Array.from({ length: N }, (_, i) => ({
        id: i + 1,
        crop_instance_id: i + 1,
        stage_definition_id: 1,
        duration_weeks: 4,
        order_index: 0,
      }));
      const tasksRows = Array.from({ length: N }, (_, i) => ({
        id: i + 1,
        crop_instance_id: i + 1,
        task_type_id: 1,
        day_of_week: i % 7,
        frequency_weeks: 1,
        start_offset_weeks: 0,
        created_at: ts,
      }));
      const taskCompletionsRows = Array.from({ length: N }, (_, i) => ({
        id: i + 1,
        task_id: i + 1,
        completed_date: '2026-05-07',
      }));
      const notesRows = Array.from({ length: N }, (_, i) => ({
        id: i + 1,
        entity_type: 'crop',
        entity_id: i + 1,
        week_date: null,
        crop_instance_id: i + 1,
        content: `Note ${String(i + 1)}`,
        created_at: ts,
        updated_at: ts,
      }));

      const pushRes = await request(app)
        .post('/sync/push')
        .set('Cookie', cookieHeader(cookies))
        .send({
          changed: [
            // Intentionally sent out of dependency order — the server sorts.
            { table: 'notes', rows: notesRows },
            { table: 'task_completions', rows: taskCompletionsRows },
            { table: 'tasks', rows: tasksRows },
            { table: 'crop_stages', rows: cropStagesRows },
            { table: 'crop_instances', rows: cropInstancesRows },
            { table: 'sections', rows: sectionsRows },
            { table: 'gardens', rows: gardensRows },
            { table: 'locations', rows: locationsRows },
          ],
        });

      expect(pushRes.status).toBe(200);
      expect(pushRes.body).toEqual({ accepted: N * 8, skipped: 0 });

      const pullRes = await request(app).get('/sync/pull').set('Cookie', cookieHeader(cookies));
      expect(pullRes.status).toBe(200);
      const pullBody = pullRes.body as SyncPullResponse;
      expect(pullBody.locations).toHaveLength(N);
      expect(pullBody.gardens).toHaveLength(N);
      expect(pullBody.sections).toHaveLength(N);
      expect(pullBody.crop_instances).toHaveLength(N);
      expect(pullBody.crop_stages).toHaveLength(N);
      expect(pullBody.tasks).toHaveLength(N);
      expect(pullBody.task_completions).toHaveLength(N);
      expect(pullBody.notes).toHaveLength(N);
    });
  });

  describe('user scoping', () => {
    it('ignores client-supplied user_id and writes under the session user', async () => {
      const caller = await signUp({ email: 'forger@example.com', name: 'Forger' });
      await makeActiveSubscription(caller.userId, 'forger');

      const victimId = 'user_victim_001';
      await db.insert(user).values({
        id: victimId,
        name: 'Victim',
        email: 'victim@example.com',
      });

      const pushRes = await request(app)
        .post('/sync/push')
        .set('Cookie', cookieHeader(caller.cookies))
        .send({
          changed: [
            {
              table: 'locations',
              rows: [{ user_id: victimId, id: 42, name: 'Forged', order_index: 0 }],
            },
          ],
        });

      expect(pushRes.status).toBe(200);

      // Row was written under the caller, not the forged user_id.
      const callerRows = await db
        .select()
        .from(locations)
        .where(eq(locations.userId, caller.userId));
      expect(callerRows).toHaveLength(1);
      expect(callerRows[0]?.id).toBe(42);
      expect(callerRows[0]?.name).toBe('Forged');

      const victimRows = await db.select().from(locations).where(eq(locations.userId, victimId));
      expect(victimRows).toHaveLength(0);
    });
  });
});

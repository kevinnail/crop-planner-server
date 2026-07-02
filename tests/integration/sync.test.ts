import { describe, it, expect, beforeEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';

vi.mock('resend', () => ({
  Resend: vi.fn(() => ({
    emails: { send: vi.fn().mockResolvedValue({ data: { id: 'msg_test' }, error: null }) },
  })),
}));

// Mock the S3 wrapper so tests never touch AWS. buildImageKey/CONTENT_TYPE_EXT
// keep real behaviour (pure string logic); the network-touching functions are
// spies we assert against.
vi.mock('../../src/lib/s3', () => ({
  CONTENT_TYPE_EXT: {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
  },
  buildImageKey: (userId: string, uuid: string, ext: string): string =>
    `note-images/${userId}/${uuid}.${ext}`,
  createUploadUrl: vi.fn((key: string) => Promise.resolve(`https://s3.test/upload/${key}`)),
  createDownloadUrl: vi.fn((key: string) => Promise.resolve(`https://s3.test/download/${key}`)),
  deleteImageObject: vi.fn(() => Promise.resolve()),
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
  noteImages,
} from '../../src/db/schema';
import { deleteImageObject } from '../../src/lib/s3';
import { resetDb } from '../helpers/db';

interface SignUpResponse {
  user: { id: string; email: string; name: string };
  token: string;
}

interface ErrorResponse {
  error: string;
}

interface SyncPullResponse {
  locations: { uuid: string; name: string; order_index: number; updated_at: string }[];
  gardens: {
    uuid: string;
    location_uuid: string;
    name: string;
    record_type: string;
    order_index: number;
    updated_at: string;
  }[];
  sections: {
    uuid: string;
    garden_uuid: string;
    name: string;
    order_index: number;
    updated_at: string;
  }[];
  crop_instances: {
    uuid: string;
    section_uuid: string;
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
    uuid: string;
    crop_instance_uuid: string;
    stage_definition_id: number;
    duration_weeks: number;
    order_index: number;
    updated_at: string;
  }[];
  tasks: {
    uuid: string;
    crop_instance_uuid: string;
    task_type_id: number;
    day_of_week: number;
    frequency_weeks: number;
    start_offset_weeks: number;
    created_at: string;
    updated_at: string;
  }[];
  task_completions: {
    uuid: string;
    task_uuid: string;
    completed_date: string;
    updated_at: string;
  }[];
  notes: {
    uuid: string;
    entity_type: string;
    week_date: string | null;
    crop_instance_uuid: string | null;
    content: string;
    created_at: string;
    updated_at: string;
  }[];
  note_images: {
    uuid: string;
    note_uuid: string;
    s3_key: string;
    created_at: string;
    updated_at: string;
  }[];
  last_sync_at: string;
}

const SEED_TS = '2026-05-10 12:00:00.000';

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

// Seeds one full hierarchy. UUIDs are namespaced by `prefix` so two users can
// hold rows with distinct keys in the same test.
async function seedFullDataset(userId: string, prefix = ''): Promise<void> {
  const namespacedUuid = (localKey: string) => `${prefix}${localKey}`;
  await db.insert(locations).values({
    userId,
    uuid: namespacedUuid('loc-1'),
    name: 'Backyard',
    orderIndex: 0,
    updatedAt: SEED_TS,
  });
  await db.insert(gardens).values({
    userId,
    uuid: namespacedUuid('gar-1'),
    locationUuid: namespacedUuid('loc-1'),
    name: 'Raised Bed A',
    recordType: 'plant',
    orderIndex: 0,
    updatedAt: SEED_TS,
  });
  await db.insert(sections).values({
    userId,
    uuid: namespacedUuid('sec-1'),
    gardenUuid: namespacedUuid('gar-1'),
    name: 'North',
    orderIndex: 0,
    updatedAt: SEED_TS,
  });
  await db.insert(cropInstances).values({
    userId,
    uuid: namespacedUuid('crop-1'),
    sectionUuid: namespacedUuid('sec-1'),
    name: 'Tomato',
    plantCount: 3,
    startDate: '2026-04-01',
    recordType: 'plant',
    archived: 0,
    notes: null,
    createdAt: SEED_TS,
    updatedAt: SEED_TS,
  });
  await db.insert(cropStages).values({
    userId,
    uuid: namespacedUuid('stage-1'),
    cropInstanceUuid: namespacedUuid('crop-1'),
    stageDefinitionId: 2,
    durationWeeks: 4,
    orderIndex: 0,
    updatedAt: SEED_TS,
  });
  await db.insert(tasks).values({
    userId,
    uuid: namespacedUuid('task-1'),
    cropInstanceUuid: namespacedUuid('crop-1'),
    taskTypeId: 1,
    dayOfWeek: 3,
    frequencyWeeks: 1,
    startOffsetWeeks: 0,
    createdAt: SEED_TS,
    updatedAt: SEED_TS,
  });
  await db.insert(taskCompletions).values({
    userId,
    uuid: namespacedUuid('comp-1'),
    taskUuid: namespacedUuid('task-1'),
    completedDate: '2026-05-07',
    updatedAt: SEED_TS,
  });
  await db.insert(notes).values({
    userId,
    uuid: namespacedUuid('note-1'),
    entityType: 'week_cell',
    weekDate: '2026-05-04',
    cropInstanceUuid: namespacedUuid('crop-1'),
    content: 'Yellowing leaves',
    createdAt: SEED_TS,
    updatedAt: SEED_TS,
  });
  await db.insert(noteImages).values({
    userId,
    uuid: namespacedUuid('img-1'),
    noteUuid: namespacedUuid('note-1'),
    s3Key: `note-images/${userId}/${namespacedUuid('img-1')}.jpg`,
    createdAt: SEED_TS,
    updatedAt: SEED_TS,
  });
}

// A full crop_instances wire row, overridable per test.
function cropInstanceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uuid: 'crop-1',
    section_uuid: 'sec-1',
    name: 'Tomato',
    plant_count: 3,
    start_date: '2026-04-01',
    record_type: 'plant',
    archived: 0,
    notes: null,
    created_at: SEED_TS,
    updated_at: SEED_TS,
    ...overrides,
  };
}

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
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
      expect(body.locations).toEqual([]);
      expect(body.gardens).toEqual([]);
      expect(body.sections).toEqual([]);
      expect(body.crop_instances).toEqual([]);
      expect(body.crop_stages).toEqual([]);
      expect(body.tasks).toEqual([]);
      expect(body.task_completions).toEqual([]);
      expect(body.notes).toEqual([]);
      expect(body.note_images).toEqual([]);
      expect(typeof body.last_sync_at).toBe('string');
    });

    it("returns the subscribed user's seeded rows keyed by uuid with parent uuids", async () => {
      const { userId, cookies } = await signUp({ email: 'seeded@example.com' });
      await makeActiveSubscription(userId);
      await seedFullDataset(userId);

      const res = await request(app).get('/sync/pull').set('Cookie', cookieHeader(cookies));

      expect(res.status).toBe(200);
      const body = res.body as SyncPullResponse;

      expect(body.locations).toEqual([
        { uuid: 'loc-1', name: 'Backyard', order_index: 0, updated_at: SEED_TS },
      ]);
      expect(body.gardens).toEqual([
        {
          uuid: 'gar-1',
          location_uuid: 'loc-1',
          name: 'Raised Bed A',
          record_type: 'plant',
          order_index: 0,
          updated_at: SEED_TS,
        },
      ]);
      expect(body.sections).toEqual([
        { uuid: 'sec-1', garden_uuid: 'gar-1', name: 'North', order_index: 0, updated_at: SEED_TS },
      ]);
      expect(body.crop_instances).toEqual([
        {
          uuid: 'crop-1',
          section_uuid: 'sec-1',
          name: 'Tomato',
          plant_count: 3,
          start_date: '2026-04-01',
          record_type: 'plant',
          archived: 0,
          notes: null,
          created_at: SEED_TS,
          updated_at: SEED_TS,
        },
      ]);
      expect(body.crop_stages).toEqual([
        {
          uuid: 'stage-1',
          crop_instance_uuid: 'crop-1',
          stage_definition_id: 2,
          duration_weeks: 4,
          order_index: 0,
          updated_at: SEED_TS,
        },
      ]);
      expect(body.tasks).toEqual([
        {
          uuid: 'task-1',
          crop_instance_uuid: 'crop-1',
          task_type_id: 1,
          day_of_week: 3,
          frequency_weeks: 1,
          start_offset_weeks: 0,
          created_at: SEED_TS,
          updated_at: SEED_TS,
        },
      ]);
      expect(body.task_completions).toEqual([
        { uuid: 'comp-1', task_uuid: 'task-1', completed_date: '2026-05-07', updated_at: SEED_TS },
      ]);
      expect(body.notes).toEqual([
        {
          uuid: 'note-1',
          entity_type: 'week_cell',
          week_date: '2026-05-04',
          crop_instance_uuid: 'crop-1',
          content: 'Yellowing leaves',
          created_at: SEED_TS,
          updated_at: SEED_TS,
        },
      ]);
      expect(body.note_images).toEqual([
        {
          uuid: 'img-1',
          note_uuid: 'note-1',
          s3_key: `note-images/${userId}/img-1.jpg`,
          created_at: SEED_TS,
          updated_at: SEED_TS,
        },
      ]);
    });

    it('does not return soft-deleted (tombstoned) rows', async () => {
      const { userId, cookies } = await signUp({ email: 'tombstone-pull@example.com' });
      await makeActiveSubscription(userId);
      await seedFullDataset(userId);
      // Tombstone the location directly in the DB.
      await db
        .update(locations)
        .set({ deletedAt: '2026-05-12 08:00:00.000' })
        .where(and(eq(locations.userId, userId), eq(locations.uuid, 'loc-1')));

      const res = await request(app).get('/sync/pull').set('Cookie', cookieHeader(cookies));

      expect(res.status).toBe(200);
      const body = res.body as SyncPullResponse;
      expect(body.locations).toEqual([]);
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
      expect(body.note_images).toEqual([]);
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

    it('returns 400 when a row is missing a non-empty `uuid`', async () => {
      const { cookies } = await makeSubscribedCaller('val-3@example.com');

      const res = await request(app)
        .post('/sync/push')
        .set('Cookie', cookieHeader(cookies))
        .send({
          changed: [
            {
              table: 'locations',
              rows: [{ name: 'No UUID', order_index: 0, updated_at: SEED_TS }],
            },
          ],
        });

      expect(res.status).toBe(400);
      const body = res.body as ErrorResponse;
      expect(body.error).toBe('Row in locations missing non-empty `uuid`');
    });

    it('rolls back all writes when a later row fails per-field validation', async () => {
      const { userId, cookies } = await signUp({ email: 'rollback@example.com' });
      await makeActiveSubscription(userId);

      // locations validates fine and would write; gardens has a non-string
      // `name`, which the per-field validator rejects after uuid/location_uuid.
      const res = await request(app)
        .post('/sync/push')
        .set('Cookie', cookieHeader(cookies))
        .send({
          changed: [
            {
              table: 'locations',
              rows: [{ uuid: 'loc-1', name: 'Backyard', order_index: 0, updated_at: SEED_TS }],
            },
            {
              table: 'gardens',
              rows: [
                {
                  uuid: 'gar-1',
                  location_uuid: 'loc-1',
                  name: 123, // invalid — should be a string
                  record_type: 'plant',
                  order_index: 0,
                  updated_at: SEED_TS,
                },
              ],
            },
          ],
        });

      expect(res.status).toBe(400);
      const body = res.body as ErrorResponse;
      expect(body.error).toBe('Expected string for "gardens.name"');

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
            {
              table: 'locations',
              rows: [{ uuid: 'loc-1', name: 'Backyard', order_index: 0, updated_at: SEED_TS }],
            },
            {
              table: 'gardens',
              rows: [
                {
                  uuid: 'gar-1',
                  location_uuid: 'no-such-location', // invalid FK
                  name: 'Raised Bed A',
                  record_type: 'plant',
                  order_index: 0,
                  updated_at: SEED_TS,
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
    it('upserts a new hierarchy and /sync/pull returns the crop_instance', async () => {
      const caller = await signUp({ email: 'push-new@example.com' });
      await makeActiveSubscription(caller.userId);

      const pushRes = await request(app)
        .post('/sync/push')
        .set('Cookie', cookieHeader(caller.cookies))
        .send({
          changed: [
            {
              table: 'locations',
              rows: [{ uuid: 'loc-1', name: 'Backyard', order_index: 0, updated_at: SEED_TS }],
            },
            {
              table: 'gardens',
              rows: [
                {
                  uuid: 'gar-1',
                  location_uuid: 'loc-1',
                  name: 'Raised Bed A',
                  record_type: 'plant',
                  order_index: 0,
                  updated_at: SEED_TS,
                },
              ],
            },
            {
              table: 'sections',
              rows: [
                {
                  uuid: 'sec-1',
                  garden_uuid: 'gar-1',
                  name: 'North',
                  order_index: 0,
                  updated_at: SEED_TS,
                },
              ],
            },
            { table: 'crop_instances', rows: [cropInstanceRow()] },
          ],
        });

      expect(pushRes.status).toBe(200);
      const pushBody = pushRes.body as PushResponse;
      expect(pushBody).toEqual({ accepted: 4, skipped: 0 });

      const pullRes = await request(app)
        .get('/sync/pull')
        .set('Cookie', cookieHeader(caller.cookies));
      expect(pullRes.status).toBe(200);
      const pullBody = pullRes.body as SyncPullResponse;
      expect(pullBody.crop_instances).toEqual([
        {
          uuid: 'crop-1',
          section_uuid: 'sec-1',
          name: 'Tomato',
          plant_count: 3,
          start_date: '2026-04-01',
          record_type: 'plant',
          archived: 0,
          notes: null,
          created_at: SEED_TS,
          updated_at: SEED_TS,
        },
      ]);
    });

    it('updates an existing crop_instance when incoming updated_at is newer', async () => {
      const { userId, cookies } = await signUp({ email: 'push-newer@example.com' });
      await makeActiveSubscription(userId);
      await seedFullDataset(userId);

      const newer = '2026-05-11 09:00:00.000';
      const pushRes = await request(app)
        .post('/sync/push')
        .set('Cookie', cookieHeader(cookies))
        .send({
          changed: [
            {
              table: 'crop_instances',
              rows: [
                cropInstanceRow({
                  name: 'Tomato (renamed)',
                  plant_count: 5,
                  notes: 'now with more plants',
                  updated_at: newer,
                }),
              ],
            },
          ],
        });

      expect(pushRes.status).toBe(200);
      expect(pushRes.body).toEqual({ accepted: 1, skipped: 0 });

      const matchingRows = await db
        .select()
        .from(cropInstances)
        .where(and(eq(cropInstances.userId, userId), eq(cropInstances.uuid, 'crop-1')));
      expect(matchingRows[0]?.name).toBe('Tomato (renamed)');
      expect(matchingRows[0]?.plantCount).toBe(5);
      expect(matchingRows[0]?.notes).toBe('now with more plants');
      expect(matchingRows[0]?.updatedAt).toBe(newer);
    });

    it('keeps the server version when incoming updated_at is stale', async () => {
      const { userId, cookies } = await signUp({ email: 'push-stale@example.com' });
      await makeActiveSubscription(userId);
      await seedFullDataset(userId);

      const older = '2026-05-09 09:00:00.000';
      const pushRes = await request(app)
        .post('/sync/push')
        .set('Cookie', cookieHeader(cookies))
        .send({
          changed: [
            {
              table: 'crop_instances',
              rows: [cropInstanceRow({ name: 'Stale name', plant_count: 99, updated_at: older })],
            },
          ],
        });

      expect(pushRes.status).toBe(200);
      expect(pushRes.body).toEqual({ accepted: 0, skipped: 1 });

      const matchingRows = await db
        .select()
        .from(cropInstances)
        .where(and(eq(cropInstances.userId, userId), eq(cropInstances.uuid, 'crop-1')));
      expect(matchingRows[0]?.name).toBe('Tomato');
      expect(matchingRows[0]?.plantCount).toBe(3);
      expect(matchingRows[0]?.updatedAt).toBe(SEED_TS);
    });

    it('pins created_at on first insert and never overwrites it on re-push', async () => {
      const { userId, cookies } = await signUp({ email: 'created-pin@example.com' });
      await makeActiveSubscription(userId);
      await seedFullDataset(userId);

      const newer = '2026-05-11 09:00:00.000';
      const pushRes = await request(app)
        .post('/sync/push')
        .set('Cookie', cookieHeader(cookies))
        .send({
          changed: [
            {
              table: 'crop_instances',
              rows: [
                cropInstanceRow({
                  name: 'Renamed',
                  created_at: '2099-01-01 00:00:00.000', // attempt to change created_at
                  updated_at: newer,
                }),
              ],
            },
          ],
        });

      expect(pushRes.status).toBe(200);
      expect(pushRes.body).toEqual({ accepted: 1, skipped: 0 });

      const matchingRows = await db
        .select()
        .from(cropInstances)
        .where(and(eq(cropInstances.userId, userId), eq(cropInstances.uuid, 'crop-1')));
      expect(matchingRows[0]?.createdAt).toBe(SEED_TS); // pinned, not the pushed 2099 value
      expect(matchingRows[0]?.name).toBe('Renamed'); // other fields still update
    });
  });

  describe('uniform last-write-wins (previously non-LWW tables)', () => {
    it('applies LWW on locations: newer wins, stale loses', async () => {
      const { userId, cookies } = await signUp({ email: 'lww-locations@example.com' });
      await makeActiveSubscription(userId);
      await seedFullDataset(userId); // loc-1, name 'Backyard', updated_at SEED_TS

      // Newer update wins.
      const newer = '2026-05-11 09:00:00.000';
      const win = await request(app)
        .post('/sync/push')
        .set('Cookie', cookieHeader(cookies))
        .send({
          changed: [
            {
              table: 'locations',
              rows: [
                { uuid: 'loc-1', name: 'Backyard (renamed)', order_index: 0, updated_at: newer },
              ],
            },
          ],
        });
      expect(win.status).toBe(200);
      expect(win.body).toEqual({ accepted: 1, skipped: 0 });

      // Stale update loses.
      const older = '2026-05-09 09:00:00.000';
      const lose = await request(app)
        .post('/sync/push')
        .set('Cookie', cookieHeader(cookies))
        .send({
          changed: [
            {
              table: 'locations',
              rows: [{ uuid: 'loc-1', name: 'Should not win', order_index: 9, updated_at: older }],
            },
          ],
        });
      expect(lose.status).toBe(200);
      expect(lose.body).toEqual({ accepted: 0, skipped: 1 });

      const matchingRows = await db
        .select()
        .from(locations)
        .where(and(eq(locations.userId, userId), eq(locations.uuid, 'loc-1')));
      expect(matchingRows[0]?.name).toBe('Backyard (renamed)');
      expect(matchingRows[0]?.updatedAt).toBe(newer);
    });
  });

  describe('tombstones', () => {
    it('applies a tombstone (deleted_at + newer updated_at); pull then omits the row', async () => {
      const { userId, cookies } = await signUp({ email: 'tombstone-apply@example.com' });
      await makeActiveSubscription(userId);
      await seedFullDataset(userId);

      const newer = '2026-05-11 09:00:00.000';
      const pushRes = await request(app)
        .post('/sync/push')
        .set('Cookie', cookieHeader(cookies))
        .send({
          changed: [
            {
              table: 'crop_instances',
              rows: [cropInstanceRow({ updated_at: newer, deleted_at: newer })],
            },
          ],
        });

      expect(pushRes.status).toBe(200);
      expect(pushRes.body).toEqual({ accepted: 1, skipped: 0 });

      // Row still exists in the DB (as a tombstone) but pull hides it.
      const matchingRows = await db
        .select()
        .from(cropInstances)
        .where(and(eq(cropInstances.userId, userId), eq(cropInstances.uuid, 'crop-1')));
      expect(matchingRows[0]?.deletedAt).toBe(newer);

      const pullRes = await request(app).get('/sync/pull').set('Cookie', cookieHeader(cookies));
      const pullBody = pullRes.body as SyncPullResponse;
      expect(pullBody.crop_instances).toEqual([]);
    });

    it('ignores a stale tombstone (older updated_at) and keeps the row alive', async () => {
      const { userId, cookies } = await signUp({ email: 'tombstone-stale@example.com' });
      await makeActiveSubscription(userId);
      await seedFullDataset(userId); // crop-1, updated_at SEED_TS, deleted_at NULL

      const older = '2026-05-09 09:00:00.000';
      const pushRes = await request(app)
        .post('/sync/push')
        .set('Cookie', cookieHeader(cookies))
        .send({
          changed: [
            {
              table: 'crop_instances',
              rows: [cropInstanceRow({ updated_at: older, deleted_at: older })],
            },
          ],
        });

      expect(pushRes.status).toBe(200);
      expect(pushRes.body).toEqual({ accepted: 0, skipped: 1 });

      const matchingRows = await db
        .select()
        .from(cropInstances)
        .where(and(eq(cropInstances.userId, userId), eq(cropInstances.uuid, 'crop-1')));
      expect(matchingRows[0]?.deletedAt).toBeNull();

      const pullRes = await request(app).get('/sync/pull').set('Cookie', cookieHeader(cookies));
      const pullBody = pullRes.body as SyncPullResponse;
      expect(pullBody.crop_instances).toHaveLength(1);
    });
  });

  describe('note_images', () => {
    // A full note_images wire row for an image belonging to the seeded note-1.
    function noteImageRow(
      userId: string,
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> {
      return {
        uuid: 'img-1',
        note_uuid: 'note-1',
        s3_key: `note-images/${userId}/img-1.jpg`,
        created_at: SEED_TS,
        updated_at: SEED_TS,
        ...overrides,
      };
    }

    it('upserts a new note_images row and pull returns it', async () => {
      const { userId, cookies } = await signUp({ email: 'img-new@example.com' });
      await makeActiveSubscription(userId);
      await seedFullDataset(userId); // provides parent note-1 (and an img-1)

      const pushRes = await request(app)
        .post('/sync/push')
        .set('Cookie', cookieHeader(cookies))
        .send({
          changed: [
            {
              table: 'note_images',
              rows: [
                {
                  uuid: 'img-2',
                  note_uuid: 'note-1',
                  s3_key: `note-images/${userId}/img-2.png`,
                  created_at: SEED_TS,
                  updated_at: SEED_TS,
                },
              ],
            },
          ],
        });

      expect(pushRes.status).toBe(200);
      expect(pushRes.body).toEqual({ accepted: 1, skipped: 0 });
      expect(vi.mocked(deleteImageObject)).not.toHaveBeenCalled();

      const pullRes = await request(app).get('/sync/pull').set('Cookie', cookieHeader(cookies));
      const pullBody = pullRes.body as SyncPullResponse;
      expect(pullBody.note_images).toEqual(
        expect.arrayContaining([
          {
            uuid: 'img-2',
            note_uuid: 'note-1',
            s3_key: `note-images/${userId}/img-2.png`,
            created_at: SEED_TS,
            updated_at: SEED_TS,
          },
        ]),
      );
    });

    it('applies LWW: newer wins, stale is skipped', async () => {
      const { userId, cookies } = await signUp({ email: 'img-lww@example.com' });
      await makeActiveSubscription(userId);
      await seedFullDataset(userId);

      const newer = '2026-05-11 09:00:00.000';
      const win = await request(app)
        .post('/sync/push')
        .set('Cookie', cookieHeader(cookies))
        .send({
          changed: [
            {
              table: 'note_images',
              rows: [
                noteImageRow(userId, {
                  s3_key: `note-images/${userId}/img-1-renamed.jpg`,
                  updated_at: newer,
                }),
              ],
            },
          ],
        });
      expect(win.status).toBe(200);
      expect(win.body).toEqual({ accepted: 1, skipped: 0 });

      const older = '2026-05-09 09:00:00.000';
      const lose = await request(app)
        .post('/sync/push')
        .set('Cookie', cookieHeader(cookies))
        .send({
          changed: [
            {
              table: 'note_images',
              rows: [noteImageRow(userId, { s3_key: 'should-not-win', updated_at: older })],
            },
          ],
        });
      expect(lose.status).toBe(200);
      expect(lose.body).toEqual({ accepted: 0, skipped: 1 });

      const matchingRows = await db
        .select()
        .from(noteImages)
        .where(and(eq(noteImages.userId, userId), eq(noteImages.uuid, 'img-1')));
      expect(matchingRows[0]?.s3Key).toBe(`note-images/${userId}/img-1-renamed.jpg`);
    });

    it('deletes the S3 object after commit when a tombstone wins, and pull omits the row', async () => {
      const { userId, cookies } = await signUp({ email: 'img-tombstone@example.com' });
      await makeActiveSubscription(userId);
      await seedFullDataset(userId);

      const newer = '2026-05-11 09:00:00.000';
      const pushRes = await request(app)
        .post('/sync/push')
        .set('Cookie', cookieHeader(cookies))
        .send({
          changed: [
            {
              table: 'note_images',
              rows: [noteImageRow(userId, { updated_at: newer, deleted_at: newer })],
            },
          ],
        });

      expect(pushRes.status).toBe(200);
      expect(pushRes.body).toEqual({ accepted: 1, skipped: 0 });
      expect(vi.mocked(deleteImageObject)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(deleteImageObject)).toHaveBeenCalledWith(`note-images/${userId}/img-1.jpg`);

      const pullRes = await request(app).get('/sync/pull').set('Cookie', cookieHeader(cookies));
      const pullBody = pullRes.body as SyncPullResponse;
      expect(pullBody.note_images).toEqual([]);
    });

    it('does not delete the S3 object for a stale tombstone; the row stays alive', async () => {
      const { userId, cookies } = await signUp({ email: 'img-stale@example.com' });
      await makeActiveSubscription(userId);
      await seedFullDataset(userId);

      const older = '2026-05-09 09:00:00.000';
      const pushRes = await request(app)
        .post('/sync/push')
        .set('Cookie', cookieHeader(cookies))
        .send({
          changed: [
            {
              table: 'note_images',
              rows: [noteImageRow(userId, { updated_at: older, deleted_at: older })],
            },
          ],
        });

      expect(pushRes.status).toBe(200);
      expect(pushRes.body).toEqual({ accepted: 0, skipped: 1 });
      expect(vi.mocked(deleteImageObject)).not.toHaveBeenCalled();

      const pullRes = await request(app).get('/sync/pull').set('Cookie', cookieHeader(cookies));
      const pullBody = pullRes.body as SyncPullResponse;
      expect(pullBody.note_images).toHaveLength(1);
    });

    it('still returns 200 when the best-effort S3 delete fails', async () => {
      const { userId, cookies } = await signUp({ email: 'img-s3fail@example.com' });
      await makeActiveSubscription(userId);
      await seedFullDataset(userId);
      vi.mocked(deleteImageObject).mockRejectedValueOnce(new Error('s3 down'));

      const newer = '2026-05-11 09:00:00.000';
      const pushRes = await request(app)
        .post('/sync/push')
        .set('Cookie', cookieHeader(cookies))
        .send({
          changed: [
            {
              table: 'note_images',
              rows: [noteImageRow(userId, { updated_at: newer, deleted_at: newer })],
            },
          ],
        });

      // The S3 delete rejected, but the push still succeeds and the tombstone
      // is persisted (pull omits the row).
      expect(pushRes.status).toBe(200);
      expect(pushRes.body).toEqual({ accepted: 1, skipped: 0 });

      const pullRes = await request(app).get('/sync/pull').set('Cookie', cookieHeader(cookies));
      const pullBody = pullRes.body as SyncPullResponse;
      expect(pullBody.note_images).toEqual([]);
    });
  });

  describe('bulk upload', () => {
    it('accepts a full local DB across all 8 tables', async () => {
      const realCaller = await signUp({ email: 'bulk@example.com' });
      await makeActiveSubscription(realCaller.userId);

      const timestamp = SEED_TS;
      const rowsPerTable = 30; // 30 rows per table × 8 tables = 240 rows
      const locationsRows = Array.from({ length: rowsPerTable }, (_unused, index) => ({
        uuid: `loc-${String(index + 1)}`,
        name: `Location ${String(index + 1)}`,
        order_index: index,
        updated_at: timestamp,
      }));
      const gardensRows = Array.from({ length: rowsPerTable }, (_unused, index) => ({
        uuid: `gar-${String(index + 1)}`,
        location_uuid: `loc-${String(index + 1)}`,
        name: `Garden ${String(index + 1)}`,
        record_type: 'plant',
        order_index: index,
        updated_at: timestamp,
      }));
      const sectionsRows = Array.from({ length: rowsPerTable }, (_unused, index) => ({
        uuid: `sec-${String(index + 1)}`,
        garden_uuid: `gar-${String(index + 1)}`,
        name: `Section ${String(index + 1)}`,
        order_index: index,
        updated_at: timestamp,
      }));
      const cropInstancesRows = Array.from({ length: rowsPerTable }, (_unused, index) => ({
        uuid: `crop-${String(index + 1)}`,
        section_uuid: `sec-${String(index + 1)}`,
        name: `Crop ${String(index + 1)}`,
        plant_count: 1,
        start_date: '2026-04-01',
        record_type: 'plant',
        archived: 0,
        notes: null,
        created_at: timestamp,
        updated_at: timestamp,
      }));
      const cropStagesRows = Array.from({ length: rowsPerTable }, (_unused, index) => ({
        uuid: `stage-${String(index + 1)}`,
        crop_instance_uuid: `crop-${String(index + 1)}`,
        stage_definition_id: 1,
        duration_weeks: 4,
        order_index: 0,
        updated_at: timestamp,
      }));
      const tasksRows = Array.from({ length: rowsPerTable }, (_unused, index) => ({
        uuid: `task-${String(index + 1)}`,
        crop_instance_uuid: `crop-${String(index + 1)}`,
        task_type_id: 1,
        day_of_week: index % 7,
        frequency_weeks: 1,
        start_offset_weeks: 0,
        created_at: timestamp,
        updated_at: timestamp,
      }));
      const taskCompletionsRows = Array.from({ length: rowsPerTable }, (_unused, index) => ({
        uuid: `comp-${String(index + 1)}`,
        task_uuid: `task-${String(index + 1)}`,
        completed_date: '2026-05-07',
        updated_at: timestamp,
      }));
      const notesRows = Array.from({ length: rowsPerTable }, (_unused, index) => ({
        uuid: `note-${String(index + 1)}`,
        entity_type: 'week_cell',
        week_date: null,
        crop_instance_uuid: `crop-${String(index + 1)}`,
        content: `Note ${String(index + 1)}`,
        created_at: timestamp,
        updated_at: timestamp,
      }));

      const pushRes = await request(app)
        .post('/sync/push')
        .set('Cookie', cookieHeader(realCaller.cookies))
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
      expect(pushRes.body).toEqual({ accepted: rowsPerTable * 8, skipped: 0 });

      const pullRes = await request(app)
        .get('/sync/pull')
        .set('Cookie', cookieHeader(realCaller.cookies));
      expect(pullRes.status).toBe(200);
      const pullBody = pullRes.body as SyncPullResponse;
      expect(pullBody.locations).toHaveLength(rowsPerTable);
      expect(pullBody.gardens).toHaveLength(rowsPerTable);
      expect(pullBody.sections).toHaveLength(rowsPerTable);
      expect(pullBody.crop_instances).toHaveLength(rowsPerTable);
      expect(pullBody.crop_stages).toHaveLength(rowsPerTable);
      expect(pullBody.tasks).toHaveLength(rowsPerTable);
      expect(pullBody.task_completions).toHaveLength(rowsPerTable);
      expect(pullBody.notes).toHaveLength(rowsPerTable);
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
              rows: [
                {
                  user_id: victimId,
                  uuid: 'loc-forged',
                  name: 'Forged',
                  order_index: 0,
                  updated_at: SEED_TS,
                },
              ],
            },
          ],
        });

      expect(pushRes.status).toBe(200);

      const callerRows = await db
        .select()
        .from(locations)
        .where(eq(locations.userId, caller.userId));
      expect(callerRows).toHaveLength(1);
      expect(callerRows[0]?.uuid).toBe('loc-forged');
      expect(callerRows[0]?.name).toBe('Forged');

      const victimRows = await db.select().from(locations).where(eq(locations.userId, victimId));
      expect(victimRows).toHaveLength(0);
    });
  });
});

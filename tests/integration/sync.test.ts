import { describe, it, expect, beforeEach, vi } from 'vitest';
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
    it('does not return another user\'s rows', async () => {
      const caller = await signUp({ email: 'caller@example.com', name: 'Caller' });
      await makeActiveSubscription(caller.userId, 'caller');

      const otherId = 'user_other_sync_001';
      await db.insert(user).values({
        id: otherId,
        name: 'Other',
        email: 'other-sync@example.com',
      });
      await seedFullDataset(otherId);

      const res = await request(app)
        .get('/sync/pull')
        .set('Cookie', cookieHeader(caller.cookies));

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

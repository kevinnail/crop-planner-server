import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import app from '../../src/app';
import { db } from '../../src/db/connection';
import { subscriptions, user } from '../../src/db/schema';
import { resetDb } from '../helpers/db';

const AUTH = process.env.REVENUECAT_WEBHOOK_AUTH_HEADER;
if (!AUTH) throw new Error('REVENUECAT_WEBHOOK_AUTH_HEADER is not set in .env.test');

const APP_USER_ID = 'rc_app_user_abc123';
const PRODUCT_ID = 'com.kevinnail.gardentracker.premium_yearly';
const EXPIRES_AT_MS = Date.UTC(2099, 0, 1);

interface EventOverrides {
  type?: string;
  app_user_id?: string;
  product_id?: string | null;
  expiration_at_ms?: number | null;
}

function buildBody(overrides: EventOverrides = {}): Record<string, unknown> {
  const event: Record<string, unknown> = {
    type: overrides.type ?? 'INITIAL_PURCHASE',
    app_user_id: overrides.app_user_id ?? APP_USER_ID,
  };
  if (overrides.product_id !== null) {
    event.product_id = overrides.product_id ?? PRODUCT_ID;
  }
  if (overrides.expiration_at_ms !== null) {
    event.expiration_at_ms = overrides.expiration_at_ms ?? EXPIRES_AT_MS;
  }
  return { api_version: '1.0', event };
}

beforeEach(async () => {
  await resetDb();
});

describe('POST /webhooks/revenuecat', () => {
  describe('auth', () => {
    it('rejects requests with no Authorization header (401, no DB write)', async () => {
      const res = await request(app).post('/webhooks/revenuecat').send(buildBody());

      expect(res.status).toBe(401);
      const rows = await db.select().from(subscriptions);
      expect(rows).toHaveLength(0);
    });

    it('rejects requests with a wrong Authorization header (401, no DB write)', async () => {
      const res = await request(app)
        .post('/webhooks/revenuecat')
        .set('Authorization', 'wrong-secret')
        .send(buildBody());

      expect(res.status).toBe(401);
      const rows = await db.select().from(subscriptions);
      expect(rows).toHaveLength(0);
    });
  });

  describe('happy path', () => {
    it('inserts an active subscription on INITIAL_PURCHASE', async () => {
      const res = await request(app)
        .post('/webhooks/revenuecat')
        .set('Authorization', AUTH)
        .send(buildBody({ type: 'INITIAL_PURCHASE' }));

      expect(res.status).toBe(200);

      const rows = await db.select().from(subscriptions);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      if (!row) throw new Error('expected one subscription row');
      expect(row.rcUserId).toBe(APP_USER_ID);
      expect(row.status).toBe('active');
      expect(row.productId).toBe(PRODUCT_ID);
      expect(row.expiresAt?.getTime()).toBe(EXPIRES_AT_MS);
      expect(row.userId).toBeNull();
    });

    it('flips status to expired on EXPIRATION for an existing subscription', async () => {
      await request(app)
        .post('/webhooks/revenuecat')
        .set('Authorization', AUTH)
        .send(buildBody({ type: 'INITIAL_PURCHASE' }));

      const res = await request(app)
        .post('/webhooks/revenuecat')
        .set('Authorization', AUTH)
        .send(buildBody({ type: 'EXPIRATION' }));

      expect(res.status).toBe(200);

      const rows = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.rcUserId, APP_USER_ID));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('expired');
    });

    it('updates the existing row on RENEWAL instead of duplicating', async () => {
      const FIRST_EXPIRY = Date.UTC(2050, 0, 1);
      await request(app)
        .post('/webhooks/revenuecat')
        .set('Authorization', AUTH)
        .send(buildBody({ type: 'INITIAL_PURCHASE', expiration_at_ms: FIRST_EXPIRY }));

      const RENEWED_EXPIRY = Date.UTC(2051, 0, 1);
      await request(app)
        .post('/webhooks/revenuecat')
        .set('Authorization', AUTH)
        .send(buildBody({ type: 'RENEWAL', expiration_at_ms: RENEWED_EXPIRY }));

      const rows = await db.select().from(subscriptions);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      if (!row) throw new Error('expected one subscription row');
      expect(row.status).toBe('active');
      expect(row.expiresAt?.getTime()).toBe(RENEWED_EXPIRY);
    });

    it('links subscription.userId to user.id when app_user_id matches', async () => {
      const userId = 'user_known_001';
      await db.insert(user).values({
        id: userId,
        name: 'Linked',
        email: 'linked@example.com',
      });

      await request(app)
        .post('/webhooks/revenuecat')
        .set('Authorization', AUTH)
        .send(buildBody({ app_user_id: userId }));

      const rows = await db.select().from(subscriptions).where(eq(subscriptions.rcUserId, userId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.userId).toBe(userId);
    });

    it('leaves userId null when app_user_id does not match any user', async () => {
      await request(app)
        .post('/webhooks/revenuecat')
        .set('Authorization', AUTH)
        .send(buildBody({ app_user_id: 'unknown_user_xyz' }));

      const rows = await db.select().from(subscriptions);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.userId).toBeNull();
    });
  });

  describe('idempotency', () => {
    it('returns 200 and writes nothing for an unknown event type', async () => {
      const res = await request(app)
        .post('/webhooks/revenuecat')
        .set('Authorization', AUTH)
        .send(buildBody({ type: 'BILLING_ISSUE' }));

      expect(res.status).toBe(200);
      const rows = await db.select().from(subscriptions);
      expect(rows).toHaveLength(0);
    });

    it('rejects a body with no event.type as 400', async () => {
      const res = await request(app)
        .post('/webhooks/revenuecat')
        .set('Authorization', AUTH)
        .send({ api_version: '1.0', event: { app_user_id: APP_USER_ID } });

      expect(res.status).toBe(400);
      const rows = await db.select().from(subscriptions);
      expect(rows).toHaveLength(0);
    });

    it('rejects a body with no event.app_user_id as 400', async () => {
      const res = await request(app)
        .post('/webhooks/revenuecat')
        .set('Authorization', AUTH)
        .send({ api_version: '1.0', event: { type: 'INITIAL_PURCHASE' } });

      expect(res.status).toBe(400);
    });
  });
});

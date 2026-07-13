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
  aliases?: string[];
  product_id?: string | null;
  expiration_at_ms?: number | null;
}

function buildBody(overrides: EventOverrides = {}): Record<string, unknown> {
  const event: Record<string, unknown> = {
    type: overrides.type ?? 'INITIAL_PURCHASE',
    app_user_id: overrides.app_user_id ?? APP_USER_ID,
  };
  if (overrides.aliases) {
    event.aliases = overrides.aliases;
  }
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

    it('rejects a wrong header of the same length (constant-time compare path)', async () => {
      const sameLengthWrong = 'X'.repeat(AUTH.length);
      expect(sameLengthWrong).not.toBe(AUTH);

      const res = await request(app)
        .post('/webhooks/revenuecat')
        .set('Authorization', sameLengthWrong)
        .send(buildBody());

      expect(res.status).toBe(401);
      const rows = await db.select().from(subscriptions);
      expect(rows).toHaveLength(0);
    });
  });

  describe('happy path', () => {
    // Webhook events only produce rows for known accounts, so the default
    // APP_USER_ID must exist as a better-auth user.
    beforeEach(async () => {
      await db.insert(user).values({
        id: APP_USER_ID,
        name: 'Webhook Tester',
        email: 'webhook-tester@example.com',
      });
    });

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
      expect(row.userId).toBe(APP_USER_ID);
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

    it('routes a RENEWAL carrying an anonymous last-seen app_user_id to the canonical row via aliases', async () => {
      // Regression: RevenueCat fires renewals with the customer's *last-seen*
      // alias as app_user_id. When that alias is an app-launch anonymous id,
      // the renewal must still land on the signed-in account's row — before
      // this fix it inserted an unmatchable anonymous row while the real row
      // went stale and /sync/* started 403ing a paying user.
      const FIRST_EXPIRY = Date.UTC(2050, 0, 1);
      await request(app)
        .post('/webhooks/revenuecat')
        .set('Authorization', AUTH)
        .send(buildBody({ type: 'INITIAL_PURCHASE', expiration_at_ms: FIRST_EXPIRY }));

      const RENEWED_EXPIRY = Date.UTC(2051, 0, 1);
      const anonymousId = '$RCAnonymousID:d0f81ecd1586424db65f5a6c3459475d';
      const res = await request(app)
        .post('/webhooks/revenuecat')
        .set('Authorization', AUTH)
        .send(
          buildBody({
            type: 'RENEWAL',
            app_user_id: anonymousId,
            aliases: [anonymousId, APP_USER_ID],
            expiration_at_ms: RENEWED_EXPIRY,
          }),
        );

      expect(res.status).toBe(200);

      const rows = await db.select().from(subscriptions);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      if (!row) throw new Error('expected one subscription row');
      expect(row.rcUserId).toBe(APP_USER_ID);
      expect(row.userId).toBe(APP_USER_ID);
      expect(row.status).toBe('active');
      expect(row.expiresAt?.getTime()).toBe(RENEWED_EXPIRY);
    });

    it('acknowledges and writes nothing when no candidate id matches a user', async () => {
      const res = await request(app)
        .post('/webhooks/revenuecat')
        .set('Authorization', AUTH)
        .send(
          buildBody({
            app_user_id: '$RCAnonymousID:8ce852924d8e4adaa1d22fa9ab00441d',
            aliases: ['$RCAnonymousID:8ce852924d8e4adaa1d22fa9ab00441d'],
          }),
        );

      expect(res.status).toBe(200);
      const rows = await db.select().from(subscriptions);
      expect(rows).toHaveLength(0);
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

  describe('TRANSFER events', () => {
    const ANON_FROM = '$RCAnonymousID:cd8d54a26312473ca9fd0f4654c67923';

    // We use RevenueCat's "Keep with original App User ID" transfer behavior:
    // one Apple ID stays bound to one better-auth account and subscriptions
    // never move between accounts. So the webhook must ACK a TRANSFER (RevenueCat
    // still emits one when the app-launch anonymous id merges into the real
    // user.id at login) without touching the subscriptions table.
    function buildTransferBody(
      transferredFrom: string[],
      transferredTo: string[],
    ): Record<string, unknown> {
      return {
        api_version: '1.0',
        event: {
          type: 'TRANSFER',
          transferred_from: transferredFrom,
          transferred_to: transferredTo,
        },
      };
    }

    it('returns 200 and writes nothing when there is no existing subscription', async () => {
      const res = await request(app)
        .post('/webhooks/revenuecat')
        .set('Authorization', AUTH)
        .send(buildTransferBody([ANON_FROM], ['user_login_target']));

      expect(res.status).toBe(200);
      const rows = await db.select().from(subscriptions);
      expect(rows).toHaveLength(0);
    });

    it('leaves an existing subscription untouched — no re-homing between accounts', async () => {
      const ownerUserId = 'user_transfer_owner';
      await db.insert(user).values({
        id: ownerUserId,
        name: ownerUserId,
        email: 'owner@example.com',
      });

      // Owner buys a subscription; it is bound to their account.
      await request(app)
        .post('/webhooks/revenuecat')
        .set('Authorization', AUTH)
        .send(buildBody({ app_user_id: ownerUserId }));

      // A TRANSFER naming the owner as source must NOT move or expire it.
      const res = await request(app)
        .post('/webhooks/revenuecat')
        .set('Authorization', AUTH)
        .send(buildTransferBody([ownerUserId], ['user_would_be_thief']));

      expect(res.status).toBe(200);

      const rows = await db.select().from(subscriptions);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      if (!row) throw new Error('expected the owner subscription row');
      expect(row.rcUserId).toBe(ownerUserId);
      expect(row.userId).toBe(ownerUserId);
      expect(row.status).toBe('active');
    });
  });
});

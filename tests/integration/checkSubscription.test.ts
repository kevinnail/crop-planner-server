import { describe, it, expect, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import express from 'express';
import request from 'supertest';
import { toNodeHandler } from 'better-auth/node';

vi.mock('resend', () => ({
  Resend: vi.fn(() => ({
    emails: { send: vi.fn().mockResolvedValue({ data: { id: 'msg_test' }, error: null }) },
  })),
}));

import { auth } from '../../src/lib/auth';
import { db } from '../../src/db/connection';
import { user, subscriptions } from '../../src/db/schema';
import { asyncHandler } from '../../src/lib/asyncHandler';
import { requireAuth } from '../../src/middleware/requireAuth';
import { checkSubscription } from '../../src/middleware/checkSubscription';
import { resetDb } from '../helpers/db';

interface ProtectedResponse {
  ok: true;
  userId: string;
}

interface ErrorResponse {
  error: string;
}

function buildTestApp(): express.Express {
  const app = express();
  const authHandler = toNodeHandler(auth);
  app.all(
    '/api/auth/*',
    asyncHandler(async (req, res) => {
      await authHandler(req, res);
    }),
  );
  app.use(express.json());
  app.get('/test/protected', requireAuth, checkSubscription, (req, res) => {
    res.json({ ok: true, userId: req.userId });
  });
  return app;
}

const app = buildTestApp();

const SIGNED_UP = {
  name: 'Sub Test',
  email: 'sub-test@example.com',
  password: 'password1234',
};

interface SignUpResponse {
  user: { id: string; email: string; name: string };
  token: string;
}

async function signUp(): Promise<{ userId: string; cookies: string[] }> {
  const res = await request(app).post('/api/auth/sign-up/email').send(SIGNED_UP);
  if (res.status !== 200) throw new Error(`sign-up failed: ${String(res.status)}`);
  const body = res.body as SignUpResponse;
  const raw = res.headers['set-cookie'];
  const cookies = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
  return { userId: body.user.id, cookies };
}

function cookieHeader(cookies: string[]): string {
  return cookies.map((c) => c.split(';')[0]).join('; ');
}

async function insertSubscription(opts: {
  userId: string;
  status: 'active' | 'expired';
  expiresAt: Date;
  rcUserId?: string;
}): Promise<void> {
  await db.insert(subscriptions).values({
    rcUserId: opts.rcUserId ?? `rc_${opts.userId}`,
    userId: opts.userId,
    status: opts.status,
    productId: 'com.kevinnail.gardentracker.premium_yearly',
    expiresAt: opts.expiresAt,
  });
}

beforeEach(async () => {
  await resetDb();
});

describe('checkSubscription middleware (via /test/protected)', () => {
  describe('auth gate', () => {
    it('returns 401 when no session cookie is present', async () => {
      const res = await request(app).get('/test/protected');

      expect(res.status).toBe(401);
      const body = res.body as ErrorResponse;
      expect(body.error).toBe('Unauthorized');
    });

    it('returns 401 when the session cookie is invalid', async () => {
      const res = await request(app)
        .get('/test/protected')
        .set('Cookie', 'better-auth.session_token=not-a-real-token');

      expect(res.status).toBe(401);
    });
  });

  describe('subscription gate', () => {
    it('returns 403 when the authenticated user has no subscription row', async () => {
      const { cookies } = await signUp();

      const res = await request(app).get('/test/protected').set('Cookie', cookieHeader(cookies));

      expect(res.status).toBe(403);
      const body = res.body as ErrorResponse;
      expect(body.error).toBe('Subscription required');
    });

    it('returns 403 when the subscription has status=expired (even if expires_at is in the future)', async () => {
      const { userId, cookies } = await signUp();
      await insertSubscription({
        userId,
        status: 'expired',
        expiresAt: new Date(Date.UTC(2099, 0, 1)),
      });

      const res = await request(app).get('/test/protected').set('Cookie', cookieHeader(cookies));

      expect(res.status).toBe(403);
    });

    it('returns 403 when the subscription is active but expires_at is in the past', async () => {
      const { userId, cookies } = await signUp();
      await insertSubscription({
        userId,
        status: 'active',
        expiresAt: new Date(Date.UTC(2000, 0, 1)),
      });

      const res = await request(app).get('/test/protected').set('Cookie', cookieHeader(cookies));

      expect(res.status).toBe(403);
    });

    it('returns 403 when an active subscription belongs to a different user', async () => {
      const { cookies } = await signUp();
      const otherId = 'user_other_001';
      await db.insert(user).values({
        id: otherId,
        name: 'Other',
        email: 'other@example.com',
      });
      await insertSubscription({
        userId: otherId,
        status: 'active',
        expiresAt: new Date(Date.UTC(2099, 0, 1)),
        rcUserId: 'rc_other',
      });

      const res = await request(app).get('/test/protected').set('Cookie', cookieHeader(cookies));

      expect(res.status).toBe(403);
    });
  });

  describe('happy path', () => {
    it('calls next() and returns 200 when the user has an active, unexpired subscription', async () => {
      const { userId, cookies } = await signUp();
      await insertSubscription({
        userId,
        status: 'active',
        expiresAt: new Date(Date.UTC(2099, 0, 1)),
      });

      const res = await request(app).get('/test/protected').set('Cookie', cookieHeader(cookies));

      expect(res.status).toBe(200);
      const body = res.body as ProtectedResponse;
      expect(body.ok).toBe(true);
      expect(body.userId).toBe(userId);

      // Confirms the gate condition we tested actually matched the DB row we inserted.
      const rows = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
      expect(rows).toHaveLength(1);
    });
  });
});

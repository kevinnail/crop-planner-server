import { describe, it, expect, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import request from 'supertest';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('resend', () => ({
  Resend: vi.fn(() => ({
    emails: { send: sendMock },
  })),
}));

import app from '../../src/app';
import { db } from '../../src/db/connection';
import { user, session, account } from '../../src/db/schema';
import { resetDb } from '../helpers/db';

interface SignUpUser {
  id: string;
  email: string;
  name: string;
}

interface SignUpResponse {
  user: SignUpUser;
  token: string;
}

interface ErrorResponse {
  message?: string;
  code?: string;
}

interface ResendSendArgs {
  from: string;
  to: string;
  subject: string;
  text: string;
}

beforeEach(async () => {
  await resetDb();
  sendMock.mockReset();
  sendMock.mockResolvedValue({ data: { id: 'msg_test' }, error: null });
});

describe('POST /api/auth/sign-up/email', () => {
  describe('happy path', () => {
    it('returns 200 with the new user and a session token', async () => {
      const res = await request(app).post('/api/auth/sign-up/email').send({
        name: 'Test User',
        email: 'test@example.com',
        password: 'password1234',
      });

      expect(res.status).toBe(200);
      const body = res.body as SignUpResponse;
      expect(body.user.email).toBe('test@example.com');
      expect(body.user.name).toBe('Test User');
      expect(typeof body.user.id).toBe('string');
      expect(body.user.id.length).toBeGreaterThan(0);
      expect(typeof body.token).toBe('string');
      expect(body.token.length).toBeGreaterThan(0);
    });

    it('does not leak the password or its hash in the response body', async () => {
      const res = await request(app).post('/api/auth/sign-up/email').send({
        name: 'Leak Check',
        email: 'leak@example.com',
        password: 'password1234',
      });

      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain('password1234');
      expect(raw.toLowerCase()).not.toMatch(/"password"|"hash"|"passwordhash"/);
    });

    it('persists exactly one user row with the expected shape', async () => {
      await request(app).post('/api/auth/sign-up/email').send({
        name: 'Persisted',
        email: 'persisted@example.com',
        password: 'password1234',
      });

      const rows = await db.select().from(user).where(eq(user.email, 'persisted@example.com'));
      expect(rows).toHaveLength(1);
      const [row] = rows;
      if (!row) throw new Error('expected one user row');
      expect(row.name).toBe('Persisted');
      expect(row.emailVerified).toBe(false);
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(row.updatedAt).toBeInstanceOf(Date);
    });

    it('persists a credential account whose stored password is hashed, not plaintext', async () => {
      const PASSWORD = 'password1234';
      const res = await request(app).post('/api/auth/sign-up/email').send({
        name: 'Hashed',
        email: 'hashed@example.com',
        password: PASSWORD,
      });
      const userId = (res.body as SignUpResponse).user.id;

      const rows = await db.select().from(account).where(eq(account.userId, userId));
      expect(rows).toHaveLength(1);
      const [row] = rows;
      if (!row) throw new Error('expected one account row');
      expect(row.providerId).toBe('credential');

      const stored = row.password;
      expect(stored).toBeTruthy();
      expect(stored).not.toBe(PASSWORD);
      // Any reasonable password hash (bcrypt/scrypt/argon2) is well over 40 chars.
      expect((stored ?? '').length).toBeGreaterThan(40);
    });

    it('persists a session row tied to the new user with a future expiry', async () => {
      const res = await request(app).post('/api/auth/sign-up/email').send({
        name: 'Sess',
        email: 'sess@example.com',
        password: 'password1234',
      });
      const userId = (res.body as SignUpResponse).user.id;

      const rows = await db.select().from(session).where(eq(session.userId, userId));
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const [row] = rows;
      if (!row) throw new Error('expected at least one session row');
      expect(row.expiresAt).toBeInstanceOf(Date);
      expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('failure cases', () => {
    it('rejects a duplicate email and leaves only the first user in the DB', async () => {
      const payload = {
        name: 'Dupe',
        email: 'dupe@example.com',
        password: 'password1234',
      };

      const first = await request(app).post('/api/auth/sign-up/email').send(payload);
      expect(first.status).toBe(200);

      const second = await request(app).post('/api/auth/sign-up/email').send(payload);
      expect(second.status).toBeGreaterThanOrEqual(400);
      expect(second.status).toBeLessThan(500);

      const body = second.body as ErrorResponse;
      expect(body.code).toBeTruthy();
      expect(body.code).toMatch(/USER|EMAIL.*EXIST/i);

      const rows = await db.select().from(user).where(eq(user.email, 'dupe@example.com'));
      expect(rows).toHaveLength(1);
    });

    it('rejects sign-up missing the password field and writes nothing to the DB', async () => {
      const res = await request(app).post('/api/auth/sign-up/email').send({
        name: 'NoPass',
        email: 'nopass@example.com',
      });

      expect(res.status).toBe(400);
      const rows = await db.select().from(user).where(eq(user.email, 'nopass@example.com'));
      expect(rows).toHaveLength(0);
    });

    it('rejects passwords shorter than the better-auth minimum (8 chars)', async () => {
      const res = await request(app).post('/api/auth/sign-up/email').send({
        name: 'Short',
        email: 'short@example.com',
        password: 'short',
      });

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      const rows = await db.select().from(user).where(eq(user.email, 'short@example.com'));
      expect(rows).toHaveLength(0);
    });
  });
});

const SIGNED_UP = {
  name: 'Signed Up',
  email: 'signed-up@example.com',
  password: 'password1234',
};

async function signUp(): Promise<string[]> {
  const res = await request(app).post('/api/auth/sign-up/email').send(SIGNED_UP);
  if (res.status !== 200) throw new Error(`sign-up failed: ${String(res.status)}`);
  return extractCookies(res);
}

function extractCookies(res: request.Response): string[] {
  const raw = res.headers['set-cookie'];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function cookieHeader(cookies: string[]): string {
  return cookies.map((c) => c.split(';')[0]).join('; ');
}

describe('POST /api/auth/sign-in/email', () => {
  describe('happy path', () => {
    it('returns 200 with the user, a session token, and a session cookie', async () => {
      await signUp();

      const res = await request(app).post('/api/auth/sign-in/email').send({
        email: SIGNED_UP.email,
        password: SIGNED_UP.password,
      });

      expect(res.status).toBe(200);
      const body = res.body as SignUpResponse;
      expect(body.user.email).toBe(SIGNED_UP.email);
      expect(typeof body.token).toBe('string');
      expect(body.token.length).toBeGreaterThan(0);

      const cookies = extractCookies(res);
      expect(cookies.some((c) => c.includes('session'))).toBe(true);
    });

    it('persists a new session row tied to the user on each sign-in', async () => {
      await signUp();
      const userRows = await db.select().from(user).where(eq(user.email, SIGNED_UP.email));
      const userId = userRows[0]?.id;
      if (!userId) throw new Error('expected user row');

      const before = await db.select().from(session).where(eq(session.userId, userId));

      const res = await request(app).post('/api/auth/sign-in/email').send({
        email: SIGNED_UP.email,
        password: SIGNED_UP.password,
      });
      expect(res.status).toBe(200);

      const after = await db.select().from(session).where(eq(session.userId, userId));
      expect(after.length).toBe(before.length + 1);
    });
  });

  describe('failure cases', () => {
    it('rejects sign-in with the wrong password', async () => {
      await signUp();

      const res = await request(app).post('/api/auth/sign-in/email').send({
        email: SIGNED_UP.email,
        password: 'wrong-password-here',
      });

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('rejects sign-in for an email that has not signed up', async () => {
      const res = await request(app).post('/api/auth/sign-in/email').send({
        email: 'nobody@example.com',
        password: 'password1234',
      });

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(res.headers['set-cookie']).toBeUndefined();
    });
  });
});

interface SessionResponseBody {
  user: { id: string; email: string };
  session: { token: string; expiresAt: string };
}

describe('GET /api/auth/get-session', () => {
  it('returns the user and session for a request with a valid session cookie', async () => {
    const cookies = await signUp();

    const res = await request(app)
      .get('/api/auth/get-session')
      .set('Cookie', cookieHeader(cookies));

    expect(res.status).toBe(200);
    const body = res.body as SessionResponseBody;
    expect(body.user.email).toBe(SIGNED_UP.email);
    expect(typeof body.session.token).toBe('string');
    expect(new Date(body.session.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('returns 200 with a null body when no session cookie is sent', async () => {
    // better-auth's get-session endpoint returns 200/null for unauthenticated
    // requests; the 401 is enforced by the app-level auth middleware that
    // wraps it (added in Slice 7 for sync routes). This test pins the
    // framework-level behavior so the middleware test catches the 401 path.
    const res = await request(app).get('/api/auth/get-session');

    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it('returns 200 with a null body when the session cookie is invalid', async () => {
    const res = await request(app)
      .get('/api/auth/get-session')
      .set('Cookie', 'better-auth.session_token=not-a-real-token');

    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });
});

describe('POST /api/auth/sign-out', () => {
  it('clears the session and subsequent get-session returns null', async () => {
    const cookies = await signUp();

    const out = await request(app)
      .post('/api/auth/sign-out')
      .set('Cookie', cookieHeader(cookies));
    expect(out.status).toBe(200);

    // Reuse the original cookie — server-side the session row should be gone,
    // so re-presenting it must not authenticate.
    const after = await request(app)
      .get('/api/auth/get-session')
      .set('Cookie', cookieHeader(cookies));
    expect(after.status).toBe(200);
    expect(after.body).toBeNull();
  });

  it('deletes the session row from the database', async () => {
    const cookies = await signUp();
    const userRows = await db.select().from(user).where(eq(user.email, SIGNED_UP.email));
    const userId = userRows[0]?.id;
    if (!userId) throw new Error('expected user row');

    const before = await db.select().from(session).where(eq(session.userId, userId));
    expect(before.length).toBeGreaterThanOrEqual(1);

    await request(app).post('/api/auth/sign-out').set('Cookie', cookieHeader(cookies));

    const after = await db.select().from(session).where(eq(session.userId, userId));
    expect(after).toHaveLength(0);
  });

  it('is a no-op when called without a session (idempotent)', async () => {
    const res = await request(app).post('/api/auth/sign-out');
    expect(res.status).toBe(200);
  });
});

describe('POST /api/auth/request-password-reset', () => {
  it('sends a reset email containing the reset URL when the email is registered', async () => {
    await signUp();

    const res = await request(app)
      .post('/api/auth/request-password-reset')
      .send({ email: SIGNED_UP.email });

    expect(res.status).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);

    const args = sendMock.mock.calls[0]?.[0] as ResendSendArgs | undefined;
    if (!args) throw new Error('expected sendMock to be called with arguments');
    expect(args.to).toBe(SIGNED_UP.email);
    expect(args.subject).toBe('Reset your Crop Planner password');
    expect(args.text).toMatch(/\/reset-password\/[A-Za-z0-9_-]+/);
  });

  it('returns 200 without sending email for an unregistered address (no enumeration)', async () => {
    const res = await request(app)
      .post('/api/auth/request-password-reset')
      .send({ email: 'nobody@example.com' });

    expect(res.status).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/reset-password', () => {
  async function requestResetAndExtractToken(): Promise<string> {
    await signUp();
    sendMock.mockClear();

    const reqRes = await request(app)
      .post('/api/auth/request-password-reset')
      .send({ email: SIGNED_UP.email });
    expect(reqRes.status).toBe(200);

    const args = sendMock.mock.calls[0]?.[0] as ResendSendArgs | undefined;
    if (!args) throw new Error('expected sendMock to be called with arguments');
    const match = /\/reset-password\/([^?\s]+)/.exec(args.text);
    if (!match?.[1]) throw new Error(`reset token not found in email body: ${args.text}`);
    return match[1];
  }

  it('sets a new password and the user can sign in with it (and not with the old one)', async () => {
    const NEW_PASSWORD = 'newpass1234';
    const token = await requestResetAndExtractToken();

    const reset = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, newPassword: NEW_PASSWORD });
    expect(reset.status).toBe(200);

    const oldFails = await request(app).post('/api/auth/sign-in/email').send({
      email: SIGNED_UP.email,
      password: SIGNED_UP.password,
    });
    expect(oldFails.status).toBeGreaterThanOrEqual(400);
    expect(oldFails.status).toBeLessThan(500);

    const ok = await request(app).post('/api/auth/sign-in/email').send({
      email: SIGNED_UP.email,
      password: NEW_PASSWORD,
    });
    expect(ok.status).toBe(200);
  });

  it('rejects a reused token (already consumed by a successful reset)', async () => {
    const token = await requestResetAndExtractToken();

    const first = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'newpass1234' });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'evennewer1234' });
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(second.status).toBeLessThan(500);
    const body = second.body as ErrorResponse;
    expect(body.code).toMatch(/INVALID_TOKEN/i);
  });

  it('rejects an unknown token', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: 'this-token-does-not-exist', newPassword: 'newpass1234' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const body = res.body as ErrorResponse;
    expect(body.code).toMatch(/INVALID_TOKEN/i);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import request from 'supertest';
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

beforeEach(async () => {
  await resetDb();
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

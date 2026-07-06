import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('resend', () => ({
  Resend: vi.fn(() => ({
    emails: { send: vi.fn().mockResolvedValue({ data: { id: 'msg_test' }, error: null }) },
  })),
}));

// Same S3 wrapper mock as sync.test.ts: pure key logic stays real, the
// presign functions are spies returning deterministic URLs.
vi.mock('../../src/lib/s3', () => ({
  CONTENT_TYPE_EXT: {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
  },
  buildImageKeyPrefix: (userId: string): string => `note-images/${userId}/`,
  buildImageKey: (userId: string, uuid: string, ext: string): string =>
    `note-images/${userId}/${uuid}.${ext}`,
  createUploadUrl: vi.fn((key: string) => Promise.resolve(`https://s3.test/upload/${key}`)),
  createDownloadUrl: vi.fn((key: string) => Promise.resolve(`https://s3.test/download/${key}`)),
  deleteImageObject: vi.fn(() => Promise.resolve()),
}));

import app from '../../src/app';
import { db } from '../../src/db/connection';
import { subscriptions } from '../../src/db/schema';
import { createUploadUrl, createDownloadUrl } from '../../src/lib/s3';
import { resetDb } from '../helpers/db';

interface SignUpResponse {
  user: { id: string; email: string; name: string };
  token: string;
}

interface ErrorResponse {
  error: string;
}

async function signUp(email: string): Promise<{ userId: string; cookies: string[] }> {
  const res = await request(app)
    .post('/api/auth/sign-up/email')
    .send({ name: 'Image Test', email, password: 'password1234' });
  if (res.status !== 200) throw new Error(`sign-up failed: ${String(res.status)}`);
  const body = res.body as SignUpResponse;
  const raw = res.headers['set-cookie'];
  const cookies = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
  return { userId: body.user.id, cookies };
}

function cookieHeader(cookies: string[]): string {
  return cookies.map((cookie) => cookie.split(';')[0]).join('; ');
}

async function makeActiveSubscription(userId: string): Promise<void> {
  await db.insert(subscriptions).values({
    rcUserId: `rc_${userId}`,
    userId,
    status: 'active',
    productId: 'com.kevinnail.gardentracker.premium_yearly',
    expiresAt: new Date(Date.UTC(2099, 0, 1)),
  });
}

async function subscribedCaller(email: string): Promise<{ userId: string; cookies: string[] }> {
  const { userId, cookies } = await signUp(email);
  await makeActiveSubscription(userId);
  return { userId, cookies };
}

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
});

describe('POST /sync/image/upload-url', () => {
  it('returns 401 when no session cookie is present', async () => {
    const res = await request(app)
      .post('/sync/image/upload-url')
      .send({ uuid: 'img-1', content_type: 'image/jpeg' });

    expect(res.status).toBe(401);
    expect((res.body as ErrorResponse).error).toBe('Unauthorized');
  });

  it('returns 403 when authenticated but with no active subscription', async () => {
    const { cookies } = await signUp('upload-no-sub@example.com');

    const res = await request(app)
      .post('/sync/image/upload-url')
      .set('Cookie', cookieHeader(cookies))
      .send({ uuid: 'img-1', content_type: 'image/jpeg' });

    expect(res.status).toBe(403);
    expect((res.body as ErrorResponse).error).toBe('Subscription required');
  });

  it('returns 400 when `uuid` is missing', async () => {
    const { cookies } = await subscribedCaller('upload-no-uuid@example.com');

    const res = await request(app)
      .post('/sync/image/upload-url')
      .set('Cookie', cookieHeader(cookies))
      .send({ content_type: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect((res.body as ErrorResponse).error).toBe('Expected non-empty `uuid`');
  });

  it('returns 400 when `content_type` is not an allowed image type', async () => {
    const { cookies } = await subscribedCaller('upload-bad-type@example.com');

    const res = await request(app)
      .post('/sync/image/upload-url')
      .set('Cookie', cookieHeader(cookies))
      .send({ uuid: 'img-1', content_type: 'application/pdf' });

    expect(res.status).toBe(400);
    expect((res.body as ErrorResponse).error).toBe('Unsupported `content_type`');
  });

  it('returns the user-scoped key + presigned upload URL for a valid request', async () => {
    const { userId, cookies } = await subscribedCaller('upload-ok@example.com');

    const res = await request(app)
      .post('/sync/image/upload-url')
      .set('Cookie', cookieHeader(cookies))
      .send({ uuid: 'img-1', content_type: 'image/jpeg' });

    expect(res.status).toBe(200);
    const body = res.body as { upload_url: string; s3_key: string };
    const expectedKey = `note-images/${userId}/img-1.jpg`;
    expect(body.s3_key).toBe(expectedKey);
    expect(body.upload_url).toBe(`https://s3.test/upload/${expectedKey}`);
    expect(vi.mocked(createUploadUrl)).toHaveBeenCalledWith(expectedKey, 'image/jpeg');
  });
});

describe('POST /sync/image/download-url', () => {
  it('returns 401 when no session cookie is present', async () => {
    const res = await request(app)
      .post('/sync/image/download-url')
      .send({ s3_key: 'note-images/someone/img-1.jpg' });

    expect(res.status).toBe(401);
    expect((res.body as ErrorResponse).error).toBe('Unauthorized');
  });

  it('returns 403 when authenticated but with no active subscription', async () => {
    const { userId, cookies } = await signUp('download-no-sub@example.com');

    const res = await request(app)
      .post('/sync/image/download-url')
      .set('Cookie', cookieHeader(cookies))
      .send({ s3_key: `note-images/${userId}/img-1.jpg` });

    expect(res.status).toBe(403);
    expect((res.body as ErrorResponse).error).toBe('Subscription required');
  });

  it('returns 403 (IDOR gate) when the key is under another user prefix', async () => {
    const { cookies } = await subscribedCaller('download-idor@example.com');

    const res = await request(app)
      .post('/sync/image/download-url')
      .set('Cookie', cookieHeader(cookies))
      .send({ s3_key: 'note-images/some-other-user/img-1.jpg' });

    expect(res.status).toBe(403);
    expect((res.body as ErrorResponse).error).toBe('Forbidden');
    expect(vi.mocked(createDownloadUrl)).not.toHaveBeenCalled();
  });

  it('returns a presigned download URL for a key the caller owns', async () => {
    const { userId, cookies } = await subscribedCaller('download-ok@example.com');
    const ownedKey = `note-images/${userId}/img-1.jpg`;

    const res = await request(app)
      .post('/sync/image/download-url')
      .set('Cookie', cookieHeader(cookies))
      .send({ s3_key: ownedKey });

    expect(res.status).toBe(200);
    const body = res.body as { download_url: string };
    expect(body.download_url).toBe(`https://s3.test/download/${ownedKey}`);
    expect(vi.mocked(createDownloadUrl)).toHaveBeenCalledWith(ownedKey);
  });
});

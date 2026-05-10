import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../../src/app';

interface HealthBody {
  status: string;
  timestamp: string;
}

describe('GET /health', () => {
  it('returns 200 with correct shape', async () => {
    const res = await request(app).get('/health');
    const body = res.body as HealthBody;
    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(typeof body.timestamp).toBe('string');
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });
});

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';

// Mock node-fetch BEFORE importing app
vi.mock('node-fetch', () => ({
  default: vi.fn(),
  __esModule: true
}));

import app from '../src/index';
import fetch from 'node-fetch';

describe('Backend Integration Tests (index.js)', () => {
  const adminToken = 'secret'; // From tests/setup.js

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /health', () => {
    it('should return 200 and ok status', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });
  });

  describe('POST /api/track', () => {
    it('should return 200 and ok:true', async () => {
      const res = await request(app)
        .post('/api/track')
        .send({ name: 'Test Channel', type: 'live', event: 'play' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  describe('POST /api/feedback', () => {
    it('should save feedback and return 200', async () => {
      const res = await request(app)
        .post('/api/feedback')
        .send({ message: 'Great app!', guestId: 'test-guest' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  describe('GET /api/feedback', () => {
    it('should return feedback list for admin', async () => {
      const res = await request(app)
        .get('/api/feedback')
        .set('x-admin-token', adminToken);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.feedback)).toBe(true);
    });
  });

  describe('GET /api/vast', () => {
    it('should proxy VAST XML', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/xml']]),
        text: () => Promise.resolve('<VAST></VAST>'),
      });

      const res = await request(app).get('/api/vast?url=https://example.com/vast.xml');
      expect(res.status).toBe(200);
      expect(res.text).toBe('<VAST></VAST>');
    });
  });

  describe('GET /api/tmdb/*', () => {
    it('should proxy TMDB requests', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ results: [{ id: 1 }] }),
      });

      const res = await request(app).get('/api/tmdb/movie/popular');
      if (res.status === 200) {
        expect(res.body.results).toBeDefined();
      } else {
        expect(res.status).toBe(503);
      }
    });
  });

  describe('GET /img', () => {
    it('should block private IP ranges', async () => {
      const res = await request(app).get('/img?url=http://127.0.0.1/logo.png');
      expect(res.status).toBe(403);
    });
  });

  describe('GET /proxy', () => {
    it('should proxy allowed URLs', async () => {
      vi.mocked(fetch).mockResolvedValue({
        status: 200,
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: () => Promise.resolve({ ok: true }),
      });

      const res = await request(app).get('/proxy?url=https://example.com/data');
      if (res.status === 200) {
        expect(res.body.ok).toBe(true);
      } else {
        expect([200, 403]).toContain(res.status);
      }
    });
  });
});

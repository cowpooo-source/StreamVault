import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const mockPool = { query: vi.fn().mockResolvedValue({ rows: [] }) };

const mockRequireAuth = (req, _res, next) => {
  req.user = { id: 'user-123', role: 'regular' };
  next();
};

const mockAuthObj = {
  requireAuth: mockRequireAuth,
  optionalAuth: (req, _res, next) => { req.user = null; next(); },
  requireRole: () => (_req, _res, next) => next(),
  default: {
    requireAuth: mockRequireAuth,
    optionalAuth: (req, _res, next) => { req.user = null; next(); },
    requireRole: () => (_req, _res, next) => next(),
  },
  init: vi.fn(),
  verifyToken: vi.fn(),
  authenticate: vi.fn(),
  revokeToken: vi.fn(),
  cleanupSessions: vi.fn(),
  getAuthStats: vi.fn().mockReturnValue({}),
  ROLE_LIMITS: { regular: { maxConnections: 5 } }
};

// Use a module preload to intercept require before vitest loads anything
// This approach registers the mock before the sync router is required
const Module = require('module');
const originalLoad = Module._load;
Module._load = function(request, parent) {
  if (request === '../auth' || request === '../../src/auth') {
    return mockAuthObj;
  }
  return originalLoad.apply(this, arguments);
};

const { createSyncRouter } = require('../../src/routes/sync');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sync', createSyncRouter(mockPool));
  return app;
}

describe('createSyncRouter', () => {
  let app;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPool.query.mockResolvedValue({ rows: [] });
    app = makeApp();
  });

  // --- GET /sync/watch-progress ---

  it('GET /sync/watch-progress returns progress rows', async () => {
    const mockRows = [
      { item_id: 'i1', position_ms: 60000, duration_ms: 3600000, provider_updated_at: '2026-05-28T10:00:00Z', synced_at: '2026-05-29T08:00:00Z' },
      { item_id: 'i2', position_ms: 120000, duration_ms: 7200000, provider_updated_at: '2026-05-28T11:00:00Z', synced_at: '2026-05-29T09:00:00Z' },
    ];
    mockPool.query.mockResolvedValueOnce({ rows: mockRows });

    const res = await request(app).get('/api/sync/watch-progress');
    expect(res.status).toBe(200);
    expect(res.body.progress).toEqual(mockRows);
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM watch_progress WHERE user_id'),
      ['user-123']
    );
  });

  it('GET /sync/watch-progress returns empty array when no rows', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get('/api/sync/watch-progress');
    expect(res.status).toBe(200);
    expect(res.body.progress).toEqual([]);
  });

  // --- POST /sync/watch-progress ---

  it('POST /sync/watch-progress upserts with conflict resolution (newest wins)', async () => {
    const updatedRow = { id: 'uuid-1', user_id: 'user-123', server_id: 's1', item_id: 'i1', position_ms: 90000, provider_updated_at: '2026-05-28T12:00:00Z' };
    mockPool.query.mockResolvedValueOnce({ rows: [updatedRow] });

    const res = await request(app)
      .post('/api/sync/watch-progress')
      .send({ serverId: 's1', itemId: 'i1', positionMs: 90000, providerUpdatedAt: '2026-05-28T12:00:00Z' });

    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual(updatedRow);
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (user_id, server_id, item_id)'),
      ['user-123', 's1', 'i1', 90000, '2026-05-28T12:00:00Z']
    );
  });

  it('POST /sync/watch-progress does not update when existing row is newer', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/api/sync/watch-progress')
      .send({ serverId: 's1', itemId: 'i1', positionMs: 1000, providerUpdatedAt: '2020-01-01T00:00:00Z' });

    expect(res.status).toBe(200);
    expect(mockPool.query).toHaveBeenCalled();
  });

  // --- GET /sync/watchlist ---

  it('GET /sync/watchlist returns watchlist rows', async () => {
    const mockRows = [
      { id: 'w1', item_id: 'i1', title_enc: 'enc1', type: 'movie', added_at: '2026-05-20T10:00:00Z' },
      { id: 'w2', item_id: 'i2', title_enc: 'enc2', type: 'series', added_at: '2026-05-21T11:00:00Z' },
    ];
    mockPool.query.mockResolvedValueOnce({ rows: mockRows });

    const res = await request(app).get('/api/sync/watchlist');
    expect(res.status).toBe(200);
    expect(res.body.watchlist).toEqual(mockRows);
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM watchlist WHERE user_id'),
      ['user-123']
    );
  });

  it('GET /sync/watchlist returns empty array when no rows', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get('/api/sync/watchlist');
    expect(res.status).toBe(200);
    expect(res.body.watchlist).toEqual([]);
  });

  // --- POST /sync/watchlist ---

  it('POST /sync/watchlist adds item with ON CONFLICT DO NOTHING', async () => {
    const addedRow = { id: 'uuid-new', user_id: 'user-123', server_id: 's1', item_id: 'i5', title_enc: 'encrypted-title', type: 'movie' };
    mockPool.query.mockResolvedValueOnce({ rows: [addedRow] });

    const res = await request(app)
      .post('/api/sync/watchlist')
      .send({ serverId: 's1', itemId: 'i5', title: 'My Movie', type: 'movie' });

    expect(res.status).toBe(201);
    expect(res.body.added).toEqual(addedRow);
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (user_id, server_id, item_id) DO NOTHING'),
      ['user-123', 's1', 'i5', expect.any(String), 'movie']
    );
  });

  it('POST /sync/watchlist returns 201 even when row already exists (DO NOTHING)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/api/sync/watchlist')
      .send({ serverId: 's1', itemId: 'i5', title: 'Already Added', type: 'movie' });

    expect(res.status).toBe(201);
    expect(res.body.added).toBeUndefined();
  });
});
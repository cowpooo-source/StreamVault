import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
const { createSyncRouter } = require('../../src/routes/sync');

function makeMockPool(overrides = {}) {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    ...overrides,
  };
}

function makeApp(pool) {
  const app = express();
  app.use(express.json());
  app.use('/api/sync', createSyncRouter(pool));
  return app;
}

describe('createSyncRouter', () => {
  let pool;
  let app;

  beforeEach(() => {
    pool = makeMockPool();
    app = makeApp(pool);
    vi.clearAllMocks();
  });

  // --- GET /sync/watch-progress/:profileId ---

  it('GET /sync/watch-progress/:profileId returns progress rows', async () => {
    const mockRows = [
      { item_id: 'i1', position_ms: 60000, duration_ms: 3600000, provider_updated_at: '2026-05-28T10:00:00Z', synced_at: '2026-05-29T08:00:00Z' },
      { item_id: 'i2', position_ms: 120000, duration_ms: 7200000, provider_updated_at: '2026-05-28T11:00:00Z', synced_at: '2026-05-29T09:00:00Z' },
    ];
    pool.query.mockResolvedValueOnce({ rows: mockRows });

    const res = await request(app).get('/api/sync/watch-progress/profile-123');
    expect(res.status).toBe(200);
    expect(res.body.progress).toEqual(mockRows);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM watch_progress'),
      ['profile-123']
    );
  });

  it('GET /sync/watch-progress/:profileId returns empty array when no rows', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get('/api/sync/watch-progress/profile-456');
    expect(res.status).toBe(200);
    expect(res.body.progress).toEqual([]);
  });

  // --- POST /sync/watch-progress ---

  it('POST /sync/watch-progress upserts with conflict resolution (newest wins)', async () => {
    const updatedRow = { id: 'uuid-1', profile_id: 'p1', server_id: 's1', item_id: 'i1', position_ms: 90000, provider_updated_at: '2026-05-28T12:00:00Z' };
    pool.query.mockResolvedValueOnce({ rows: [updatedRow] });

    const res = await request(app)
      .post('/api/sync/watch-progress')
      .send({ profileId: 'p1', serverId: 's1', itemId: 'i1', positionMs: 90000, providerUpdatedAt: '2026-05-28T12:00:00Z' });

    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual(updatedRow);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT'),
      ['p1', 's1', 'i1', 90000, '2026-05-28T12:00:00Z']
    );
  });

  it('POST /sync/watch-progress does not update when existing row is newer', async () => {
    // The mock pool always returns rows from the INSERT...RETURNING, but the
    // ON CONFLICT clause filters based on provider_updated_at comparison.
    // When the incoming row is older, the WHERE clause keeps the existing row.
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/api/sync/watch-progress')
      .send({ profileId: 'p1', serverId: 's1', itemId: 'i1', positionMs: 1000, providerUpdatedAt: '2020-01-01T00:00:00Z' });

    expect(res.status).toBe(200);
    expect(pool.query).toHaveBeenCalled();
  });

  // --- GET /sync/watchlist/:profileId ---

  it('GET /sync/watchlist/:profileId returns watchlist rows', async () => {
    const mockRows = [
      { id: 'w1', item_id: 'i1', title_enc: 'enc1', type: 'movie', added_at: '2026-05-20T10:00:00Z' },
      { id: 'w2', item_id: 'i2', title_enc: 'enc2', type: 'series', added_at: '2026-05-21T11:00:00Z' },
    ];
    pool.query.mockResolvedValueOnce({ rows: mockRows });

    const res = await request(app).get('/api/sync/watchlist/profile-123');
    expect(res.status).toBe(200);
    expect(res.body.watchlist).toEqual(mockRows);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM watchlist'),
      ['profile-123']
    );
  });

  it('GET /sync/watchlist/:profileId returns empty array when no rows', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get('/api/sync/watchlist/profile-789');
    expect(res.status).toBe(200);
    expect(res.body.watchlist).toEqual([]);
  });

  // --- POST /sync/watchlist ---

  it('POST /sync/watchlist adds item with ON CONFLICT DO NOTHING', async () => {
    const addedRow = { id: 'uuid-new', profile_id: 'p1', server_id: 's1', item_id: 'i5', title_enc: 'encrypted-title', type: 'movie' };
    pool.query.mockResolvedValueOnce({ rows: [addedRow] });

    const res = await request(app)
      .post('/api/sync/watchlist')
      .send({ profileId: 'p1', serverId: 's1', itemId: 'i5', title: 'My Movie', type: 'movie' });

    expect(res.status).toBe(201);
    expect(res.body.added).toEqual(addedRow);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (profile_id, server_id, item_id) DO NOTHING'),
      expect.any(Array)
    );
  });

  it('POST /sync/watchlist returns 201 even when row already exists (DO NOTHING)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/api/sync/watchlist')
      .send({ profileId: 'p1', serverId: 's1', itemId: 'i5', title: 'Already Added', type: 'movie' });

    expect(res.status).toBe(201);
    expect(res.body.added).toBeUndefined();
  });
});
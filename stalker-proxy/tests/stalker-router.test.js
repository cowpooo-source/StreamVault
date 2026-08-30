import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { Readable } from 'stream';
import crypto from 'node:crypto';
import { createStalkerRouter } from '../src/routes/stalker';
import { encryptToken } from '../src/middleware/encrypt';

function makeDeps(overrides = {}) {
  return {
    cache: {
      get: vi.fn(),
      set: vi.fn(),
      trackWatch: vi.fn(),
      trackCacheHit: vi.fn(),
      trackCacheMiss: vi.fn(),
      cacheKey: vi.fn((portal, mac, endpoint, extra) => `${portal}|${mac}|${endpoint}|${extra || ''}`),
      trackPortalHealth: vi.fn(),
      trackRequest: vi.fn(),
    },
    auth: { verifyToken: vi.fn().mockReturnValue({ id: 1, username: 'testuser', role: 'regular' }) },
    fetch: vi.fn(),
    fetchWithRedirectCheck: vi.fn(),
    isUrlAllowed: vi.fn(() => true),
    getSession: vi.fn(),
    portalFetchRetry: vi.fn(),
    safeError: vi.fn((e) => e?.message || 'error'),
    buildStalkerStreamHeaders: vi.fn(),
    summarizeUpstreamHeaders: vi.fn(),
    ...overrides,
  };
}

function makeApp(deps) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  // Inject a test authentication cookie so every request passes the auth check.
  // The verifyToken mock ignores the token value and returns a fixed user.
  app.use((req, res, next) => {
    if (!req.cookies) req.cookies = {};
    req.cookies.sv_auth = req.cookies.sv_auth || 'test-auth-token';
    next();
  });
  app.use('/stalker', createStalkerRouter(deps));
  return app;
}

function makeGuestApp(deps) {
  const app = express();
  app.use(express.json());
  app.use('/stalker', createStalkerRouter(deps));
  return app;
}

function cacheBackedBy(records) {
  return {
    get: key => records.get(key),
    set: (key, value) => records.set(key, value),
    del: key => records.delete(key),
    keysByPrefix: prefix => [...records.keys()].filter(key => key.startsWith(prefix)),
    deleteKeysByPrefix: vi.fn(prefix => {
      for (const key of [...records.keys()]) if (key.startsWith(prefix)) records.delete(key);
    }),
    trackWatch: vi.fn(),
    trackCacheHit: vi.fn(),
    trackCacheMiss: vi.fn(),
    trackPortalHealth: vi.fn(),
    trackRequest: vi.fn(),
    cacheKey: vi.fn((portal, mac, endpoint, extra = '') => `${portal}|${mac}|${endpoint}|${extra}`),
  };
}

function stalkerSession() {
  return { portal: 'http://p.com/c', mac: '00:1A:79:AA:BB:CC', headers: {}, refresh: vi.fn() };
}

function streamCatalog(items) {
  return vi.fn(async (_session, _limit, _timeout, { onItem } = {}) => {
    for (const item of items) await onItem?.(item);
    return items;
  });
}

function relayGrant(cmd = 'ABC') {
  const expires = Date.now() + 60_000;
  const commandHash = crypto.createHash('sha256').update(cmd).digest('hex');
  const signature = crypto.createHmac('sha256', process.env.STALKER_RELAY_GRANT_SECRET)
    .update(`1:${expires}:${commandHash}`)
    .digest('base64url');
  return `${expires}.${signature}`;
}

describe('createStalkerRouter - unit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STALKER_PLAYBACK_MODE = 'relay_allowed';
    process.env.STALKER_MEDIA_RELAY_ENABLED = 'true';
    process.env.STALKER_RELAY_GRANT_SECRET = 'test-relay-secret';
    process.env.STALKER_VALIDATE_MAX_PER_MINUTE = '10';
    process.env.TOKEN_MASTER_KEY = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
  });

  // --- handshake ---

  it('POST /stalker/handshake returns token on success', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 'new-token', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
    });
    const app = makeApp(deps);
    const res = await request(app).post('/stalker/handshake').send({ portal: 'http://p.com/c/', mac: '00:1a:79:aa:bb:cc' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBe('new-token');
  });

  it('POST /stalker/handshake returns 400 when portal missing', async () => {
    const deps = makeDeps();
    const app = makeApp(deps);
    const res = await request(app).post('/stalker/handshake').send({ mac: '00:1a:79:aa:bb:cc' });
    expect(res.status).toBe(400);
  });

  it('POST /stalker/handshake returns 400 when mac missing', async () => {
    const deps = makeDeps();
    const app = makeApp(deps);
    const res = await request(app).post('/stalker/handshake').send({ portal: 'http://p.com/c/' });
    expect(res.status).toBe(400);
  });

  it('POST /stalker/handshake returns 403 when getSession throws auth error', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockRejectedValue(new Error('Portal auth failed')),
    });
    const app = makeApp(deps);
    const res = await request(app).post('/stalker/handshake').send({ portal: 'http://p.com/c/', mac: '00:1a:79:aa:bb:cc' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Portal auth failed');
    expect(res.body.code).toBe('authorization_failure');
  });

  // --- validate ---

  it('POST /stalker/validate returns full result shape when active', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 'tok', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn()
        .mockResolvedValueOnce({ js: { serial_number: 'SN1', device_id: 'D1' } })
        .mockResolvedValueOnce({ js: { status: 0, expire_billing_date: '2030-12-31', tariff: 'Premium', phone: '555-1234', max_connections: 5, id: 'uid1' } }),
    });
    const app = makeApp(deps);
    const res = await request(app).post('/stalker/validate').send({ portal: 'http://p.com/c/', mac: '00:1a:79:aa:bb:cc', serial: 'SN1', deviceId: 'D1', deviceId2: 'D2' });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.status).toBe('active');
    expect(res.body.statusCode).toBe(0);
    expect(res.body.expiry).toBe('2030-12-31');
    expect(res.body.daysLeft).toBeGreaterThan(0);
    expect(res.body.serial).toBe('SN1');
    expect(res.body.deviceId).toBe('D1');
    expect(res.body.deviceId2).toBe('D2');
    expect(res.body.tariff).toBe('Premium');
    expect(res.body.phone).toBe('555-1234');
    expect(res.body.maxConnections).toBe(5);
    expect(res.body.portalReachable).toBe(true);
    expect(res.body.latency).toBeGreaterThanOrEqual(0);
    expect(res.body.token).toBeUndefined();
  });

  it('POST /stalker/validate allows a guest with a valid guest id', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 'provider-token', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn()
        .mockResolvedValueOnce({ js: { serial_number: 'SN1', device_id: 'D1' } })
        .mockResolvedValueOnce({ js: { status: 0, expire_billing_date: '2030-12-31', id: 'uid1' } }),
    });
    const app = makeGuestApp(deps);
    const res = await request(app)
      .post('/stalker/validate')
      .set('X-Guest-Id', '841f8a36-fb33-4e1b-bb0d-e57f9346d34a')
      .send({ portal: 'http://p.com/c/', mac: '00:1a:79:aa:bb:cc' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.token).toBeUndefined();
  });

  it('POST /stalker/validate accepts a bounded legacy guest id', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockImplementation((_session, params) => {
        if (params.action === 'get_profile') return Promise.resolve({ js: { mac: '00:1a:79:aa:bb:cc' } });
        if (params.action === 'get_main_info') return Promise.resolve({ js: { status: 'active', end_date: '2099-01-01' } });
        return Promise.resolve({ js: [] });
      }),
    });
    const app = makeApp(deps);
    const res = await request(app)
      .post('/stalker/validate')
      .set('X-Guest-Id', 'pfx934phakpmn3iafdr')
      .send({ portal: 'http://p.com/c/', mac: '00:1a:79:aa:bb:cc' });
    expect(res.status).not.toBe(401);
  });

  it('POST /stalker/validate rejects missing or malformed guest identity', async () => {
    const deps = makeDeps();
    const app = makeGuestApp(deps);

    const missing = await request(app)
      .post('/stalker/validate')
      .send({ portal: 'http://p.com/c/', mac: '00:1a:79:aa:bb:cc' });
    const malformed = await request(app)
      .post('/stalker/validate')
      .set('X-Guest-Id', 'not-a-guest-id')
      .send({ portal: 'http://p.com/c/', mac: '00:1a:79:aa:bb:cc' });

    expect(missing.status).toBe(401);
    expect(malformed.status).toBe(401);
    expect(deps.getSession).not.toHaveBeenCalled();
  });

  it('keeps guest access to catalog routes protected by a content session', async () => {
    const deps = makeDeps();
    const app = makeGuestApp(deps);
    const res = await request(app)
      .get('/stalker/channels?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc')
      .set('X-Guest-Id', '841f8a36-fb33-4e1b-bb0d-e57f9346d34a');

    expect(res.status).toBe(401);
    expect(deps.getSession).not.toHaveBeenCalled();
  });

  it('rate limits repeated guest validation requests', async () => {
    process.env.STALKER_VALIDATE_MAX_PER_MINUTE = '1';
    const deps = makeDeps({
      getSession: vi.fn().mockRejectedValue(new Error('Portal unreachable')),
    });
    const app = makeGuestApp(deps);
    const body = { portal: 'http://p.com/c/', mac: '00:1a:79:aa:bb:cc' };
    const guestId = '841f8a36-fb33-4e1b-bb0d-e57f9346d34a';

    const first = await request(app).post('/stalker/validate').set('X-Guest-Id', guestId).send(body);
    const second = await request(app).post('/stalker/validate').set('X-Guest-Id', guestId).send(body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });

  it('POST /stalker/validate returns valid=false on upstream session failure', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockRejectedValue(new Error('Portal unreachable')),
      safeError: vi.fn((e) => e.message),
    });
    const app = makeApp(deps);
    const res = await request(app).post('/stalker/validate').send({ portal: 'http://p.com/c/', mac: '00:1a:79:aa:bb:cc' });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.portalReachable).toBe(false);
    expect(res.body.error).toBe('Portal unreachable');
  });

  it('POST /stalker/validate parses MM/DD/YYYY expiry date format', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 'tok', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn()
        .mockResolvedValueOnce({ js: {} })
        .mockResolvedValueOnce({ js: { status: 0, expire_billing_date: '12/31/2030' } }),
    });
    const app = makeApp(deps);
    const res = await request(app).post('/stalker/validate').send({ portal: 'http://p.com/c/', mac: '00:1a:79:aa:bb:cc' });
    expect(res.status).toBe(200);
    expect(res.body.expiry).toBe('2030-12-31');
  });

  it('POST /stalker/validate sets status=unregistered when no valid user ID found', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 'tok', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn()
        .mockResolvedValueOnce({ js: {} })
        .mockResolvedValueOnce({ js: { status: 0, expire_billing_date: '2030-12-31' } }), // no id/login/user_id/etc
    });
    const app = makeApp(deps);
    const res = await request(app).post('/stalker/validate').send({ portal: 'http://p.com/c/', mac: '00:1a:79:aa:bb:cc' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('unregistered');
    expect(res.body.valid).toBe(false);
    expect(res.body.error).toContain('No valid user ID');
  });

  it('POST /stalker/validate handles status values 1-4', async () => {
    for (const [statusVal, expectedStatus] of [
      [1, 'unregistered'],
      [2, 'suspended'],
      [3, 'expired'],
      [4, 'blocked'],
    ]) {
      const deps = makeDeps({
        getSession: vi.fn().mockResolvedValue({ token: 'tok', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
        portalFetchRetry: vi.fn()
          .mockResolvedValueOnce({ js: {} })
          .mockResolvedValueOnce({ js: { status: statusVal } }),
      });
      const app = makeApp(deps);
      const res = await request(app).post('/stalker/validate').send({ portal: 'http://p.com/c/', mac: '00:1a:79:aa:bb:cc' });
      expect(res.body.status).toBe(expectedStatus);
    }
  });

  // --- channels ---

  it('GET /stalker/channels parses channel list with genre mapping', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn()
        .mockResolvedValueOnce({ js: [{ id: 'g1', title: 'Entertainment' }, { id: 'g2', title: 'Sports' }] })
        .mockResolvedValueOnce({
          js: {
            data: [
              { id: 'ch1', name: 'HBO', number: 10, logo: 'http://cdn/hbo.png', tv_genre_id: 'g1', cmd: 'http://stream.com/hbo' },
              { id: 'ch2', name: 'ESPN', number: 20, icon: 'http://cdn/espn.png', tv_genre_id: 'g2', cmd: 'http://stream.com/espn' },
              { id: 'ch3', name: 'Unknown', number: 30, tv_genre_id: 'g99', cmd: null },
            ]
          }
        }),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/channels?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc');
    expect(res.status).toBe(200);
    expect(res.body.channels).toHaveLength(3);
    expect(res.body.channels[0]).toMatchObject({ id: 'ch1', name: 'HBO', num: 10, logo: 'http://cdn/hbo.png', group: 'Entertainment', type: 'live' });
    expect(res.body.channels[1]).toMatchObject({ id: 'ch2', name: 'ESPN', num: 20, logo: 'http://cdn/espn.png', group: 'Sports' });
    expect(res.body.channels[2]).toMatchObject({ id: 'ch3', name: 'Unknown', num: 30, group: 'Other', url: null });
    expect(res.body.total).toBe(3);
    expect(deps.cache.set).toHaveBeenCalled();
  });

  it('GET /stalker/channels falls back to paginated channel metadata when the full catalog exceeds the byte limit', async () => {
    const portalFetchRetry = vi.fn().mockImplementation((_session, params) => {
      if (params.action === 'get_genres') return Promise.resolve({ js: [{ id: 'g1', title: 'News' }] });
      if (params.action === 'get_all_channels') return Promise.reject(new Error('Portal metadata response exceeds 52428800 bytes'));
      if (params.action === 'get_ichannels_via_api' && params.page === 1) return Promise.resolve({
        js: {
          data: [
            { id: 'ch1', name: 'One', number: 1, tv_genre_id: 'g1', cmd: 'http://stream.example/1' },
            { id: 'ch2', name: 'Two', number: 2, tv_genre_id: 'g1', cmd: 'http://stream.example/2' },
          ],
          total_pages: 2,
        },
      });
      if (params.action === 'get_ichannels_via_api' && params.page === 2) return Promise.resolve({
        js: {
          data: [{ id: 'ch3', name: 'Three', number: 3, tv_genre_id: 'g1', cmd: 'http://stream.example/3' }],
          total_pages: 2,
        },
      });
      return Promise.reject(new Error('Unexpected portal call'));
    });
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry,
    });

    const res = await request(makeApp(deps)).get('/stalker/channels?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc');

    expect(res.status).toBe(200);
    expect(res.body.channels.map(channel => channel.id)).toEqual(['ch1', 'ch2', 'ch3']);
    expect(portalFetchRetry).toHaveBeenCalledWith(expect.any(Object), {
      type: 'itv', action: 'get_ichannels_via_api', page: 2, p: 2,
    }, undefined, expect.objectContaining({ signal: expect.anything() }));
  });

  it('GET /stalker/channels uses paginated get_all_channels when the provider supports it', async () => {
    const portalFetchRetry = vi.fn().mockImplementation((_session, params) => {
      if (params.action === 'get_genres') return Promise.resolve({ js: [] });
      if (params.action === 'get_all_channels' && !params.page) {
        return Promise.reject(new Error('Portal metadata response exceeds 52428800 bytes'));
      }
      if (params.action === 'get_all_channels' && params.page === 1) {
        return Promise.resolve({ js: { data: [{ id: 'ch1', name: 'One', cmd: 'http://stream.example/1' }], total_pages: 2 } });
      }
      if (params.action === 'get_all_channels' && params.page === 2) {
        return Promise.resolve({ js: { data: [{ id: 'ch2', name: 'Two', cmd: 'http://stream.example/2' }], total_pages: 2 } });
      }
      return Promise.reject(new Error('Fallback action should not be used'));
    });
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry,
    });

    const res = await request(makeApp(deps)).get('/stalker/channels?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc');

    expect(res.status).toBe(200);
    expect(res.body.channels.map(channel => channel.id)).toEqual(['ch1', 'ch2']);
    expect(portalFetchRetry.mock.calls.some(([, params]) => params.action === 'get_ichannels_via_api')).toBe(false);
  });

  it('GET /stalker/channels uses the streaming catalog before paginated fallbacks', async () => {
    const portalFetchRetry = vi.fn().mockImplementation((_session, params) => {
      if (params.action === 'get_genres') return Promise.resolve({ js: [] });
      if (params.action === 'get_all_channels' && !params.page) {
        return Promise.reject(new Error('Portal metadata response exceeds 52428800 bytes'));
      }
      return Promise.reject(new Error('Paginated fallback should not be used'));
    });
    const portalFetchChannelCatalog = vi.fn().mockResolvedValue([
      { id: 'ch1', name: 'One', cmd: 'http://stream.example/1' },
      { id: 'ch2', name: 'Two', cmd: 'http://stream.example/2' },
    ]);
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry,
      portalFetchChannelCatalog,
    });

    const res = await request(makeApp(deps)).get('/stalker/channels?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc');

    expect(res.status).toBe(200);
    expect(res.body.channels.map(channel => channel.id)).toEqual(['ch1', 'ch2']);
    expect(portalFetchChannelCatalog).toHaveBeenCalledWith(
      expect.any(Object),
      50000,
      undefined,
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(portalFetchRetry).toHaveBeenCalledTimes(1);
  });

  it('GET /stalker/channels bounds the streaming catalog', async () => {
    const previousLimit = process.env.STALKER_CHANNELS_MAX_ITEMS;
    process.env.STALKER_CHANNELS_MAX_ITEMS = '100';
    const portalFetchChannelCatalog = vi.fn().mockResolvedValue(
      Array.from({ length: 250 }, (_, index) => ({ id: `ch${index + 1}`, name: `Channel ${index + 1}` })),
    );
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchChannelCatalog,
    });

    try {
      const res = await request(makeApp(deps)).get('/stalker/channels?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc');
      expect(res.status).toBe(200);
      expect(res.body.channels).toHaveLength(100);
      expect(portalFetchChannelCatalog).toHaveBeenCalledWith(
        expect.any(Object),
        100,
        undefined,
        expect.objectContaining({ signal: expect.anything() }),
      );
    } finally {
      if (previousLimit === undefined) delete process.env.STALKER_CHANNELS_MAX_ITEMS;
      else process.env.STALKER_CHANNELS_MAX_ITEMS = previousLimit;
    }
  });

  it('GET /stalker/channels returns all paginated fallback results within the page cap', async () => {
    const previousLimit = process.env.STALKER_CHANNELS_MAX_ITEMS;
    process.env.STALKER_CHANNELS_MAX_ITEMS = '100';
    const page = Array.from({ length: 100 }, (_, index) => ({
      id: `ch${index + 1}`,
      name: `Channel ${index + 1}`,
      number: index + 1,
      cmd: `http://stream.example/${index + 1}`,
    }));
    const portalFetchRetry = vi.fn().mockImplementation((_session, params) => {
      if (params.action === 'get_genres') return Promise.resolve({ js: [] });
      if (params.action === 'get_all_channels') return Promise.reject(new Error('Portal metadata response exceeds 52428800 bytes'));
      return Promise.resolve({ js: { data: page, total_pages: 5 } });
    });
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry,
    });

    try {
      const res = await request(makeApp(deps)).get('/stalker/channels?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc');
      expect(res.status).toBe(200);
      expect(res.body.channels).toHaveLength(100);
      expect(portalFetchRetry.mock.calls.filter(([, params]) => params.action === 'get_ichannels_via_api')).toHaveLength(1);
    } finally {
      if (previousLimit === undefined) delete process.env.STALKER_CHANNELS_MAX_ITEMS;
      else process.env.STALKER_CHANNELS_MAX_ITEMS = previousLimit;
    }
  });

  it('GET /stalker/channels returns the complete primary catalog', async () => {
    const previousLimit = process.env.STALKER_CHANNELS_MAX_ITEMS;
    process.env.STALKER_CHANNELS_MAX_ITEMS = '1000';
    const channels = Array.from({ length: 101 }, (_, index) => ({
      id: `ch${index + 1}`,
      name: `Channel ${index + 1}`,
      number: index + 1,
      cmd: `http://stream.example/${index + 1}`,
    }));
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn()
        .mockResolvedValueOnce({ js: [] })
        .mockResolvedValueOnce({ js: { data: channels } }),
    });

    try {
      const res = await request(makeApp(deps)).get('/stalker/channels?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc');

      expect(res.status).toBe(200);
      expect(res.body.channels).toHaveLength(101);
    } finally {
      if (previousLimit === undefined) delete process.env.STALKER_CHANNELS_MAX_ITEMS;
      else process.env.STALKER_CHANNELS_MAX_ITEMS = previousLimit;
    }
  });

  it('GET /stalker/channels does not use the catalog fallback for unrelated provider failures', async () => {
    const portalFetchRetry = vi.fn().mockImplementation((_session, params) => {
      if (params.action === 'get_genres') return Promise.resolve({ js: [] });
      return Promise.reject(new Error('Portal server error (503)'));
    });
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry,
    });

    const res = await request(makeApp(deps)).get('/stalker/channels?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc');

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('provider_failure');
    expect(portalFetchRetry.mock.calls.some(([, params]) => params.action === 'get_ichannels_via_api')).toBe(false);
  });

  it('GET /stalker/channels returns catalog_too_large when the paginated fallback is unavailable', async () => {
    const portalFetchRetry = vi.fn().mockImplementation((_session, params) => {
      if (params.action === 'get_genres') return Promise.resolve({ js: [] });
      if (params.action === 'get_all_channels') return Promise.reject(new Error('Portal metadata response exceeds 52428800 bytes'));
      return Promise.reject(new Error('Unsupported action'));
    });
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry,
    });

    const res = await request(makeApp(deps)).get('/stalker/channels?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc');

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('catalog_too_large');
    expect(res.body.error).toContain('Portal metadata response exceeds 52428800 bytes');
  });

  it('GET /stalker/channels returns 502 on session error', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockRejectedValue(new Error('Session failed')),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/channels?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc');
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('provider_failure');
    expect(res.body.error).toBe('Session failed');
  });

  // --- play ---

  it("POST /stalker/resolve-redirect returns the validated edge URL without relaying bytes", async () => {
    const destroy = vi.fn();
    const deps = makeDeps({
      fetchWithRedirectCheck: vi.fn().mockResolvedValue({
        response: { status: 200, ok: true, body: { destroy } },
        url: "http://edge.example/stream.m3u8",
        redirected: true,
      }),
    });
    const res = await request(makeApp(deps))
      .post("/stalker/resolve-redirect")
      .send({ url: "http://front.example/stream.m3u8" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ url: "http://edge.example/stream.m3u8", redirected: true });
    expect(deps.fetchWithRedirectCheck).toHaveBeenCalledWith(
      "http://front.example/stream.m3u8",
      expect.objectContaining({ method: "HEAD", headers: { Accept: "*/*", "User-Agent": "StreamVault/1.0" } }),
    );
    expect(destroy).toHaveBeenCalled();
  });

  it("returns an explicit compatibility error when a provider rejects HEAD", async () => {
    const deps = makeDeps({
      fetchWithRedirectCheck: vi.fn().mockResolvedValue({
        response: { ok: false, status: 405, body: { destroy: vi.fn() } },
        url: "http://front.example/stream.m3u8",
        redirected: false,
      }),
    });
    const res = await request(makeApp(deps))
      .post("/stalker/resolve-redirect")
      .send({ url: "http://front.example/stream.m3u8" });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: "redirect_resolution_unsupported", status: 405 });
  });

  it("returns unsupported protocols as a non-direct contract", async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: "t", headers: {} }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { cmd: "rtsp://provider.example/live" } }),
    });
    const res = await request(makeApp(deps)).get("/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=ABC&resolve=1");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ direct: false, directCapability: "unsupported_protocol", warnings: ["unsupported_protocol"] });
    expect(deps.isUrlAllowed).not.toHaveBeenCalled();
  });

  it("rejects unsigned emergency relay requests", async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: "t", headers: {} }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { cmd: "http://cdn.example/live.ts" } }),
    });
    const res = await request(makeApp(deps)).get("/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=ABC");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("relay_confirmation_required");
    expect(deps.fetchWithRedirectCheck).not.toHaveBeenCalled();
  });

  it("tries at most three catch-up parameter strategies", async () => {
    const portalFetchRetry = vi.fn()
      .mockResolvedValueOnce({ js: {} })
      .mockResolvedValueOnce({ js: {} })
      .mockResolvedValueOnce({ js: { cmd: "http://cdn.example/archive.m3u8" } });
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: "t", headers: {} }),
      portalFetchRetry,
    });
    const res = await request(makeApp(deps)).get("/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=ABC&content_type=live&start=100&end=160&program_id=9&resolve=1");
    expect(res.status).toBe(200);
    expect(portalFetchRetry).toHaveBeenCalledTimes(3);
    expect(portalFetchRetry.mock.calls[1][1]).toMatchObject({ utc: 100, duration: 60 });
    expect(portalFetchRetry.mock.calls[2][1]).toMatchObject({ archive: 1, program_id: '9' });
  });

  it('GET /stalker/play with resolve=1 returns metadata for direct playback', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { cmd: 'http://cdn.com/video.m3u8' } }),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=ABC&resolve=1');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      url: 'http://cdn.com/video.m3u8',
      streamKind: 'hls',
      direct: true,
      expiresAt: null,
    });
    expect(res.body.refreshUrl).toContain('/stalker/play?');
  });

  it('GET /stalker/play resolves CDN redirects before direct HLS playback', async () => {
    const cancel = vi.fn();
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { cmd: 'http://cloudedgeserver01.cloudlivecdn.com/path/mono.m3u8?token=t' } }),
      fetchWithRedirectCheck: vi.fn().mockResolvedValue({
        response: { ok: true, status: 200, body: { cancel } },
        url: 'http://edge34358171d.akamaix.com/path/mono.m3u8?token=t',
      }),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=ABC&resolve=1');

    expect(res.status).toBe(200);
    expect(res.body.url).toBe('http://edge34358171d.akamaix.com/path/mono.m3u8?token=t');
    expect(deps.fetchWithRedirectCheck).toHaveBeenCalledWith(
      'http://cloudedgeserver01.cloudlivecdn.com/path/mono.m3u8?token=t',
      expect.objectContaining({ method: 'HEAD' }),
    );
    expect(cancel).toHaveBeenCalled();
  });

  it('GET /stalker/play preserves a redirected edge URL when the VPS probe is denied', async () => {
    const destroy = vi.fn();
    const edgeUrl = 'http://edge34358171d.akamaix.com/path/mono.m3u8?token=t';
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { cmd: 'http://cloudedgeserver01.cloudlivecdn.com/path/mono.m3u8?token=t' } }),
      fetchWithRedirectCheck: vi.fn().mockResolvedValue({
        response: { ok: false, status: 403, body: { destroy } },
        url: edgeUrl,
        redirected: true,
      }),
    });

    const res = await request(makeApp(deps)).get('/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=ABC&resolve=1');

    expect(res.status).toBe(200);
    expect(res.body.url).toBe(edgeUrl);
    expect(destroy).toHaveBeenCalled();
  });

  it('GET /stalker/play refreshes tokenized live URLs from the channel list', async () => {
    const staleUrl = 'http://me.mdmfista.com/play/live.php?mac=00:1A:79:18:15:1D&stream=1433159&extension=ts&play_token=stale';
    const freshUrl = 'http://me.mdmfista.com/play/live.php?mac=00:1A:79:18:15:1D&stream=1433159&extension=ts&play_token=fresh';
    const portalFetchRetry = vi.fn().mockResolvedValue({ js: { data: [{ id: '1433159', cmd: 'ffmpeg ' + freshUrl }] } });
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry,
      fetchWithRedirectCheck: vi.fn().mockResolvedValue({
        response: { ok: true, status: 206, body: { cancel: vi.fn() } },
        url: freshUrl,
      }),
    });

    const res = await request(makeApp(deps)).get(
      '/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=' + encodeURIComponent('ffmpeg ' + staleUrl) + '&content_type=live&channel_id=1433159&resolve=1',
    );

    expect(res.status).toBe(200);
    expect(res.body.url).toBe(freshUrl);
    expect(res.body.refreshUrl).toContain('channel_id=1433159');
    expect(deps.fetchWithRedirectCheck).not.toHaveBeenCalled();
    expect(portalFetchRetry).toHaveBeenCalledTimes(1);
    expect(portalFetchRetry.mock.calls[0][1]).toMatchObject({
      type: 'itv',
      action: 'get_all_channels',
    });
  });

  it('GET /stalker/play reuses a complete live URL when no channel ID is available', async () => {
    const directUrl = 'http://me.mdmfista.com/play/live.php?mac=00:1A:79:18:15:1D&stream=1433159&extension=ts&play_token=token';
    const portalFetchRetry = vi.fn();
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry,
      fetchWithRedirectCheck: vi.fn().mockResolvedValue({
        response: { ok: true, status: 206, body: { cancel: vi.fn() } },
        url: directUrl,
      }),
    });

    const res = await request(makeApp(deps)).get(
      '/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=' + encodeURIComponent('ffmpeg ' + directUrl) + '&content_type=live&resolve=1',
    );

    expect(res.status).toBe(200);
    expect(res.body.url).toBe(directUrl);
    expect(portalFetchRetry).not.toHaveBeenCalled();
  });
  it('GET /stalker/play uses the channel command when a live URL has an empty stream value', async () => {
    const portalFetchRetry = vi.fn().mockResolvedValue({ js: { cmd: 'http://cdn.example/live.ts' } });
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry,
      fetchWithRedirectCheck: vi.fn().mockResolvedValue({
        response: { ok: true, status: 200, body: { cancel: vi.fn() } },
        url: 'http://cdn.example/live.ts',
      }),
    });

    const cmd = 'http://me.mdmfista.com/play/live.php?mac=00:1A:79:18:15:1D&stream=&extension=ts&play_token=token';
    const res = await request(makeApp(deps)).get(
      '/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=' + encodeURIComponent(cmd) + '&content_type=live&channel_id=11665&resolve=1',
    );

    expect(res.status).toBe(200);
    expect(res.body.refreshUrl).toContain('channel_id=11665');
    expect(portalFetchRetry.mock.calls[0][1]).toMatchObject({
      action: 'create_link',
      cmd: 'ffrt http:///ch/11665',
    });
  });
  it('GET /stalker/play retries a path-only VOD command with the MAG ffmpeg prefix', async () => {
    const portalFetchRetry = vi.fn()
      .mockResolvedValueOnce({ js: {} })
      .mockResolvedValueOnce({ js: { cmd: 'http://cdn.com/movie.mp4' } });
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry,
    });
    const app = makeApp(deps);

    const res = await request(app).get('/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=%2Fmedia%2Fmovie.mpg&content_type=vod&resolve=1');

    expect(res.status).toBe(200);
    expect(res.body.url).toBe('http://cdn.com/movie.mp4');
    expect(portalFetchRetry).toHaveBeenCalledTimes(2);
    expect(portalFetchRetry.mock.calls[0][1].cmd).toBe('/media/movie.mpg');
    expect(portalFetchRetry.mock.calls[1][1].cmd).toBe('ffmpeg /media/movie.mpg');
  });
  it('GET /stalker/play resolves a numeric VOD catalog ID before creating its link', async () => {
    const portalFetchRetry = vi.fn()
      .mockResolvedValueOnce({ js: { data: [{ id: '83226', cmd: '/media/file_1753626.mpg' }] } })
      .mockResolvedValueOnce({ js: { cmd: 'http://cdn.com/media/st12-vod/mac/83226.mp4' } });
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry,
    });
    const app = makeApp(deps);

    const res = await request(app).get('/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=%2Fmedia%2F83226.mpg&content_type=vod&resolve=1');

    expect(res.status).toBe(200);
    expect(res.body.url).toBe('http://cdn.com/media/st12-vod/mac/83226.mp4');
    expect(portalFetchRetry).toHaveBeenCalledTimes(2);
    expect(portalFetchRetry.mock.calls[0][1]).toMatchObject({
      type: 'vod', action: 'get_ordered_list', category: 0, movie_id: '83226',
      season_id: 0, episode_id: 0, p: 1, from_ch_id: 0,
    });
    expect(portalFetchRetry.mock.calls[1][1].cmd).toBe('/media/file_1753626.mpg');
  });
  it('GET /stalker/play resolves credentials from a scoped content session', async () => {
    const encryptedConnection = encryptToken(JSON.stringify({
      id: 'stalker-1',
      type: 'stalker',
      config: {
        type: 'stalker',
        server: 'http://portal.example/c',
        mac: '00:1A:79:AA:BB:CC',
        serial: 'SN1',
      },
    }));
    const deps = makeDeps({
      contentSessionStore: {
        findByTokenHash: vi.fn().mockResolvedValue({
          encryptedConnection,
          expiresAt: Date.now() + 60_000,
        }),
        deleteByTokenHash: vi.fn(),
      },
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'http://portal.example/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { cmd: 'https://cdn.example/live.ts' } }),
    });
    const app = makeApp(deps);

    const res = await request(app).get('/stalker/play?contentToken=scoped-token&cmd=ABC&resolve=1');

    expect(res.status).toBe(200);
    expect(deps.getSession).toHaveBeenCalledWith(
      'http://portal.example/c',
      '00:1A:79:AA:BB:CC',
      expect.objectContaining({ serial: 'SN1' }),
    );
    expect(res.body.refreshUrl).toContain('contentToken=scoped-token');
    expect(res.body.refreshUrl).not.toContain('portal=');
    expect(res.body.refreshUrl).not.toContain('mac=');
  });

  it('GET /stalker/play deletes and rejects an expired content session', async () => {
    const contentSessionStore = {
      findByTokenHash: vi.fn().mockResolvedValue({
        encryptedConnection: 'unused',
        expiresAt: Date.now() - 1,
      }),
      deleteByTokenHash: vi.fn(),
    };
    const app = makeApp(makeDeps({ contentSessionStore }));

    const res = await request(app).get('/stalker/play?contentToken=expired-token&cmd=ABC&resolve=1');

    expect(res.status).toBe(410);
    expect(res.body.code).toBe('expired');
    expect(contentSessionStore.deleteByTokenHash).toHaveBeenCalledTimes(1);
  });

  // ── Authentication tests ──────────────────────────────────────────────

  it('GET /stalker/play returns 503 when auth dependency is missing entirely', async () => {
    const app = makeApp(makeDeps({ auth: undefined }));

    const res = await request(app).get('/stalker/channels?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc');

    expect(res.status).toBe(503);
    expect(res.body.error).toContain('Authentication service unavailable');
    expect(res.body.code).toBe('auth_unavailable');
  });

  it('GET /stalker/play returns 503 when auth.verifyToken is missing from the object', async () => {
    const app = makeApp(makeDeps({ auth: {} }));

    // For this test only, remove the injected cookie so we exercise the
    // missing-verifyToken path rather than falling through to token=null.
    const miniApp = express();
    miniApp.use(express.json());
    miniApp.use('/stalker', createStalkerRouter(makeDeps({ auth: {} })));
    const res = await request(miniApp).get('/stalker/channels?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc');

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('auth_unavailable');
  });

  it('GET /stalker/play returns 401 when the token is missing and no cookie exists', async () => {
    // Bypass the test cookie injector.
    const miniApp = express();
    miniApp.use(express.json());
    miniApp.use('/stalker', createStalkerRouter(
      makeDeps({ auth: { verifyToken: vi.fn().mockReturnValue(null) } }),
    ));
    const res = await request(miniApp).get('/stalker/channels?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthorized');
  });

  it('GET /stalker/play returns 503 when verifyToken throws an exception', async () => {
    const app = makeApp(makeDeps({
      auth: { verifyToken: vi.fn().mockImplementation(() => { throw new Error('DB connection lost'); }) },
    }));
    const res = await request(app).get('/stalker/channels?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc');

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('auth_unavailable');
  });

  it('GET /stalker/play succeeds with a valid Bearer token', async () => {
    const miniApp = express();
    miniApp.use(express.json());
    miniApp.use('/stalker', createStalkerRouter(makeDeps({
      auth: { verifyToken: vi.fn().mockReturnValue({ id: 1, username: 'bearer-user', role: 'regular' }) },
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://portal.example/', apiPath: 'server/load.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { cmd: 'https://cdn.example/live.ts' } }),
    })));
    const res = await request(miniApp)
      .get('/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=ABC&resolve=1')
      .set('authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^https:/);
  });

  it('GET /stalker/play with content-session still works alongside mandatory auth', async () => {
    const encryptedConnection = encryptToken(JSON.stringify({
      id: 'stalker-1',
      type: 'stalker',
      config: { type: 'stalker', server: 'http://portal.example/c', mac: '00:1A:79:AA:BB:CC', serial: 'SN1' },
    }));
    const deps = makeDeps({
      contentSessionStore: {
        findByTokenHash: vi.fn().mockResolvedValue({ encryptedConnection, expiresAt: Date.now() + 60_000 }),
        deleteByTokenHash: vi.fn(),
      },
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'http://portal.example/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { cmd: 'https://cdn.example/live.ts' } }),
    });
    const app = makeApp(deps);

    const res = await request(app).get('/stalker/play?contentToken=scoped-token&cmd=ABC&resolve=1');

    expect(res.status).toBe(200);
    expect(res.body.refreshUrl).toContain('contentToken=scoped-token');
    expect(res.body.direct).toBe(true);
  });

  it('GET /stalker/play succeeds when content-session extension DB write fails', async () => {
    const encryptedConnection = encryptToken(JSON.stringify({
      id: 'stalker-1',
      type: 'stalker',
      config: { type: 'stalker', server: 'http://portal.example/c', mac: '00:1A:79:AA:BB:CC', serial: 'SN1' },
    }));
    const deps = makeDeps({
      contentSessionStore: {
        findByTokenHash: vi.fn().mockResolvedValue({
          encryptedConnection,
          expiresAt: Date.now() + 60_000, // still valid but close enough to trigger extension
          createdAt: Date.now() - 4 * 60 * 60_000, // old enough to trigger TTL check
        }),
        extendByTokenHash: vi.fn().mockRejectedValue(new Error('SQLITE_IOERR: disk I/O error')),
        deleteByTokenHash: vi.fn(),
      },
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'http://portal.example/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { cmd: 'https://cdn.example/live.ts' } }),
    });
    const app = makeApp(deps);

    const res = await request(app).get('/stalker/play?contentToken=scoped-token&cmd=ABC&resolve=1');

    // Extension failure must NOT prevent the request from succeeding.
    expect(res.status).toBe(200);
    expect(res.body.direct).toBe(true);
    expect(deps.contentSessionStore.extendByTokenHash).toHaveBeenCalled();
  });

  it('GET /stalker/play succeeds when content-session extension is not supported by store', async () => {
    const encryptedConnection = encryptToken(JSON.stringify({
      id: 'stalker-1',
      type: 'stalker',
      config: { type: 'stalker', server: 'http://portal.example/c', mac: '00:1A:79:AA:BB:CC' },
    }));
    const deps = makeDeps({
      contentSessionStore: {
        findByTokenHash: vi.fn().mockResolvedValue({
          encryptedConnection,
          expiresAt: Date.now() + 60_000,
          createdAt: Date.now() - 4 * 60 * 60_000,
        }),
        // No extendByTokenHash method — should be gracefully skipped.
        deleteByTokenHash: vi.fn(),
      },
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'http://portal.example/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { cmd: 'https://cdn.example/live.ts' } }),
    });
    const app = makeApp(deps);

    const res = await request(app).get('/stalker/play?contentToken=scoped-token&cmd=ABC&resolve=1');

    expect(res.status).toBe(200);
    expect(res.body.direct).toBe(true);
  });

  // ── End authentication tests ──────────────────────────────────────────

  it('GET /stalker/play rejects raw credentials when authentication is configured', async () => {
    const app = makeApp(makeDeps({
      auth: { verifyToken: vi.fn().mockReturnValue(null) },
    }));

    const res = await request(app).get('/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=ABC&resolve=1');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthorized');
  });
  it('GET /stalker/play rewrites localhost/127.0.0.1 to portal host', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { cmd: 'ffmpeg http://127.0.0.1:8080/stream.m3u8' } }),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=ABC&resolve=1');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      url: 'http://p.com/stream.m3u8',
      streamKind: 'hls',
      direct: true,
    });
  });

  it('GET /stalker/play calls trackWatch for live streams', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { cmd: 'http://cdn.com/video.mp4' } }),
      fetchWithRedirectCheck: vi.fn().mockResolvedValue({
        response: {
          ok: true, status: 200,
          headers: { get: (k) => k === 'content-type' ? 'video/mp4' : null },
          body: Readable.from(['video data']),
        },
        url: 'http://cdn.com/video.mp4',
      }),
      buildStalkerStreamHeaders: vi.fn().mockReturnValue({}),
      summarizeUpstreamHeaders: vi.fn().mockReturnValue({}),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=ABC&content_type=live&relayGrant=' + encodeURIComponent(relayGrant()) );
    expect(res.status).toBe(200);
    expect(deps.cache.trackWatch).toHaveBeenCalledWith('ABC', 'live');
  });

  it('GET /stalker/play pipes non-HLS streams directly', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { cmd: 'http://cdn.com/video.mp4' } }),
      fetchWithRedirectCheck: vi.fn().mockResolvedValue({
        response: {
          ok: true, status: 200,
          headers: { get: (k) => k === 'content-type' ? 'video/mp4' : null },
          body: Readable.from(['video data']),
        },
        url: 'http://cdn.com/video.mp4',
      }),
      buildStalkerStreamHeaders: vi.fn().mockReturnValue({}),
      summarizeUpstreamHeaders: vi.fn().mockReturnValue({}),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=ABC&relayGrant=' + encodeURIComponent(relayGrant()) );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/video/);
  });

  it('GET /stalker/play rewrites HLS manifest through /stream proxy', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { cmd: 'http://cdn.com/live.m3u8' } }),
      fetchWithRedirectCheck: vi.fn().mockResolvedValue({
        response: {
          ok: true, status: 200,
          headers: { get: (k) => {
            if (k === 'content-type') return 'application/vnd.apple.mpegurl';
            if (k === 'content-length') return null;
            return null;
          } },
          body: Readable.from(['#EXTM3U\nsegment.ts\n']),
        },
        url: 'http://cdn.com/live.m3u8',
      }),
      buildStalkerStreamHeaders: vi.fn().mockReturnValue({}),
      summarizeUpstreamHeaders: vi.fn().mockReturnValue({ contentType: 'application/vnd.apple.mpegurl' }),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=ABC&relayGrant=' + encodeURIComponent(relayGrant()) );
    expect(res.status).toBe(200);
    expect(res.text).toContain('/stream?url=');
    expect(res.text).toContain(encodeURIComponent('http://cdn.com/segment.ts'));
    expect(res.headers['content-length']).toBeUndefined();
  });

  it('GET /stalker/play returns 502 when upstream fetch fails', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { cmd: 'http://cdn.com/video.mp4' } }),
      fetchWithRedirectCheck: vi.fn().mockResolvedValue({
        response: { ok: false, status: 500, headers: { get: () => 'text/plain' }, body: null },
        url: 'http://cdn.com/video.mp4',
      }),
      buildStalkerStreamHeaders: vi.fn().mockReturnValue({}),
      summarizeUpstreamHeaders: vi.fn().mockReturnValue({}),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=ABC&relayGrant=' + encodeURIComponent(relayGrant()) );
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('500');
  });

  // ── relay-grant tests ──────────────────────────────────────────────────

  it('POST /stalker/relay-grant creates a valid grant for authenticated user', async () => {
    const deps = makeDeps({});
    const app = makeApp(deps);
    const res = await request(app).post('/stalker/relay-grant').send({ cmd: 'ABC', confirm: true });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('relayGrant');
    expect(typeof res.body.relayGrant).toBe('string');
    expect(res.body.expiresAt).toBeGreaterThan(Date.now());
  });

  it('POST /stalker/relay-grant returns 409 when media relay is disabled', async () => {
    process.env.STALKER_MEDIA_RELAY_ENABLED = 'false';
    const prevEnvRelay = process.env.STALKER_MEDIA_RELAY_ENABLED;
    const app = makeApp(makeDeps({}));
    const res = await request(app).post('/stalker/relay-grant').send({ cmd: 'ABC', confirm: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('media_relay_disabled');
    process.env.STALKER_MEDIA_RELAY_ENABLED = prevEnvRelay;
  });

  it('POST /stalker/relay-grant returns 503 when secret is not configured', async () => {
    const prev = process.env.STALKER_RELAY_GRANT_SECRET;
    delete process.env.STALKER_RELAY_GRANT_SECRET;
    const app = makeApp(makeDeps({}));
    const res = await request(app).post('/stalker/relay-grant').send({ cmd: 'ABC', confirm: true });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('relay_not_configured');
    if (prev !== undefined) process.env.STALKER_RELAY_GRANT_SECRET = prev;
  });

  it('POST /stalker/relay-grant returns 400 when confirm is missing', async () => {
    const app = makeApp(makeDeps({}));
    const res = await request(app).post('/stalker/relay-grant').send({ cmd: 'ABC' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('relay_confirmation_required');
  });

  it('GET /stalker/play with expired relay-grant returns 403', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { cmd: 'http://video.cdn.com/stream.mp4' } }),
    });
    const app = makeApp(deps);
    const expiredGrant = `${Date.now() - 10_000}.${relayGrant('ABC').split('.')[1]}`;
    const res = await request(app).get('/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=ABC&relayGrant=' + encodeURIComponent(expiredGrant));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('relay_confirmation_required');
  });

  it('GET /stalker/play with tampered relay-grant signature returns 403', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { cmd: 'http://video.cdn.com/stream.mp4' } }),
      fetchWithRedirectCheck: vi.fn().mockResolvedValue({
        response: { ok: true, status: 200, headers: new Map([['content-type', 'video/mp4']]), body: Readable.from(['chunk']) },
        url: 'http://video.cdn.com/stream.mp4',
      }),
    });
    const app = makeApp(deps);
    const [expires, sig] = relayGrant('ABC').split('.');
    const tamperedSig = sig.slice(0, -4) + 'xxxx';
    const tamperedGrant = `${expires}.${tamperedSig}`;
    const res = await request(app).get('/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=ABC&relayGrant=' + encodeURIComponent(tamperedGrant));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('relay_confirmation_required');
  });

  it('GET /stalker/play with relay-grant for wrong command returns 403', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { cmd: 'http://video.cdn.com/stream.mp4' } }),
    });
    const app = makeApp(deps);
    const grant = relayGrant('ABC');
    const res = await request(app).get('/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=XYZ&relayGrant=' + encodeURIComponent(grant));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('relay_confirmation_required');
  });

  // --- series ---

  it('GET /stalker/series/categories returns mapped categories with counts', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({
        js: [
          { id: 1, title: 'Drama', count: 12 },
          { id: 2, title: 'Comedy', videos_count: 8 },
          { id: 3, title: 'Horror', censored_count: 5 },
        ]
      }),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/series/categories?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc');
    expect(res.status).toBe(200);
    expect(res.body.categories).toHaveLength(3);
    expect(res.body.categories[0]).toMatchObject({ id: '1', title: 'Drama', count: 12 });
    expect(res.body.categories[1]).toMatchObject({ id: '2', title: 'Comedy', count: 8 });
    expect(res.body.categories[2]).toMatchObject({ id: '3', title: 'Horror', count: 5 });
    expect(deps.cache.set).toHaveBeenCalled();
  });

  it('GET /stalker/series/seasons returns seasons with episodes array', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({
        js: {
          data: [
            {
              id: 's1',
              name: 'Season 1',
              cmd: '/s1.m3u8',
              screenshot_uri: 'http://cdn/s1.jpg',
              series: [
                { id: 'e1', name: 'Ep1', cmd: 'ABC1' },
                { id: 'e2', name: 'Ep2', cmd: 'ABC2' },
              ]
            }
          ]
        }
      }),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/series/seasons?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&seriesId=123');
    expect(res.status).toBe(200);
    expect(res.body.seasons).toHaveLength(1);
    expect(res.body.seasons[0]).toMatchObject({ id: 's1', name: 'Season 1', logo: 'http://cdn/s1.jpg' });
    expect(res.body.seasons[0].cmd).toMatch(/^svopaque:/);
    expect(res.body.seasons[0].episodes).toHaveLength(2);
  });

  it('GET /stalker/series/seasons handles series where series field is not an array', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({
        js: {
          data: [
            { id: 's1', name: 'Bad Season', series: null },
            { id: 's2', name: 'String Season', series: 'not an array' },
          ]
        }
      }),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/series/seasons?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&seriesId=123');
    expect(res.status).toBe(200);
    expect(res.body.seasons[0].episodes).toEqual([]);
    expect(res.body.seasons[1].episodes).toEqual([]);
  });

  it('GET /stalker/series/seasons returns 502 on upstream failure', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockRejectedValue(new Error('Series portal error')),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/series/seasons?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&seriesId=123');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ supported: false, error: 'unsupported_series_api' });
  });

  it('GET /stalker/series/seasons uses cache when available and refresh not set', async () => {
    const cachedData = { seasons: [{ id: 'cached', name: 'Cached' }] };
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn(),
      cache: {
        ...makeDeps().cache,
        get: vi.fn().mockReturnValue(cachedData),
        trackCacheHit: vi.fn(),
        trackCacheMiss: vi.fn(),
        cacheKey: vi.fn(),
      },
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/series/seasons?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&seriesId=123');
    expect(res.status).toBe(200);
    expect(res.body.seasons[0].name).toBe('Cached');
    expect(deps.cache.trackCacheHit).toHaveBeenCalled();
    expect(deps.portalFetchRetry).not.toHaveBeenCalled();
  });

  it('GET /stalker/series/seasons bypasses cache when refresh=1', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({
        js: { data: [{ id: 'fresh', name: 'Fresh Season', series: [] }] }
      }),
      cache: {
        ...makeDeps().cache,
        get: vi.fn().mockReturnValue({ seasons: [{ id: 'old', name: 'Old Season' }] }),
        trackCacheHit: vi.fn(),
        trackCacheMiss: vi.fn(),
        cacheKey: vi.fn(),
      },
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/series/seasons?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&seriesId=123&refresh=1');
    expect(res.status).toBe(200);
    expect(res.body.seasons[0].name).toBe('Fresh Season');
    expect(deps.cache.trackCacheMiss).toHaveBeenCalled();
    expect(deps.portalFetchRetry).toHaveBeenCalled();
  });

  // --- series paging ---

  it('fetchAllPages fetches multiple pages up to maxItems', async () => {
    let page = 0;
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockImplementation(() => {
        page++;
        if (page === 1) return Promise.resolve({ js: { data: [{ id: 'i1' }, { id: 'i2' }], total_pages: 4 } });
        if (page === 2) return Promise.resolve({ js: { data: [{ id: 'i3' }] } });
        return Promise.resolve({ js: { data: [{ id: 'i4' }, { id: 'i5' }, { id: 'i6' }] } });
      }),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/series?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cat=1');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThanOrEqual(3);
    // should have called portalFetchRetry at least twice (page 1 + additional)
    expect(deps.portalFetchRetry).toHaveBeenCalled();
  });

  it('fetchAllPages continues when the provider omits total_pages and stops at an empty page', async () => {
    let page = 0;
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockImplementation(() => {
        page++;
        if (page === 1) return Promise.resolve({ js: { data: [{ id: 'v1' }, { id: 'v2' }] } });
        if (page === 2) return Promise.resolve({ js: { data: [{ id: 'v3' }, { id: 'v4' }] } });
        return Promise.resolve({ js: { data: [] } });
      }),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/vod?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cat=1');
    expect(res.status).toBe(200);
    expect(res.body.items.map(item => item.id)).toEqual(['v1', 'v2', 'v3', 'v4']);
    expect(deps.portalFetchRetry).toHaveBeenCalledTimes(3);
  });

  it('fetchAllPages returns empty array on first page failure', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockRejectedValue(new Error('Network failure')),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/series?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cat=1');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('fetchAllPages returns empty when first page has no items', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { data: [] } }),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/series?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cat=1');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  // --- vod ---

  it('GET /stalker/vod maps item fields correctly', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({
        js: {
          data: [
            { id: 'v1', name: 'Movie One', year: 2024, rating_imdb: '8.5', cmd: 'ffmpeg http://cdn/m1.m3u8', screenshot_uri: 'http://cdn/c1.jpg' },
            { id: 'v2', name: 'Movie Two', cover: 'http://cdn/c2.jpg', time: 7200 },
          ],
          total_pages: 1,
        }
      }),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/vod?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cat=1');
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({ id: 'v1', name: 'Movie One', year: 2024, rating: '8.5', logo: 'http://cdn/c1.jpg', type: 'vod' });
    expect(res.body.items[0].url).toMatch(/^svopaque:/);
    expect(res.body.items[0].url).not.toContain('cdn/m1');
    expect(res.body.items[1]).toMatchObject({ id: 'v2', logo: 'http://cdn/c2.jpg' });
    expect(res.body.total).toBe(2);
  });

  it("round-trips an opaque catalog command without exposing the provider URL", async () => {
    const portalFetchRetry = vi.fn()
      .mockResolvedValueOnce({ js: { data: [{ id: "v1", name: "Movie", cmd: "ffmpeg http://private.example/movie.mp4?play_token=secret" }], total_pages: 1 } })
      .mockResolvedValueOnce({ js: { cmd: "http://cdn.example/movie.mp4" } });
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: "t", headers: {} }),
      portalFetchRetry,
    });
    const app = makeApp(deps);
    const catalog = await request(app).get("/stalker/vod?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cat=1");
    const reference = catalog.body.items[0].url;
    expect(reference).toMatch(/^svopaque:/);
    expect(reference).not.toContain("private.example");

    const playback = await request(app).get("/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&content_type=vod&resolve=1&cmd=" + encodeURIComponent(reference));
    expect(playback.status).toBe(200);
    expect(portalFetchRetry.mock.calls[1][1].cmd).toBe("ffmpeg http://private.example/movie.mp4?play_token=secret");
  });

  // --- series episode stream ---

  it('GET /stalker/series/episode/stream strips ffmpeg prefix', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { cmd: 'ffmpeg http://cdn.com/ep1.m3u8' } }),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/series/episode/stream?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=ABC&episode=3');
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('http://cdn.com/ep1.m3u8');
  });

  // --- api passthrough ---

  it('GET /stalker/api forwards allowed params to portal', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { result: 'ok' } }),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/api?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&action=get_ichannels_via_api&type=itv');
    expect(res.status).toBe(200);
    expect(res.body.js.result).toBe('ok');
    expect(deps.portalFetchRetry).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      action: 'get_ichannels_via_api',
      type: 'itv',
    }), undefined, expect.objectContaining({ signal: expect.anything() }));
  });

  // --- root passthrough ---

  it('GET /stalker/ passes through arbitrary action params', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { info: 'data' } }),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&action=get_full_info');
    expect(res.status).toBe(200);
    expect(res.body.js.info).toBe('data');
    expect(deps.cache.trackRequest).toHaveBeenCalledWith('stalker', 200, expect.any(Number));
  });

  // ── Parameter allowlist tests ──────────────────────────────────────────

  it('GET /stalker/api rejects unknown parameters with 400 and invalid_parameter', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { result: 'ok' } }),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/api?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&action=get_genres&__proto__=bad&hacked=true');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_parameter');
  });

  it('GET /stalker/api strips portal and mac from forwarded params', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { result: 'ok' } }),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/api?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&action=get_genres&type=itv');
    expect(res.status).toBe(200);
    expect(deps.portalFetchRetry).toHaveBeenCalledWith(
      expect.any(Object),
      expect.not.objectContaining({ portal: expect.anything() }),
      undefined, expect.any(Object),
    );
    expect(deps.portalFetchRetry).toHaveBeenCalledWith(
      expect.any(Object),
      expect.not.objectContaining({ mac: expect.anything() }),
      undefined, expect.any(Object),
    );
  });

  it('GET /stalker/api returns 403 for dangerous action values', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { result: 'ok' } }),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/api?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&action=create_link&cmd=http://evil.com/');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('action_forbidden');
  });

  it('GET /stalker/api returns 403 for handshake action via passthrough', async () => {
    const deps = makeDeps({});
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/api?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&action=handshake');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('action_forbidden');
  });

  it('GET /stalker/ rejects prototype-pollution keys', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: {} }),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&action=get_genres&constructor=malicious');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_parameter');
  });

  it('GET /stalker/api allows read-only catalog actions through', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: {} }),
    });
    const app = makeApp(deps);

    // Each tuple is [action, type (or null if schema allows any), extra params]
    const catalogActions = [
      ['get_genres',            'type=itv'],
      ['get_all_channels',      'type=itv'],
      ['get_categories',        'type=vod'],
      ['get_ordered_list',      'type=vod'],
      ['get_epg_info',          'type=itv&period=3'],
      ['get_main_info',         'type=account_info'],
      ['get_simple_data_table', 'type=vod&period=1'],
    ];
    for (const [action, extra] of catalogActions) {
      const res = await request(app).get(
        `/stalker/api?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&action=${action}&${extra}`,
      );
      expect(res.status, `${action} should be allowed`).toBe(200);
    }
  });

  it('GET /stalker/api rejects oversized string values', async () => {
    const deps = makeDeps({});
    const app = makeApp(deps);
    const longAction = 'a'.repeat(500);
    const res = await request(app).get(`/stalker/api?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&action=${longAction}`);
    expect(res.status).toBe(400); // length check fires before action whitelist
  });

  it('GET /stalker/api rejects missing action on generic passthrough', async () => {
    const deps = makeDeps({});
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/api?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_parameter');
    expect(res.body.error).toContain('action');
  });

  it('GET /stalker/api rejects invalid type/action pairs', async () => {
    const deps = makeDeps({});
    const app = makeApp(deps);
    // get_genres requires type=itv, but we send type=vod.
    const res = await request(app).get('/stalker/api?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&action=get_genres&type=vod');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_parameter');
  });

  it('GET /stalker/api rejects fields not supported by the selected action', async () => {
    const deps = makeDeps({});
    const app = makeApp(deps);
    // get_genres only allows category/page/p, not cmd.
    const res = await request(app).get('/stalker/api?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&action=get_genres&type=itv&cmd=malicious');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_parameter');
  });

  it('GET /stalker/api rejects array values for scalar parameters', async () => {
    const deps = makeDeps({});
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/api?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&action=get_genres&action=create_link');
    // Express will merge duplicates into the first value, so this is actually
    // safe by default. The array check fires when Express parses query params
    // with bracket notation. Test that with a constructed request.
    expect(res.status).toBe(400); // duplicate "action" in seen set
  });

  it('GET /stalker/api rejects decimal page values', async () => {
    const deps = makeDeps({});
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/api?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&action=get_ordered_list&type=vod&page=1.9');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_parameter');
  });

  it('GET /stalker/api rejects exponent numeric values', async () => {
    const deps = makeDeps({});
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/api?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&action=get_ordered_list&type=vod&page=1e3');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_parameter');
  });

  it('GET /stalker/api rejects leading-zero numeric values', async () => {
    const deps = makeDeps({});
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/api?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&action=get_ordered_list&type=vod&page=01');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_parameter');
  });

  it('GET /stalker/api rejects missing type on get_genres', async () => {
    const deps = makeDeps({});
    const app = makeApp(deps);
    // get_genres requires type=itv.
    const res = await request(app).get('/stalker/api?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&action=get_genres');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_parameter');
    expect(res.body.error).toContain('requires type');
  });

  it('GET /stalker/api rejects invalid type for get_categories', async () => {
    const deps = makeDeps({});
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/api?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&action=get_categories&type=stb');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_parameter');
  });

  it('GET /stalker/api rejects invalid type for get_ordered_list', async () => {
    const deps = makeDeps({});
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/api?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&action=get_ordered_list&type=itv');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_parameter');
  });

  it('GET /stalker/api allows actions that do not require a type', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: {} }),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/api?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&action=get_full_info');
    expect(res.status).toBe(200);
  });

  it('GET /stalker/api allows stb_type as a string for get_profile', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: {} }),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/api?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&action=get_profile&type=stb&stb_type=MAG250');
    expect(res.status).toBe(200);
  });

  it('GET /stalker/api strips serial and deviceId from forwarded params', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { result: 'ok' } }),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/api?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&action=get_genres&type=itv&serial=SN123&deviceId=DEV456');
    expect(res.status).toBe(200);
    expect(deps.portalFetchRetry).toHaveBeenCalledWith(
      expect.any(Object),
      expect.not.objectContaining({ serial: expect.anything() }),
      undefined, expect.any(Object),
    );
    expect(deps.portalFetchRetry).toHaveBeenCalledWith(
      expect.any(Object),
      expect.not.objectContaining({ deviceId: expect.anything() }),
      undefined, expect.any(Object),
    );
  });

  // ── stream ---

  it('GET /stalker/stream returns URL with localhost rewrite', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { cmd: 'http://localhost:9000/live.m3u8' } }),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/stream?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=ABC');
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('http://p.com/live.m3u8');
  });

  it('GET /stalker/stream returns content_not_found when no URL is returned', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: {} }),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/stream?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=ABC');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('content_not_found');
  });

  it('GET /stalker/stream rejects a resolved URL that fails SSRF validation', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { cmd: 'http://127.0.0.1/private.ts' } }),
      isUrlAllowed: vi.fn().mockResolvedValue(false),
    });
    const res = await request(makeApp(deps)).get(
      '/stalker/stream?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=ABC',
    );

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'url_not_allowed' });
  });

  it('GET /stalker/series/episode/stream rejects a resolved URL that fails SSRF validation', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { cmd: 'ffmpeg http://169.254.169.254/private.mp4' } }),
      isUrlAllowed: vi.fn().mockResolvedValue(false),
    });
    const res = await request(makeApp(deps)).get(
      '/stalker/series/episode/stream?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=ABC&episode=1',
    );

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'url_not_allowed' });
  });

  // --- EPG ---

  it('GET /stalker/epg returns parsed EPG data', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { data: { '123': [{ name: 'Program', start_timestamp: 1672567200, stop_timestamp: 1672570800 }] } } })
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/epg?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&ch_id=123');
    expect(res.status).toBe(200);
    expect(res.body.programs['123'][0].title).toBe('Program');
    expect(deps.portalFetchRetry.mock.calls[0][1]).toMatchObject({
      type: 'itv',
      action: 'get_short_epg',
      ch_id: '123',
      size: '10',
    });
  });

  it('GET /stalker/epg returns 200 with empty array on upstream failure', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockRejectedValue(new Error('epg err')),
      safeError: vi.fn((e) => e.message)
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/epg?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&ch_id=123');
    expect(res.status).toBe(502);
  });

  it('GET /stalker/play preserves the provider channel command when catalog and stream IDs differ', async () => {
    const portalCommand = 'ffrt http://localhost/ch/480452';
    const edgeUrl = 'http://192.101.68.254/stream/tracks-v1a1/mono.m3u8?token=fresh';
    const portalFetchRetry = vi.fn().mockResolvedValue({ js: { cmd: edgeUrl } });
    const fetchWithRedirectCheck = vi.fn().mockResolvedValue({
      response: { ok: true, status: 206, body: { cancel: vi.fn() } },
      url: edgeUrl,
    });
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'http://nawaabexpress.me/stalker_portal/', apiPath: 'server/load.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry,
      fetchWithRedirectCheck,
    });

    const res = await request(makeApp(deps)).get(
      '/stalker/play?portal=http://nawaabexpress.me/stalker_portal/c/&mac=00:1a:79:aa:bb:cc&cmd='
      + encodeURIComponent(portalCommand)
      + '&content_type=live&channel_id=76815&resolve=1',
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ url: edgeUrl, streamKind: 'hls', direct: true });
    expect(portalFetchRetry).toHaveBeenCalledTimes(1);
    expect(portalFetchRetry.mock.calls[0][1]).toMatchObject({
      type: 'itv',
      action: 'create_link',
      cmd: portalCommand,
    });
    expect(fetchWithRedirectCheck).toHaveBeenCalledWith(edgeUrl, expect.any(Object));
  });

  it('rejects media relay when direct-only mode is enabled', async () => {
    process.env.STALKER_PLAYBACK_MODE = 'direct_only';
    process.env.STALKER_MEDIA_RELAY_ENABLED = 'false';
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { cmd: 'http://cdn.example/live.ts' } }),
    });
    const res = await request(makeApp(deps)).get('/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=ABC&relayGrant=' + encodeURIComponent(relayGrant()) );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('media_relay_disabled');
  });
});

describe('dedicated Stalker route validation', () => {
  it('rejects unknown catalog parameters before contacting the provider', async () => {
    const deps = makeDeps();
    const res = await request(makeApp(deps)).get(
      '/stalker/channels?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&injected=true',
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_parameter');
    expect(deps.getSession).not.toHaveBeenCalled();
  });

  it('rejects invalid dedicated EPG numeric fields', async () => {
    const deps = makeDeps();
    const res = await request(makeApp(deps)).get(
      '/stalker/epg?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&period=1.5',
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_parameter');
    expect(deps.getSession).not.toHaveBeenCalled();
  });

  it('returns a structured error for malformed opaque commands', async () => {
    const deps = makeDeps();
    const res = await request(makeApp(deps)).get(
      '/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=svopaque%3Anot-a-token&resolve=1',
    );

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'malformed' });
    expect(deps.getSession).not.toHaveBeenCalled();
  });

  it('returns a refreshable error for expired catalog playback references', async () => {
    const payload = encryptToken(JSON.stringify({ command: 'ffrt http://provider/ch/1', iat: Date.now() - 60_000, exp: Date.now() - 1 }));
    const deps = makeDeps();
    const res = await request(makeApp(deps)).get(
      `/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=svopaque%3A${encodeURIComponent(payload)}&resolve=1`,
    );

    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({ code: 'play_ref_expired' });
    expect(deps.getSession).not.toHaveBeenCalled();
  });

  it('re-materializes an expired opaque reference after an explicit refresh request', async () => {
    const command = 'ffrt http://provider/ch/1';
    const payload = encryptToken(JSON.stringify({ command, iat: Date.now() - 60_000, exp: Date.now() - 1 }));
    const portalFetchRetry = vi.fn().mockResolvedValue({ js: { cmd: 'http://cdn.example/live.ts' } });
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry,
      fetchWithRedirectCheck: vi.fn().mockResolvedValue({
        response: { ok: true, status: 200, body: { cancel: vi.fn() } },
        url: 'http://cdn.example/live.ts',
      }),
    });

    const res = await request(makeApp(deps)).get(
      `/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=svopaque%3A${encodeURIComponent(payload)}&content_type=live&channel_id=1&resolve=1&refresh=1`,
    );

    expect(res.status).toBe(200);
    expect(res.body.url).toBe('http://cdn.example/live.ts');
    expect(portalFetchRetry).toHaveBeenCalledTimes(1);
    expect(portalFetchRetry.mock.calls[0][1]).toMatchObject({
      action: 'create_link',
      cmd: expect.stringContaining('/ch/1'),
    });
  });

  it('rejects a catalog playback reference bound to another connection', async () => {
    const payload = encryptToken(JSON.stringify({
      command: 'ffrt http://provider/ch/1',
      iat: Date.now(),
      exp: Date.now() + 60_000,
      binding: 'wrong-connection',
    }));
    const deps = makeDeps();
    const res = await request(makeApp(deps)).get(
      `/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=svopaque%3A${encodeURIComponent(payload)}&resolve=1`,
    );

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'play_ref_connection_mismatch' });
    expect(deps.getSession).not.toHaveBeenCalled();
  });
});

describe('generic Stalker error contracts', () => {
  it('classifies a generic passthrough timeout and records its status', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockRejectedValue(Object.assign(new Error('upstream timed out'), { code: 'ETIMEDOUT' })),
    });
    const res = await request(makeApp(deps)).get(
      '/stalker/?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&action=get_full_info',
    );

    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({ code: 'provider_timeout' });
    expect(deps.cache.trackRequest).toHaveBeenCalledWith('stalker', 504, expect.any(Number));
  });
});

describe('versioned lazy Stalker catalog routes', () => {
  beforeEach(() => {
    process.env.STALKER_LAZY_CATALOG_ENABLED = 'true';
  });

  it('keeps legacy catalog routes available when lazy catalog is disabled', async () => {
    process.env.STALKER_LAZY_CATALOG_ENABLED = 'false';
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn()
        .mockResolvedValueOnce({ js: [] })
        .mockResolvedValueOnce({ js: { data: [{ id: 1, name: 'Legacy', cmd: 'legacy' }] } }),
    });

    const app = makeApp(deps);
    const legacy = await request(app).get('/stalker/channels?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc');
    const lazy = await request(app).get('/stalker/catalog/v1/items?kind=live&category=all&page=1&pageSize=100');

    expect(legacy.status).toBe(200);
    expect(legacy.body.channels).toHaveLength(1);
    expect(lazy.status).toBe(404);
    expect(lazy.body.code).toBe('feature_disabled');
  });

  it('rejects legacy aggregate catalog routes from a lazy-mode client', async () => {
    const deps = makeDeps({
      getSession: vi.fn(),
      portalFetchRetry: vi.fn(),
    });
    const app = makeApp(deps);
    const channels = await request(app)
      .get('/stalker/channels?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc')
      .set('X-StreamVault-Catalog-Mode', 'lazy-v1');
    const vod = await request(app)
      .get('/stalker/vod?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cat=*')
      .set('X-StreamVault-Catalog-Mode', 'lazy-v1');

    expect(channels.status).toBe(409);
    expect(channels.body).toMatchObject({ code: 'lazy_catalog_required' });
    expect(vod.status).toBe(409);
    expect(vod.body).toMatchObject({ code: 'lazy_catalog_required' });
    expect(deps.getSession).not.toHaveBeenCalled();
    expect(deps.portalFetchRetry).not.toHaveBeenCalled();
  });

  it('keeps legacy aggregate routes available when the lazy backend is disabled', async () => {
    process.env.STALKER_LAZY_CATALOG_ENABLED = 'false';
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn()
        .mockResolvedValueOnce({ js: [] })
        .mockResolvedValueOnce({ js: { data: [{ id: 1, name: 'Legacy', cmd: 'legacy' }] } }),
    });
    const res = await request(makeApp(deps))
      .get('/stalker/channels?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc')
      .set('X-StreamVault-Catalog-Mode', 'lazy-v1');
    expect(res.status).toBe(200);
    expect(res.body.channels).toHaveLength(1);
  });

  it('keeps legacy aggregate routes unchanged without the lazy-mode header', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn()
        .mockResolvedValueOnce({ js: [] })
        .mockResolvedValueOnce({ js: { data: [{ id: 1, name: 'Legacy', cmd: 'legacy' }] } }),
    });
    const res = await request(makeApp(deps)).get('/stalker/channels?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc');
    expect(res.status).toBe(200);
    expect(res.body.channels).toHaveLength(1);
  });

  it('returns normalized live pages without exposing raw commands', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { data: [{ id: 7, name: 'News', cmd: 'http://cdn.example/live.ts' }] } }),
    });
    const res = await request(makeApp(deps)).get('/stalker/catalog/v1/items?kind=live&category=all&page=1&pageSize=100');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: 'live', category: 'all', page: 1, hasMore: false });
    expect(res.body.items[0]).toMatchObject({ id: 7, name: 'News', type: 'live' });
    expect(res.body.items[0].cmd).toBeUndefined();
    expect(res.body.items[0].playRef).toMatch(/^svopaque:/);
  });

  it('does not use the full-catalog fallback when a real live category page fails', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockRejectedValue(Object.assign(
        new Error('Portal metadata response exceeds 16777216 bytes'),
        { code: 'METADATA_TOO_LARGE' },
      )),
      portalFetchChannelCatalogPage: vi.fn().mockResolvedValue({
        js: {
          data: [{ id: 7, name: 'News', tv_genre_id: 3, cmd: 'http://cdn.example/live.ts' }],
          max_page_items: 1,
          total_items: 1,
          total_pages: 1,
        },
      }),
    });

    const res = await request(makeApp(deps)).get('/stalker/catalog/v1/items?kind=live&category=3&page=1&pageSize=1');

    expect(res.status).toBe(502);
    expect(deps.portalFetchChannelCatalogPage).not.toHaveBeenCalled();
  });

  it('switches a real live category with genres and an empty provider page to one shared snapshot', async () => {
    const records = new Map();
    const deps = makeDeps({
      cache: cacheBackedBy(records),
      getSession: vi.fn().mockResolvedValue(stalkerSession()),
      portalFetchRetry: vi.fn().mockImplementation((_session, params) => {
        if (params.action === 'get_genres') return { js: [{ id: '3010', title: 'Sports' }] };
        return { js: { data: [] } };
      }),
      portalFetchChannelCatalog: streamCatalog([
        { id: 1, name: 'Sports One', tv_genre_id: '3010', cmd: 'sports-one' },
        { id: 2, name: 'Sports Two', tv_genre_id: '3010', cmd: 'sports-two' },
      ]),
    });

    const res = await request(makeApp(deps))
      .get('/stalker/catalog/v1/items?kind=live&category=3010&page=1&pageSize=100&portal=http://p.com/c&mac=00:1A:79:AA:BB:CC');

    expect(res.status).toBe(200);
    expect(res.body.items.map(item => item.id)).toEqual([1, 2]);
    expect(res.body.capabilities).toMatchObject({ mode: 'bounded_live_snapshot', pagination: 'unsupported' });
    expect(deps.portalFetchChannelCatalog).toHaveBeenCalledTimes(1);
  });

  it('uses cached live categories as compatibility evidence without another provider call', async () => {
    const records = new Map();
    const deps = makeDeps({
      cache: cacheBackedBy(records),
      getSession: vi.fn().mockResolvedValue(stalkerSession()),
      portalFetchRetry: vi.fn().mockImplementation((_session, params) => {
        if (params.action === 'get_genres') return { js: [{ id: '3010', title: 'Sports' }] };
        return { js: { data: [] } };
      }),
    });
    const app = makeApp(deps);

    await request(app).get('/stalker/catalog/v1/items?kind=live&category=3010&page=1&pageSize=100&portal=http://p.com/c&mac=00:1A:79:AA:BB:CC');

    expect(deps.portalFetchRetry.mock.calls.filter(([, params]) => params.action === 'get_genres')).toHaveLength(1);
  });

  it('does not activate compatibility fallback when live categories contain only All', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue(stalkerSession()),
      portalFetchRetry: vi.fn().mockImplementation((_session, params) => {
        if (params.action === 'get_genres') return { js: [{ id: '*', title: 'All' }] };
        return { js: { data: [] } };
      }),
      portalFetchChannelCatalog: vi.fn(),
    });
    const app = makeApp(deps);
    const response = await request(app)
      .get('/stalker/catalog/v1/items?kind=live&category=all&page=1&pageSize=100&portal=http://p.com/c&mac=00:1A:79:AA:BB:CC');

    expect(response.status).toBe(200);
    expect(response.body.items).toEqual([]);
    expect(deps.portalFetchChannelCatalog).not.toHaveBeenCalled();
  });

  it('joins All and real-category requests to one live snapshot scan', async () => {
    const records = new Map();
    const deps = makeDeps({
      cache: cacheBackedBy(records),
      getSession: vi.fn().mockResolvedValue(stalkerSession()),
      portalFetchRetry: vi.fn().mockImplementation((_session, params) => {
        if (params.action === 'get_genres') return { js: [{ id: '3010', title: 'Sports' }] };
        return { js: { data: [] } };
      }),
      portalFetchChannelCatalog: streamCatalog([
        { id: 1, name: 'Sports One', tv_genre_id: '3010', cmd: 'sports-one' },
      ]),
    });

    const app = makeApp(deps);
    const [all, category] = await Promise.all([
      request(app).get('/stalker/catalog/v1/items?kind=live&category=all&page=1&pageSize=100&portal=http://p.com/c&mac=00:1A:79:AA:BB:CC'),
      request(app).get('/stalker/catalog/v1/items?kind=live&category=3010&page=1&pageSize=100&portal=http://p.com/c&mac=00:1A:79:AA:BB:CC'),
    ]);

    expect(all.status).toBe(200);
    expect(category.status).toBe(200);
    expect(all.body.items).toHaveLength(1);
    expect(category.body.items).toHaveLength(1);
    expect(deps.portalFetchChannelCatalog).toHaveBeenCalledTimes(1);
  });

  it('keeps provider-page-compatible live responses out of the snapshot path', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue(stalkerSession()),
      portalFetchRetry: vi.fn().mockImplementation((_session, params) => {
        if (params.action === 'get_genres') return { js: [{ id: '3010', title: 'Sports' }] };
        return { js: { data: [{ id: 1, name: 'Sports One', tv_genre_id: '3010', cmd: 'sports-one' }] } };
      }),
      portalFetchChannelCatalog: vi.fn(),
    });
    const response = await request(makeApp(deps))
      .get('/stalker/catalog/v1/items?kind=live&category=3010&page=1&pageSize=100&portal=http://p.com/c&mac=00:1A:79:AA:BB:CC');

    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    expect(deps.portalFetchChannelCatalog).not.toHaveBeenCalled();
  });

  it('does not start compatibility scanning for terminal live provider failures', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue(stalkerSession()),
      portalFetchRetry: vi.fn().mockImplementation((_session, params) => {
        if (params.action === 'get_genres') return { js: [{ id: '3010', title: 'Sports' }] };
        throw Object.assign(new Error('Provider rate limited'), { code: 'RATE_LIMITED', status: 429 });
      }),
      portalFetchChannelCatalog: vi.fn(),
    });
    const response = await request(makeApp(deps))
      .get('/stalker/catalog/v1/items?kind=live&category=3010&page=1&pageSize=100&portal=http://p.com/c&mac=00:1A:79:AA:BB:CC');

    expect(response.status).toBe(429);
    expect(deps.portalFetchChannelCatalog).not.toHaveBeenCalled();
  });

  it('negative-caches a completed zero-channel compatibility scan', async () => {
    const records = new Map();
    const deps = makeDeps({
      cache: cacheBackedBy(records),
      getSession: vi.fn().mockResolvedValue(stalkerSession()),
      portalFetchRetry: vi.fn().mockImplementation((_session, params) => {
        if (params.action === 'get_genres') return { js: [{ id: '3010', title: 'Sports' }] };
        return { js: { data: [] } };
      }),
      portalFetchChannelCatalog: streamCatalog([]),
    });
    const app = makeApp(deps);
    const url = '/stalker/catalog/v1/items?kind=live&category=3010&page=1&pageSize=100&portal=http://p.com/c&mac=00:1A:79:AA:BB:CC';

    const first = await request(app).get(url);
    const providerCalls = deps.portalFetchRetry.mock.calls.length;
    const second = await request(app).get(url);

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ items: [], complete: true, total: 0 });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ items: [], complete: true, total: 0 });
    expect(deps.portalFetchChannelCatalog).toHaveBeenCalledTimes(1);
    expect(deps.portalFetchRetry).toHaveBeenCalledTimes(providerCalls);
  });

  it('does not publish a failed snapshot manifest after a refresh invalidates the build', async () => {
    const records = new Map();
    let release;
    let streamCalls = 0;
    const cache = cacheBackedBy(records);
    const deps = makeDeps({
      cache,
      getSession: vi.fn().mockResolvedValue(stalkerSession()),
      portalFetchRetry: vi.fn().mockImplementation((_session, params) => {
        if (params.action === 'get_genres') return { js: [{ id: '3010', title: 'Sports' }] };
        return { js: { data: [] } };
      }),
      portalFetchChannelCatalog: vi.fn(async (_session, _limit, _timeout, options) => {
        streamCalls += 1;
        if (streamCalls === 1) {
          await new Promise(resolve => { release = resolve; });
          await options?.onItem?.({ id: 1, name: 'Stale', tv_genre_id: '3010', cmd: 'stale' });
          return;
        }
        await options?.onItem?.({ id: 2, name: 'Fresh', tv_genre_id: '3010', cmd: 'fresh' });
      }),
    });
    const app = makeApp(deps);
    const url = '/stalker/catalog/v1/items?kind=live&category=3010&page=1&pageSize=1&portal=http://p.com/c&mac=00:1A:79:AA:BB:CC';
    const first = request(app).get(url).then(response => response);
    await vi.waitFor(() => expect(deps.portalFetchChannelCatalog).toHaveBeenCalledTimes(1));
    const refreshed = request(app).get(`${url}&refresh=1`).then(response => response);
    await vi.waitFor(() => expect(cache.deleteKeysByPrefix).toHaveBeenCalled());
    release();

    const firstResponse = await first;
    const refreshedResponse = await refreshed;

    expect(firstResponse.status).toBeGreaterThanOrEqual(400);
    expect(refreshedResponse.status).toBe(200);
    expect(refreshedResponse.body.items.map(item => item.id)).toEqual([2]);
    expect([...records.keys()].some(key => key.includes('|manifest'))).toBe(true);
  });

  it('does not duplicate a provider-supplied All live category', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: [
        { id: '*', title: 'All' },
        { id: '1577', title: 'Sports' },
      ] }),
    });

    const res = await request(makeApp(deps)).get('/stalker/catalog/v1/categories?kind=live');

    expect(res.status).toBe(200);
    expect(res.body.categories.map(category => category.title)).toEqual(['All', 'Sports']);
  });

  it.each(['live', 'vod', 'series'])('normalizes aggregate categories for %s', async kind => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: [
        { id: '*', title: 'All' },
        { id: 'all', title: 'Everything' },
        { id: '1577', title: 'Sports', count: null },
      ] }),
    });

    const res = await request(makeApp(deps)).get(`/stalker/catalog/v1/categories?kind=${kind}`);

    expect(res.status).toBe(200);
    expect(res.body.categories.filter(category => category.aggregate)).toEqual([
      { id: 'all', title: 'All', count: null, aggregate: true },
    ]);
    expect(res.body.categories.filter(category => category.id === '1577')).toEqual([
      { id: '1577', title: 'Sports', count: null, aggregate: false },
    ]);
  });

  it('probes one additional page and marks pagination supported', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn()
        .mockResolvedValueOnce({ js: { data: [{ id: 1, name: 'One', cmd: 'one' }], total_items: 2 } })
        .mockResolvedValueOnce({ js: { data: [{ id: 2, name: 'Two', cmd: 'two' }], total_items: 2 } }),
    });
    const res = await request(makeApp(deps)).get('/stalker/catalog/v1/items?kind=vod&category=1&page=1&pageSize=1');
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(deps.portalFetchRetry).toHaveBeenCalledTimes(2));
    expect(res.body.capabilities.pagination).toBe('unknown');
    expect(res.body.hasMore).toBe(true);
  });

  it('rejects invalid page sizes before contacting the provider', async () => {
    const deps = makeDeps();
    const res = await request(makeApp(deps)).get('/stalker/catalog/v1/items?kind=vod&category=1&pageSize=251');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_parameter');
    expect(deps.getSession).not.toHaveBeenCalled();
  });

  it('builds bounded live snapshot pages when the portal ignores pagination', async () => {
    const records = new Map();
    const deps = makeDeps({
      cache: {
        ...makeDeps().cache,
        get: vi.fn(key => records.get(key)),
        set: vi.fn((key, value) => records.set(key, value)),
      },
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', portal: 'https://p.com/c/', mac: '00:1a:79:aa:bb:cc', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { data: [
        { id: 1, name: 'One', cmd: 'one' },
        { id: 2, name: 'Two', cmd: 'two' },
      ] } }),
      portalFetchChannelCatalog: vi.fn(async (_session, _limit, _timeout, options) => {
        const items = [
          { id: 1, name: 'One', cmd: 'one' },
          { id: 2, name: 'Two', cmd: 'two' },
          { id: 3, name: 'Three', cmd: 'three' },
        ];
        if (options?.onItem) {
          for (const item of items) await options.onItem(item);
          return items.length;
        }
        return items;
      }),
    });
    const app = makeApp(deps);
    const first = await request(app).get('/stalker/catalog/v1/items?kind=live&category=all&page=1&pageSize=2&snapshot=1');
    const second = await request(app).get('/stalker/catalog/v1/items?kind=live&category=all&page=2&pageSize=2&snapshot=1');

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ hasMore: true, capabilities: { mode: 'bounded_live_snapshot' } });
    expect(first.body.items.map(item => item.id)).toEqual([1, 2]);
    expect(second.status).toBe(200);
    expect(second.body.items.map(item => item.id)).toEqual([3]);
    expect(second.body.hasMore).toBe(false);
    const beyond = await request(app).get('/stalker/catalog/v1/items?kind=live&category=all&page=3&pageSize=2&snapshot=1');
    expect(beyond.status).toBe(200);
    expect(beyond.body).toMatchObject({ items: [], total: 3, totalKnown: true, complete: true, hasMore: false, nextPage: null });
    expect(deps.portalFetchChannelCatalog).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown versioned catalog parameters before contacting the provider', async () => {
    const deps = makeDeps({ getSession: vi.fn() });
    const res = await request(makeApp(deps)).get('/stalker/catalog/v1/items?kind=vod&category=1&unexpected=1');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_parameter');
    expect(deps.getSession).not.toHaveBeenCalled();
  });

  it('rejects item-only parameters on the categories endpoint', async () => {
    const deps = makeDeps({ getSession: vi.fn() });
    const res = await request(makeApp(deps)).get('/stalker/catalog/v1/categories?kind=vod&page=2');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_parameter');
    expect(deps.getSession).not.toHaveBeenCalled();
  });

  it('rejects a missing VOD category on the items endpoint', async () => {
    const deps = makeDeps({ getSession: vi.fn() });
    const res = await request(makeApp(deps)).get('/stalker/catalog/v1/items?kind=vod&page=1&pageSize=100');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_parameter');
    expect(deps.getSession).not.toHaveBeenCalled();
  });

  it('rejects refresh on the search endpoint', async () => {
    const deps = makeDeps({ getSession: vi.fn() });
    const res = await request(makeApp(deps)).get('/stalker/catalog/v1/search?kind=vod&query=movie&refresh=1');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_parameter');
    expect(deps.getSession).not.toHaveBeenCalled();
  });

  it('does not let refresh coalesce with or republish an older page request', async () => {
    let calls = 0;
    let releaseFirst;
    let refreshInvalidated = false;
    const firstPayload = new Promise(resolve => { releaseFirst = resolve; });
    const deps = makeDeps({
      cache: {
        ...makeDeps().cache,
        deleteKeysByPrefix: vi.fn(() => { refreshInvalidated = true; }),
      },
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn(() => {
        calls += 1;
        return calls === 1
          ? firstPayload
          : Promise.resolve({ js: { data: [{ id: 2, name: 'Fresh', cmd: 'fresh' }], total_items: 1 } });
      }),
    });
    const app = makeApp(deps);
    const query = '/stalker/catalog/v1/items?kind=vod&category=1&page=1&pageSize=100';
    const first = request(app).get(query);
    const firstStarted = first.then(response => response);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(calls).toBe(1);
    const refreshed = request(app).get(`${query}&refresh=1`).then(response => response);
    while (!refreshInvalidated) await new Promise(resolve => setTimeout(resolve, 0));
    releaseFirst({ js: { data: [{ id: 1, name: 'Stale', cmd: 'stale' }], total_items: 1 } });
    const staleResponse = await firstStarted;
    expect(staleResponse.status).toBe(409);
    expect(staleResponse.body.code).toBe('catalog_superseded');

    const freshResponse = await refreshed;
    expect(freshResponse.status).toBe(200);
    expect(freshResponse.body.items[0].id).toBe(2);
  });

  it('verifies provider search with a distinct probe before enabling it', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn()
        .mockResolvedValueOnce({ js: { data: [{ id: 1, name: 'Movie', cmd: 'movie' }] } })
        .mockResolvedValueOnce({ js: { data: [{ id: 2, name: 'Other', cmd: 'other' }] } }),
    });
    const res = await request(makeApp(deps)).get('/stalker/catalog/v1/search?kind=vod&category=1&query=movie&page=1&pageSize=100');

    expect(res.status).toBe(200);
    expect(deps.portalFetchRetry).toHaveBeenCalledTimes(2);
    expect(deps.portalFetchRetry.mock.calls[1][1].search).toContain('__sv_probe_');
    expect(res.body.capabilities.search).toBe('supported');
  });

  it('recovers an inconclusive search without probing until a later request', async () => {
    const records = new Map();
    const responses = [
      { js: { data: [] } },
      { js: { data: [] } },
      { js: { data: [{ id: 2, name: 'Movie', cmd: 'movie-2' }] } },
      { js: { data: [{ id: 3, name: 'Movie', cmd: 'movie-3' }] } },
      { js: { data: [{ id: 4, name: 'Other', cmd: 'other-4' }] } },
    ];
    const deps = makeDeps({
      cache: {
        ...makeDeps().cache,
        get: vi.fn(key => records.get(key)),
        set: vi.fn((key, value) => records.set(key, value)),
      },
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockImplementation(() => Promise.resolve(responses.shift())),
    });
    const app = makeApp(deps);
    const query = '/stalker/catalog/v1/search?kind=vod&category=1&query=movie&page=1&pageSize=100';

    const inconclusive = await request(app).get(query);
    const recovered = await request(app).get(query);
    const classified = await request(app).get(query);

    expect(inconclusive.status).toBe(200);
    expect(inconclusive.body.capabilities.search).toBe('inconclusive');
    expect(recovered.status).toBe(200);
    expect(recovered.body.items).toHaveLength(1);
    expect(recovered.body.capabilities.search).toBe('unknown');
    expect(classified.status).toBe(200);
    expect(classified.body.capabilities.search).toBe('supported');
    expect(deps.portalFetchRetry).toHaveBeenCalledTimes(5);
  });

  it('rejects providers that return the same catalog for the search probe', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { data: [{ id: 1, name: 'Everything', cmd: 'one' }] } }),
    });
    const res = await request(makeApp(deps)).get('/stalker/catalog/v1/search?kind=vod&category=1&query=movie&page=1&pageSize=100');

    expect(res.status).toBe(501);
    expect(res.body.code).toBe('provider_search_unsupported');
    expect(deps.portalFetchRetry).toHaveBeenCalledTimes(2);
  });
});

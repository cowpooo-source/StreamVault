import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { Readable } from 'stream';
import { createStalkerRouter } from '../src/routes/stalker';

describe('Integration Tests - Routes', () => {
  let app;
  let mockAuth;
  let mockCache;

  beforeAll(async () => {
    // 1. Set environment variables
    process.env.ADMIN_PASS = 'secret';
    process.env.JWT_SECRET = 'test-secret';

    // 2. Define mocks
    mockAuth = {
      init: vi.fn(),
      verifyToken: vi.fn(),
      optionalAuth: vi.fn((req, res, next) => {
        req.user = null;
        next();
      }),
      requireAuth: vi.fn((req, res, next) => {
        if (req.headers.authorization === 'Bearer valid-token') {
          req.user = { id: 1, username: 'testuser', role: 'regular' };
          return next();
        }
        res.status(401).json({ error: 'Authentication required' });
      }),
      requireRole: vi.fn((role) => (req, res, next) => next()),
      authenticate: vi.fn(),
      revokeToken: vi.fn(),
      cleanupSessions: vi.fn(),
      getAuthStats: vi.fn().mockReturnValue({}),
      ROLE_LIMITS: {
        regular: { maxConnections: 5 }
      }
    };

    mockCache = {
      trackRequest: vi.fn(),
      trackVisitor: vi.fn(),
      trackGuest: vi.fn(),
      trackWatch: vi.fn(),
      trackGuestActivity: vi.fn(),
      saveFeedback: vi.fn(),
      getFeedback: vi.fn().mockReturnValue([]),
      saveGuestData: vi.fn(),
      getGuestData: vi.fn(),
      deleteGuestData: vi.fn(),
      deleteByPrefix: vi.fn(),
      get: vi.fn(),
      set: vi.fn(),
      trackPortal: vi.fn(),
      trackPortalHealth: vi.fn(),
      getStats: vi.fn().mockReturnValue({
        activeNow: 0, health: {}, visitors: {}, recentVisitors: [], guests: {},
        recentGuests: [], mostWatched: [], portals: [], portalsByType: {},
        engagement: {}, cacheTotal: 0, cacheValid: 0, cacheSizeMB: 0,
        cacheHitRate: 0, cacheHits: 0, cacheMisses: 0, cacheBreakdown: {},
        todayReqs: {}, daily: {}
      }),
      db: {
        prepare: vi.fn().mockReturnValue({
          all: vi.fn().mockReturnValue([]),
          get: vi.fn().mockReturnValue({}),
          run: vi.fn()
        })
      }
    };

    // 3. Register mocks BEFORE requiring app
    vi.doMock('../src/auth', () => mockAuth);
    vi.doMock('../src/cache', () => mockCache);
    vi.doMock('../src/services/system', () => ({
      getNetworkStats: vi.fn().mockReturnValue({ rx_bytes: 0, tx_bytes: 0, rx_gb: 0, tx_gb: 0 }),
      getDiskUsage: vi.fn().mockReturnValue({ total_gb: 100, used_gb: 50, percent: 50 }),
      trackDailyBandwidth: vi.fn(),
      getLastNetStat: vi.fn(),
      setLastNetStat: vi.fn(),
      getSystemMetrics: vi.fn().mockReturnValue({})
    }));

    // 4. Require app factory and its real components (which will be replaced by mocks via vi.doMock)
    vi.resetModules();
    const { createApp } = require('../src/app');
    
    // Inject the MOCKED dependencies defined above directly into the factory!
    app = createApp({ 
      auth: mockAuth, 
      cache: mockCache, 
      fetch: vi.fn(), // we can mock fetch here too if needed
      system: {
        getNetworkStats: vi.fn().mockReturnValue({ rx_bytes: 0, tx_bytes: 0, rx_gb: 0, tx_gb: 0 }),
        getDiskUsage: vi.fn().mockReturnValue({ total_gb: 100, used_gb: 50, percent: 50 }),
        trackDailyBandwidth: vi.fn(),
        getLastNetStat: vi.fn(),
        setLastNetStat: vi.fn(),
        getSystemMetrics: vi.fn().mockReturnValue({})
      },
      email: {
        sendPasswordReset: vi.fn().mockResolvedValue(true)
      }
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /health returns 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('POST /api/track returns 200', async () => {
    const res = await request(app)
      .post('/api/track')
      .send({ name: 'Test', type: 'live', event: 'play' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /api/auth/login returns 200 on success', async () => {
    mockAuth.authenticate.mockResolvedValue({
      token: 'valid-token',
      user: { id: 1, username: 'testuser', role: 'regular' }
    });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'testuser', password: 'Password123' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBe('valid-token');
  });

  it('GET /api/analytics returns 200 with valid token', async () => {
    const res = await request(app)
      .get('/api/analytics')
      .set('x-admin-token', 'secret');
    expect(res.status).toBe(200);
  });

  // --- Stalker Proxy Smoke Tests ---
  
  it('POST /stalker/validate returns 400 without params', async () => {
    const res = await request(app).post('/stalker/validate').send({});
    expect(res.status).toBe(400);
  });

  it('GET /stalker/series/categories returns 400 without params', async () => {
    const res = await request(app).get('/stalker/series/categories');
    expect(res.status).toBe(400);
  });

  it('GET /stalker/series returns 400 without params', async () => {
    const res = await request(app).get('/stalker/series');
    expect(res.status).toBe(400);
  });

  it('GET /stalker/series/seasons returns 400 without params', async () => {
    const res = await request(app).get('/stalker/series/seasons');
    expect(res.status).toBe(400);
  });

  it('GET /stalker/series/episode/stream returns 400 without params', async () => {
    const res = await request(app).get('/stalker/series/episode/stream');
    expect(res.status).toBe(400);
  });

  it('GET /stalker/vod returns items with playable url', async () => {
    const miniApp = express();
    const deps = {
      cache: {
        get: vi.fn().mockReturnValue(null),
        set: vi.fn(),
        trackCacheHit: vi.fn(),
        trackCacheMiss: vi.fn(),
        cacheKey: (portal, mac, endpoint, extra) => `${portal}|${mac}|${endpoint}|${extra || ''}`,
      },
      auth: mockAuth,
      fetch: vi.fn(),
      isUrlAllowed: vi.fn().mockResolvedValue(true),
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://portal/', apiPath: 'server/load.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({
        js: {
          data: [
            { id: '1', name: 'Movie', cmd: 'ffmpeg http://example.com/movie.m3u8', screenshot_uri: null, year: 2024, rating_imdb: '8.2' },
          ],
          total_pages: 1,
        },
      }),
      safeError: vi.fn((e) => e?.message || 'error'),
      buildStalkerStreamHeaders: vi.fn().mockReturnValue({}),
      summarizeUpstreamHeaders: vi.fn(),
    };
    miniApp.use(express.json());
    miniApp.use('/stalker', createStalkerRouter(deps));

    const res = await request(miniApp).get('/stalker/vod?portal=http://p.test/c/&mac=00:11:22:33:44:55&cat=1');
    expect(res.status).toBe(200);
    expect(res.body.items[0].url).toBe('ffmpeg http://example.com/movie.m3u8');
  });

  it('GET /stalker/play resolves series episode parameters and normalizes localhost URLs', async () => {
    const miniApp = express();
    const portalFetchRetry = vi.fn().mockResolvedValue({
      js: { cmd: 'http://localhost:8080/stream.m3u8' }
    });
    const getSession = vi.fn().mockResolvedValue({ token: 't', base: 'https://portal/', apiPath: 'server/load.php', headers: {}, refresh: vi.fn() });
    const deps = {
      cache: {
        get: vi.fn(),
        set: vi.fn(),
        trackCacheHit: vi.fn(),
        trackCacheMiss: vi.fn(),
        trackWatch: vi.fn(),
        trackPortalHealth: vi.fn(),
        cacheKey: (portal, mac, endpoint, extra) => `${portal}|${mac}|${endpoint}|${extra || ''}`,
      },
      auth: mockAuth,
      fetch: vi.fn(),
      isUrlAllowed: vi.fn().mockResolvedValue(true),
      getSession,
      portalFetchRetry,
      safeError: vi.fn((e) => e?.message || 'error'),
      buildStalkerStreamHeaders: vi.fn().mockReturnValue({}),
      summarizeUpstreamHeaders: vi.fn().mockReturnValue({ contentType: 'application/vnd.apple.mpegurl' }),
    };
    miniApp.use(express.json());
    miniApp.use('/stalker', createStalkerRouter(deps));

    const res = await request(miniApp).get('/stalker/play?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55&cmd=ABC&content_type=series&episode=7&resolve=1');
    expect(res.status).toBe(200);
    expect(portalFetchRetry).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      type: 'vod',
      action: 'create_link',
      cmd: 'ABC',
      series: '7',
      forced_storage: 0,
      disable_ad: 0,
      download: 0,
      force_ch_link_check: 0,
    }));
    expect(res.body.url).toBe('http://portal.example.com/stream.m3u8');
  });

  it('GET /stalker/play rewrites HLS manifests through /stream', async () => {
    const miniApp = express();
    const portalFetchRetry = vi.fn().mockResolvedValue({
      js: { cmd: 'http://cdn.example.com/live/index.m3u8' }
    });
    const getSession = vi.fn().mockResolvedValue({ token: 't', base: 'https://portal/', apiPath: 'server/load.php', headers: {}, refresh: vi.fn() });
    const deps = {
      cache: {
        get: vi.fn(),
        set: vi.fn(),
        trackCacheHit: vi.fn(),
        trackCacheMiss: vi.fn(),
        trackWatch: vi.fn(),
        trackPortalHealth: vi.fn(),
        cacheKey: (portal, mac, endpoint, extra) => `${portal}|${mac}|${endpoint}|${extra || ''}`,
      },
      auth: mockAuth,
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: {
          get: (key) => {
            if (key === 'content-type') return 'application/vnd.apple.mpegurl';
            if (key === 'content-length') return null;
            if (key === 'content-range') return null;
            return null;
          }
        },
        body: Readable.from(['#EXTM3U\nsegment.ts\n'])
      }),
      isUrlAllowed: vi.fn().mockResolvedValue(true),
      getSession,
      portalFetchRetry,
      safeError: vi.fn((e) => e?.message || 'error'),
      buildStalkerStreamHeaders: vi.fn().mockReturnValue({}),
      summarizeUpstreamHeaders: vi.fn().mockReturnValue({ contentType: 'application/vnd.apple.mpegurl' }),
    };
    miniApp.use(express.json());
    miniApp.use('/stalker', createStalkerRouter(deps));

    const res = await request(miniApp).get('/stalker/play?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55&cmd=ABC');
    expect(res.status).toBe(200);
    expect(res.text).toContain('/stream?url=');
    expect(res.text).toContain(encodeURIComponent('http://cdn.example.com/live/segment.ts'));
    expect(deps.cache.trackWatch).toHaveBeenCalledWith('ABC', 'live');
  });

  it('GET /stalker/stream sends legacy create_link params and normalizes localhost URLs', async () => {
    const miniApp = express();
    const portalFetchRetry = vi.fn().mockResolvedValue({
      js: { cmd: 'ffmpeg http://127.0.0.1:8080/live.m3u8' }
    });
    const getSession = vi.fn().mockResolvedValue({ token: 't', base: 'https://portal/', apiPath: 'server/load.php', headers: {}, refresh: vi.fn() });
    const deps = {
      cache: {
        get: vi.fn(),
        set: vi.fn(),
        trackCacheHit: vi.fn(),
        trackCacheMiss: vi.fn(),
        trackWatch: vi.fn(),
        trackPortalHealth: vi.fn(),
        cacheKey: (portal, mac, endpoint, extra) => `${portal}|${mac}|${endpoint}|${extra || ''}`,
      },
      auth: mockAuth,
      fetch: vi.fn(),
      isUrlAllowed: vi.fn().mockResolvedValue(true),
      getSession,
      portalFetchRetry,
      safeError: vi.fn((e) => e?.message || 'error'),
      buildStalkerStreamHeaders: vi.fn().mockReturnValue({}),
      summarizeUpstreamHeaders: vi.fn().mockReturnValue({}),
    };
    miniApp.use(express.json());
    miniApp.use('/stalker', createStalkerRouter(deps));

    const res = await request(miniApp).get('/stalker/stream?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55&cmd=ABC&content_type=series');
    expect(res.status).toBe(200);
    expect(portalFetchRetry).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      type: 'vod',
      action: 'create_link',
      cmd: 'ABC',
      series: 0,
      forced_storage: 0,
      disable_ad: 0,
      download: 0,
      force_ch_link_check: 0,
    }));
    expect(res.body.url).toBe('http://portal.example.com/live.m3u8');
  });

  it('POST /stalker/validate returns the expanded legacy shape', async () => {
    const miniApp = express();
    const portalFetchRetry = vi.fn()
      .mockResolvedValueOnce({ js: { serial_number: 'SN1', device_id: 'D1', device_id2: 'D2' } })
      .mockResolvedValueOnce({ js: { status: 0, expire_billing_date: '2030-01-01', tariff: 'Gold', phone: '123', max_connections: 4, id: 'abc' } });
    const getSession = vi.fn().mockResolvedValue({ token: 'tok', base: 'https://portal/', apiPath: 'server/load.php', headers: {}, refresh: vi.fn() });
    const deps = {
      cache: {
        get: vi.fn(),
        set: vi.fn(),
        trackCacheHit: vi.fn(),
        trackCacheMiss: vi.fn(),
        trackWatch: vi.fn(),
        trackPortalHealth: vi.fn(),
        trackRequest: vi.fn(),
        cacheKey: (portal, mac, endpoint, extra) => `${portal}|${mac}|${endpoint}|${extra || ''}`,
      },
      auth: mockAuth,
      fetch: vi.fn(),
      isUrlAllowed: vi.fn().mockResolvedValue(true),
      getSession,
      portalFetchRetry,
      safeError: vi.fn((e) => e?.message || 'error'),
      buildStalkerStreamHeaders: vi.fn().mockReturnValue({}),
      summarizeUpstreamHeaders: vi.fn().mockReturnValue({}),
    };
    miniApp.use(express.json());
    miniApp.use('/stalker', createStalkerRouter(deps));

    const res = await request(miniApp).post('/stalker/validate').send({ portal: 'http://portal.example.com/c/', mac: '00:11:22:33:44:55' });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.portalReachable).toBe(true);
    expect(res.body.status).toBe('active');
    expect(res.body.expiry).toBe('2030-01-01');
    expect(res.body.token).toBe('tok');
  });

  it('GET /stalker/profile, /stalker/account, and /stalker passthrough respond', async () => {
    const miniApp = express();
    const portalFetchRetry = vi.fn()
      .mockResolvedValueOnce({ js: { profile: true } })
      .mockResolvedValueOnce({ js: { account: true } })
      .mockResolvedValueOnce({ js: { ok: true } });
    const getSession = vi.fn().mockResolvedValue({ token: 'tok', base: 'https://portal/', apiPath: 'server/load.php', headers: {}, refresh: vi.fn() });
    const trackRequest = vi.fn();
    const deps = {
      cache: {
        get: vi.fn(),
        set: vi.fn(),
        trackCacheHit: vi.fn(),
        trackCacheMiss: vi.fn(),
        trackWatch: vi.fn(),
        trackPortalHealth: vi.fn(),
        trackRequest,
        cacheKey: (portal, mac, endpoint, extra) => `${portal}|${mac}|${endpoint}|${extra || ''}`,
      },
      auth: mockAuth,
      fetch: vi.fn(),
      isUrlAllowed: vi.fn().mockResolvedValue(true),
      getSession,
      portalFetchRetry,
      safeError: vi.fn((e) => e?.message || 'error'),
      buildStalkerStreamHeaders: vi.fn().mockReturnValue({}),
      summarizeUpstreamHeaders: vi.fn().mockReturnValue({}),
    };
    miniApp.use(express.json());
    miniApp.use('/stalker', createStalkerRouter(deps));

    const profileRes = await request(miniApp).get('/stalker/profile?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55');
    const accountRes = await request(miniApp).get('/stalker/account?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55');
    const rootRes = await request(miniApp).get('/stalker/?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55&action=get_info');

    expect(profileRes.status).toBe(200);
    expect(profileRes.body.profile).toBe(true);
    expect(accountRes.status).toBe(200);
    expect(accountRes.body.account).toBe(true);
    expect(rootRes.status).toBe(200);
    expect(rootRes.body.js.ok).toBe(true);
    expect(trackRequest).toHaveBeenCalled();
  });
});

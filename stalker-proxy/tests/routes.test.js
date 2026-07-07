import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { Readable } from 'stream';
import { createStalkerRouter } from '../src/routes/stalker';

describe('Integration Tests - Routes', () => {
  let app;
  let mockAuth;
  let mockCache;
  let mockFetch;

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
    mockFetch = vi.fn();
    app = createApp({ 
      auth: mockAuth, 
      cache: mockCache, 
      fetch: mockFetch, // shared fetch mock for player routes
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
    const { tokens, playbackSessions } = require("../src/routes/player");
    tokens.clear();
    playbackSessions.clear();
  });

  it('GET /health returns 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });


  it('POST /api/play-token issues a playbackId and refreshes to a new URL', async () => {
    mockAuth.verifyToken.mockReturnValue({ id: 1, username: 'testuser', role: 'regular' });
    mockFetch.mockResolvedValueOnce({
      url: 'http://provider.example.com/live/index.m3u8?token=old',
      body: { cancel: vi.fn() },
    });
    mockFetch.mockResolvedValueOnce({
      url: 'http://provider.example.com/live/index.m3u8?token=new',
      body: { cancel: vi.fn() },
    });

    const playRes = await request(app)
      .post('/api/play-token')
      .set('authorization', 'Bearer valid-token')
      .send({ url: 'http://provider.example.com/live/index.m3u8' });

    expect(playRes.status).toBe(200);
    expect(playRes.body.playerUrl).toContain('/player?token=');

    const validateRes = await request(app)
      .get(`/api/validate-token?token=${playRes.body.token}`);

    expect(validateRes.status).toBe(200);
    expect(validateRes.body.playbackId).toBeTruthy();

    const refreshRes = await request(app)
      .get(`/api/refresh-playback?playbackId=${validateRes.body.playbackId}`);

    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.url).toContain('token=new');
  });
  it('GET /player serves direct-play HTML without the VPS stream proxy rewrite', async () => {
    const res = await request(app).get('/player?token=test-token');

    expect(res.status).toBe(200);
    expect(res.text).toContain("hls.js");
    expect(res.text).toContain("mpegts.js");
    expect(res.text).toContain("CODECS=\"avc1.4d401f,mp4a.40.5\"");
    expect(res.text).toContain("String.fromCharCode(10)");
    expect(res.text).toContain("Account Blocked (456)");
    expect(res.text).toContain("Rate Limited (429)");
    expect(res.text).toContain("Network error - could not load stream");
    expect(res.text).toContain("startMpegts");
    expect(res.text).toContain("refreshStream");
    expect(res.text).not.toContain("/stream?url=");
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

  it('GET /stream keeps rewritten HLS URLs relative to the current origin', async () => {
    const { createApp } = require('../src/app');
    const miniApp = createApp({
      auth: mockAuth,
      cache: mockCache,
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

    const res = await request(miniApp)
      .get('/stream?url=https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8')
      .set('Host', 'play.portalheaven.stream');

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/^\/stream\?url=https%3A%2F%2Ftest-streams.mux.dev%2Fx36xhzz%2Fsegment.ts$/m);
    expect(res.text).not.toContain('http://play.portalheaven.stream/stream?url=');
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

  // --- Additional integration smoke tests ---

  it('POST /stalker/validate returns 400 when portal is missing', async () => {
    const miniApp = express();
    const deps = {
      cache: { get: vi.fn(), set: vi.fn(), trackCacheHit: vi.fn(), trackCacheMiss: vi.fn(), trackWatch: vi.fn(), trackPortalHealth: vi.fn(), trackRequest: vi.fn(), cacheKey: vi.fn() },
      auth: mockAuth,
      fetch: vi.fn(),
      isUrlAllowed: vi.fn().mockResolvedValue(true),
      getSession: vi.fn(),
      portalFetchRetry: vi.fn(),
      safeError: vi.fn((e) => e?.message || 'error'),
      buildStalkerStreamHeaders: vi.fn().mockReturnValue({}),
      summarizeUpstreamHeaders: vi.fn().mockReturnValue({}),
    };
    miniApp.use(express.json());
    miniApp.use('/stalker', createStalkerRouter(deps));

    const res = await request(miniApp).post('/stalker/validate').send({ mac: '00:11:22:33:44:55' });
    expect(res.status).toBe(400);
  });

  it('POST /stalker/validate returns 400 when mac is missing', async () => {
    const miniApp = express();
    const deps = {
      cache: { get: vi.fn(), set: vi.fn(), trackCacheHit: vi.fn(), trackCacheMiss: vi.fn(), trackWatch: vi.fn(), trackPortalHealth: vi.fn(), trackRequest: vi.fn(), cacheKey: vi.fn() },
      auth: mockAuth,
      fetch: vi.fn(),
      isUrlAllowed: vi.fn().mockResolvedValue(true),
      getSession: vi.fn(),
      portalFetchRetry: vi.fn(),
      safeError: vi.fn((e) => e?.message || 'error'),
      buildStalkerStreamHeaders: vi.fn().mockReturnValue({}),
      summarizeUpstreamHeaders: vi.fn().mockReturnValue({}),
    };
    miniApp.use(express.json());
    miniApp.use('/stalker', createStalkerRouter(deps));

    const res = await request(miniApp).post('/stalker/validate').send({ portal: 'http://portal.example.com/c/' });
    expect(res.status).toBe(400);
  });

  it('POST /stalker/validate returns 502 when upstream fails', async () => {
    const miniApp = express();
    const getSession = vi.fn().mockRejectedValue(new Error('Upstream portal unreachable'));
    const deps = {
      cache: { get: vi.fn(), set: vi.fn(), trackCacheHit: vi.fn(), trackCacheMiss: vi.fn(), trackWatch: vi.fn(), trackPortalHealth: vi.fn(), trackRequest: vi.fn(), cacheKey: vi.fn() },
      auth: mockAuth,
      fetch: vi.fn(),
      isUrlAllowed: vi.fn().mockResolvedValue(true),
      getSession,
      portalFetchRetry: vi.fn(),
      safeError: vi.fn((e) => e?.message || 'error'),
      buildStalkerStreamHeaders: vi.fn().mockReturnValue({}),
      summarizeUpstreamHeaders: vi.fn().mockReturnValue({}),
    };
    miniApp.use(express.json());
    miniApp.use('/stalker', createStalkerRouter(deps));

    const res = await request(miniApp).post('/stalker/validate').send({ portal: 'http://portal.example.com/c/', mac: '00:11:22:33:44:55' });
    expect(res.status).toBe(200); // validate always returns 200 with result object
    expect(res.body.valid).toBe(false);
    expect(res.body.error).toBe('Upstream portal unreachable');
  });

  it('POST /stalker/validate marks account as expired when daysLeft < 0', async () => {
    const miniApp = express();
    const portalFetchRetry = vi.fn()
      .mockResolvedValueOnce({ js: { serial_number: 'SN1' } })
      .mockResolvedValueOnce({ js: { status: 0, expire_billing_date: '2020-01-01', tariff: 'Gold', id: 'abc' } });
    const getSession = vi.fn().mockResolvedValue({ token: 'tok', base: 'https://portal/', apiPath: 'server/load.php', headers: {}, refresh: vi.fn() });
    const deps = {
      cache: { get: vi.fn(), set: vi.fn(), trackCacheHit: vi.fn(), trackCacheMiss: vi.fn(), trackWatch: vi.fn(), trackPortalHealth: vi.fn(), trackRequest: vi.fn(), cacheKey: vi.fn() },
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
    expect(res.body.valid).toBe(false);
    expect(res.body.status).toBe('expired');
    expect(res.body.daysLeft).toBeLessThan(0);
  });

  it('POST /stalker/validate marks account as suspended when status is 2', async () => {
    const miniApp = express();
    const portalFetchRetry = vi.fn()
      .mockResolvedValueOnce({ js: { serial_number: 'SN1' } })
      .mockResolvedValueOnce({ js: { status: 2 } });
    const getSession = vi.fn().mockResolvedValue({ token: 'tok', base: 'https://portal/', apiPath: 'server/load.php', headers: {}, refresh: vi.fn() });
    const deps = {
      cache: { get: vi.fn(), set: vi.fn(), trackCacheHit: vi.fn(), trackCacheMiss: vi.fn(), trackWatch: vi.fn(), trackPortalHealth: vi.fn(), trackRequest: vi.fn(), cacheKey: vi.fn() },
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
    expect(res.body.status).toBe('suspended');
  });

  it('POST /stalker/validate marks account as blocked when empty info returned', async () => {
    const miniApp = express();
    const portalFetchRetry = vi.fn()
      .mockResolvedValueOnce({ js: { serial_number: 'SN1' } })
      .mockResolvedValueOnce({ js: {} });
    const getSession = vi.fn().mockResolvedValue({ token: 'tok', base: 'https://portal/', apiPath: 'server/load.php', headers: {}, refresh: vi.fn() });
    const deps = {
      cache: { get: vi.fn(), set: vi.fn(), trackCacheHit: vi.fn(), trackCacheMiss: vi.fn(), trackWatch: vi.fn(), trackPortalHealth: vi.fn(), trackRequest: vi.fn(), cacheKey: vi.fn() },
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
    expect(res.body.status).toBe('blocked');
    expect(res.body.error).toContain('empty info');
  });

  it('GET /stalker/play normalizes localhost in resolved stream URL', async () => {
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
    // localhost:8080 rewritten to portal host
    expect(res.body.url).toBe('http://portal.example.com/stream.m3u8');
  });

  it('GET /stalker/play normalizes 127.0.0.1 in resolved stream URL', async () => {
    const miniApp = express();
    const portalFetchRetry = vi.fn().mockResolvedValue({
      js: { cmd: 'ffmpeg http://127.0.0.1:9090/video.m3u8' }
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
    // 127.0.0.1:9090 rewritten to portal host
    expect(res.body.url).toBe('http://portal.example.com/video.m3u8');
  });

  it('GET /stalker/play returns 403 when stream URL is not allowed', async () => {
    const miniApp = express();
    const portalFetchRetry = vi.fn().mockResolvedValue({
      js: { cmd: 'http://malicious.com/stream.m3u8' }
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
      isUrlAllowed: vi.fn().mockResolvedValue(false),
      getSession,
      portalFetchRetry,
      safeError: vi.fn((e) => e?.message || 'error'),
      buildStalkerStreamHeaders: vi.fn().mockReturnValue({}),
      summarizeUpstreamHeaders: vi.fn().mockReturnValue({}),
    };
    miniApp.use(express.json());
    miniApp.use('/stalker', createStalkerRouter(deps));

    const res = await request(miniApp).get('/stalker/play?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55&cmd=ABC&resolve=1');
    expect(res.status).toBe(403);
  });

  it('GET /stalker/series/categories returns categories on happy path', async () => {
    const miniApp = express();
    const portalFetchRetry = vi.fn().mockResolvedValue({
      js: [
        { id: 1, title: 'Action', count: 10, videos_count: 10 },
        { id: 2, title: 'Drama', count: 5 },
      ]
    });
    const getSession = vi.fn().mockResolvedValue({ token: 't', base: 'https://portal/', apiPath: 'server/load.php', headers: {}, refresh: vi.fn() });
    const deps = {
      cache: {
        get: vi.fn().mockReturnValue(null),
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

    const res = await request(miniApp).get('/stalker/series/categories?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55');
    expect(res.status).toBe(200);
    expect(res.body.categories).toHaveLength(2);
    expect(res.body.categories[0]).toMatchObject({ id: '1', title: 'Action', count: 10 });
    expect(res.body.categories[1]).toMatchObject({ id: '2', title: 'Drama', count: 5 });
    expect(deps.cache.set).toHaveBeenCalled();
  });

  it('GET /stalker/series/categories returns 502 on upstream failure', async () => {
    const miniApp = express();
    const portalFetchRetry = vi.fn().mockRejectedValue(new Error('Portal timeout'));
    const getSession = vi.fn().mockResolvedValue({ token: 't', base: 'https://portal/', apiPath: 'server/load.php', headers: {}, refresh: vi.fn() });
    const deps = {
      cache: {
        get: vi.fn().mockReturnValue(null),
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

    const res = await request(miniApp).get('/stalker/series/categories?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Portal timeout');
  });

  it('GET /stalker/series/seasons returns seasons on happy path', async () => {
    const miniApp = express();
    const portalFetchRetry = vi.fn().mockResolvedValue({
      js: {
        data: [
          {
            id: 's1',
            name: 'Season 1',
            cmd: '/episodes/s1.m3u8',
            screenshot_uri: 'http://cdn/logo.png',
            series: [
              { id: 'e1', name: 'Episode 1', cmd: 'ABC1' },
              { id: 'e2', name: 'Episode 2', cmd: 'ABC2' },
            ]
          },
          {
            id: 's2',
            name: 'Season 2',
            series: [{ id: 'e3', name: 'Episode 3', cmd: 'ABC3' }]
          }
        ]
      }
    });
    const getSession = vi.fn().mockResolvedValue({ token: 't', base: 'https://portal/', apiPath: 'server/load.php', headers: {}, refresh: vi.fn() });
    const deps = {
      cache: {
        get: vi.fn().mockReturnValue(null),
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

    const res = await request(miniApp).get('/stalker/series/seasons?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55&seriesId=123');
    expect(res.status).toBe(200);
    expect(res.body.seasons).toHaveLength(2);
    expect(res.body.seasons[0]).toMatchObject({ id: 's1', name: 'Season 1' });
    expect(res.body.seasons[0].episodes).toHaveLength(2);
    expect(res.body.seasons[1].episodes).toHaveLength(1);
    expect(deps.cache.set).toHaveBeenCalled();
    expect(deps.cache.trackCacheMiss).toHaveBeenCalled();
  });

  it('GET /stalker/series/seasons returns cached data when available', async () => {
    const miniApp = express();
    const cachedData = { seasons: [{ id: 's1', name: 'Cached Season' }] };
    const getSession = vi.fn().mockResolvedValue({ token: 't', base: 'https://portal/', apiPath: 'server/load.php', headers: {}, refresh: vi.fn() });
    const deps = {
      cache: {
        get: vi.fn().mockReturnValue(cachedData),
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
      portalFetchRetry: vi.fn(),
      safeError: vi.fn((e) => e?.message || 'error'),
      buildStalkerStreamHeaders: vi.fn().mockReturnValue({}),
      summarizeUpstreamHeaders: vi.fn().mockReturnValue({}),
    };
    miniApp.use(express.json());
    miniApp.use('/stalker', createStalkerRouter(deps));

    const res = await request(miniApp).get('/stalker/series/seasons?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55&seriesId=123');
    expect(res.status).toBe(200);
    expect(res.body.seasons).toHaveLength(1);
    expect(res.body.seasons[0].name).toBe('Cached Season');
    expect(deps.cache.trackCacheHit).toHaveBeenCalled();
  });

  it('GET /stalker/series/seasons returns 502 on upstream failure', async () => {
    const miniApp = express();
    const portalFetchRetry = vi.fn().mockRejectedValue(new Error('Portal error'));
    const getSession = vi.fn().mockResolvedValue({ token: 't', base: 'https://portal/', apiPath: 'server/load.php', headers: {}, refresh: vi.fn() });
    const deps = {
      cache: {
        get: vi.fn().mockReturnValue(null),
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

    const res = await request(miniApp).get('/stalker/series/seasons?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55&seriesId=123');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Portal error');
  });

  it('GET /stalker/series/seasons returns 400 when seriesId is missing', async () => {
    const miniApp = express();
    const deps = {
      cache: { get: vi.fn(), set: vi.fn(), trackCacheHit: vi.fn(), trackCacheMiss: vi.fn(), trackWatch: vi.fn(), trackPortalHealth: vi.fn(), cacheKey: vi.fn() },
      auth: mockAuth,
      fetch: vi.fn(),
      isUrlAllowed: vi.fn().mockResolvedValue(true),
      getSession: vi.fn(),
      portalFetchRetry: vi.fn(),
      safeError: vi.fn((e) => e?.message || 'error'),
      buildStalkerStreamHeaders: vi.fn().mockReturnValue({}),
      summarizeUpstreamHeaders: vi.fn().mockReturnValue({}),
    };
    miniApp.use(express.json());
    miniApp.use('/stalker', createStalkerRouter(deps));

    const res = await request(miniApp).get('/stalker/series/seasons?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55');
    expect(res.status).toBe(400);
  });

  it('GET /stalker/series/:seriesId/seasons returns seasons via param route', async () => {
    const miniApp = express();
    const portalFetchRetry = vi.fn().mockResolvedValue({
      js: {
        data: [
          { id: 's1', name: 'Season 1', series: [{ id: 'e1', name: 'Ep 1', cmd: 'CMD' }] }
        ]
      }
    });
    const getSession = vi.fn().mockResolvedValue({ token: 't', base: 'https://portal/', apiPath: 'server/load.php', headers: {}, refresh: vi.fn() });
    const deps = {
      cache: {
        get: vi.fn().mockReturnValue(null),
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

    const res = await request(miniApp).get('/stalker/series/456/seasons?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55');
    expect(res.status).toBe(200);
    expect(res.body.seasons).toHaveLength(1);
    expect(res.body.seasons[0].name).toBe('Season 1');
  });

  it('GET /stalker/series/episode/stream returns episode URL on happy path', async () => {
    const miniApp = express();
    const portalFetchRetry = vi.fn().mockResolvedValue({
      js: { cmd: 'http://cdn.example.com/ep1.m3u8' }
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

    const res = await request(miniApp).get('/stalker/series/episode/stream?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55&cmd=ABC&episode=5');
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('http://cdn.example.com/ep1.m3u8');
    expect(portalFetchRetry).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      series: '5',
      cmd: 'ABC',
    }));
  });

  it('GET /stalker/series/episode/stream strips ffmpeg prefix from URL', async () => {
    const miniApp = express();
    const portalFetchRetry = vi.fn().mockResolvedValue({
      js: { cmd: 'ffmpeg http://cdn.example.com/ep1.m3u8' }
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

    const res = await request(miniApp).get('/stalker/series/episode/stream?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55&cmd=ABC&episode=5');
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('http://cdn.example.com/ep1.m3u8');
  });

  it('GET /stalker/series/episode/stream returns 400 when params missing', async () => {
    const miniApp = express();
    const deps = {
      cache: { get: vi.fn(), set: vi.fn(), trackCacheHit: vi.fn(), trackCacheMiss: vi.fn(), trackWatch: vi.fn(), trackPortalHealth: vi.fn(), cacheKey: vi.fn() },
      auth: mockAuth,
      fetch: vi.fn(),
      isUrlAllowed: vi.fn().mockResolvedValue(true),
      getSession: vi.fn(),
      portalFetchRetry: vi.fn(),
      safeError: vi.fn((e) => e?.message || 'error'),
      buildStalkerStreamHeaders: vi.fn().mockReturnValue({}),
      summarizeUpstreamHeaders: vi.fn().mockReturnValue({}),
    };
    miniApp.use(express.json());
    miniApp.use('/stalker', createStalkerRouter(deps));

    const res = await request(miniApp).get('/stalker/series/episode/stream?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55&cmd=ABC');
    expect(res.status).toBe(400);
  });

  it('GET /stalker/series/episode/stream returns 502 when no URL returned', async () => {
    const miniApp = express();
    const portalFetchRetry = vi.fn().mockResolvedValue({ js: {} });
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

    const res = await request(miniApp).get('/stalker/series/episode/stream?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55&cmd=ABC&episode=5');
    expect(res.status).toBe(502);
  });

  it('GET /stalker/vod/categories returns vod categories', async () => {
    const miniApp = express();
    const portalFetchRetry = vi.fn().mockResolvedValue({
      js: [
        { id: 1, title: 'Movies', count: 20 },
        { id: 2, title: 'Documentaries', count: 5 },
      ]
    });
    const getSession = vi.fn().mockResolvedValue({ token: 't', base: 'https://portal/', apiPath: 'server/load.php', headers: {}, refresh: vi.fn() });
    const deps = {
      cache: {
        get: vi.fn().mockReturnValue(null),
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

    const res = await request(miniApp).get('/stalker/vod/categories?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55');
    expect(res.status).toBe(200);
    expect(res.body.categories).toHaveLength(2);
    expect(res.body.categories[0]).toMatchObject({ id: '1', title: 'Movies', count: 20 });
  });

  it('GET /stalker/vod returns mapped items', async () => {
    const miniApp = express();
    const portalFetchRetry = vi.fn().mockResolvedValue({
      js: {
        data: [
          { id: '1', name: 'Film A', year: 2023, rating_imdb: '8.5', cmd: 'ffmpeg http://a.com/a.m3u8', screenshot_uri: 'http://a.com/cover.jpg' },
          { id: '2', name: 'Film B', year: 2022, cover: 'http://b.com/c.jpg' },
        ],
        total_pages: 1,
      }
    });
    const getSession = vi.fn().mockResolvedValue({ token: 't', base: 'https://portal/', apiPath: 'server/load.php', headers: {}, refresh: vi.fn() });
    const deps = {
      cache: {
        get: vi.fn().mockReturnValue(null),
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

    const res = await request(miniApp).get('/stalker/vod?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55&cat=1');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toMatchObject({ id: '1', name: 'Film A', year: 2023, rating: '8.5', type: 'vod' });
    expect(res.body.items[0].url).toBe('ffmpeg http://a.com/a.m3u8');
    expect(res.body.items[1].logo).toBe('http://b.com/c.jpg');
  });

  it('GET /stalker/vod handles multi-page fetching', async () => {
    const miniApp = express();
    let callCount = 0;
    const portalFetchRetry = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ js: { data: [{ id: '1', name: 'Film 1' }], total_pages: 3 } });
      }
      return Promise.resolve({ js: { data: [{ id: String(callCount), name: `Film ${callCount}` }] } });
    });
    const getSession = vi.fn().mockResolvedValue({ token: 't', base: 'https://portal/', apiPath: 'server/load.php', headers: {}, refresh: vi.fn() });
    const deps = {
      cache: {
        get: vi.fn().mockReturnValue(null),
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

    const res = await request(miniApp).get('/stalker/vod?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55&cat=1');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(2);
    expect(portalFetchRetry).toHaveBeenCalledTimes(3);
  });

  it('GET /stalker/epg returns EPG programs', async () => {
    const miniApp = express();
    const portalFetchRetry = vi.fn().mockResolvedValue({
      js: {
        data: {
          'ch1': [
            { name: 'Show A', start_timestamp: 1716403200, stop_timestamp: 1716406800 },
            { name: 'Show B', start_timestamp: 1716406800, stop_timestamp: 1716410400 },
          ]
        }
      }
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

    const res = await request(miniApp).get('/stalker/epg?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55');
    expect(res.status).toBe(200);
    expect(res.body.programs).toBeDefined();
    expect(res.body.programs['ch1']).toBeDefined();
    expect(res.body.programs['ch1'][0]).toMatchObject({ title: 'Show A' });
    expect(res.body.programs['ch1'][0].start).toBe(1716403200000);
  });

  it('GET /stalker/epg returns 502 on upstream failure', async () => {
    const miniApp = express();
    const portalFetchRetry = vi.fn().mockRejectedValue(new Error('EPG server down'));
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

    const res = await request(miniApp).get('/stalker/epg?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('EPG server down');
  });

  it('GET /stalker/channels returns channel list with genre grouping', async () => {
    const miniApp = express();
    const portalFetchRetry = vi.fn()
      .mockResolvedValueOnce({ js: [{ id: '1', title: 'Movies' }, { id: '2', title: 'Sports' }] })
      .mockResolvedValueOnce({
        js: {
          data: [
            { id: 'ch1', name: 'HBO', number: 1, logo: 'http://cdn/hbo.png', tv_genre_id: '1', cmd: 'http://stream.com/hbo', xmltv_id: 'hbo1' },
            { id: 'ch2', name: 'ESPN', number: 2, icon: 'http://cdn/espn.png', tv_genre_id: '2', cmd: 'http://stream.com/espn' },
            { id: 'ch3', name: 'Local', number: 3, tv_genre_id: '99' },
          ]
        }
      });
    const getSession = vi.fn().mockResolvedValue({ token: 't', base: 'https://portal/', apiPath: 'server/load.php', headers: {}, refresh: vi.fn() });
    const deps = {
      cache: {
        get: vi.fn().mockReturnValue(null),
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

    const res = await request(miniApp).get('/stalker/channels?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55');
    expect(res.status).toBe(200);
    expect(res.body.channels).toHaveLength(3);
    expect(res.body.channels[0]).toMatchObject({ id: 'ch1', name: 'HBO', num: 1, group: 'Movies', type: 'live' });
    expect(res.body.channels[1]).toMatchObject({ id: 'ch2', name: 'ESPN', num: 2, group: 'Sports' });
    expect(res.body.channels[2]).toMatchObject({ id: 'ch3', name: 'Local', num: 3, group: 'Other' });
    expect(deps.cache.set).toHaveBeenCalled();
  });

  it('GET /stalker/channels returns cached data without hitting portal', async () => {
    const miniApp = express();
    const cachedData = { channels: [{ id: 'cached', name: 'Cached Channel' }], total: 1, refreshed_at: Date.now() };
    const getSession = vi.fn().mockResolvedValue({ token: 't', base: 'https://portal/', apiPath: 'server/load.php', headers: {}, refresh: vi.fn() });
    const deps = {
      cache: {
        get: vi.fn().mockReturnValue(cachedData),
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
      portalFetchRetry: vi.fn(),
      safeError: vi.fn((e) => e?.message || 'error'),
      buildStalkerStreamHeaders: vi.fn().mockReturnValue({}),
      summarizeUpstreamHeaders: vi.fn().mockReturnValue({}),
    };
    miniApp.use(express.json());
    miniApp.use('/stalker', createStalkerRouter(deps));

    const res = await request(miniApp).get('/stalker/channels?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55');
    expect(res.status).toBe(200);
    expect(res.body.channels[0].name).toBe('Cached Channel');
    expect(deps.portalFetchRetry).not.toHaveBeenCalled();
  });

  it('GET /stalker/channels bypasses cache with refresh=1', async () => {
    const miniApp = express();
    const portalFetchRetry = vi.fn()
      .mockResolvedValueOnce({ js: [] })
      .mockResolvedValueOnce({ js: { data: [{ id: 'ch1', name: 'Fresh', number: 1, tv_genre_id: '1', cmd: 'http://x.com' }] } });
    const getSession = vi.fn().mockResolvedValue({ token: 't', base: 'https://portal/', apiPath: 'server/load.php', headers: {}, refresh: vi.fn() });
    const deps = {
      cache: {
        get: vi.fn().mockReturnValue({ channels: [{ id: 'old', name: 'Old' }], total: 1, refreshed_at: Date.now() }),
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

    const res = await request(miniApp).get('/stalker/channels?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55&refresh=1');
    expect(res.status).toBe(200);
    expect(res.body.channels[0].name).toBe('Fresh');
    expect(portalFetchRetry).toHaveBeenCalled();
  });

  it('GET /stalker/channels returns 502 on upstream failure', async () => {
    const miniApp = express();
    const getSession = vi.fn().mockRejectedValue(new Error('Portal unreachable'));
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
      portalFetchRetry: vi.fn(),
      safeError: vi.fn((e) => e?.message || 'error'),
      buildStalkerStreamHeaders: vi.fn().mockReturnValue({}),
      summarizeUpstreamHeaders: vi.fn().mockReturnValue({}),
    };
    miniApp.use(express.json());
    miniApp.use('/stalker', createStalkerRouter(deps));

    const res = await request(miniApp).get('/stalker/channels?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55');
    expect(res.status).toBe(502);
  });

  it('GET /stalker/api passes through arbitrary API params', async () => {
    const miniApp = express();
    const portalFetchRetry = vi.fn().mockResolvedValue({ js: { custom: 'response' } });
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

    const res = await request(miniApp).get('/stalker/api?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55&action=custom_action&param1=value1');
    expect(res.status).toBe(200);
    expect(res.body.js.custom).toBe('response');
    expect(portalFetchRetry).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      action: 'custom_action',
      param1: 'value1',
    }));
  });

  it('GET /stalker/api returns 502 when upstream fails', async () => {
    const miniApp = express();
    const portalFetchRetry = vi.fn().mockRejectedValue(new Error('API timeout'));
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

    const res = await request(miniApp).get('/stalker/api?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55&action=test');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('API timeout');
  });

  it('GET /stalker/series returns series items with all metadata', async () => {
    const miniApp = express();
    const portalFetchRetry = vi.fn().mockResolvedValue({
      js: {
        data: [
          {
            id: 's1',
            name: 'Show A',
            screenshot_uri: 'http://cdn/showa.jpg',
            year: 2023,
            rating_imdb: '9.0',
            description: 'A drama',
            genre_str: 'Drama',
            director: 'Director A',
            actors: 'Actor A',
            duration: 3600,
            age: '16+',
            country: 'USA',
          }
        ],
        total_pages: 1,
      }
    });
    const getSession = vi.fn().mockResolvedValue({ token: 't', base: 'https://portal/', apiPath: 'server/load.php', headers: {}, refresh: vi.fn() });
    const deps = {
      cache: {
        get: vi.fn().mockReturnValue(null),
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

    const res = await request(miniApp).get('/stalker/series?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55&cat=5');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      id: 's1', name: 'Show A', year: 2023, rating: '9.0', type: 'series',
      plot: 'A drama', genre: 'Drama', director: 'Director A', actors: 'Actor A',
      duration: 3600, age: '16+', country: 'USA',
    });
    expect(res.body.total).toBe(1);
    expect(deps.cache.set).toHaveBeenCalled();
  });

  it('GET /stalker/series returns 400 without cat param', async () => {
    const miniApp = express();
    const deps = {
      cache: { get: vi.fn(), set: vi.fn(), trackCacheHit: vi.fn(), trackCacheMiss: vi.fn(), trackWatch: vi.fn(), trackPortalHealth: vi.fn(), cacheKey: vi.fn() },
      auth: mockAuth,
      fetch: vi.fn(),
      isUrlAllowed: vi.fn().mockResolvedValue(true),
      getSession: vi.fn(),
      portalFetchRetry: vi.fn(),
      safeError: vi.fn((e) => e?.message || 'error'),
      buildStalkerStreamHeaders: vi.fn().mockReturnValue({}),
      summarizeUpstreamHeaders: vi.fn().mockReturnValue({}),
    };
    miniApp.use(express.json());
    miniApp.use('/stalker', createStalkerRouter(deps));

    const res = await request(miniApp).get('/stalker/series?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55');
    expect(res.status).toBe(400);
  });

  it('POST /stalker/handshake returns token on success', async () => {
    const miniApp = express();
    const getSession = vi.fn().mockResolvedValue({ token: 'handshake-token', base: 'https://portal/', apiPath: 'server/load.php', headers: {}, refresh: vi.fn() });
    const deps = {
      cache: { get: vi.fn(), set: vi.fn(), trackCacheHit: vi.fn(), trackCacheMiss: vi.fn(), trackWatch: vi.fn(), trackPortalHealth: vi.fn(), cacheKey: vi.fn() },
      auth: mockAuth,
      fetch: vi.fn(),
      isUrlAllowed: vi.fn().mockResolvedValue(true),
      getSession,
      portalFetchRetry: vi.fn(),
      safeError: vi.fn((e) => e?.message || 'error'),
      buildStalkerStreamHeaders: vi.fn().mockReturnValue({}),
      summarizeUpstreamHeaders: vi.fn().mockReturnValue({}),
    };
    miniApp.use(express.json());
    miniApp.use('/stalker', createStalkerRouter(deps));

    const res = await request(miniApp).post('/stalker/handshake').send({ portal: 'http://portal.example.com/c/', mac: '00:11:22:33:44:55', serial: 'SN123' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBe('handshake-token');
  });

  it('POST /stalker/handshake returns 400 without portal or mac', async () => {
    const miniApp = express();
    const deps = {
      cache: { get: vi.fn(), set: vi.fn(), trackCacheHit: vi.fn(), trackCacheMiss: vi.fn(), trackWatch: vi.fn(), trackPortalHealth: vi.fn(), cacheKey: vi.fn() },
      auth: mockAuth,
      fetch: vi.fn(),
      isUrlAllowed: vi.fn().mockResolvedValue(true),
      getSession: vi.fn(),
      portalFetchRetry: vi.fn(),
      safeError: vi.fn((e) => e?.message || 'error'),
      buildStalkerStreamHeaders: vi.fn().mockReturnValue({}),
      summarizeUpstreamHeaders: vi.fn().mockReturnValue({}),
    };
    miniApp.use(express.json());
    miniApp.use('/stalker', createStalkerRouter(deps));

    const res = await request(miniApp).post('/stalker/handshake').send({ portal: 'http://portal.example.com/c/' });
    expect(res.status).toBe(400);

    const res2 = await request(miniApp).post('/stalker/handshake').send({ mac: '00:11:22:33:44:55' });
    expect(res2.status).toBe(400);
  });

  it('POST /stalker/handshake returns 502 when getSession throws', async () => {
    const miniApp = express();
    const getSession = vi.fn().mockRejectedValue(new Error('Session creation failed'));
    const deps = {
      cache: { get: vi.fn(), set: vi.fn(), trackCacheHit: vi.fn(), trackCacheMiss: vi.fn(), trackWatch: vi.fn(), trackPortalHealth: vi.fn(), cacheKey: vi.fn() },
      auth: mockAuth,
      fetch: vi.fn(),
      isUrlAllowed: vi.fn().mockResolvedValue(true),
      getSession,
      portalFetchRetry: vi.fn(),
      safeError: vi.fn((e) => e?.message || 'error'),
      buildStalkerStreamHeaders: vi.fn().mockReturnValue({}),
      summarizeUpstreamHeaders: vi.fn().mockReturnValue({}),
    };
    miniApp.use(express.json());
    miniApp.use('/stalker', createStalkerRouter(deps));

    const res = await request(miniApp).post('/stalker/handshake').send({ portal: 'http://portal.example.com/c/', mac: '00:11:22:33:44:55' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Session creation failed');
  });

  it('GET /stalker/stream returns normalized URL including localhost rewrite', async () => {
    const miniApp = express();
    const portalFetchRetry = vi.fn().mockResolvedValue({
      js: { cmd: 'ffmpeg http://localhost:8080/live.m3u8' }
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

    const res = await request(miniApp).get('/stalker/stream?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55&cmd=ABC');
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('http://portal.example.com/live.m3u8');
  });

  it('GET /stalker/stream returns 502 when no URL returned', async () => {
    const miniApp = express();
    const portalFetchRetry = vi.fn().mockResolvedValue({ js: {} });
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

    const res = await request(miniApp).get('/stalker/stream?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55&cmd=ABC');
    expect(res.status).toBe(502);
  });

  it('GET /stalker/stream returns 400 when cmd is missing', async () => {
    const miniApp = express();
    const deps = {
      cache: { get: vi.fn(), set: vi.fn(), trackCacheHit: vi.fn(), trackCacheMiss: vi.fn(), trackWatch: vi.fn(), trackPortalHealth: vi.fn(), cacheKey: vi.fn() },
      auth: mockAuth,
      fetch: vi.fn(),
      isUrlAllowed: vi.fn().mockResolvedValue(true),
      getSession: vi.fn(),
      portalFetchRetry: vi.fn(),
      safeError: vi.fn((e) => e?.message || 'error'),
      buildStalkerStreamHeaders: vi.fn().mockReturnValue({}),
      summarizeUpstreamHeaders: vi.fn().mockReturnValue({}),
    };
    miniApp.use(express.json());
    miniApp.use('/stalker', createStalkerRouter(deps));

    const res = await request(miniApp).get('/stalker/stream?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55');
    expect(res.status).toBe(400);
  });

  it('GET /stalker/play returns 502 when upstream server returns non-ok', async () => {
    const miniApp = express();
    const portalFetchRetry = vi.fn().mockResolvedValue({
      js: { cmd: 'http://stream.example.com/video.mp4' }
    });
    const getSession = vi.fn().mockResolvedValue({ token: 't', base: 'https://portal/', apiPath: 'server/load.php', headers: {}, refresh: vi.fn() });
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Map([['content-type', 'video/mp4']]),
      body: null,
    });
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
      fetch: mockFetch,
      isUrlAllowed: vi.fn().mockResolvedValue(true),
      getSession,
      portalFetchRetry,
      safeError: vi.fn((e) => e?.message || 'error'),
      buildStalkerStreamHeaders: vi.fn().mockReturnValue({}),
      summarizeUpstreamHeaders: vi.fn().mockReturnValue({}),
    };
    miniApp.use(express.json());
    miniApp.use('/stalker', createStalkerRouter(deps));

    const res = await request(miniApp).get('/stalker/play?portal=http://portal.example.com/c/&mac=00:11:22:33:44:55&cmd=ABC');
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('503');
  });
});




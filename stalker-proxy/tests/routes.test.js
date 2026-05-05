import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import request from 'supertest';

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
    vi.doMock('resend', () => ({
      Resend: vi.fn().mockImplementation(() => ({
        emails: { send: vi.fn().mockResolvedValue({ data: { id: 'id' }, error: null }) }
      }))
    }));

    // 4. Require app and its components
    vi.resetModules();
    const index = require('../src/index');
    app = index.app || index; // Handle different export styles
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
});

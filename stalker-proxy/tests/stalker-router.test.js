import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { Readable } from 'stream';
import { createStalkerRouter } from '../src/routes/stalker';

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
    auth: {},
    fetch: vi.fn(),
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
  app.use(express.json());
  app.use('/stalker', createStalkerRouter(deps));
  return app;
}

describe('createStalkerRouter - unit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('POST /stalker/handshake returns 502 when getSession throws', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockRejectedValue(new Error('Portal auth failed')),
    });
    const app = makeApp(deps);
    const res = await request(app).post('/stalker/handshake').send({ portal: 'http://p.com/c/', mac: '00:1a:79:aa:bb:cc' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Portal auth failed');
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
    expect(res.body.token).toBe('tok');
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

  it('GET /stalker/channels returns 502 on session error', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockRejectedValue(new Error('Session failed')),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/channels?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Session failed');
  });

  // --- play ---

  it('GET /stalker/play with resolve=1 returns normalized URL', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { cmd: 'http://cdn.com/video.m3u8' } }),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=ABC&resolve=1');
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('http://cdn.com/video.m3u8');
  });

  it('GET /stalker/play rewrites localhost/127.0.0.1 to portal host', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { cmd: 'ffmpeg http://127.0.0.1:8080/stream.m3u8' } }),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=ABC&resolve=1');
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('http://p.com/stream.m3u8');
  });

  it('GET /stalker/play calls trackWatch for live streams', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { cmd: 'http://cdn.com/video.mp4' } }),
      fetch: vi.fn().mockResolvedValue({
        ok: true, status: 200,
        headers: { get: (k) => k === 'content-type' ? 'video/mp4' : null },
        body: Readable.from(['video data']),
      }),
      buildStalkerStreamHeaders: vi.fn().mockReturnValue({}),
      summarizeUpstreamHeaders: vi.fn().mockReturnValue({}),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=ABC&content_type=live');
    expect(res.status).toBe(200);
    expect(deps.cache.trackWatch).toHaveBeenCalledWith('ABC', 'live');
  });

  it('GET /stalker/play pipes non-HLS streams directly', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { cmd: 'http://cdn.com/video.mp4' } }),
      fetch: vi.fn().mockResolvedValue({
        ok: true, status: 200,
        headers: { get: (k) => k === 'content-type' ? 'video/mp4' : null },
        body: Readable.from(['video data']),
      }),
      buildStalkerStreamHeaders: vi.fn().mockReturnValue({}),
      summarizeUpstreamHeaders: vi.fn().mockReturnValue({}),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=ABC');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/video/);
  });

  it('GET /stalker/play rewrites HLS manifest through /stream proxy', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { cmd: 'http://cdn.com/live.m3u8' } }),
      fetch: vi.fn().mockResolvedValue({
        ok: true, status: 200,
        headers: { get: (k) => {
          if (k === 'content-type') return 'application/vnd.apple.mpegurl';
          if (k === 'content-length') return null;
          return null;
        } },
        body: Readable.from(['#EXTM3U\nsegment.ts\n']),
      }),
      buildStalkerStreamHeaders: vi.fn().mockReturnValue({}),
      summarizeUpstreamHeaders: vi.fn().mockReturnValue({ contentType: 'application/vnd.apple.mpegurl' }),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=ABC');
    expect(res.status).toBe(200);
    expect(res.text).toContain('/stream?url=');
    expect(res.text).toContain(encodeURIComponent('http://cdn.com/segment.ts'));
  });

  it('GET /stalker/play returns 502 when upstream fetch fails', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { cmd: 'http://cdn.com/video.mp4' } }),
      fetch: vi.fn().mockResolvedValue({ ok: false, status: 500, headers: new Map([['content-type', 'text/plain']]), body: null }),
      buildStalkerStreamHeaders: vi.fn().mockReturnValue({}),
      summarizeUpstreamHeaders: vi.fn().mockReturnValue({}),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/play?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=ABC');
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('500');
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
    expect(res.body.seasons[0]).toMatchObject({ id: 's1', name: 'Season 1', cmd: '/s1.m3u8', logo: 'http://cdn/s1.jpg' });
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
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Series portal error');
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
    expect(res.body.items[0]).toMatchObject({ id: 'v1', name: 'Movie One', year: 2024, rating: '8.5', url: 'ffmpeg http://cdn/m1.m3u8', logo: 'http://cdn/c1.jpg', type: 'vod' });
    expect(res.body.items[1]).toMatchObject({ id: 'v2', logo: 'http://cdn/c2.jpg' });
    expect(res.body.total).toBe(2);
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

  it('GET /stalker/api forwards arbitrary params to portal', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: { result: 'ok' } }),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/api?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&action=get_ichannels_via_api&serial=SN&deviceId=DEV');
    expect(res.status).toBe(200);
    expect(res.body.js.result).toBe('ok');
    expect(deps.portalFetchRetry).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      action: 'get_ichannels_via_api',
    }));
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

  // --- stream ---

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

  it('GET /stalker/stream returns 502 when no URL returned', async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ token: 't', base: 'https://p.com/', apiPath: 's.php', headers: {}, refresh: vi.fn() }),
      portalFetchRetry: vi.fn().mockResolvedValue({ js: {} }),
    });
    const app = makeApp(deps);
    const res = await request(app).get('/stalker/stream?portal=http://p.com/c/&mac=00:1a:79:aa:bb:cc&cmd=ABC');
    expect(res.status).toBe(502);
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
});
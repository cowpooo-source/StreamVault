import { describe, it, expect, vi } from 'vitest';
import { resolveUrl, rewriteM3u8, rewriteMediaUrl, createProxyHelpers } from '../src/utils/proxyHelpers';

describe('proxyHelpers', () => {
  describe('resolveUrl', () => {
    it('should resolve absolute URLs directly', () => {
      expect(resolveUrl('http://example.com/test.ts', 'http://base.com')).toBe('http://example.com/test.ts');
      expect(resolveUrl('https://example.com/test.ts', 'http://base.com')).toBe('https://example.com/test.ts');
    });

    it('should resolve relative URLs against base', () => {
      expect(resolveUrl('test.ts', 'http://base.com/path/file.m3u8')).toBe('http://base.com/path/test.ts');
      expect(resolveUrl('./test.ts', 'http://base.com/path/file.m3u8')).toBe('http://base.com/path/test.ts');
      expect(resolveUrl('../test.ts', 'http://base.com/path/file.m3u8')).toBe('http://base.com/test.ts');
    });

    it('should resolve root-absolute paths against base', () => {
      expect(resolveUrl('/test.ts', 'http://base.com/path/file.m3u8')).toBe('http://base.com/test.ts');
      expect(resolveUrl('/deep/test.ts', 'http://base.com/path/file.m3u8')).toBe('http://base.com/deep/test.ts');
    });

    it('should resolve protocol-relative URLs', () => {
      expect(resolveUrl('//example.com/test.ts', 'http://base.com')).toBe('http://example.com/test.ts');
      expect(resolveUrl('//example.com/test.ts', 'https://base.com')).toBe('https://example.com/test.ts');
    });

    it('should return baseStr when urlStr is empty', () => {
      expect(resolveUrl('', 'http://base.com/path')).toBe('http://base.com/path');
    });

    it('should handle base URLs with query strings', () => {
      expect(resolveUrl('test.ts', 'http://base.com/path/file.m3u8?token=abc')).toBe('http://base.com/path/test.ts');
    });
  });

  describe('rewriteMediaUrl', () => {
    it('should rewrite media URLs to proxy endpoint', () => {
      const url = 'http://example.com/video.ts';
      expect(rewriteMediaUrl(url, 'my-token')).toBe('/stream?url=http%3A%2F%2Fexample.com%2Fvideo.ts&token=my-token');
    });

    it('should pass through safe data: URIs untouched', () => {
      expect(rewriteMediaUrl('data:image/png;base64,123', 'tok')).toBe('data:image/png;base64,123');
    });

    it('should pass through safe blob: URIs untouched', () => {
      expect(rewriteMediaUrl('blob:http://localhost/123', 'tok')).toBe('blob:http://localhost/123');
    });

    it('should pass through safe about: URIs untouched', () => {
      expect(rewriteMediaUrl('about:blank', 'tok')).toBe('about:blank');
    });

    it('should return empty string unchanged when url is empty', () => {
      expect(rewriteMediaUrl('', 'tok')).toBe('');
    });

    it('should encode the token parameter', () => {
      const result = rewriteMediaUrl('http://example.com/v.ts', 'tok|with-pipe');
      expect(result).toContain('token=tok%7Cwith-pipe');
    });
  });

  describe('rewriteM3u8', () => {
    it('should rewrite m3u8 manifests', () => {
      const m3u8 = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nlevel1.m3u8\n#EXTINF:10,\nsegment1.ts`;
      const rewritten = rewriteM3u8(m3u8, 'http://base.com/', 'tok');
      expect(rewritten).toContain('/stream?url=http%3A%2F%2Fbase.com%2Flevel1.m3u8');
      expect(rewritten).toContain('/stream?url=http%3A%2F%2Fbase.com%2Fsegment1.ts');
    });

    it('should preserve non-media lines unchanged', () => {
      const m3u8 = `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttp://example.com/segment1.ts`;
      const rewritten = rewriteM3u8(m3u8, 'http://base.com/', 'tok');
      expect(rewritten).toContain('#EXTM3U');
      expect(rewritten).toContain('#EXT-X-TARGETDURATION:10');
      expect(rewritten).toContain('#EXTINF:10,');
    });

    it('should rewrite .mp4 and .aac segments', () => {
      const m3u8 = `#EXTINF:10,\nhttp://example.com/video.mp4\n#EXTINF:10,\nhttp://example.com/audio.aac`;
      const rewritten = rewriteM3u8(m3u8, 'http://base.com/', 'tok');
      expect(rewritten).toContain('/stream?url=http%3A%2F%2Fexample.com%2Fvideo.mp4');
      expect(rewritten).toContain('/stream?url=http%3A%2F%2Fexample.com%2Faudio.aac');
    });

    it('should handle already-relative media paths', () => {
      const m3u8 = `#EXTINF:10,\nsegment1.ts`;
      const rewritten = rewriteM3u8(m3u8, 'http://base.com/', 'tok');
      expect(rewritten).toContain('/stream?url=http%3A%2F%2Fbase.com%2Fsegment1.ts');
    });
  });
});
describe("redirect targets", () => {
  it("rejects a redirect into a private address", async () => {
    const fetch = vi.fn().mockResolvedValue({
      status: 302,
      headers: { get: (name) => name.toLowerCase() === "location" ? "http://127.0.0.1/admin" : null },
    });
    const helpers = createProxyHelpers({ fetch });
    await expect(helpers.fetchWithRedirectCheck("http://example.com/start")).rejects.toThrow("Redirect target is not allowed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("drops portal credentials when a redirect changes hosts", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ status: 302, headers: { get: name => name.toLowerCase() === "location" ? "http://cdn.example/media" : null } })
      .mockResolvedValueOnce({ status: 200, headers: { get: () => null } });
    const helpers = createProxyHelpers({ fetch, isUrlAllowed: vi.fn().mockResolvedValue(true) });
    await helpers.fetchWithRedirectCheck("http://portal.example/start", {
      headers: { Authorization: "Bearer secret", Cookie: "mac=secret", Accept: "*/*" },
    });
    expect(fetch.mock.calls[0][1].headers).toMatchObject({ Authorization: "Bearer secret", Cookie: "mac=secret" });
    expect(fetch.mock.calls[1][1].headers).toEqual({ Accept: "*/*" });
  });

  it("limits redirect chains", async () => {
    const fetch = vi.fn().mockResolvedValue({
      status: 302,
      headers: { get: () => "http://example.com/next" },
    });
    const helpers = createProxyHelpers({ fetch });
    await expect(helpers.fetchWithRedirectCheck("http://example.com/start", {}, 2)).rejects.toThrow("Too many redirects");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("returns a non-redirect 3xx response unchanged", async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 300, headers: { get: () => null } });
    const helpers = createProxyHelpers({ fetch });
    const result = await helpers.fetchWithRedirectCheck("http://example.com/choices");
    expect(result.response.status).toBe(300);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  describe('handshake failure cache', () => {
    it('evicts the oldest failure after 500 unique entries', async () => {
      const fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
      const helpers = createProxyHelpers({ fetch });

      await expect(helpers.getSession('http://portal-0.example.com/c/', '00:11:22:33:44:55'))
        .rejects.toThrow('Handshake failed');
      const callsAfterFirst = fetch.mock.calls.length;

      for (let i = 1; i <= 500; i += 1) {
        await expect(helpers.getSession(`http://portal-${i}.example.com/c/`, '00:11:22:33:44:55'))
          .rejects.toThrow('Handshake failed');
      }

      await expect(helpers.getSession('http://portal-0.example.com/c/', '00:11:22:33:44:55'))
        .rejects.toThrow('Handshake failed');
      expect(fetch.mock.calls.length).toBeGreaterThan(callsAfterFirst + 1);
    });
  });
  it('preserves handshake random and performs device auth after an auth failure', async () => {
    const random = 'handshake-random';
    let catalogCalls = 0;
    const fetch = vi.fn().mockImplementation(async (url, options = {}) => {
      if (url.includes('action=handshake')) {
        return { ok: true, status: 200, json: async () => ({ js: { token: 'token-1', random } }) };
      }
      if (options.method === 'POST' && String(options.body).includes('action=get_profile')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ js: { status: 0 } }) };
      }
      if (url.includes('action=get_genres')) {
        catalogCalls += 1;
        return {
          ok: true,
          status: 200,
          text: async () => catalogCalls === 1
            ? 'Authorization failed'
            : JSON.stringify({ js: [{ id: '1', title: 'All' }] }),
        };
      }
      return { ok: false, status: 404 };
    });
    const helpers = createProxyHelpers({ fetch });

    const session = await helpers.getSession('http://portal.example.com/c/', '00:11:22:33:44:55');
    const result = await helpers.portalFetchRetry(session, { type: 'itv', action: 'get_genres' });

    expect(session.random).toBe(random);
    expect(result.js).toEqual([{ id: '1', title: 'All' }]);
    const deviceAuth = fetch.mock.calls.find(([, options]) => options.method === 'POST');
    expect(deviceAuth).toBeDefined();
    expect(deviceAuth[1].body).toContain('action=get_profile');
    expect(deviceAuth[1].body).toContain('metrics=');
    expect(deviceAuth[1].body).toContain('hw_version_2=');
  });

  it('builds FFmpeg media headers without leaking portal credentials', () => {
    const helpers = createProxyHelpers({ fetch: vi.fn() });
    const headers = helpers.buildStalkerStreamHeaders({
      headers: {
        Authorization: 'Bearer portal-token',
        Cookie: 'mac=00:11:22:33:44:55',
        Referer: 'http://portal.example/c/',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }, { range: 'bytes=5-' });

    expect(headers).toEqual({
      'User-Agent': 'Lavf53.32.100',
      Accept: '*/*',
      Connection: 'close',
      'Icy-MetaData': '1',
      Range: 'bytes=5-',
    });
    expect(headers).not.toHaveProperty('Authorization');
    expect(headers).not.toHaveProperty('Cookie');
    expect(headers).not.toHaveProperty('Referer');
  });
  it('does not perform device authentication when the handshake token works', async () => {
    const fetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('action=handshake')) {
        return { ok: true, status: 200, json: async () => ({ js: { token: 'token-1', random: 'random-1' } }) };
      }
      if (url.includes('action=get_genres')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ js: [] }) };
      }
      return { ok: false, status: 404 };
    });
    const helpers = createProxyHelpers({ fetch });

    const session = await helpers.getSession('http://legacy.example.com/c/', '00:11:22:33:44:55');
    await helpers.portalFetchRetry(session, { type: 'itv', action: 'get_genres' });

    expect(fetch.mock.calls.some(([, options = {}]) => options.method === 'POST')).toBe(false);
  });
});

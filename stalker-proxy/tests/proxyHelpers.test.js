import { describe, it, expect } from 'vitest';
import { resolveUrl, rewriteM3u8, rewriteMediaUrl } from '../src/utils/proxyHelpers';

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
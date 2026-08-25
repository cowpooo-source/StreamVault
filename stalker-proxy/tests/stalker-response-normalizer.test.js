import { describe, expect, it } from 'vitest';
import {
  classifyStreamKind,
  normalizeCreateLinkResponse,
  normalizeUrl,
  stripCommandPrefix,
} from '../src/services/stalkerResponseNormalizer';

describe('Stalker response normalizer', () => {
  it('normalizes ffmpeg and ffrt commands', () => {
    expect(stripCommandPrefix('ffmpeg http://cdn/live.m3u8')).toBe('http://cdn/live.m3u8');
    expect(stripCommandPrefix('ffrt http://cdn/channel.ts')).toBe('http://cdn/channel.ts');
  });

  it('normalizes cmd and url responses', () => {
    expect(normalizeCreateLinkResponse({ js: { cmd: 'ffrt http://cdn/live.m3u8?token=x' } }, { contentType: 'live' })).toMatchObject({
      url: 'http://cdn/live.m3u8?token=x', streamKind: 'hls', sourceShape: 'cmd', tokenized: true,
    });
    expect(normalizeCreateLinkResponse({ js: { url: 'http://cdn/movie.mp4' } }, { contentType: 'vod' })).toMatchObject({
      url: 'http://cdn/movie.mp4', streamKind: 'file', sourceShape: 'url',
    });
  });

  it('constructs a movie URL from an id and play token', () => {
    const result = normalizeCreateLinkResponse(
      { js: { id: '465708.mp4', play_token: 'opaque' } },
      { portal: 'http://portal.example/stalker_portal/c/', mac: '00:1A:79:00:00:01', contentType: 'vod' },
    );
    expect(result).toMatchObject({ streamKind: 'file', sourceShape: 'id_play_token', tokenized: true });
    expect(result.url).toContain('/play/movie.php?');
    expect(result.url).toContain('play_token=opaque');
  });

  it('resolves localhost and classifies extension query parameters', () => {
    expect(normalizeUrl('http://localhost/ch/480452', 'http://portal.example/c/')).toBe('http://portal.example/ch/480452');
    expect(classifyStreamKind('http://cdn/live?id=1&extension=ts', 'live')).toBe('ts');
  });
});

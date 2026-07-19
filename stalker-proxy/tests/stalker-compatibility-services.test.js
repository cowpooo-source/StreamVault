import { beforeEach, describe, expect, it } from 'vitest';
import { buildResolveContract } from '../src/services/stalkerLinkResolver';
import { normalizeSeasons } from '../src/services/stalkerSeriesNormalizer';
import { catchupVariants, normalizeCatchupRequest } from '../src/services/stalkerCatchupResolver';
import { sanitizeStalkerUrl, stripStalkerPlaybackTokens } from '../src/services/stalkerSecurity';
import metrics from '../src/services/stalkerAuditMetrics';

describe('Stalker compatibility services', () => {
  beforeEach(() => metrics.reset());

  it('redacts credentials and device identifiers', () => {
    const sanitized = sanitizeStalkerUrl('http://user:pass@example.test/play?mac=00:1A:79:00:00:01&play_token=secret&deviceId=abc');
    expect(sanitized).not.toContain('00%3A1A');
    expect(sanitized).not.toContain('secret');
    expect(sanitized).not.toContain('user:pass');
    expect(sanitized).toContain('%5BREDACTED%5D');
    expect(stripStalkerPlaybackTokens('ffrt http://cdn.example/live.ts?play_token=secret&keep=1')).toBe('ffrt http://cdn.example/live.ts?keep=1');
  });

  it('returns a stable direct resolve contract', () => {
    const result = buildResolveContract({
      normalized: { url: 'http://cdn.example.test/live.m3u8', streamKind: 'hls', expiresAt: 1234 },
      refreshUrl: '/stalker/play?contentToken=opaque&resolve=1',
      warnings: ['cors_risk', 'cors_risk'],
    });
    expect(result).toMatchObject({
      streamKind: 'hls', direct: true, directCapability: 'cors_risk', refreshable: true,
      relayAvailable: false, warnings: ['cors_risk'],
    });
    expect(result.generation).toMatch(/^[a-f0-9]{24}$/);
  });

  it('normalizes numeric and flat object episode responses', () => {
    const numeric = normalizeSeasons([1, 2], { cmd: '/media/parent.mpg' });
    expect(numeric.seasons).toHaveLength(1);
    expect(numeric.seasons[0].episodes[1]).toMatchObject({ episode_id: 2, cmd: '/media/parent.mpg' });

    const flat = normalizeSeasons([
      { episode_id: '11', season_id: '1', series_number: 1, cmd: '/media/file_11.mpg' },
      { episode_id: '21', season_id: '2', series_number: 1, video_id: 'v21' },
    ]);
    expect(flat.seasons).toHaveLength(2);
    expect(flat.seasons[1].episodes[0]).toMatchObject({ episode_id: '21', video_id: 'v21' });
  });

  it('builds bounded catch-up parameter variants', () => {
    expect(normalizeCatchupRequest({ channel_id: 5, utc: 100, duration: 60, program_id: 9 })).toMatchObject({
      channelId: 5, start: 100, duration: 60, programId: 9,
    });
    expect(catchupVariants({ start: 100, end: 160, programId: 9 })).toEqual([
      { start: 100, end: 160 },
      { utc: 100, duration: 60 },
      { archive: 1, program_id: 9 },
    ]);
  });

  it('tracks relay counters without sensitive metric labels', () => {
    metrics.increment('stalker_control_requests_total');
    metrics.increment('stalker_media_relay_bytes_total', 128);
    expect(metrics.snapshot()).toMatchObject({
      stalker_control_requests_total: 1,
      stalker_media_relay_bytes_total: 128,
    });
  });
});

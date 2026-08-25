import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { directPlayEnabled, mediaRelayEnabled, playbackMode, redirectProbeMode } from '../src/services/stalkerDirectPolicy';

describe('Stalker direct playback policy', () => {
  const original = { ...process.env };

  beforeEach(() => {
    delete process.env.STALKER_PLAYBACK_MODE;
    delete process.env.STALKER_MEDIA_RELAY_ENABLED;
    delete process.env.STALKER_REDIRECT_RESOLUTION;
    delete process.env.STALKER_DIRECT_PLAY_ENABLED;
    delete process.env.STALKER_ALLOW_RANGE_REDIRECT_PROBE;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  });

  it('defaults to direct-only playback and HEAD redirect resolution', () => {
    expect(playbackMode()).toBe('direct_only');
    expect(mediaRelayEnabled()).toBe(false);
    expect(redirectProbeMode()).toBe('head');
    expect(directPlayEnabled()).toBe(true);
  });

  it('requires both an explicit mode and relay flag', () => {
    process.env.STALKER_PLAYBACK_MODE = 'direct_preferred';
    process.env.STALKER_MEDIA_RELAY_ENABLED = 'true';
    expect(mediaRelayEnabled()).toBe(true);
  });

  it('allows range redirect probes only when explicitly enabled in direct-preferred mode', () => {
    process.env.STALKER_REDIRECT_RESOLUTION = 'range';
    process.env.STALKER_ALLOW_RANGE_REDIRECT_PROBE = 'true';
    expect(redirectProbeMode()).toBe('head');

    process.env.STALKER_PLAYBACK_MODE = 'direct_preferred';
    expect(redirectProbeMode()).toBe('range');

    delete process.env.STALKER_ALLOW_RANGE_REDIRECT_PROBE;
    expect(redirectProbeMode()).toBe('head');
  });
});

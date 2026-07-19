import { describe, expect, it } from 'vitest';
import { buildStalkerProfileParams } from '../src/utils/proxyHelpers.js';

describe('Stalker profile parameters', () => {
  it('builds device-bound profile fields without credentials or media URLs', () => {
    const params = buildStalkerProfileParams(
      { mac: '00:1A:79:AA:BB:CC', random: 'random-value' },
      { serial: 'SERIAL', deviceId: 'DEVICE', deviceId2: 'DEVICE2' },
    );

    expect(params).toMatchObject({
      type: 'stb',
      action: 'get_profile',
      sn: 'SERIAL',
      device_id: 'DEVICE',
      device_id2: 'DEVICE2',
      auth_second_step: 1,
      timestamp: expect.any(Number),
      metrics: expect.stringContaining('random-value'),
    });
    expect(params).not.toHaveProperty('password');
    expect(params).not.toHaveProperty('url');
  });
});

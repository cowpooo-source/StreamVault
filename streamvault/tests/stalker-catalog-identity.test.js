import { describe, expect, it } from 'vitest';
import { stalkerCatalogConnectionFingerprint } from '../src/stalker-catalog-identity.js';

describe('stalker catalog identity', () => {
  it('creates a stable cache scope when Web Crypto is unavailable', async () => {
    const connection = {
      server: 'http://portal.example/c',
      mac: '00:1a:79:00:00:01',
      serial: 'SERIAL',
      deviceId: 'DEVICE-1',
      deviceId2: 'DEVICE-2',
    };

    const first = await stalkerCatalogConnectionFingerprint(connection, undefined);
    const second = await stalkerCatalogConnectionFingerprint(connection, undefined);

    expect(first).toBe(second);
    expect(first).not.toContain(connection.mac);
    expect(first).not.toContain(connection.serial);
  });
});

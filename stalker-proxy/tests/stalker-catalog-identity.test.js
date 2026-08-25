import { describe, expect, it } from 'vitest';
import { catalogIdentity, catalogIdentityHash } from '../src/services/stalkerCatalogIdentity';

describe('stalker catalog identity', () => {
  it('includes all authentication-affecting device fields', () => {
    expect(catalogIdentity({
      portal: 'HTTP://P.EXAMPLE/c/',
      mac: 'aa:bb',
      serial: 'SERIAL-1',
      deviceId: 'DEVICE-1',
      deviceId2: 'DEVICE-2',
    })).toEqual({
      portal: 'http://p.example/c',
      mac: 'AA:BB',
      serial: 'SERIAL-1',
      deviceId: 'DEVICE-1',
      deviceId2: 'DEVICE-2',
    });
  });

  it('changes when a device identifier changes', () => {
    const base = { portal: 'http://p.example/c', mac: 'AA:BB', serial: 'S' };
    expect(catalogIdentityHash(base)).not.toBe(catalogIdentityHash({ ...base, serial: 'S2' }));
    expect(catalogIdentityHash(base)).not.toBe(catalogIdentityHash({ ...base, deviceId: 'D1' }));
    expect(catalogIdentityHash(base)).not.toBe(catalogIdentityHash({ ...base, deviceId2: 'D2' }));
  });
});

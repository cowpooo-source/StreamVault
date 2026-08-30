import { describe, expect, it } from 'vitest';
import { CATALOG_MODE_HEADER, getCatalogMode, isLazyCatalogRequest } from '../src/services/stalkerCatalogMode.js';

describe('Stalker catalog mode', () => {
  it('accepts the versioned lazy catalog mode header', () => {
    const request = { headers: { [CATALOG_MODE_HEADER]: 'lazy-v1' } };
    expect(getCatalogMode(request)).toBe('lazy-v1');
    expect(isLazyCatalogRequest(request)).toBe(true);
  });

  it('leaves requests without the header in legacy mode', () => {
    expect(getCatalogMode({ headers: {} })).toBeNull();
    expect(isLazyCatalogRequest({ headers: {} })).toBe(false);
  });

  it('rejects unsupported catalog mode values', () => {
    expect(() => getCatalogMode({ headers: { [CATALOG_MODE_HEADER]: 'legacy' } }))
      .toThrowError(expect.objectContaining({ code: 'invalid_catalog_mode', status: 400 }));
  });
});

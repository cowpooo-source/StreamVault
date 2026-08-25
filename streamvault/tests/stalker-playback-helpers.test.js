import { describe, expect, it } from 'vitest';
import { findExactCatalogItem } from '../src/stalker-playback-helpers.js';

describe('Stalker playback item matching', () => {
  it('does not use a same-name item when a stable ID differs', () => {
    const items = [
      { id: 'other', name: 'Same Movie', type: 'vod', playRef: 'wrong' },
      { id: 'target', name: 'Same Movie', type: 'vod', playRef: 'right' },
    ];

    expect(findExactCatalogItem(items, { id: 'target', name: 'Same Movie', type: 'vod' }).playRef).toBe('right');
    expect(findExactCatalogItem(items, { id: 'missing', name: 'Same Movie', type: 'vod' })).toBeNull();
  });
});

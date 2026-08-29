import { describe, expect, it } from 'vitest';
import { firstBrowsableCategory, normalizeStalkerCategory } from '../src/stalker-category-selection.js';

describe('Stalker category selection', () => {
  it('normalizes star and All categories as aggregate', () => {
    expect(normalizeStalkerCategory({ id: '*', title: 'All' })).toMatchObject({
      id: 'all',
      title: 'All',
      aggregate: true,
    });
  });

  it('preserves an unknown category count as null', () => {
    expect(normalizeStalkerCategory({ id: '1577', title: 'Sports', count: null })).toMatchObject({
      id: '1577',
      count: null,
      aggregate: false,
    });
  });

  it('selects the first non-aggregate category', () => {
    expect(firstBrowsableCategory([
      { id: '*', title: 'All' },
      { id: '92', title: 'New Movies' },
    ])).toMatchObject({ id: '92', title: 'New Movies', aggregate: false });
  });

  it('returns null instead of implicitly selecting All', () => {
    expect(firstBrowsableCategory([{ id: '*', title: 'All' }])).toBeNull();
  });
});

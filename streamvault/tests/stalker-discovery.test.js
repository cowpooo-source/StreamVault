import { describe, it, expect } from 'vitest';
import { discoverySeed, selectDiscoveryCategories } from '../src/stalker-discovery.js';

const categories = Array.from({ length: 8 }, (_, index) => ({ id: String(index + 1), title: `Category ${index + 1}` }));

describe('stalker discovery sampling', () => {
  it('always includes the first category and stays bounded', () => {
    const selected = selectDiscoveryCategories(categories, { seed: 'connection:day', max: 4 });
    expect(selected).toHaveLength(4);
    expect(selected[0].id).toBe('1');
    expect(new Set(selected.map(category => category.id)).size).toBe(4);
  });

  it('is deterministic for a seed and changes when the seed changes', () => {
    const first = selectDiscoveryCategories(categories, { seed: 'a', max: 4 }).map(category => category.id);
    expect(selectDiscoveryCategories(categories, { seed: 'a', max: 4 }).map(category => category.id)).toEqual(first);
    expect(selectDiscoveryCategories(categories, { seed: 'b', max: 4 }).map(category => category.id)).not.toEqual(first);
  });

  it('does not exceed available categories or include invalid duplicates', () => {
    const selected = selectDiscoveryCategories([{ id: '1' }, { id: '1' }, null, { id: '2' }], { max: 4 });
    expect(selected.map(category => category.id)).toEqual(['1', '2']);
  });

  it('uses a day-based seed for bounded daily rotation', () => {
    expect(discoverySeed('scope', 86_400_000)).toBe('scope:1');
  });
});

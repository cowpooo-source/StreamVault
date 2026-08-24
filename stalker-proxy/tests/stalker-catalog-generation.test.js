import { describe, expect, it } from 'vitest';
import { createCatalogGenerations } from '../src/services/stalkerCatalogGeneration';

describe('catalog generations', () => {
  it('rejects publication from an operation superseded by refresh', () => {
    const generations = createCatalogGenerations();
    const key = 'provider|live|all';
    const operationGeneration = generations.current(key);

    generations.bump(key);

    expect(generations.isCurrent(key, operationGeneration)).toBe(false);
    expect(generations.current(key)).toBe(1);
  });
});

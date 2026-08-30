import { describe, expect, it } from 'vitest';
import { normalizeCatalogPage } from '../src/services/stalkerCatalogPager';
import { createCatalogCapabilities } from '../src/services/stalkerCatalogCapabilities';
import { createProviderMetadataCoordinator } from '../src/services/providerMetadataCoordinator';
import { createCatalogPageHistory } from '../src/services/stalkerCatalogPageHistory';
import { TTL_MS } from '../src/services/stalkerCatalogCapabilities';
import { CATALOG_TTL, LAZY_CATALOG_TTL } from '../src/routes/stalker';

describe('lazy catalog cache policy', () => {
  it('keeps capability records for 48 hours', () => {
    expect(TTL_MS).toBe(48 * 60 * 60_000);
  });

  it('uses 48-hour TTLs only for lazy catalog data', () => {
    expect(LAZY_CATALOG_TTL).toEqual({
      live: 30 * 24 * 60 * 60_000,
      categories: 48 * 60 * 60_000,
      content: 48 * 60 * 60_000,
    });
    expect(CATALOG_TTL).toMatchObject({
      channels: 30 * 24 * 60 * 60_000,
      categories: 24 * 60 * 60_000,
      content: 12 * 60 * 60_000,
    });
  });
});

describe('stalker catalog services', () => {
  it('marks the final known-total page complete even when it is shorter than the total', () => {
    const page = normalizeCatalogPage({
      js: { data: Array.from({ length: 100 }, (_, index) => ({ id: 1101 + index, name: `Item ${index}` })), total_items: 1200 },
    }, { kind: 'vod', category: '1', page: 12, pageSize: 100 });

    expect(page.hasMore).toBe(false);
    expect(page.complete).toBe(true);
  });

  it('uses the provider page size when calculating known-total completeness', () => {
    const page = normalizeCatalogPage({
      js: { data: Array.from({ length: 14 }, (_, index) => ({ id: 101 + index })), total_items: 28, max_page_items: 14 },
    }, { kind: 'vod', category: '1', page: 1, pageSize: 100 });

    expect(page.items).toHaveLength(14);
    expect(page.hasMore).toBe(true);
    expect(page.nextPage).toBe(2);
  });

  it('continues unknown-total pagination when the provider-sized page is full', () => {
    const page = normalizeCatalogPage({
      js: { data: Array.from({ length: 14 }, (_, index) => ({ id: index + 1 })), max_page_items: 14 },
    }, { kind: 'vod', category: '1', page: 1, pageSize: 100 });

    expect(page.providerPageSize).toBe(14);
    expect(page.hasMore).toBe(true);
    expect(page.nextPage).toBe(2);
  });

  it('does not drop overflow items when a provider page is larger than the browser page', () => {
    const page = normalizeCatalogPage({
      js: { data: Array.from({ length: 150 }, (_, index) => ({ id: index + 1 })) },
    }, { kind: 'vod', category: '1', page: 1, pageSize: 100 });

    expect(page.items).toHaveLength(150);
    expect(page.providerPageSize).toBe(150);
    expect(page.hasMore).toBe(true);
  });

  it('terminates pagination when the provider returns an empty page', () => {
    const page = normalizeCatalogPage({
      js: { data: [], total_pages: 10, total_items: 1000, max_page_items: 100 },
    }, { kind: 'vod', category: '1', page: 2, pageSize: 100 });

    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextPage).toBeNull();
    expect(page.complete).toBe(true);
  });

  it('detects repeated pages within a catalog generation', () => {
    const history = createCatalogPageHistory({ maxSignatures: 2 });

    expect(history.observe('provider|vod|category-1', 0, 'page-one')).toBe(false);
    expect(history.observe('provider|vod|category-1', 0, 'page-two')).toBe(false);
    expect(history.observe('provider|vod|category-1', 0, 'page-one')).toBe(true);
    expect(history.observe('provider|vod|category-1', 1, 'page-one')).toBe(false);
    expect(history.observe('provider|vod|category-2', 0, 'page-one')).toBe(false);
  });

  it('clears page history for an invalidated category scope', () => {
    const history = createCatalogPageHistory();
    const scope = 'provider|vod|category-1|';
    history.observe(scope, 3, 'page-one');
    history.clear('provider|vod|category-1|');
    expect(history.observe(scope, 3, 'page-one')).toBe(false);
  });

  it('preserves learned fields when only one capability changes', () => {
    const store = new Map();
    const cache = { get: key => store.get(key), set: (key, value) => store.set(key, value) };
    const capabilities = createCatalogCapabilities({ cache });

    capabilities.recordPaginationProbe('p|m', 'vod', [{ id: 1 }], [{ id: 2 }]);
    capabilities.recordSearchProbe('p|m', 'vod', [{ id: 1 }], [{ id: 1 }]);

    expect(capabilities.get('p|m', 'vod')).toMatchObject({ pagination: 'supported', search: 'unsupported' });
  });

  it('records bounded live snapshot mode without changing search capability', () => {
    const store = new Map();
    const cache = { get: key => store.get(key), set: (key, value) => store.set(key, value) };
    const capabilities = createCatalogCapabilities({ cache, now: () => 1_000 });

    capabilities.recordSearchSuccess('identity-a', 'live');
    const result = capabilities.recordLiveSnapshotMode('identity-a');

    expect(result).toMatchObject({
      pagination: 'unsupported',
      mode: 'bounded_live_snapshot',
      search: 'supported',
    });
  });

  it('keeps live snapshot capability for the 30-day live catalog TTL', () => {
    let now = 1_000;
    const store = new Map();
    const cache = { get: key => store.get(key), set: (key, value) => store.set(key, value) };
    const capabilities = createCatalogCapabilities({ cache, now: () => now });
    capabilities.recordLiveSnapshotMode('identity-a');

    now += 30 * 24 * 60 * 60_000 - 1;
    expect(capabilities.get('identity-a', 'live')).toMatchObject({
      mode: 'bounded_live_snapshot',
      pagination: 'unsupported',
    });

    now += 2;
    expect(capabilities.get('identity-a', 'live')).toMatchObject({
      mode: 'provider_pages',
      pagination: 'unknown',
    });
  });

  it('does not persist a capability result when its generation is stale', () => {
    const store = new Map();
    const cache = { get: key => store.get(key), set: (key, value) => store.set(key, value) };
    const capabilities = createCatalogCapabilities({ cache });
    let generation = 0;
    const operationGeneration = generation;
    generation += 1;

    capabilities.recordPaginationProbe('p|m', 'vod', [{ id: 1 }], [{ id: 2 }], {
      canCommit: () => generation === operationGeneration,
    });

    expect(capabilities.get('p|m', 'vod').pagination).toBe('unknown');
    expect(store.size).toBe(0);
  });

  it('does not mark search unsupported when both the query and probe are empty', () => {
    const store = new Map();
    const cache = { get: key => store.get(key), set: (key, value) => store.set(key, value) };
    const capabilities = createCatalogCapabilities({ cache });

    const result = capabilities.recordSearchProbe('p|m', 'vod', [], []);

    expect(result.search).toBe('inconclusive');
  });

  it('arms one follow-up search probe after an inconclusive search returns results', () => {
    const store = new Map();
    const cache = { get: key => store.get(key), set: (key, value) => store.set(key, value) };
    const capabilities = createCatalogCapabilities({ cache, now: () => 1000 });

    capabilities.recordSearchProbe('p|m', 'vod', [], []);
    const observed = capabilities.recordSearchResult('p|m', 'vod', [{ id: 1 }]);

    expect(observed).toMatchObject({ search: 'unknown', searchProbeAfter: 0 });
    expect(capabilities.get('p|m', 'vod').searchProbeAfter).toBe(0);
  });

  it('removes an aborted queued request without consuming a slot', async () => {
    const coordinator = createProviderMetadataCoordinator({ maxActive: 1, maxQueued: 2, safetyMs: 1000 });
    let release;
    const active = coordinator.runProviderMetadata({
      providerKey: 'p', requestKey: 'active', operation: () => new Promise(resolve => { release = resolve; }),
    });
    const controller = new AbortController();
    const queued = coordinator.runProviderMetadata({
      providerKey: 'p', requestKey: 'queued', signal: controller.signal, operation: () => 'should-not-run',
    });
    controller.abort();

    await expect(queued).rejects.toMatchObject({ code: 'ABORT_ERR' });
    release('done');
    await expect(active).resolves.toBe('done');
    expect(coordinator.size()).toBe(0);
  });

  it('does not start the next request while a timed out operation is still running', async () => {
    const coordinator = createProviderMetadataCoordinator({ maxActive: 1, maxQueued: 1, safetyMs: 10 });
    let release;
    const slow = coordinator.runProviderMetadata({
      providerKey: 'p', requestKey: 'slow', operation: () => new Promise(resolve => { release = resolve; }),
    });
    const next = coordinator.runProviderMetadata({ providerKey: 'p', requestKey: 'next', operation: () => 'next' });

    await expect(slow).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(coordinator.size()).toBe(1);
    release('late');
    await expect(next).resolves.toBe('next');
    expect(coordinator.size()).toBe(0);
  });

  it('does not let an aborted coalesced caller cancel another caller', async () => {
    let release;
    const coordinator = createProviderMetadataCoordinator({ maxActive: 1, maxQueued: 1, safetyMs: 1000 });
    const first = coordinator.runProviderMetadata({
      providerKey: 'p', requestKey: 'same', operation: () => new Promise(resolve => { release = resolve; }),
    });
    const controller = new AbortController();
    const second = coordinator.runProviderMetadata({
      providerKey: 'p', requestKey: 'same', signal: controller.signal, operation: () => { throw new Error('must coalesce'); },
    });

    controller.abort();
    await expect(second).rejects.toMatchObject({ code: 'ABORT_ERR' });
    release('done');
    await expect(first).resolves.toBe('done');
  });

  it('prioritizes a foreground request over a queued background probe', async () => {
    const coordinator = createProviderMetadataCoordinator({ maxActive: 1, maxQueued: 2, safetyMs: 1000, backgroundDelayMs: 25 });
    const order = [];
    let release;
    const active = coordinator.runProviderMetadata({
      providerKey: 'p',
      requestKey: 'active',
      operation: () => new Promise(resolve => { release = resolve; }),
    });
    const background = coordinator.runProviderMetadata({
      providerKey: 'p',
      requestKey: 'background',
      priority: 'background',
      operation: () => {
        order.push('background');
        return 'background';
      },
    });
    const foreground = coordinator.runProviderMetadata({
      providerKey: 'p',
      requestKey: 'foreground',
      operation: () => {
        order.push('foreground');
        return 'foreground';
      },
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    release('active');
    await expect(foreground).resolves.toBe('foreground');
    expect(order[0]).toBe('foreground');
    await expect(background).resolves.toBe('background');
    await expect(active).resolves.toBe('active');
  });
});

import { describe, expect, it } from 'vitest';
import { createLiveSnapshotStore } from '../src/services/stalkerLiveSnapshot';

function createCacheFake() {
  const values = new Map();
  return {
    get: key => values.get(key)?.value || null,
    set: (key, value, ttl) => values.set(key, { value, ttl }),
    del: key => values.delete(key),
    values: () => [...values.values()].map(entry => entry.value),
    keys: () => [...values.keys()],
  };
}

describe('Stalker live snapshot store', () => {
  it('writes fixed chunks and reads a category page without storing the full item list', async () => {
    const cache = createCacheFake();
    const snapshots = createLiveSnapshotStore({ cache, ttlMs: 1_000, chunkSize: 2 });
    const build = snapshots.begin({ identityHash: 'connection-a-hash', generation: 1 });

    await build.append({ item: { id: '1', name: 'One' }, categoryId: 'sports' });
    await build.append({ item: { id: '2', name: 'Two' }, categoryId: 'news' });
    await build.append({ item: { id: '3', name: 'Three' }, categoryId: 'sports' });
    await build.complete();

    await expect(build.readPage({ category: 'sports', page: 1, pageSize: 100 }))
      .resolves.toMatchObject({ items: [{ id: '1' }, { id: '3' }], total: 2, complete: true });
    expect(cache.values()).not.toContainEqual(expect.arrayContaining([
      { id: '1', name: 'One' },
      { id: '2', name: 'Two' },
      { id: '3', name: 'Three' },
    ]));
  });

  it('shares one build for different live categories of the same connection', () => {
    const snapshots = createLiveSnapshotStore({ cache: createCacheFake(), ttlMs: 1_000, chunkSize: 2 });
    const first = snapshots.begin({ identityHash: 'connection-a-hash', generation: 1 });
    const second = snapshots.begin({ identityHash: 'connection-a-hash', generation: 1 });

    expect(second).toBe(first);
  });

  it('resolves a waiting category page once it has pageSize plus one references', async () => {
    const build = createLiveSnapshotStore({ cache: createCacheFake(), ttlMs: 1_000, chunkSize: 2 })
      .begin({ identityHash: 'connection-a-hash', generation: 1 });
    const page = build.waitForPage({ category: 'sports', page: 1, pageSize: 2 });

    await build.append({ item: { id: '1' }, categoryId: 'sports' });
    await build.append({ item: { id: '2' }, categoryId: 'sports' });
    await build.append({ item: { id: '3' }, categoryId: 'sports' });

    await expect(page).resolves.toMatchObject({
      items: [{ id: '1' }, { id: '2' }],
      hasMore: true,
      complete: false,
    });
    await build.fail(new Error('stop test build'));
  });

  it('removes incomplete chunks and rejects pending pages on failure', async () => {
    const cache = createCacheFake();
    const build = createLiveSnapshotStore({ cache, ttlMs: 1_000, chunkSize: 2 })
      .begin({ identityHash: 'connection-a-hash', generation: 1 });
    const page = build.waitForPage({ category: 'sports', page: 1, pageSize: 100 });
    await build.append({ item: { id: '1' }, categoryId: 'sports' });
    const failure = new Error('provider failed');
    await build.fail(failure);

    await expect(page).rejects.toBe(failure);
    expect(cache.keys()).toEqual([]);
  });

  it('caps accepted records at the configured maximum', async () => {
    const build = createLiveSnapshotStore({ cache: createCacheFake(), ttlMs: 1_000, chunkSize: 2, maxItems: 2 })
      .begin({ identityHash: 'connection-a-hash', generation: 1 });
    await build.append({ item: { id: '1' }, categoryId: 'sports' });
    await build.append({ item: { id: '2' }, categoryId: 'sports' });
    await build.append({ item: { id: '3' }, categoryId: 'sports' });
    await build.complete();

    const page = await build.readPage({ category: 'sports', page: 1, pageSize: 100 });
    expect(page.items).toHaveLength(2);
    expect(page.truncated).toBe(true);
  });

  it('reads a completed snapshot from persisted chunks after the build is released', async () => {
    const cache = createCacheFake();
    const snapshots = createLiveSnapshotStore({ cache, ttlMs: 1_000, chunkSize: 2 });
    const build = snapshots.begin({ identityHash: 'connection-a-hash', generation: 1 });
    await build.append({ item: { id: '1', name: 'One' }, categoryId: 'sports' });
    await build.append({ item: { id: '2', name: 'Two' }, categoryId: 'sports' });
    await build.complete();

    await expect(snapshots.readPage({ identityHash: 'connection-a-hash', category: 'sports', page: 1, pageSize: 100 }))
      .resolves.toMatchObject({ items: [{ id: '1' }, { id: '2' }], total: 2, complete: true });
  });
});

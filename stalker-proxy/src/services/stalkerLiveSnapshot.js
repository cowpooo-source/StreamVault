const crypto = require('crypto');

const PREFIX = 'stalker-live-snapshot-v1';

function hashPart(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function categoryKey(category) {
  return String(category || 'all').trim() || 'all';
}

function createLiveSnapshotStore({ cache, ttlMs, chunkSize = 250, maxItems = 50_000 } = {}) {
  if (!cache || typeof cache.get !== 'function' || typeof cache.set !== 'function') {
    throw new TypeError('A cache with get and set methods is required');
  }
  const safeChunkSize = Math.max(1, Math.min(250, Number(chunkSize) || 250));
  const safeMaxItems = Math.max(1, Math.min(50_000, Number(maxItems) || 50_000));
  const builds = new Map();

  const manifestKey = identityHash => `${PREFIX}|${identityHash}|manifest`;
  const itemKey = (identityHash, generation, chunk) => `${PREFIX}|${identityHash}|${generation}|items|${chunk}`;
  const refsKey = (identityHash, generation, category, chunk) =>
    `${PREFIX}|${identityHash}|${generation}|refs|${hashPart(category)}|${chunk}`;

  function emptyPage(category, page, pageSize, total = null, complete = false, truncated = false) {
    const normalizedPage = Math.max(1, Number(page) || 1);
    const normalizedSize = Math.max(1, Math.min(250, Number(pageSize) || 100));
    const hasMore = complete ? Number(total || 0) > normalizedPage * normalizedSize : true;
    return {
      kind: 'live',
      category: categoryKey(category),
      items: [],
      page: normalizedPage,
      pageSize: normalizedSize,
      hasMore,
      nextPage: hasMore ? normalizedPage + 1 : null,
      total,
      totalKnown: complete,
      complete,
      truncated,
      capabilities: { pagination: 'unsupported', mode: 'bounded_live_snapshot', search: 'unknown' },
      refreshedAt: Date.now(),
    };
  }

  function newBuild(identityHash, generation) {
    const state = {
      identityHash: String(identityHash),
      generation: String(generation),
      itemChunk: [],
      itemChunkNumber: 0,
      writtenItemChunks: 0,
      referenceChunks: new Map(),
      referenceChunkCounts: new Map(),
      categoryCounts: new Map(),
      itemCount: 0,
      writtenKeys: new Set(),
      waiters: [],
      done: false,
      truncated: false,
      failed: null,
    };

    const countFor = category => state.categoryCounts.get(categoryKey(category)) || 0;
    const referenceBufferFor = category => {
      const key = categoryKey(category);
      if (!state.referenceChunks.has(key)) state.referenceChunks.set(key, []);
      return state.referenceChunks.get(key);
    };

    const flushItems = () => {
      if (!state.itemChunk.length) return;
      const key = itemKey(state.identityHash, state.generation, state.itemChunkNumber);
      cache.set(key, state.itemChunk, ttlMs);
      state.writtenKeys.add(key);
      state.itemChunk = [];
      state.itemChunkNumber += 1;
      state.writtenItemChunks = state.itemChunkNumber;
    };

    const flushReferences = category => {
      const key = categoryKey(category);
      const buffer = referenceBufferFor(key);
      if (!buffer.length) return;
      const chunk = state.referenceChunkCounts.get(key) || 0;
      const storageKey = refsKey(state.identityHash, state.generation, key, chunk);
      cache.set(storageKey, buffer, ttlMs);
      state.writtenKeys.add(storageKey);
      state.referenceChunks.set(key, []);
      state.referenceChunkCounts.set(key, chunk + 1);
    };

    const availableRefs = category => countFor(category);

    const getItems = refs => {
      const chunks = new Map();
      return refs.map(ref => {
        if (!chunks.has(ref.chunk)) {
          const stored = ref.chunk < state.writtenItemChunks
            ? cache.get(itemKey(state.identityHash, state.generation, ref.chunk))
            : state.itemChunk;
          chunks.set(ref.chunk, stored || []);
        }
        return chunks.get(ref.chunk)[ref.index] || null;
      }).filter(Boolean);
    };

    const getRefs = (category, limit = Number.POSITIVE_INFINITY) => {
      const key = categoryKey(category);
      const refs = [];
      const count = state.referenceChunkCounts.get(key) || 0;
      for (let index = 0; index < count && refs.length < limit; index += 1) {
        const stored = cache.get(refsKey(state.identityHash, state.generation, key, index)) || [];
        refs.push(...stored.slice(0, limit - refs.length));
      }
      refs.push(...referenceBufferFor(key).slice(0, limit - refs.length));
      return refs;
    };

    const readPage = async ({ category = 'all', page = 1, pageSize = 100 } = {}) => {
      const normalizedPage = Math.max(1, Number(page) || 1);
      const normalizedSize = Math.max(1, Math.min(250, Number(pageSize) || 100));
      const offset = (normalizedPage - 1) * normalizedSize;
      const refs = getRefs(category, offset + normalizedSize + 1);
      const items = getItems(refs.slice(offset, offset + normalizedSize));
      const total = state.done ? countFor(category) : null;
      const hasMore = state.done ? countFor(category) > offset + normalizedSize : true;
      return {
        kind: 'live',
        category: categoryKey(category),
        items,
        page: normalizedPage,
        pageSize: normalizedSize,
        hasMore,
        nextPage: hasMore ? normalizedPage + 1 : null,
        total,
        totalKnown: state.done,
        complete: state.done,
        truncated: state.truncated,
        capabilities: { pagination: 'unsupported', mode: 'bounded_live_snapshot', search: 'unknown' },
        refreshedAt: Date.now(),
      };
    };

    const canServe = ({ category = 'all', page = 1, pageSize = 100 } = {}) => {
      const offset = (Math.max(1, Number(page) || 1) - 1) * Math.max(1, Math.min(250, Number(pageSize) || 100));
      return state.done || availableRefs(category) > offset + Math.max(1, Math.min(250, Number(pageSize) || 100));
    };

    const resolveWaiters = () => {
      for (let index = state.waiters.length - 1; index >= 0; index -= 1) {
        const waiter = state.waiters[index];
        if (!state.done && !canServe(waiter.options)) continue;
        state.waiters.splice(index, 1);
        readPage(waiter.options).then(waiter.resolve, waiter.reject);
      }
    };

    const build = {
      identityHash: state.identityHash,
      generation: state.generation,
      isBuilding: () => !state.done && !state.failed,
      append: async ({ item, categoryId } = {}) => {
        if (state.done || state.failed || state.itemCount >= safeMaxItems) {
          state.truncated = state.itemCount >= safeMaxItems;
          return false;
        }
        if (!item || typeof item !== 'object') return false;
        const globalChunk = state.itemChunkNumber;
        const itemIndex = state.itemChunk.length;
        state.itemChunk.push(item);
        state.itemCount += 1;
        const categories = new Set(['all', categoryKey(categoryId)]);
        for (const category of categories) {
          const refs = referenceBufferFor(category);
          refs.push({ chunk: globalChunk, index: itemIndex });
          state.categoryCounts.set(category, countFor(category) + 1);
          if (refs.length >= safeChunkSize) flushReferences(category);
        }
        if (state.itemChunk.length >= safeChunkSize) flushItems();
        resolveWaiters();
        return true;
      },
      waitForPage: (options = {}) => {
        if (options.signal?.aborted) return Promise.reject(Object.assign(new Error('Snapshot request aborted'), { code: 'ABORT_ERR', status: 499 }));
        if (canServe(options)) return readPage(options);
        return new Promise((resolve, reject) => {
          const waiter = { options, resolve, reject };
          state.waiters.push(waiter);
          options.signal?.addEventListener('abort', () => {
            const position = state.waiters.indexOf(waiter);
            if (position >= 0) state.waiters.splice(position, 1);
            reject(Object.assign(new Error('Snapshot request aborted'), { code: 'ABORT_ERR', status: 499 }));
          }, { once: true });
        });
      },
      readPage,
      complete: async () => {
        if (state.done || state.failed) return false;
        flushItems();
        for (const category of state.referenceChunks.keys()) flushReferences(category);
        state.done = true;
        const manifest = {
          generation: state.generation,
          itemCount: state.itemCount,
          categoryCounts: Object.fromEntries(state.categoryCounts),
          itemChunks: state.writtenItemChunks,
          referenceChunks: Object.fromEntries(state.referenceChunkCounts),
          truncated: state.truncated,
          refreshedAt: Date.now(),
        };
        cache.set(manifestKey(state.identityHash), manifest, ttlMs);
        resolveWaiters();
        builds.delete(`${state.identityHash}|${state.generation}`);
        return true;
      },
      fail: async error => {
        if (state.failed) return;
        state.failed = error;
        for (const key of state.writtenKeys) cache.del?.(key);
        for (const waiter of state.waiters.splice(0)) waiter.reject(error);
        builds.delete(`${state.identityHash}|${state.generation}`);
      },
    };
    return build;
  }

  function begin({ identityHash, generation } = {}) {
    const key = `${identityHash}|${generation}`;
    const existing = builds.get(key);
    if (existing) return existing;
    const build = newBuild(identityHash, generation);
    builds.set(key, build);
    return build;
  }

  function getManifest(identityHash) {
    return cache.get(manifestKey(identityHash));
  }

  function invalidate(identityHash) {
    const manifest = getManifest(identityHash);
    if (manifest) {
      for (let index = 0; index < Number(manifest.itemChunks || 0); index += 1) {
        cache.del?.(itemKey(identityHash, manifest.generation, index));
      }
      for (const [category, count] of Object.entries(manifest.referenceChunks || {})) {
        for (let index = 0; index < Number(count || 0); index += 1) {
          cache.del?.(refsKey(identityHash, manifest.generation, category, index));
        }
      }
      cache.del?.(manifestKey(identityHash));
    }
    for (const [key, build] of builds) {
      if (!key.startsWith(`${identityHash}|`)) continue;
      void build.fail(Object.assign(new Error('Live catalog snapshot invalidated'), {
        code: 'SNAPSHOT_INVALIDATED',
        status: 409,
      }));
    }
  }

  async function readPage({ identityHash, category = 'all', page = 1, pageSize = 100 } = {}) {
    const manifest = getManifest(identityHash);
    if (!manifest) return null;
    const normalizedCategory = categoryKey(category);
    const normalizedPage = Math.max(1, Number(page) || 1);
    const normalizedSize = Math.max(1, Math.min(250, Number(pageSize) || 100));
    const offset = (normalizedPage - 1) * normalizedSize;
    const refChunkCount = Number(manifest.referenceChunks?.[normalizedCategory] || 0);
    const refs = [];
    for (let index = 0; index < refChunkCount && refs.length < offset + normalizedSize + 1; index += 1) {
      const stored = cache.get(refsKey(identityHash, manifest.generation, normalizedCategory, index)) || [];
      refs.push(...stored.slice(0, offset + normalizedSize + 1 - refs.length));
    }
    const items = [];
    const itemChunks = new Map();
    for (const ref of refs.slice(offset, offset + normalizedSize)) {
      if (!itemChunks.has(ref.chunk)) {
        itemChunks.set(ref.chunk, cache.get(itemKey(identityHash, manifest.generation, ref.chunk)) || []);
      }
      const item = itemChunks.get(ref.chunk)[ref.index];
      if (item) items.push(item);
    }
    const total = Number(manifest.categoryCounts?.[normalizedCategory] || 0);
    const hasMore = total > offset + normalizedSize;
    return {
      kind: 'live',
      category: normalizedCategory,
      items,
      page: normalizedPage,
      pageSize: normalizedSize,
      hasMore,
      nextPage: hasMore ? normalizedPage + 1 : null,
      total,
      totalKnown: true,
      complete: true,
      truncated: Boolean(manifest.truncated),
      capabilities: { pagination: 'unsupported', mode: 'bounded_live_snapshot', search: 'unknown' },
      refreshedAt: Number(manifest.refreshedAt || Date.now()),
    };
  }

  return { begin, getManifest, readPage, invalidate, manifestKey, itemKey, refsKey, size: () => builds.size };
}

module.exports = { createLiveSnapshotStore };

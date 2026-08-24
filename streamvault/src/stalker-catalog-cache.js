import { normalizeStalkerCatalogConnection, stalkerCatalogConnectionFingerprint } from './stalker-catalog-identity.js';

const DB_NAME = 'sv-stalker-cache';
const DB_VERSION = 3;
const STORE = 'pages';
const META = 'meta';
const MAX_BYTES = 75 * 1024 * 1024;
const MAX_RECORDS = 1000;
// Catalog metadata can live longer than a playback reference. References are
// removed before persistence and refreshed from the originating page at play.
const LIVE_TTL = 30 * 24 * 60 * 60 * 1000;
const CONTENT_TTL = 48 * 60 * 60 * 1000;

function openDatabase(indexedDBRef = globalThis.indexedDB) {
  if (!indexedDBRef) return Promise.resolve(null);
  return new Promise(resolve => {
    let settled = false;
    const request = indexedDBRef.open(DB_NAME, DB_VERSION);
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => finish(null), 2000);
    request.onupgradeneeded = () => {
      try {
        const db = request.result;
        if (db.objectStoreNames.contains('c')) db.deleteObjectStore('c');
        // v2 stored provider-issued play references. Drop that store once so
        // pages are rebuilt with fresh references under the v3 contract.
        if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
        db.createObjectStore(STORE, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
      } catch {
        try { request.transaction?.abort(); } catch { /* best effort */ }
        finish(null);
      }
    };
    request.onsuccess = () => {
      if (settled) {
        request.result?.close?.();
        return;
      }
      finish(request.result);
    };
    request.onerror = () => finish(null);
    request.onblocked = () => finish(null);
  });
}

function tx(db, stores, mode, action) {
  return new Promise((resolve, reject) => {
    if (!db) return resolve(null);
    const transaction = db.transaction(stores, mode);
    let value;
    try { value = action(transaction); } catch (error) { reject(error); return; }
    transaction.oncomplete = () => resolve(value);
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

export async function createStalkerCatalogCache({ indexedDBRef = globalThis.indexedDB, ownerId, connection } = {}) {
  const db = await openDatabase(indexedDBRef);
  const owner = String(ownerId || 'guest:unknown');
  const connectionFingerprint = await stalkerCatalogConnectionFingerprint(normalizeStalkerCatalogConnection(connection));
  const scope = `${owner}|${connectionFingerprint}`;
  let persistent = Boolean(db);
  const pageKey = page => `${scope}|${page.kind}|${page.category || 'all'}|${page.page}|${page.pageSize}`;
  const ttlFor = kind => kind === 'live' ? LIVE_TTL : CONTENT_TTL;
  const memory = new Map();
  const categoryMemory = new Map();
  const sanitizePage = page => ({
    ...page,
    items: Array.isArray(page?.items) ? page.items.map(item => {
      const safeItem = { ...(item || {}) };
      for (const field of ['playRef', '_catalogPlayRef', 'url', '_stalkerCmd', 'cmd', 'contentToken', 'portal', 'mac']) delete safeItem[field];
      return safeItem;
    }) : [],
  });

  const persistRecord = async record => {
    if (!db || !persistent) return;
    try {
      await tx(db, [STORE], 'readwrite', t => t.objectStore(STORE).put(record));
    } catch {
      persistent = false;
    }
  };

  const categoryKey = kind => `${scope}|categories|${String(kind || '')}`;
  const persistCategory = async record => {
    if (!db || !persistent) return;
    try {
      await tx(db, [META], 'readwrite', t => t.objectStore(META).put(record));
    } catch {
      persistent = false;
    }
  };

  const getCategories = async kind => {
    const key = categoryKey(kind);
    let record = categoryMemory.get(key);
    if (!record && db) {
      record = await tx(db, [META], 'readonly', t => new Promise(resolve => {
        const get = t.objectStore(META).get(key);
        get.onsuccess = () => resolve(get.result || null);
        get.onerror = () => resolve(null);
      })).catch(() => null);
    }
    if (!record) return null;
    record.lastAccess = Date.now();
    categoryMemory.set(key, record);
    if (Date.now() < record.expiresAt) void persistCategory(record);
    return { ...record.value, stale: Date.now() >= record.expiresAt };
  };

  const putCategories = async (kind, value) => {
    const safeValue = {
      categories: Array.isArray(value?.categories) ? value.categories : [],
      capabilities: value?.capabilities,
    };
    const record = {
      key: categoryKey(kind),
      value: safeValue,
      expiresAt: Date.now() + CONTENT_TTL,
      lastAccess: Date.now(),
    };
    categoryMemory.set(record.key, record);
    await persistCategory(record);
    return safeValue;
  };

  const getPage = async request => {
    const key = pageKey(request);
    let record = memory.get(key);
    if (!record && db) {
      record = await tx(db, [STORE], 'readonly', t => new Promise(resolve => {
        const get = t.objectStore(STORE).get(key);
        get.onsuccess = () => resolve(get.result || null);
        get.onerror = () => resolve(null);
      })).catch(() => null);
    }
    if (!record) return null;
    const stale = Date.now() >= record.expiresAt;
    record.lastAccess = Date.now();
    memory.set(key, record);
    // Persist the access timestamp so quota eviction remains LRU after reload.
    if (!stale) void persistRecord(record);
    return { ...record.page, stale };
  };

  const putPage = async page => {
    const safePage = sanitizePage(page);
    const record = { key: pageKey(page), page: safePage, bytes: new TextEncoder().encode(JSON.stringify(safePage)).byteLength, expiresAt: Date.now() + ttlFor(page.kind), lastAccess: Date.now() };
    memory.set(record.key, record);
    if (db && persistent) {
      try {
        await tx(db, [STORE], 'readwrite', t => t.objectStore(STORE).put(record));
        await enforceQuota();
      } catch { persistent = false; }
    }
    return safePage;
  };

  const readPersistentRecords = async () => {
    if (!db || !persistent) return [];
    return tx(db, [STORE], 'readonly', t => new Promise(resolve => {
      const records = [];
      const request = t.objectStore(STORE).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve(records);
        records.push(cursor.value);
        cursor.continue();
      };
      request.onerror = () => resolve(records);
    })).catch(() => []);
  };
  const allRecords = async ({ currentScopeOnly = false } = {}) => {
    const records = new Map((await readPersistentRecords()).map(record => [record.key, record]));
    for (const [key, record] of memory.entries()) records.set(key, record);
    return [...records.values()].filter(record => !currentScopeOnly || String(record.key).startsWith(`${scope}|`));
  };
  const deleteByPrefix = async prefix => {
    for (const key of memory.keys()) if (key.startsWith(prefix)) memory.delete(key);
    if (db && persistent) await tx(db, [STORE], 'readwrite', t => {
      const request = t.objectStore(STORE).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (String(cursor.key).startsWith(prefix)) cursor.delete();
        cursor.continue();
      };
    }).catch(() => { persistent = false; });
  };
  const deleteMetaByPrefix = async prefix => {
    for (const key of categoryMemory.keys()) if (key.startsWith(prefix)) categoryMemory.delete(key);
    if (db && persistent) await tx(db, [META], 'readwrite', t => {
      const request = t.objectStore(META).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (String(cursor.key).startsWith(prefix)) cursor.delete();
        cursor.continue();
      };
    }).catch(() => { persistent = false; });
  };
  const enforceQuota = async () => {
    const records = await allRecords();
    let total = records.reduce((sum, item) => sum + item.bytes, 0);
    records.sort((a, b) => a.lastAccess - b.lastAccess);
    while (records.length > MAX_RECORDS || total > MAX_BYTES) {
      const victim = records.shift();
      if (!victim) break;
      memory.delete(victim.key);
      total -= victim.bytes;
      if (db && persistent) await tx(db, [STORE], 'readwrite', t => t.objectStore(STORE).delete(victim.key)).catch(() => { persistent = false; });
    }
  };
  const searchPages = async query => {
    const needle = String(query || '').trim().toLocaleLowerCase();
    if (needle.length < 2) return [];
    const records = await allRecords({ currentScopeOnly: true });
    return records.flatMap(record => record.page.items.filter(item => `${item.name || ''} ${item.group || ''}`.toLocaleLowerCase().includes(needle)))
      .slice(0, 80);
  };
  const clearOwner = async targetOwner => {
    const prefix = `${String(targetOwner)}|`;
    await deleteByPrefix(prefix);
    await deleteMetaByPrefix(prefix);
  };
  const clearConnection = async targetConnection => {
    const fingerprint = await stalkerCatalogConnectionFingerprint(normalizeStalkerCatalogConnection(targetConnection));
    const prefix = `${owner}|${fingerprint}|`;
    await deleteByPrefix(prefix);
    await deleteMetaByPrefix(prefix);
  };
  const invalidateScope = async filter => {
    for (const [key, record] of memory.entries()) {
      if (key.startsWith(`${scope}|`) && (!filter || Object.entries(filter).every(([name, value]) => record.page[name] === value))) memory.delete(key);
    }
    if (db && persistent) await tx(db, [STORE], 'readwrite', t => {
      const request = t.objectStore(STORE).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const record = cursor.value;
        const matches = String(cursor.key).startsWith(`${scope}|`)
          && (!filter || Object.entries(filter).every(([name, value]) => record.page?.[name] === value));
        if (matches) cursor.delete();
        cursor.continue();
      };
      }).catch(() => { persistent = false; });
    if (!filter || filter.kind === undefined) {
      await deleteMetaByPrefix(`${scope}|categories|`);
    } else if (filter.kind) {
      await deleteMetaByPrefix(`${scope}|categories|${String(filter.kind)}`);
    }
  };
  return {
    getPage,
    putPage,
    getCategories,
    putCategories,
    searchPages,
    clearOwner,
    clearConnection,
    invalidateScope,
    enforceQuota,
    persistent: () => persistent,
    scope,
  };
}

export { DB_NAME, DB_VERSION, MAX_BYTES, MAX_RECORDS, LIVE_TTL, CONTENT_TTL };

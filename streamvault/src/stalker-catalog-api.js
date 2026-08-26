import { API } from './utils.js';

const BASE = `${API}/stalker/catalog/v1`;
const FEATURE_ENABLED = String(import.meta.env.VITE_STALKER_LAZY_CATALOG_ENABLED || '').toLowerCase() === 'true';

export class StalkerCatalogError extends Error {
  constructor(message, code, status, retryAfterSeconds = 0) {
    super(message);
    this.name = 'StalkerCatalogError';
    this.code = code || 'provider_failure';
    this.status = status || 502;
    this.retryAfterSeconds = Number(retryAfterSeconds) || 0;
  }
}

export function formatStalkerCatalogError(error, fallback = 'Provider catalog request failed.') {
  const status = Number(error?.status);
  const code = String(error?.code || '');
  const retryAfter = Number(error?.retryAfterSeconds);

  if (code === 'provider_cooldown' || code === 'provider_rate_limited' || status === 429) {
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      const seconds = Math.ceil(retryAfter);
      return `Provider cooldown active. Please wait ${seconds} ${seconds === 1 ? 'second' : 'seconds'} before trying again.`;
    }
    return 'Provider cooldown active. Please wait before trying again.';
  }

  return error?.message || fallback;
}

function requireFeature(enabled) {
  if (!enabled) throw new StalkerCatalogError('Lazy catalog is disabled', 'feature_disabled', 404);
}

function assertPage(page) {
  if (!page || typeof page !== 'object' || !Array.isArray(page.items)
      || !Number.isInteger(page.page) || !Number.isInteger(page.pageSize)
      || typeof page.hasMore !== 'boolean') {
    throw new StalkerCatalogError('Invalid catalog response', 'invalid_catalog_response', 502);
  }
  return page;
}

function requestKeyPart(value) {
  let hash = 2166136261;
  for (const char of String(value ?? '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function abortError() {
  return typeof DOMException === 'function'
    ? new DOMException('The operation was aborted', 'AbortError')
    : Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

async function request(path, { fetcher = fetch, signal, enabled = FEATURE_ENABLED } = {}) {
  requireFeature(enabled);
  const response = await fetcher(`${BASE}${path}`, { credentials: 'include', signal });
  let body = null;
  try { body = await response.json(); } catch { /* structured error below */ }
  if (!response.ok) {
    throw new StalkerCatalogError(
      body?.error || `Catalog request failed (${response.status})`,
      body?.code,
      response.status,
      body?.retryAfterSeconds || response.headers?.get?.('Retry-After'),
    );
  }
  return body;
}

export function createStalkerCatalogApi({ fetcher = fetch, enabled = FEATURE_ENABLED } = {}) {
  const inFlight = new Map();
  const run = (key, operation, signal) => {
    let entry = inFlight.get(key);
    if (!entry) {
      const controller = new AbortController();
      entry = { controller };
      entry.promise = Promise.resolve().then(() => operation(controller.signal)).finally(() => inFlight.delete(key));
      inFlight.set(key, entry);
    }
    if (!signal) return entry.promise;
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      const onAbort = () => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  };
  return {
    fetchCategories({ kind, contentToken, refresh = false, signal }) {
      const params = new URLSearchParams({ kind, contentToken, ...(refresh ? { refresh: '1' } : {}) });
      return run(`categories:${kind}:${requestKeyPart(contentToken)}:${refresh}`, requestSignal => request(`/categories?${params}`, { fetcher, signal: requestSignal, enabled }), signal);
    },
    fetchCatalogPage({ kind, category = 'all', page = 1, pageSize = 100, contentToken, refresh = false, signal }) {
      const params = new URLSearchParams({ kind, category, page: String(page), pageSize: String(pageSize), contentToken, ...(refresh ? { refresh: '1' } : {}) });
      return run(`items:${kind}:${category}:${page}:${pageSize}:${requestKeyPart(contentToken)}:${refresh}`, async requestSignal => assertPage(await request(`/items?${params}`, { fetcher, signal: requestSignal, enabled })), signal);
    },
    searchProvider({ kind, category = 'all', query, page = 1, pageSize = 100, contentToken, signal }) {
      const params = new URLSearchParams({ kind, category, query, page: String(page), pageSize: String(pageSize), contentToken });
      return run(`search:${kind}:${category}:${requestKeyPart(query)}:${page}:${pageSize}:${requestKeyPart(contentToken)}`, async requestSignal => assertPage(await request(`/search?${params}`, { fetcher, signal: requestSignal, enabled })), signal);
    },
    abortScope() {
      for (const entry of inFlight.values()) entry.controller.abort();
      inFlight.clear();
    },
  };
}

export { FEATURE_ENABLED };

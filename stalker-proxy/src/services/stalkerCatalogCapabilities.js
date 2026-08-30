const { hashPart, pageSignature } = require('./stalkerCatalogPager');

const TTL_MS = 48 * 60 * 60 * 1000;
const LIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function createCatalogCapabilities({ cache, now = () => Date.now(), ttlForKind } = {}) {
  const keyFor = (providerKey, kind) => `stalker-capability-v1|${hashPart(providerKey)}|${kind}`;
  const ttlFor = kind => typeof ttlForKind === 'function'
    ? Number(ttlForKind(kind)) || TTL_MS
    : kind === 'live' ? LIVE_TTL_MS : TTL_MS;
  const defaults = () => ({ pagination: 'unknown', search: 'unknown', mode: 'provider_pages', updatedAt: now() });
  const get = (providerKey, kind) => {
    const value = cache?.get?.(keyFor(providerKey, kind));
    if (!value || now() - Number(value.updatedAt || 0) >= ttlFor(kind)) return defaults();
    return value;
  };
  const set = (providerKey, kind, value, { canCommit } = {}) => {
    if (typeof canCommit === 'function' && !canCommit()) return get(providerKey, kind);
    const next = { ...get(providerKey, kind), ...value, updatedAt: now() };
    cache?.set?.(keyFor(providerKey, kind), next, ttlFor(kind));
    return next;
  };
  return {
    get,
    invalidate(providerKey, kind) { cache?.del?.(keyFor(providerKey, kind)); },
    recordPaginationProbe(providerKey, kind, firstItems, secondItems, options) {
      const first = pageSignature(firstItems || []);
      const second = pageSignature(secondItems || []);
      if (!secondItems?.length || first !== second) return set(providerKey, kind, { pagination: 'supported', mode: 'provider_pages', firstSignature: first }, options);
      return set(providerKey, kind, { pagination: 'unsupported', mode: 'first_page_only', firstSignature: first }, options);
    },
    recordPaginationUnsupported(providerKey, kind, options) {
      return set(providerKey, kind, {
        pagination: 'unsupported',
        mode: 'first_page_only',
      }, options);
    },
    recordLiveSnapshotMode(providerKey, options) {
      return set(providerKey, 'live', {
        pagination: 'unsupported',
        mode: 'bounded_live_snapshot',
      }, options);
    },
    recordSearchProbe(providerKey, kind, firstItems, secondItems, options) {
      const first = firstItems || [];
      const second = secondItems || [];
      if (!first.length && !second.length) {
        return set(providerKey, kind, {
          search: 'inconclusive',
          searchProbeAfter: now() + 15 * 60 * 1000,
        }, options);
      }
      const same = pageSignature(first) === pageSignature(second);
      return set(providerKey, kind, {
        search: same ? 'unsupported' : 'supported',
        searchProbeAfter: null,
      }, options);
    },
    recordSearchSuccess(providerKey, kind) {
      return set(providerKey, kind, { search: 'supported' });
    },
    recordSearchResult(providerKey, kind, items, options) {
      const current = get(providerKey, kind);
      if (current.search !== 'inconclusive' || !Array.isArray(items) || items.length === 0) return current;
      // A non-empty result proves the provider can react to at least one
      // query. Allow one fresh probe on the next request to classify it.
      return set(providerKey, kind, { search: 'unknown', searchProbeAfter: 0 }, options);
    },
  };
}

module.exports = { createCatalogCapabilities, TTL_MS, LIVE_TTL_MS };

const crypto = require('crypto');

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 250;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

function pageSize(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, parsed));
}

function itemsFromPayload(payload) {
  if (Array.isArray(payload?.js?.data)) return payload.js.data;
  if (Array.isArray(payload?.js)) return payload.js;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function metaFromPayload(payload) {
  return payload?.js && !Array.isArray(payload.js) ? payload.js : payload || {};
}

function itemIdentity(item) {
  return String(item?.id ?? item?.stream_id ?? item?.ch_id ?? item?.cmd ?? item?.name ?? '');
}

function pageSignature(items) {
  return crypto.createHash('sha256')
    .update(items.map(itemIdentity).join('\u001f'))
    .digest('hex');
}

function totalFrom(meta) {
  const value = Number.parseInt(meta.total_items ?? meta.totalItems ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function pagesFrom(meta) {
  const value = Number.parseInt(meta.total_pages ?? meta.totalPages ?? meta.max_pages ?? meta.maxPages ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function providerPageSizeFrom(meta, fallback) {
  const value = Number.parseInt(meta.max_page_items ?? meta.page_items ?? meta.per_page ?? meta.pageSize ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeCatalogPage(payload, options = {}) {
  const page = Math.max(1, Number.parseInt(options.page, 10) || 1);
  const size = pageSize(options.pageSize);
  const raw = itemsFromPayload(payload);
  const meta = metaFromPayload(payload);
  const total = totalFrom(meta);
  const providerPages = pagesFrom(meta);
  // Some portals return a complete provider page even when the browser asks
  // for a smaller page. Keep that provider page intact so its overflow is not
  // skipped when the next provider page is requested.
  const declaredProviderPageSize = providerPageSizeFrom(meta, null);
  const providerPageSize = declaredProviderPageSize || (raw.length > size ? raw.length : size);
  const itemLimit = declaredProviderPageSize
    ? Math.max(size, providerPageSize)
    : raw.length > size
      ? raw.length
      : size;
  const seen = new Set();
  const items = [];
  for (const item of raw) {
    const identity = itemIdentity(item);
    if (identity && seen.has(identity)) continue;
    if (identity) seen.add(identity);
    items.push(typeof options.mapItem === 'function' ? options.mapItem(item) : item);
    if (items.length >= itemLimit) break;
  }

  const shortPage = raw.length < providerPageSize;
  const hasMore = raw.length === 0
    ? false
    : providerPages
    ? page < providerPages
      : total !== null
      ? page * providerPageSize < total
      : !shortPage;
  const result = {
    kind: options.kind,
    category: options.category ?? 'all',
    items,
    page,
    pageSize: size,
    hasMore: Boolean(hasMore),
    nextPage: hasMore ? page + 1 : null,
    total,
    totalKnown: total !== null,
    complete: !hasMore && (raw.length === 0 || total === null || page * providerPageSize >= total || shortPage),
    providerPageSize,
    capabilities: options.capabilities || {
      pagination: 'unknown',
      search: 'unknown',
      mode: 'provider_pages',
    },
    refreshedAt: Date.now(),
  };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_PAGE_BYTES) {
    const error = new Error('Normalized catalog page exceeds 2097152 bytes');
    error.code = 'CATALOG_PAGE_TOO_LARGE';
    error.status = 502;
    throw error;
  }
  return result;
}

function hashPart(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_PAGE_BYTES,
  itemsFromPayload,
  itemIdentity,
  pageSignature,
  normalizeCatalogPage,
  hashPart,
  pageSize,
};

const express = require("express");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { decryptToken, encryptToken } = require('../middleware/encrypt');
const { createContentSessionStore } = require('../services/contentSessionStore');
const { normalizeCreateLinkResponse, classifyStreamKind: classifyNormalizedStreamKind } = require('../services/stalkerResponseNormalizer');
const { directPlayEnabled, mediaRelayEnabled, redirectProbeMode } = require('../services/stalkerDirectPolicy');
const { buildResolveContract } = require('../services/stalkerLinkResolver');
const { normalizeSeasons } = require('../services/stalkerSeriesNormalizer');
const { catchupVariants, normalizeCatchupRequest } = require('../services/stalkerCatchupResolver');
const { sanitizeStalkerUrl, stripStalkerPlaybackTokens } = require('../services/stalkerSecurity');
const stalkerMetrics = require('../services/stalkerAuditMetrics');
const { pickAndValidateStalkerParams } = require('../services/stalkerRequestParams');
const { classifyProviderError } = require('../services/stalkerErrorClassifier');
const { createRelaySlotManager } = require('../services/stalkerRelaySlots');
const { createCatalogCapabilities } = require('../services/stalkerCatalogCapabilities');
const { createProviderMetadataCoordinator } = require('../services/providerMetadataCoordinator');
const { catalogIdentityHash } = require('../services/stalkerCatalogIdentity');
const { createCatalogGenerations } = require('../services/stalkerCatalogGeneration');
const { createCatalogPageHistory } = require('../services/stalkerCatalogPageHistory');
const { createLiveSnapshotStore } = require('../services/stalkerLiveSnapshot');
const { normalizeCatalogPage, hashPart, pageSignature, pageSize: normalizePageSize, itemsFromPayload } = require('../services/stalkerCatalogPager');
const rateLimit = require('express-rate-limit');

const fallbackSessionStore = createContentSessionStore();
const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex');

const contentSessionTtlMs = () => {
  const parsed = Number.parseInt(process.env.CONTENT_SESSION_TTL_MINUTES || '', 10);
  const minutes = Number.isFinite(parsed) ? Math.min(120, Math.max(5, parsed)) : 30;
  return minutes * 60_000;
};

const CATALOG_TTL = {
  channels: 30 * 24 * 60 * 60_000,
  categories: 24 * 60 * 60_000,
  content: 12 * 60 * 60_000,
  epg: 30 * 60_000,
};
const LAZY_CATALOG_TTL = {
  live: 30 * 24 * 60 * 60_000,
  categories: 48 * 60 * 60_000,
  content: 48 * 60 * 60_000,
};
const isRateLimitError = error => /(?:429|rate limit|too many request)/i.test(error?.message || "");
const OPAQUE_COMMAND_PREFIX = 'svopaque:';
const GUEST_ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[A-Za-z0-9_-]{16,64})$/i;
function encodeOpaqueCommand(command, { expires = true, binding = null } = {}) {
  if (!command || String(command).startsWith(OPAQUE_COMMAND_PREFIX)) return command || null;
  const issuedAt = Date.now();
  const payload = {
    command: String(command),
    iat: issuedAt,
    ...(binding ? { binding: String(binding) } : {}),
    ...(expires ? { exp: issuedAt + 30 * 60_000 } : {}),
  };
  return OPAQUE_COMMAND_PREFIX + encryptToken(JSON.stringify(payload));
}
function decodeOpaqueCommand(command, expectedBinding = null) {
  if (!String(command || '').startsWith(OPAQUE_COMMAND_PREFIX)) return command;
  const payload = JSON.parse(decryptToken(String(command).slice(OPAQUE_COMMAND_PREFIX.length)));
  if (!payload?.command) throw new Error('Opaque Stalker command is invalid');
  if (payload.exp && Number(payload.exp) <= Date.now()) {
    const error = new Error('Opaque Stalker command expired');
    error.code = 'EXPIRED';
    error.status = 410;
    throw error;
  }
  if (payload.binding && expectedBinding && payload.binding !== expectedBinding) {
    const error = new Error('Opaque Stalker command belongs to another connection');
    error.code = 'PLAY_REF_CONNECTION_MISMATCH';
    error.status = 403;
    throw error;
  }
  return payload.command;
}
function opaqueSeasonCommands(value, key = '') {
  if (Array.isArray(value)) return value.map(item => opaqueSeasonCommands(item));
  if (!value || typeof value !== 'object') return /^(?:cmd|url)$/.test(key) && typeof value === 'string' ? encodeOpaqueCommand(value) : value;
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, opaqueSeasonCommands(child, childKey)]));
}
function cacheSafeCatalog(value, key = '') {
  if (Array.isArray(value)) return value.map(item => cacheSafeCatalog(item));
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' && /^(?:cmd|url)$/i.test(key)
      ? stripStalkerPlaybackTokens(value)
      : value;
  }
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, cacheSafeCatalog(child, childKey)]));
}
const catalogItemLimit = () => {
  const parsed = Number.parseInt(process.env.STALKER_CATALOG_MAX_ITEMS || '', 10);
  return Number.isFinite(parsed) ? Math.min(50_000, Math.max(100, parsed)) : 50_000;
};
// Keep channel responses bounded. Some portals expose hundreds of thousands of
// channels, and aggregating an unbounded catalog can exhaust the Node heap.
const channelCatalogItemLimit = () => {
  const configured = Number.parseInt(
    process.env.STALKER_CHANNELS_MAX_ITEMS || '',
    10,
  );
  return Number.isFinite(configured) ? Math.min(50_000, Math.max(100, configured)) : 50_000;
};
const CHANNEL_CATALOG_MAX_PAGES = 500;
const isMetadataLimitError = error => error?.code === "METADATA_TOO_LARGE"
  || /^Portal metadata response exceeds \d+ bytes$/i.test(String(error?.message || ""));
const channelPageItems = payload => {
  if (Array.isArray(payload?.js?.data)) return payload.js.data;
  if (Array.isArray(payload?.js)) return payload.js;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
};
const channelPageCount = (payload, itemCount) => {
  const body = payload?.js && !Array.isArray(payload.js) ? payload.js : payload;
  const explicitPages = Number.parseInt(body?.total_pages || body?.totalPages || "", 10);
  if (Number.isFinite(explicitPages) && explicitPages > 0) return explicitPages;
  const totalItems = Number.parseInt(body?.total_items || body?.totalItems || "", 10);
  const pageSize = Number.parseInt(body?.max_page_items || body?.per_page || itemCount || "", 10);
  if (Number.isFinite(totalItems) && Number.isFinite(pageSize) && pageSize > 0) {
    return Math.max(1, Math.ceil(totalItems / pageSize));
  }
  return 1;
};

function createStalkerRouter(deps) {
  const { cache, auth, fetch, isUrlAllowed, fetchWithRedirectCheck, getSession, portalFetchRetry: rawPortalFetchRetry, portalFetchChannelCatalog: rawPortalFetchChannelCatalog, portalFetchChannelCatalogPage: rawPortalFetchChannelCatalogPage, safeError, buildStalkerStreamHeaders, summarizeUpstreamHeaders } = deps;
  const sessionStore = deps.contentSessionStore || (deps.cache?.db && typeof deps.cache.db.exec === 'function' ? createContentSessionStore({ db: deps.cache.db }) : fallbackSessionStore);
  const router = express.Router();
  const requestContext = new AsyncLocalStorage();
  const portalFetchRetry = (session, params, timeout, signal) => rawPortalFetchRetry(
    session,
    params,
    timeout,
    { signal: signal || requestContext.getStore()?.signal },
  );
  const portalFetchChannelCatalog = rawPortalFetchChannelCatalog
    ? (session, maxItems, timeout, requestOptions) => {
      const options = requestOptions && typeof requestOptions === 'object' && ('signal' in requestOptions || 'onItem' in requestOptions)
        ? { ...requestOptions }
        : { signal: requestOptions };
      if (!options.signal) options.signal = requestContext.getStore()?.signal;
      return rawPortalFetchChannelCatalog(session, maxItems, timeout, options);
    }
    : null;
  const portalFetchChannelCatalogPage = rawPortalFetchChannelCatalogPage
    ? (session, options, timeout, requestOptions) => {
      const signal = requestOptions && typeof requestOptions === 'object' && 'signal' in requestOptions
        ? requestOptions.signal
        : requestOptions;
      return rawPortalFetchChannelCatalogPage(session, options, timeout, {
        ...(requestOptions && typeof requestOptions === 'object' ? requestOptions : {}),
        signal: signal || requestContext.getStore()?.signal,
      });
    }
    : null;
  router.use((req, res, next) => {
    const controller = new AbortController();
    let completed = false;
    res.once('finish', () => { completed = true; });
    res.once('close', () => { if (!completed) controller.abort(); });
    req.once('aborted', () => controller.abort());
    requestContext.run({ signal: controller.signal }, next);
  });
  const STREAM_CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Allow-Headers": "Range, Content-Type", "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length, Content-Type" };
  const safeStalkerError = error => sanitizeStalkerUrl(safeError(error));
  const respondWithError = (res, error) => {
    if (res.headersSent || res.destroyed) {
      stalkerMetrics.increment("stalker_errors_after_headers_total");
      if (!res.destroyed) res.destroy(error instanceof Error ? error : undefined);
      return;
    }
    const { status, code } = classifyProviderError(error);
    if (error?.retryAfterMs) {
      res.set('Retry-After', String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
    }
    res.status(status).json({
      error: safeStalkerError(error),
      code,
      ...(error?.retryAfterMs ? { retryAfterSeconds: Math.max(1, Math.ceil(error.retryAfterMs / 1000)) } : {}),
    });
  };
  const validateQuery = route => (req, res, next) => {
    try {
      pickAndValidateStalkerParams(req.query, route);
      next();
    } catch (error) {
      res.status(error.status || 400).json({
        error: sanitizeStalkerUrl(error.message),
        code: error.code || "invalid_parameter",
      });
    }
  };
  const mediaTargetHeaders = (headers, portal, target) => {
    try {
      if (new URL(portal).host === new URL(target).host) return headers;
    } catch { return {}; }
    return Object.fromEntries(Object.entries(headers || {}).filter(([name]) =>
      !["authorization", "cookie", "proxy-authorization", "referer", "x-user-agent"].includes(name.toLowerCase())));
  };
  const relaySlots = createRelaySlotManager();
  const catalogCapabilities = createCatalogCapabilities({ cache });
  const liveSnapshotStore = deps.liveSnapshotStore || createLiveSnapshotStore({ cache, ttlMs: LAZY_CATALOG_TTL.live });
  const metadataCoordinator = createProviderMetadataCoordinator();
  const lazyCatalogEnabled = () => String(process.env.STALKER_LAZY_CATALOG_ENABLED || '').toLowerCase() === 'true';
  const catalogBinding = (portal, mac, opts = {}) => catalogIdentityHash({ portal, mac, ...opts });
  const catalogProviderKey = (portal, mac, opts = {}) => catalogBinding(portal, mac, opts);
  const catalogIdentityKey = (portal, mac, opts = {}) => catalogIdentityHash({ portal, mac, ...opts });
  const catalogCapabilityGenerationKey = (portal, mac, kind, opts = {}) =>
    `${catalogIdentityKey(portal, mac, opts)}|${kind}|capabilities`;
  const catalogCacheKey = (portal, mac, kind, category, page, size, query = '', opts = {}) =>
    `stalker-catalog-v2|${catalogIdentityKey(portal, mac, opts)}|${kind}|${hashPart(category || 'all')}|${page}|${size}|${hashPart(query)}`;
  const catalogCategoryCacheKey = (portal, mac, kind, opts = {}) =>
    `stalker-catalog-categories-v2|${catalogIdentityKey(portal, mac, opts)}|${kind}`;
  const catalogSnapshotKey = (portal, mac, kind, category, size, opts = {}) =>
    `stalker-catalog-snapshot-v1|${catalogIdentityKey(portal, mac, opts)}|${kind}|${hashPart(category || 'all')}|${size}`;
  const catalogSnapshotPageKey = (portal, mac, kind, category, size, generation, page, opts = {}) =>
    `${catalogSnapshotKey(portal, mac, kind, category, size, opts)}|generation:${generation}|page:${page}`;
  const snapshotBuilds = new Map();
  const liveSnapshotRuns = new Map();
  const snapshotEpochs = new Map();
  const catalogGenerations = createCatalogGenerations();
  const catalogPageHistory = createCatalogPageHistory();
  const catalogParam = (value, fallback = '') => String(value ?? fallback).trim();
  const catalogKind = value => ['live', 'vod', 'series'].includes(value) ? value : null;
  const catalogRequestError = (message, code = 'invalid_parameter', status = 400) => Object.assign(new Error(message), { code: code.toUpperCase(), status });
  const invalidateCatalog = (portal, mac, kind, category, size = 100, opts = {}) => {
    const identityKey = catalogIdentityKey(portal, mac, opts);
    const epochKey = `${identityKey}|${kind}|${category || 'all'}`;
    if (category == null) catalogGenerations.bumpMatching(`${identityKey}|${kind}|`);
    else catalogGenerations.bump(epochKey);
    catalogGenerations.bump(catalogCapabilityGenerationKey(portal, mac, kind, opts));
    catalogCapabilities.invalidate(catalogProviderKey(portal, mac, opts), kind);
    if (kind === 'live') {
      catalogGenerations.bump(liveSnapshotGenerationKey(identityKey));
      liveSnapshotStore.invalidate?.(identityKey);
      for (const [runKey, run] of liveSnapshotRuns) {
        if (runKey.startsWith(`${identityKey}|`)) run.controller.abort();
      }
    }
    const manifestKey = catalogSnapshotKey(portal, mac, kind, category, size, opts);
    const manifest = cache.get(manifestKey);
    const categoryPrefix = category == null ? '' : `${hashPart(category || 'all')}|`;
    const pagePrefix = `stalker-catalog-v2|${identityKey}|${kind}|${categoryPrefix}`;
    const snapshotPrefix = `stalker-catalog-snapshot-v1|${identityKey}|${kind}|${categoryPrefix}`;
    catalogPageHistory.clear(`${identityKey}|${kind}|${category == null ? '' : `${hashPart(category || 'all')}|`}`);
    for (const buildKey of snapshotBuilds.keys()) {
      if (buildKey.startsWith(snapshotPrefix)) {
        snapshotEpochs.set(buildKey, (snapshotEpochs.get(buildKey) || 0) + 1);
        snapshotBuilds.delete(buildKey);
      }
    }
    if (typeof cache.deleteKeysByPrefix === 'function') {
      cache.deleteKeysByPrefix(pagePrefix);
      cache.deleteKeysByPrefix(snapshotPrefix);
    } else if (typeof cache.keysByPrefix === 'function') {
      for (const key of cache.keysByPrefix(pagePrefix)) cache.del?.(key);
      for (const key of cache.keysByPrefix(snapshotPrefix)) cache.del?.(key);
    } else {
      if (manifest?.generation) {
        for (let page = 1; page <= Math.min(500, Number(manifest.pageCount) || 0); page += 1) {
          cache.del?.(catalogSnapshotPageKey(portal, mac, kind, category, size, manifest.generation, page, opts));
        }
      }
      for (let page = 1; page <= 500; page += 1) {
          cache.del?.(catalogCacheKey(portal, mac, kind, category, page, size, '', opts));
      }
    }
    cache.del?.(manifestKey);
  };
  const parseCatalogQuery = (req, { endpoint = 'items' } = {}) => {
    const authParams = ['contentToken', 'portal', 'mac', 'serial', 'deviceId', 'deviceId2'];
    const endpointParams = {
      categories: ['kind', 'refresh'],
      items: ['kind', 'category', 'page', 'pageSize', 'refresh'],
      search: ['kind', 'category', 'query', 'page', 'pageSize'],
    };
    const allowed = new Set([...(endpointParams[endpoint] || endpointParams.items), ...authParams]);
    const unexpected = Object.keys(req.query || {}).find(key => !allowed.has(key));
    if (unexpected) throw catalogRequestError(`Unsupported catalog parameter: ${unexpected}`);
    const kind = catalogKind(catalogParam(req.query.kind));
    if (!kind) throw catalogRequestError('kind must be live, vod, or series');
    const category = catalogParam(req.query.category, 'all');
    if ((kind === 'vod' || kind === 'series') && !category) throw catalogRequestError('category is required');
    const page = Number.parseInt(req.query.page || '1', 10);
    const size = normalizePageSize(req.query.pageSize || '100');
    if (!/^\d+$/.test(String(req.query.page || '1')) || page < 1) throw catalogRequestError('page must be a positive integer');
    const rawPageSize = String(req.query.pageSize || '100');
    if (!/^\d+$/.test(rawPageSize) || Number(rawPageSize) < 1 || Number(rawPageSize) > 250) throw catalogRequestError('pageSize must be between 1 and 250');
    const query = endpoint === 'search' ? catalogParam(req.query.query) : '';
    if (endpoint === 'search' && (query.length < 2 || query.length > 128)) throw catalogRequestError('query must contain between 2 and 128 characters');
    return { kind, category, page, size, query };
  };
  const mapCatalogItem = (kind, item, binding) => {
    const base = {
      id: item?.id ?? item?.stream_id ?? item?.ch_id ?? null,
      name: item?.name || item?.title || item?.o_name || 'Untitled',
      logo: item?.logo || item?.icon || item?.screenshot_uri || item?.cover || null,
      type: kind,
      group: item?.group_name || item?.genre_str || item?.category_name || null,
    };
    if (kind === 'live') return {
      ...base,
      num: item?.number ?? item?.num ?? null,
      epgId: item?.xmltv_id || item?.epg_id || null,
      _catalogPlayRef: encodeOpaqueCommand(item?.cmd || item?.command, { expires: false, binding }),
    };
    return {
      ...base,
      year: item?.year || null,
      rating: item?.rating_imdb || item?.rating || null,
      plot: item?.description || item?.plot || null,
      _catalogPlayRef: encodeOpaqueCommand(item?.cmd || item?.command, { expires: false, binding }),
    };
  };
  const materializeCatalogPage = (page, binding) => {
    if (!page || !Array.isArray(page.items)) return page;
    return {
      ...page,
      items: page.items.map(item => {
        if (!item?._catalogPlayRef) return item;
        const { _catalogPlayRef, ...safeItem } = item;
        return { ...safeItem, playRef: encodeOpaqueCommand(decodeOpaqueCommand(_catalogPlayRef), { binding }) };
      }),
    };
  };
  const providerPageParams = ({ kind, category, page, query }) => {
    if (kind === 'live') {
      return { type: 'itv', action: page === 1 ? 'get_ichannels_via_api' : 'get_ichannels_via_api', page, p: page, genre: category === 'all' ? undefined : category, search: query || undefined };
    }
    return { type: kind, action: 'get_ordered_list', category, page, p: page, search: query || undefined };
  };
  const canUseLiveCatalogFallback = error => {
    const code = String(error?.code || '').toUpperCase();
    const message = String(error?.message || '');
    if (['RATE_LIMITED', 'PROVIDER_COOLDOWN', 'ABORT_ERR', 'PROVIDER_METADATA_BUSY', 'AUTHORIZATION_FAILURE', 'UNAUTHORIZED'].includes(code)) return false;
    return !error?.status || ![401, 403, 429, 499].includes(Number(error.status))
      && !/rate.?limited|cooldown|unauthori[sz]ed|authorization|device not found|access denied|\b429\b|aborted/i.test(message);
  };
  const fetchCatalogProviderPage = async (session, request, signal) => {
    const params = providerPageParams(request);
    try {
      const payload = await portalFetchRetry(session, Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined)), undefined, signal);
      if (request.kind === 'live' && request.page === 1 && !request.query && !itemsFromPayload(payload).length && portalFetchChannelCatalog && liveSnapshotStore) {
        return { js: { data: [] }, __liveSnapshotFallback: true };
      }
      if (request.kind === 'live' && request.page === 1 && !request.query && !itemsFromPayload(payload).length && portalFetchChannelCatalogPage) {
        return portalFetchChannelCatalogPage(session, {
          category: request.category,
          page: request.page,
          pageSize: request.size,
        }, undefined, { signal });
      }
      return payload;
    } catch (error) {
      if (request.kind === 'live' && !request.query && canUseLiveCatalogFallback(error) && portalFetchChannelCatalog) {
        return { js: { data: [] }, __liveSnapshotFallback: true };
      }
      if (request.kind === 'live' && !request.query && canUseLiveCatalogFallback(error)) {
        if (portalFetchChannelCatalogPage) {
          return portalFetchChannelCatalogPage(session, {
            category: request.category,
            page: request.page,
            pageSize: request.size,
          }, undefined, { signal });
        }
        if (request.page === 1) {
          return portalFetchRetry(session, { type: 'itv', action: 'get_all_channels', page: 1, p: 1 }, undefined, signal);
        }
      }
      throw error;
    }
  };
  const liveSnapshotGenerationKey = identityHash => `${identityHash}|live|snapshot`;
  const buildOrJoinLiveSnapshot = async ({ session, portal, mac, catalogOpts, request, signal }) => {
    const identityHash = catalogIdentityKey(portal, mac, catalogOpts);
    const generationKey = liveSnapshotGenerationKey(identityHash);
    const generation = catalogGenerations.current(generationKey);
    const existing = liveSnapshotStore.getManifest(identityHash);
    if (existing && String(existing.generation) === String(generation)) {
      return liveSnapshotStore.readPage({ identityHash, category: request.category, page: request.page, pageSize: request.size });
    }

    const buildKey = `${identityHash}|${generation}`;
    const build = liveSnapshotStore.begin({ identityHash, generation });
    if (!liveSnapshotRuns.has(buildKey)) {
      const snapshotController = new AbortController();
      const startedAt = Date.now();
      let acceptedItems = 0;
      stalkerMetrics.increment('stalker_live_snapshot_started_total');
      const promise = (async () => {
        try {
          await portalFetchChannelCatalog(session, channelCatalogItemLimit(), undefined, {
            signal: snapshotController.signal,
            onItem: async rawItem => {
              const accepted = await build.append({
                item: mapCatalogItem('live', rawItem, catalogBinding(portal, mac, catalogOpts)),
                categoryId: rawItem?.tv_genre_id ?? rawItem?.genre_id ?? rawItem?.category_id ?? rawItem?.group_id ?? 'all',
              });
              if (accepted) acceptedItems += 1;
            },
          });
          const completed = await build.complete();
          if (completed) {
            stalkerMetrics.increment('stalker_live_snapshot_completed_total');
            stalkerMetrics.increment('stalker_live_snapshot_items_total', acceptedItems);
          }
        } catch (error) {
          stalkerMetrics.increment('stalker_live_snapshot_failed_total');
          await build.fail(error);
          throw error;
        } finally {
          stalkerMetrics.increment('stalker_live_snapshot_duration_ms', Date.now() - startedAt);
        }
      })().finally(() => liveSnapshotRuns.delete(buildKey));
      liveSnapshotRuns.set(buildKey, { promise, controller: snapshotController });
    } else {
      stalkerMetrics.increment('stalker_live_snapshot_joined_total');
    }
    return build.waitForPage({ category: request.category, page: request.page, pageSize: request.size, signal });
  };
  const emptySnapshotPage = (request, total = 0) => ({
    kind: request.kind,
    category: request.category || 'all',
    items: [],
    page: request.page,
    pageSize: request.size,
    hasMore: false,
    nextPage: null,
    total,
    totalKnown: true,
    complete: true,
    capabilities: { pagination: 'unsupported', mode: 'bounded_live_snapshot', search: 'unknown' },
    refreshedAt: Date.now(),
  });
  const buildLiveSnapshot = async (session, request, capabilities, signal) => {
    const sessionOpts = session.opts || {};
    const manifestKey = catalogSnapshotKey(session.portal || session.base, session.mac, request.kind, request.category, request.size, sessionOpts);
    const existingManifest = cache.get(manifestKey);
    const snapshotPageFor = manifest => {
      if (!manifest || request.page > manifest.pageCount) return emptySnapshotPage(request, Number(manifest?.total) || 0);
      const page = cache.get(catalogSnapshotPageKey(session.portal || session.base, session.mac, request.kind, request.category, request.size, manifest.generation, request.page, sessionOpts));
      if (!page) return emptySnapshotPage(request, Number(manifest.total) || 0);
      return { ...page, total: Number(manifest.total) || 0, totalKnown: true, complete: page.page >= manifest.pageCount };
    };
    if (existingManifest) return snapshotPageFor(existingManifest);

    const buildKey = manifestKey;
    if (snapshotBuilds.has(buildKey)) {
      await snapshotBuilds.get(buildKey);
      return snapshotPageFor(cache.get(manifestKey));
    }

    const generation = crypto.randomBytes(12).toString('hex');
    const stagedKeys = [];
    const buildEpoch = snapshotEpochs.get(buildKey) || 0;
    const snapshotCapabilities = { ...capabilities, pagination: 'unsupported', mode: 'bounded_live_snapshot' };
    const binding = catalogBinding(session.portal || session.base, session.mac, sessionOpts);
    const staged = (async () => {
      let page = 1;
      let total = 0;
      let chunk = [];
      const seen = new Set();
      const maxItems = channelCatalogItemLimit();
      const writePage = (pageNumber, items, complete) => {
        const snapshotPage = normalizeCatalogPage({ js: { data: items } }, {
          kind: request.kind,
          category: request.category,
          page: pageNumber,
          pageSize: request.size,
          capabilities: snapshotCapabilities,
          mapItem: item => mapCatalogItem(request.kind, item, binding),
        });
        snapshotPage.total = null;
        snapshotPage.totalKnown = false;
        snapshotPage.hasMore = !complete;
        snapshotPage.nextPage = complete ? null : pageNumber + 1;
        snapshotPage.complete = complete;
        const key = catalogSnapshotPageKey(session.portal || session.base, session.mac, request.kind, request.category, request.size, generation, pageNumber, sessionOpts);
        stagedKeys.push(key);
        cache.set(key, snapshotPage, CATALOG_TTL.channels);
      };
      const consume = async item => {
        if (signal?.aborted) throw Object.assign(new Error('Snapshot build aborted'), { code: 'ABORT_ERR', status: 499 });
        if (total >= maxItems) return;
        const identity = String(item?.id ?? item?.stream_id ?? item?.ch_id ?? item?.cmd ?? item?.name ?? '');
        if (identity && seen.has(identity)) return;
        if (identity) seen.add(identity);
        chunk.push(item);
        total += 1;
        if (chunk.length >= request.size) {
          writePage(page, chunk, false);
          page += 1;
          chunk = [];
        }
      };
      if (portalFetchChannelCatalog) {
        const result = await portalFetchChannelCatalog(session, maxItems, undefined, { signal, onItem: consume });
        // Test doubles and older integrations may still return an array instead
        // of consuming the callback. Keep that compatibility without changing
        // the streaming production path.
        if (Array.isArray(result)) for (const item of result) await consume(item);
      } else {
        for (const item of itemsFromPayload(await fetchCatalogProviderPage(session, { ...request, page: 1 }, signal))) await consume(item);
      }
      if (chunk.length || page === 1) writePage(page, chunk, true);
      else {
        const lastKey = stagedKeys[stagedKeys.length - 1];
        const lastPage = cache.get(lastKey);
        if (lastPage) {
          lastPage.complete = true;
          lastPage.hasMore = false;
          lastPage.nextPage = null;
          cache.set(lastKey, lastPage, CATALOG_TTL.channels);
        }
      }
      if ((snapshotEpochs.get(buildKey) || 0) !== buildEpoch) {
        throw Object.assign(new Error('Live catalog snapshot invalidated'), { code: 'SNAPSHOT_INVALIDATED', status: 409 });
      }
      const pageCount = Math.max(1, stagedKeys.length);
      cache.set(manifestKey, { generation, total, pageCount, pageSize: request.size, refreshedAt: Date.now() }, CATALOG_TTL.channels);
    })().catch(error => {
      for (const key of stagedKeys) cache.del?.(key);
      throw error;
    });
    snapshotBuilds.set(buildKey, staged);
    try {
      await staged;
      return snapshotPageFor(cache.get(manifestKey));
    } finally {
      if (snapshotBuilds.get(buildKey) === staged) snapshotBuilds.delete(buildKey);
    }
  };
  const validationIpLimit = rateLimit({
    windowMs: 60_000,
    max: Math.max(1, Math.min(120, Number.parseInt(process.env.STALKER_VALIDATE_IP_MAX_PER_MINUTE || '30', 10) || 30)),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many Stalker validation requests', code: 'rate_limited' },
  });
  const validationGuestLimit = rateLimit({
    windowMs: 60_000,
    max: Math.max(1, Math.min(60, Number.parseInt(process.env.STALKER_VALIDATE_MAX_PER_MINUTE || '10', 10) || 10)),
    keyGenerator: req => String(req.headers['x-guest-id'] || '').trim(),
    skip: req => !GUEST_ID_RE.test(String(req.headers['x-guest-id'] || '').trim()),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many Stalker validation requests', code: 'rate_limited' },
  });
  const relayGrantSecret = () => String(process.env.STALKER_RELAY_GRANT_SECRET || "");
  const relaySubject = req => req._stalkerCreds?.contentToken
    ? tokenHash(req._stalkerCreds.contentToken)
    : String(req.user?.sub || req.user?.id || "authenticated");
  const relaySignature = (req, cmd, expires) => crypto.createHmac("sha256", relayGrantSecret())
    .update(`${relaySubject(req)}:${expires}:${crypto.createHash("sha256").update(String(cmd)).digest("hex")}`)
    .digest("base64url");
  const verifyRelayGrant = (req, cmd) => {
    const [rawExpires, signature] = String(req.query.relayGrant || "").split(".");
    const expires = Number(rawExpires);
    if (!relayGrantSecret() || !signature || !Number.isFinite(expires) || expires <= Date.now()) return false;
    const expected = relaySignature(req, cmd, expires);
    return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  };
  const relayLimit = () => Math.max(1, Math.min(10, Number.parseInt(process.env.STALKER_RELAY_MAX_CONCURRENCY || "2", 10) || 2));

  async function fetchChannelCatalog(session) {
    const limit = channelCatalogItemLimit();
    let streamingError;
    if (portalFetchChannelCatalog) {
      try {
        const channels = await portalFetchChannelCatalog(session, limit);
        if (channels.length) return { js: { data: channels.slice(0, limit) } };
      } catch (error) {
        streamingError = error;
      }
    }

    let catalogError;
    try {
      const payload = await portalFetchRetry(session, { type: "itv", action: "get_all_channels" });
      const items = channelPageItems(payload);
      return { js: { data: items.slice(0, limit) } };
    } catch (error) {
      catalogError = error;
    }
    if (!isMetadataLimitError(catalogError)) throw catalogError;

    const loadPages = async action => {
      const channels = [];
      const seen = new Set();
      let totalPages = 1;
      for (let page = 1; page <= Math.min(totalPages, CHANNEL_CATALOG_MAX_PAGES) && channels.length < limit; page++) {
        const payload = await portalFetchRetry(session, { type: "itv", action, page, p: page });
        const items = channelPageItems(payload);
        if (!items.length) break;
        if (page === 1) totalPages = channelPageCount(payload, items.length);

        let added = 0;
        for (const item of items) {
          const identity = String(item?.id ?? item?.ch_id ?? item?.cmd ?? "");
          if (identity && seen.has(identity)) continue;
          if (identity) seen.add(identity);
          channels.push(item);
          added++;
          if (channels.length >= limit) break;
        }
        // Some portals ignore page parameters and repeat page one forever.
        if (!added) break;
      }
      return channels;
    };

    let fallbackError = streamingError || catalogError;
    for (const action of ["get_all_channels", "get_ichannels_via_api"]) {
      try {
        const channels = await loadPages(action);
        if (channels.length) return { js: { data: channels } };
      } catch (error) {
        fallbackError = error;
      }
    }

    catalogError.cause = fallbackError;
    catalogError.code = "CATALOG_TOO_LARGE";
    throw catalogError;
  }


  // Resolve stalker credentials from a content-session token or from direct query params.
  // When a contentToken is present, portal+mac are resolved server-side from the encrypted session.
  // When portal+mac are passed directly, they're only accepted if authenticated (not guest).
  function resolveStalkerCreds(req) {
    const contentToken = String(req.query.contentToken || req.body?.contentToken || '');
    const portal = req.body?.portal || req.query?.portal;
    const mac = req.body?.mac || req.query?.mac;
    if (contentToken) return { mode: 'content-session', contentToken, portal: null, mac: null };
    return { mode: 'direct', contentToken: null, portal: portal || null, mac: mac || null };
  }

  // Middleware: only allow stalker content-session requests or authenticated direct requests.
  async function requireStalkerAuth(req, res, next) {
    const creds = resolveStalkerCreds(req);
    req._stalkerCreds = creds;

    if (creds.mode === 'content-session') {
      try {
        const hash = tokenHash(creds.contentToken);
        const session = await sessionStore.findByTokenHash(hash);
        if (!session) return res.status(401).json({ error: 'Content session invalid', code: 'unauthorized' });
        if (session.expiresAt <= Date.now()) {
          await sessionStore.deleteByTokenHash(hash);
          return res.status(410).json({ error: 'Content session expired', code: 'expired' });
        }
        let connection;
        try { connection = JSON.parse(decryptToken(session.encryptedConnection)); }
        catch { return res.status(401).json({ error: 'Content session corrupted', code: 'unauthorized' }); }
        if (connection.type !== 'stalker') return res.status(400).json({ error: 'Connection is not a Stalker portal', code: 'invalid_connection' });
        req._stalkerConfig = connection.config;

        // Extend active sessions atomically near expiry. Deleting and recreating
        // the row here creates intermittent 401s under concurrent requests.
        const ttlMs = contentSessionTtlMs();
        const now = Date.now();
        if (session.expiresAt - now < ttlMs / 2 && typeof sessionStore.extendByTokenHash === 'function') {
          try { await sessionStore.extendByTokenHash(hash, now + ttlMs, now); }
          catch (extErr) {
            // A transient DB failure must not turn a valid request into an error.
            // Log without credentials and continue.
            console.error('Session extension failed:', safeStalkerError(extErr));
            stalkerMetrics.increment('stalker_session_extension_failures_total');
          }
        }

        if (req.query && connection.config) {
          req.query.portal = connection.config.portal || connection.config.server;
          req.query.mac = connection.config.mac;
          if (connection.config.serial) req.query.serial = connection.config.serial;
          if (connection.config.deviceId) req.query.deviceId = connection.config.deviceId;
          if (connection.config.deviceId2) req.query.deviceId2 = connection.config.deviceId2;
        }
        return next();
      } catch (e) {
        if (e.code) return res.status(e.status || 500).json({ error: sanitizeStalkerUrl(e.message), code: e.code });
        return res.status(502).json({ error: 'Failed to verify content session', code: 'server_failure' });
      }
    }

    // Authentication is mandatory. Every deployment must provide verifyToken.
    if (typeof auth?.verifyToken !== 'function') {
      return res.status(503).json({ error: 'Authentication service unavailable', code: 'auth_unavailable' });
    }
    const header = req.headers.authorization || '';
    const token = req.cookies?.sv_auth || (header.startsWith('Bearer ') ? header.slice(7) : null);
    let user = null;
    if (token) {
      try { user = auth.verifyToken(token); }
      catch (e) {
        return res.status(503).json({ error: 'Authentication verification failed', code: 'auth_unavailable' });
      }
    }
    if (!user) return res.status(401).json({ error: 'Authentication required', code: 'unauthorized' });
    req.user = user;
    return next();
  }

  // Connection setup is available to guests, but playback and catalog access
  // still require a content session. Keep this exception limited to validation.
  function requireStalkerValidationAuth(req, res, next) {
    const guestId = String(req.headers['x-guest-id'] || '').trim();
    if (GUEST_ID_RE.test(guestId)) {
      req.user = { id: `guest:${guestId}`, guest: true };
      req._stalkerValidationGuest = true;
      return next();
    }

    if (typeof auth?.verifyToken !== 'function') {
      return res.status(503).json({ error: 'Authentication service unavailable', code: 'auth_unavailable' });
    }
    const header = req.headers.authorization || '';
    const token = req.cookies?.sv_auth || (header.startsWith('Bearer ') ? header.slice(7) : null);
    let user = null;
    if (token) {
      try { user = auth.verifyToken(token); }
      catch { return res.status(503).json({ error: 'Authentication verification failed', code: 'auth_unavailable' }); }
    }
    if (!user) return res.status(401).json({ error: 'Authentication required', code: 'unauthorized' });
    req.user = user;
    return next();
  }
  function normalizeResolvedUrl(streamUrl, portal) {
    if (!streamUrl) return streamUrl;
    let cleanUrl = String(streamUrl).replace(/^(?:ffmpeg|ffrt)\s+/i, "").trim();
    if (cleanUrl.includes("localhost") || cleanUrl.includes("127.0.0.1")) {
      try {
        const portalHost = new URL(portal).host;
        cleanUrl = cleanUrl.replace(/localhost(:\d+)?/g, portalHost).replace(/127\.0\.0\.1(:\d+)?/g, portalHost);
      } catch {}
    }
    return cleanUrl;
  }

  function classifyStreamKind(streamUrl, contentType = "live") {
    const value = String(streamUrl || "").toLowerCase();
    const path = value.split("?")[0];
    const query = value.includes("?") ? value.slice(value.indexOf("?") + 1) : "";
    const params = new URLSearchParams(query);
    const extension = path.split("/").pop()?.split(".").pop() || "";
    if (path.endsWith(".m3u8")) return "hls";
    if (path.endsWith(".ts") || params.get("extension") === "ts") return "ts";
    if (["mp4", "mkv", "mpg", "mpeg", "avi", "mov", "webm", "mp3", "aac"].includes(extension)) return "file";
    if (params.get("extension") === "mp4") return "file";
    if (contentType === "live" || path.includes("/live/")) return "ts";
    if (contentType === "file" || contentType === "vod" || contentType === "series") return "file";
    return "unknown";
  }
  // Resolve redirect-only CDN front doors without downloading media bytes.
  async function resolveDirectMediaUrl(streamUrl, session, req) {
    if (typeof fetchWithRedirectCheck !== "function") return streamUrl;
    try {
      const probe = redirectProbeMode();
      if (probe === "off") return streamUrl;
      const headers = (typeof buildStalkerStreamHeaders === "function"
        ? buildStalkerStreamHeaders(session, req.headers)
        : {}) || {};
      const probeHeaders = mediaTargetHeaders(headers, session.portal || session.base, streamUrl);
      const options = {
        method: probe === "head" ? "HEAD" : "GET",
        headers: probeHeaders,
        signal: AbortSignal.timeout(8000),
      };
      if (probe === "range") headers.Range = "bytes=0-0";
      const resolved = await fetchWithRedirectCheck(streamUrl, options);
      const response = resolved?.response;
      try {
        if (typeof response?.body?.destroy === "function") response.body.destroy();
        else await response?.body?.cancel?.();
      } catch {}
      if (!resolved?.url || !response) return streamUrl;
      if (!response.ok && response.status !== 206 && !resolved.redirected) return streamUrl;
      return resolved.url;
    } catch (error) {
      console.warn("Direct stream redirect resolution failed:", sanitizeStalkerUrl(error?.message || String(error)));
      return streamUrl;
    }
  }
  async function createStalkerLink(session, { cmd, contentType, episode, episodeId, seasonId, seriesNumber, videoId, start, end, duration, programId, channelId }) {
    let portalCalls = 0;
    const portalCall = (...args) => {
      if (portalCalls >= 3) throw new Error("Stalker link resolution call limit reached");
      portalCalls += 1;
      return portalFetchRetry(...args);
    };
    const hasLinkPayload = payload => Boolean(payload?.js?.cmd || payload?.js?.url || payload?.js?.stream || (payload?.js?.id && (payload?.js?.play_token || payload?.js?.playToken)));
    const requestLink = (candidate, timing = {}) => {
      stalkerMetrics.increment("stalker_create_link_calls_total");
      return portalCall(session, {
      type: (contentType === "vod" || contentType === "series") ? "vod" : "itv",
      action: "create_link",
      cmd: candidate,
      series: episode || 0,
      forced_storage: 0,
      disable_ad: 0,
      download: 0,
      force_ch_link_check: 0,
      episode_id: episodeId,
      season_id: seasonId,
      series_number: seriesNumber,
      video_id: videoId,
      start,
      end,
      utc: timing.utc,
      duration: timing.duration ?? duration,
      archive: timing.archive,
      program_id: timing.program_id ?? programId,
      ...timing,
    });
    };

    const playableLiveUrl = candidate => {
      const clean = String(candidate || "").trim().replace(/^(?:ffmpeg|ffrt)\s+/i, "").trim();
      try {
        const parsed = new URL(clean);
        if (!/^https?:$/.test(parsed.protocol)) return null;
        if (/\/play\/live\.php$/i.test(parsed.pathname) && !parsed.searchParams.get("stream")) return null;
        return clean;
      } catch {
        return null;
      }
    };

    const catchup = normalizeCatchupRequest({ cmd, channelId, start, end, duration, programId });
    const isCatchup = catchup.start != null || catchup.programId != null;
    const existingLiveUrl = contentType === "live" && !isCatchup ? playableLiveUrl(cmd) : null;
    const numericChannelId = String(channelId || "").match(/^\d+$/)?.[0];
    const tokenizedChannelListUrl = existingLiveUrl && /\/play\/live\.php\?/i.test(existingLiveUrl)
      && /(?:[?&])play_token=/i.test(existingLiveUrl);

    if (contentType === "live" && numericChannelId && tokenizedChannelListUrl) {
      try {
        const channelList = await portalCall(session, { type: "itv", action: "get_all_channels" });
        const selected = (channelList?.js?.data || []).find(channel => String(channel.id) === numericChannelId);
        const freshLiveUrl = playableLiveUrl(selected?.cmd);
        if (freshLiveUrl) return { js: { cmd: freshLiveUrl } };
        if (selected?.cmd) {
          const selectedData = await requestLink(selected.cmd);
          const selectedResolvedUrl = playableLiveUrl(selectedData?.js?.cmd);
          if (selectedResolvedUrl) {
            return { ...selectedData, js: { ...selectedData.js, cmd: selectedResolvedUrl } };
          }
        }
      } catch (error) {
        if (isRateLimitError(error)) throw error;
        if (!existingLiveUrl) throw error;
      }
    } else if (contentType === "live" && numericChannelId) {
      try {
        // The catalog channel ID and the provider's internal /ch/ ID are often
        // different. Preserve the command supplied by get_all_channels instead
        // of fabricating a URL from the catalog ID.
        const originalCommand = String(cmd || "").trim();
        const hasPortalChannelCommand = /^(?:ffmpeg|ffrt)\s+/i.test(originalCommand)
          && /(?:(?:localhost|127\.0\.0\.1).*\/ch\/\d+|\/{2,3}ch\/\d+)/i.test(originalCommand);
        const channelData = await requestLink(hasPortalChannelCommand
          ? originalCommand
          : "ffrt http:///ch/" + numericChannelId);
        const freshLiveUrl = playableLiveUrl(channelData?.js?.cmd);
        if (freshLiveUrl) {
          return { ...channelData, js: { ...channelData.js, cmd: freshLiveUrl } };
        }
      } catch (error) {
        if (isRateLimitError(error)) throw error;
        if (!existingLiveUrl) throw error;
      }
    }
    if (existingLiveUrl) return { js: { cmd: existingLiveUrl } };

    if (contentType === "live" && isCatchup) {
      let lastData;
      for (const timing of catchupVariants(catchup)) {
        lastData = await requestLink(catchup.cmd || cmd, timing);
        if (hasLinkPayload(lastData)) return lastData;
      }
      return lastData;
    }

    const numericMedia = contentType === "vod"
      ? String(cmd || "").trim().match(/^\/media\/(\d+)\.[a-z0-9]+$/i)
      : null;

    // The numeric catalog ID is not necessarily the provider's storage ID.
    // Match MAG/STB behavior by loading the selected movie before create_link.
    if (numericMedia) {
      const movieId = numericMedia[1];
      const details = await portalCall(session, {
        type: "vod",
        action: "get_ordered_list",
        category: 0,
        movie_id: movieId,
        season_id: 0,
        episode_id: 0,
        force_ch_link_check: "",
        fav: 0,
        sortby: "added",
        hd: 0,
        not_ended: 0,
        page: 1,
        p: 1,
        from_ch_id: 0,
      });
      const detailItems = Array.isArray(details?.js?.data) ? details.js.data : [];
      const selected = detailItems.find(item => String(item.id) === movieId) || detailItems[0];
      if (selected?.cmd) {
        const selectedData = await requestLink(selected.cmd);
        if (hasLinkPayload(selectedData)) return selectedData;
      }
    }

    let data = await requestLink(cmd);
    const isVod = contentType === "vod" || contentType === "series";
    if (hasLinkPayload(data) || !isVod) return data;

    // Some MAG portals return catalog paths such as /media/123.mpg but only
    // accept the traditional ffmpeg-prefixed command in create_link.
    const normalized = String(cmd || "").trim();
    if (normalized && portalCalls < 3 && !/^ffmpeg\s+/i.test(normalized)) {
      data = await requestLink("ffmpeg " + normalized);
    }
    return data;
  }
  router.post("/handshake", requireStalkerAuth, async (req, res) => {
    const { portal, mac, serial } = req.body;
    if (!portal || !mac) return res.status(400).json({ error: 'portal and mac required', code: 'malformed' });
    try {
      const session = await getSession(portal, mac, { serial });
      res.json({ token: session.token });
    } catch (e) { respondWithError(res, e); }
  });

  router.get("/catalog/v1/categories", requireStalkerAuth, async (req, res) => {
    if (!lazyCatalogEnabled()) return res.status(404).json({ error: 'Lazy catalog is disabled', code: 'feature_disabled' });
    stalkerMetrics.increment('stalker_catalog_requests_total');
    try {
      const { kind } = parseCatalogQuery(req, { endpoint: 'categories' });
      const { portal, mac, serial, deviceId, deviceId2, refresh } = req.query;
      const catalogOpts = { serial, deviceId, deviceId2 };
      const key = catalogCategoryCacheKey(portal, mac, kind, catalogOpts);
      const categoryGenerationKey = `${catalogIdentityKey(portal, mac, catalogOpts)}|categories|${kind}`;
      if (refresh !== '1') {
        const cached = cache.get(key);
        if (cached) { stalkerMetrics.increment('stalker_catalog_cache_hits_total'); return res.json(cached); }
      }
      if (refresh === '1') {
        invalidateCatalog(portal, mac, kind, null, 100, catalogOpts);
        catalogGenerations.bump(categoryGenerationKey);
      }
      const providerKey = catalogProviderKey(portal, mac, catalogOpts);
      const operationGeneration = catalogGenerations.current(categoryGenerationKey);
      const data = await metadataCoordinator.runProviderMetadata({
        providerKey,
        requestKey: `categories|${kind}|generation:${operationGeneration}`,
        signal: requestContext.getStore()?.signal,
        operation: async signal => {
          stalkerMetrics.increment('stalker_catalog_upstream_calls_total');
          const session = await getSession(portal, mac, { serial, deviceId, deviceId2 });
          const action = kind === 'live' ? 'get_genres' : 'get_categories';
          const payload = await portalFetchRetry(session, { type: kind === 'live' ? 'itv' : kind, action }, undefined, signal);
          const raw = Array.isArray(payload?.js) ? payload.js : Array.isArray(payload?.data) ? payload.data : [];
          const categories = raw.map(item => ({
            id: String(item?.id ?? item?.category_id ?? 'all'),
            title: String(item?.title || item?.name || 'Other'),
            count: Number.isFinite(Number(item?.count)) ? Number(item.count) : null,
          })).map(item => item.id === '*' || item.title.trim().toLowerCase() === 'all'
            ? { ...item, id: 'all', title: 'All' }
            : item);
          const result = {
            kind,
            categories: kind === 'live'
              ? [{ id: 'all', title: 'All', count: null }, ...categories.filter(item => item.id.toLowerCase() !== 'all' && item.title.trim().toLowerCase() !== 'all')]
              : categories,
            capabilities: catalogCapabilities.get(providerKey, kind),
            refreshedAt: Date.now(),
          };
          if (!catalogGenerations.isCurrent(categoryGenerationKey, operationGeneration)) {
            throw catalogRequestError('Catalog request was superseded by a refresh', 'catalog_superseded', 409);
          }
          cache.set(key, result, LAZY_CATALOG_TTL.categories);
          return result;
        },
      });
      res.json(data);
    } catch (e) { respondWithError(res, e); }
  });

  router.get("/catalog/v1/items", requireStalkerAuth, async (req, res) => {
    if (!lazyCatalogEnabled()) return res.status(404).json({ error: 'Lazy catalog is disabled', code: 'feature_disabled' });
    stalkerMetrics.increment('stalker_catalog_requests_total');
    try {
      const parsed = parseCatalogQuery(req, { endpoint: 'items' });
      const { portal, mac, serial, deviceId, deviceId2, refresh } = req.query;
      const catalogOpts = { serial, deviceId, deviceId2 };
      const providerKey = catalogProviderKey(portal, mac, catalogOpts);
      const key = catalogCacheKey(portal, mac, parsed.kind, parsed.category, parsed.page, parsed.size, '', catalogOpts);
      const epochKey = `${catalogIdentityKey(portal, mac, catalogOpts)}|${parsed.kind}|${parsed.category}`;
      const capabilityGenerationKey = catalogCapabilityGenerationKey(portal, mac, parsed.kind, catalogOpts);
      if (refresh === '1') invalidateCatalog(portal, mac, parsed.kind, parsed.category, parsed.size, catalogOpts);
      const operationGeneration = catalogGenerations.current(epochKey);
      const operationCapabilityGeneration = catalogGenerations.current(capabilityGenerationKey);
      if (refresh !== '1') {
        const cached = cache.get(key);
        if (cached) { stalkerMetrics.increment('stalker_catalog_cache_hits_total'); return res.json(materializeCatalogPage(cached, catalogBinding(portal, mac, catalogOpts))); }
      }
      const data = await metadataCoordinator.runProviderMetadata({
        providerKey,
        requestKey: `items|${parsed.kind}|${parsed.category}|${parsed.page}|${parsed.size}|generation:${operationGeneration}`,
        signal: requestContext.getStore()?.signal,
        operation: async signal => {
          stalkerMetrics.increment('stalker_catalog_upstream_calls_total');
          const session = await getSession(portal, mac, { serial, deviceId, deviceId2 });
          const currentCapabilities = catalogCapabilities.get(providerKey, parsed.kind);
          if (parsed.kind === 'live' && !parsed.query && currentCapabilities.mode === 'bounded_live_snapshot') {
            const snapshotPage = await buildOrJoinLiveSnapshot({ session, portal, mac, catalogOpts, request: parsed, signal });
            if (snapshotPage) return snapshotPage;
          }
          const payload = await fetchCatalogProviderPage(session, { ...parsed }, signal);
          if (parsed.kind === 'live' && !parsed.query && payload?.__liveSnapshotFallback) {
            const nextCapabilities = catalogCapabilities.recordPaginationUnsupported(providerKey, parsed.kind, {
              canCommit: () => catalogGenerations.isCurrent(capabilityGenerationKey, operationCapabilityGeneration),
            });
            const snapshotPage = await buildOrJoinLiveSnapshot({ session, portal, mac, catalogOpts, request: parsed, signal });
            return { ...snapshotPage, capabilities: nextCapabilities };
          }
          const capabilities = currentCapabilities;
          const pageHistoryKey = `${catalogIdentityKey(portal, mac, catalogOpts)}|${parsed.kind}|${hashPart(parsed.category)}|`;
          const pageWasRepeated = catalogPageHistory.observe(
            pageHistoryKey,
            operationGeneration,
            pageSignature(itemsFromPayload(payload)),
          );
          const repeatedPage = parsed.page > 1 && pageWasRepeated;
          const result = normalizeCatalogPage(payload, {
            kind: parsed.kind,
            category: parsed.category,
            page: parsed.page,
            pageSize: parsed.size,
            capabilities,
            mapItem: item => mapCatalogItem(parsed.kind, item, catalogBinding(portal, mac, catalogOpts)),
          });
          if (repeatedPage) {
            result.hasMore = false;
            result.nextPage = null;
            result.complete = true;
            result.capabilities = { ...capabilities, pagination: 'unsupported', mode: 'first_page_only' };
          }
          // Probe one additional page only once. It is never returned as part
          // of page 1, and no later pages are crawled automatically.
          if (parsed.page === 1 && result.hasMore && capabilities.pagination === 'unknown' && !parsed.query) {
            const secondPayload = await fetchCatalogProviderPage(session, { ...parsed, page: 2 }, signal);
            const secondItems = itemsFromPayload(secondPayload);
            // Record the probe page in the same generation history. If the
            // provider repeats it for the browser's page-2 request, the
            // client can stop immediately instead of probing page-3 forever.
            catalogPageHistory.observe(
              pageHistoryKey,
              operationGeneration,
              pageSignature(secondItems),
            );
            const nextCapabilities = catalogCapabilities.recordPaginationProbe(
              providerKey,
              parsed.kind,
              itemsFromPayload(payload),
              secondItems,
              { canCommit: () => catalogGenerations.isCurrent(capabilityGenerationKey, operationCapabilityGeneration) },
            );
            result.capabilities = nextCapabilities;
            if (nextCapabilities.pagination === 'unsupported') {
              if (parsed.kind === 'live') {
                const snapshotPage = await buildOrJoinLiveSnapshot({ session, portal, mac, catalogOpts, request: parsed, signal });
                if (snapshotPage) return snapshotPage;
              }
              result.hasMore = false;
              result.nextPage = null;
              result.complete = false;
              result.capabilities = { ...nextCapabilities, mode: 'first_page_only' };
            } else {
              const secondPage = normalizeCatalogPage(secondPayload, {
                kind: parsed.kind,
                category: parsed.category,
                page: 2,
                pageSize: parsed.size,
                capabilities: nextCapabilities,
                mapItem: item => mapCatalogItem(parsed.kind, item, catalogBinding(portal, mac, catalogOpts)),
              });
              if (catalogGenerations.isCurrent(epochKey, operationGeneration)) {
                cache.set(catalogCacheKey(portal, mac, parsed.kind, parsed.category, 2, parsed.size, '', catalogOpts), secondPage, parsed.kind === 'live' ? LAZY_CATALOG_TTL.live : LAZY_CATALOG_TTL.content);
              }
            }
          }
          if (!catalogGenerations.isCurrent(epochKey, operationGeneration)) {
            throw catalogRequestError('Catalog request was superseded by a refresh', 'catalog_superseded', 409);
          }
          cache.set(key, result, parsed.kind === 'live' ? LAZY_CATALOG_TTL.live : LAZY_CATALOG_TTL.content);
          return result;
        },
      });
      res.json(materializeCatalogPage(data, catalogBinding(portal, mac, catalogOpts)));
    } catch (e) { respondWithError(res, e); }
  });

  router.get("/catalog/v1/search", requireStalkerAuth, async (req, res) => {
    if (!lazyCatalogEnabled()) return res.status(404).json({ error: 'Lazy catalog is disabled', code: 'feature_disabled' });
    stalkerMetrics.increment('stalker_catalog_requests_total');
    try {
      const parsed = parseCatalogQuery(req, { endpoint: 'search' });
      const { portal, mac, serial, deviceId, deviceId2 } = req.query;
      const catalogOpts = { serial, deviceId, deviceId2 };
      const providerKey = catalogProviderKey(portal, mac, catalogOpts);
      const epochKey = `${catalogIdentityKey(portal, mac, catalogOpts)}|${parsed.kind}|${parsed.category}`;
      const capabilityGenerationKey = catalogCapabilityGenerationKey(portal, mac, parsed.kind, catalogOpts);
      const operationGeneration = catalogGenerations.current(epochKey);
      const operationCapabilityGeneration = catalogGenerations.current(capabilityGenerationKey);
      const capabilities = catalogCapabilities.get(providerKey, parsed.kind);
      if (capabilities.search === 'unsupported') {
        return res.status(501).json({ error: 'Provider search is not supported', code: 'provider_search_unsupported' });
      }
      const data = await metadataCoordinator.runProviderMetadata({
        providerKey,
        requestKey: `search|${parsed.kind}|${parsed.category}|${hashPart(parsed.query)}|${parsed.page}|${parsed.size}|generation:${operationGeneration}`,
        signal: requestContext.getStore()?.signal,
        operation: async signal => {
          stalkerMetrics.increment('stalker_catalog_upstream_calls_total');
          const session = await getSession(portal, mac, { serial, deviceId, deviceId2 });
          const payload = await fetchCatalogProviderPage(session, parsed, signal);
          let nextCapabilities = capabilities;
          const probeAllowed = capabilities.search !== 'inconclusive'
            || Number(capabilities.searchProbeAfter || 0) <= Date.now();
          if (capabilities.search !== 'supported' && probeAllowed) {
            const probeQuery = `${parsed.query}__sv_probe_${hashPart(parsed.query).slice(0, 8)}`;
            const probePayload = await fetchCatalogProviderPage(session, { ...parsed, query: probeQuery }, signal);
            nextCapabilities = catalogCapabilities.recordSearchProbe(
              providerKey,
              parsed.kind,
              itemsFromPayload(payload),
              itemsFromPayload(probePayload),
              { canCommit: () => catalogGenerations.isCurrent(capabilityGenerationKey, operationCapabilityGeneration) },
            );
            if (nextCapabilities.search === 'unsupported') {
              const error = new Error('Provider search is not supported or does not filter results');
              error.code = 'PROVIDER_SEARCH_UNSUPPORTED';
              error.status = 501;
              throw error;
            }
          } else if (capabilities.search === 'inconclusive') {
            nextCapabilities = catalogCapabilities.recordSearchResult(
              providerKey,
              parsed.kind,
              itemsFromPayload(payload),
              { canCommit: () => catalogGenerations.isCurrent(capabilityGenerationKey, operationCapabilityGeneration) },
            );
          }
          if (!catalogGenerations.isCurrent(epochKey, operationGeneration)) {
            throw catalogRequestError('Catalog request was superseded by a refresh', 'catalog_superseded', 409);
          }
          const result = normalizeCatalogPage(payload, {
            kind: parsed.kind,
            category: parsed.category,
            page: parsed.page,
            pageSize: parsed.size,
            capabilities: nextCapabilities,
            mapItem: item => mapCatalogItem(parsed.kind, item, catalogBinding(portal, mac, catalogOpts)),
          });
          return materializeCatalogPage({ ...result, capabilities: nextCapabilities, query: parsed.query, source: 'provider' }, catalogBinding(portal, mac, catalogOpts));
        },
      });
      res.json(data);
    } catch (e) {
      if (e?.status === 429) stalkerMetrics.increment('stalker_catalog_rate_limited_total');
      respondWithError(res, e);
    }
  });

  router.get("/channels", requireStalkerAuth, validateQuery("channels"), async (req, res) => {
    const { portal, mac, refresh, serial } = req.query;
    if (!portal || !mac) return res.status(400).end();
    const ck = cache.cacheKey(portal, mac, "channels");
    if (!refresh) { const cached = cache.get(ck); if (cached) return res.json(opaqueSeasonCommands(cached)); }
    try {
      const session = await getSession(portal, mac, { serial });
      const genreData = await portalFetchRetry(session, { type: "itv", action: "get_genres" });
      const chData = await fetchChannelCatalog(session);
      const genres = genreData?.js || [];
      const genreMap = Object.fromEntries(genres.map(g => [g.id, g.title]));
      const channels = channelPageItems(chData).map(ch => ({
        id: ch.id, name: ch.name, num: ch.number, logo: ch.logo || ch.icon || null,
        group: genreMap[ch.tv_genre_id] || "Other", url: encodeOpaqueCommand(ch.cmd), epgId: ch.xmltv_id || null, type: "live"
      }));
      const data = { channels, total: channels.length, refreshed_at: Date.now() };
      cache.set(ck, cacheSafeCatalog(data), CATALOG_TTL.channels);
      res.json(data);
    } catch (e) { respondWithError(res, e); }
  });

  async function fetchAllPages(session, type, category, maxItems = catalogItemLimit()) {
    let data;
    try { data = await portalFetchRetry(session, { type, action: "get_ordered_list", category, page: 1, p: 1 }); }
    catch (error) { if (isRateLimitError(error)) throw error; return []; }
    const items = data?.js?.data || [];
    if (!items.length) return [];
    const all = [];
    const seen = new Set();
    const firstPageSize = items.length;
    const body = data?.js || {};
    const explicitPages = Number.parseInt(body.total_pages || body.totalPages || body.max_pages || body.maxPages || '', 10);
    const totalItems = Number.parseInt(body.total_items || body.totalItems || '', 10);
    const providerPageSize = Number.parseInt(body.max_page_items || body.maxPageItems || body.per_page || firstPageSize || '', 10);
    const derivedPages = Number.isFinite(totalItems) && Number.isFinite(providerPageSize) && providerPageSize > 0
      ? Math.ceil(totalItems / providerPageSize)
      : null;
    const maxPages = Number.isFinite(explicitPages) && explicitPages > 0
      ? Math.min(explicitPages, 500)
      : Number.isFinite(derivedPages) && derivedPages > 0
        ? Math.min(derivedPages, 500)
        : 500;
    const addPageItems = pageItems => {
      let added = 0;
      for (const item of pageItems) {
        const identity = String(item?.id ?? item?.stream_id ?? item?.cmd ?? item?.name ?? JSON.stringify(item));
        if (seen.has(identity)) continue;
        seen.add(identity);
        all.push(item);
        added++;
        if (all.length >= maxItems) break;
      }
      return added;
    };
    addPageItems(items);
    for (let p = 2; p <= maxPages && all.length < maxItems; p++) {
      let r;
      try { r = await portalFetchRetry(session, { type, action: "get_ordered_list", category, page: p, p }); }
      catch (error) { if (isRateLimitError(error)) throw error; break; }
      const pageItems = r?.js?.data || [];
      if (!pageItems.length) break;
      if (!addPageItems(pageItems)) break;
      // When pagination metadata is absent, a short final page is the safest
      // stopping signal. Known page counts are still honored above.
      if (!Number.isFinite(explicitPages) && !Number.isFinite(derivedPages) && pageItems.length < firstPageSize) break;
    }
    return all.slice(0, maxItems);
  }

  router.get("/vod/categories", requireStalkerAuth, validateQuery("channels"), async (req, res) => {
    const { portal, mac, serial, refresh } = req.query;
    const ck = cache.cacheKey(portal, mac, "vod-categories");
    if (!refresh) { const cached = cache.get(ck); if (cached) return res.json(opaqueSeasonCommands(cached)); }
    try {
      const session = await getSession(portal, mac, { serial });
      const catData = await portalFetchRetry(session, { type: "vod", action: "get_categories" });
      const data = { categories: (catData?.js || []).map(c => ({ id: String(c.id), title: c.title, count: parseInt(c.count || 0) })) };
      cache.set(ck, data, CATALOG_TTL.categories);
      res.json(data);
    } catch (e) { respondWithError(res, e); }
  });

  router.get("/vod", requireStalkerAuth, validateQuery("vod"), async (req, res) => {
    const { portal, mac, cat, serial, refresh } = req.query;
    const ck = cache.cacheKey(portal, mac, "vod", cat || "all");
    if (!refresh) { const cached = cache.get(ck); if (cached) return res.json(opaqueSeasonCommands(cached)); }
    try {
      const session = await getSession(portal, mac, { serial });
      const raw = await fetchAllPages(session, "vod", cat);
      const data = {
        items: raw.map(v => ({
          id: v.id,
          name: v.name,
          logo: v.screenshot_uri || v.cover || null,
          year: v.year,
          rating: v.rating_imdb || null,
          url: encodeOpaqueCommand(v.cmd),
          type: "vod",
        })),
        total: raw.length,
      };
      cache.set(ck, cacheSafeCatalog(data), CATALOG_TTL.content);
      res.json(data);
    } catch (e) { respondWithError(res, e); }
  });

  router.post("/resolve-redirect", express.json({ limit: "2kb" }), requireStalkerAuth, async (req, res) => {
    const sourceUrl = String(req.body?.url || "").trim();
    if (!sourceUrl) return res.status(400).json({ error: "url required", code: "invalid_url" });
    if (!(await isUrlAllowed(sourceUrl))) return res.status(403).json({ error: "URL not allowed", code: "url_not_allowed" });
    try {
      // This endpoint is control-plane only: HEAD follows redirects, and no
      // portal authorization or response body is forwarded to the CDN.
      const resolved = await fetchWithRedirectCheck(sourceUrl, {
        method: "HEAD",
        headers: { Accept: "*/*", "User-Agent": "StreamVault/1.0" },
        signal: AbortSignal.timeout(8000),
      });
      const response = resolved?.response;
      try {
        if (typeof response?.body?.destroy === "function") response.body.destroy();
        else await response?.body?.cancel?.();
      } catch {}
      if (!resolved?.url || !response) return res.status(502).json({ error: "Redirect resolution failed", code: "redirect_resolution_failed" });
      if (!response.ok) return res.status(422).json({ error: "Provider does not support HEAD redirect resolution", code: "redirect_resolution_unsupported", status: response.status });
      stalkerMetrics.increment("stalker_redirect_resolutions_total");
      res.json({ url: resolved.url, status: response.status, redirected: Boolean(resolved.redirected) });
    } catch (error) {
      const code = error?.code === "TOO_MANY_REDIRECTS" ? "too_many_redirects" : error?.code === "URL_NOT_ALLOWED" ? "url_not_allowed" : "redirect_resolution_failed";
      res.status(code === "url_not_allowed" ? 403 : 502).json({ error: sanitizeStalkerUrl(error?.message || "Redirect resolution failed"), code });
    }
  });

  router.post("/relay-grant", express.json({ limit: "2kb" }), requireStalkerAuth, (req, res) => {
    if (!mediaRelayEnabled()) return res.status(409).json({ error: "Media relay is disabled", code: "media_relay_disabled" });
    const cmd = req.body?.cmd;
    if (req.body?.confirm !== true || typeof cmd !== 'string' || !cmd.trim()) {
      return res.status(400).json({ error: "Explicit confirmation and a non-empty cmd string are required", code: "relay_confirmation_required" });
    }
    if (cmd.length > 4096) {
      return res.status(400).json({ error: "Relay grant command exceeds maximum length", code: "invalid_parameter" });
    }
    if (!relayGrantSecret()) return res.status(503).json({ error: "Relay grants are not configured", code: "relay_not_configured" });
    const expires = Date.now() + 5 * 60_000;
    const signature = relaySignature(req, req.body.cmd, expires);
    res.json({ relayGrant: `${expires}.${signature}`, expiresAt: expires });
  });

  router.get("/play", requireStalkerAuth, validateQuery("play"), async (req, res) => {
    stalkerMetrics.increment("stalker_control_requests_total");
    if (req.query.refresh === "1") stalkerMetrics.increment("stalker_direct_refreshes_total");
    const resolved = req._stalkerCreds || resolveStalkerCreds(req);
    const { portal, mac, serial, deviceId, deviceId2 } = resolved.mode === 'content-session' && req._stalkerConfig
      ? {
          portal: req._stalkerConfig.portal || req._stalkerConfig.server,
          mac: req._stalkerConfig.mac,
          serial: req._stalkerConfig.serial,
          deviceId: req._stalkerConfig.deviceId,
          deviceId2: req._stalkerConfig.deviceId2,
        }
      : { portal: resolved.portal, mac: resolved.mac, serial: req.query.serial, deviceId: req.query.deviceId, deviceId2: req.query.deviceId2 };
    if (!portal || !mac) return res.status(400).json({ error: 'portal and mac required', code: 'malformed' });

    const { cmd: rawCmd, content_type, episode, episode_id, season_id, series_number, video_id, start, end, duration, program_id, channel_id } = req.query;
    let cmd;
    try { cmd = decodeOpaqueCommand(rawCmd, catalogBinding(portal, mac, { serial, deviceId, deviceId2 })); }
    catch (error) {
      if (error?.status === 410 || error?.code === 'EXPIRED') {
        return res.status(410).json({ error: 'Stalker playback reference expired', code: 'play_ref_expired' });
      }
      if (error?.status === 403 || error?.code === 'PLAY_REF_CONNECTION_MISMATCH') {
        return res.status(403).json({ error: 'Stalker playback reference belongs to another connection', code: 'play_ref_connection_mismatch' });
      }
      return res.status(400).json({ error: 'Malformed Stalker command', code: 'malformed' });
    }
    const directEnabled = directPlayEnabled();

    const fallbackUrl = (() => {
      const params = new URLSearchParams({ cmd: rawCmd });
      if (content_type) params.set("content_type", content_type);
      if (episode) params.set("episode", episode);
      if (episode_id) params.set("episode_id", episode_id);
      if (season_id) params.set("season_id", season_id);
      if (series_number) params.set("series_number", series_number);
      if (video_id) params.set("video_id", video_id);
      if (start) params.set("start", start);
      if (end) params.set("end", end);
      if (duration) params.set("duration", duration);
      if (program_id) params.set("program_id", program_id);
      if (channel_id) params.set("channel_id", channel_id);
      if (resolved.mode === 'content-session') {
        params.set("contentToken", resolved.contentToken);
      } else {
        params.set("portal", portal);
        params.set("mac", mac);
        if (serial) params.set("serial", serial);
        if (deviceId) params.set("deviceId", deviceId);
        if (deviceId2) params.set("deviceId2", deviceId2);
      }
      return `/stalker/play?${params.toString()}`;
    })();

    let releaseActiveRelay = () => {};
    try {
      const session = await getSession(portal, mac, { serial, deviceId, deviceId2 });
      const data = await createStalkerLink(session, {
        cmd, contentType: content_type, episode, episodeId: episode_id, seasonId: season_id, seriesNumber: series_number, videoId: video_id, start, end, duration, programId: program_id, channelId: channel_id,
      });
      const normalized = normalizeCreateLinkResponse(data, {
        portal,
        mac,
        contentType: content_type === "vod" || content_type === "series" ? content_type : "live",
      });
      const streamUrl = normalized?.url || normalizeResolvedUrl(data?.js?.cmd, portal);
      const refreshUrl = `${fallbackUrl}${fallbackUrl.includes("?") ? "&" : "?"}resolve=1`;
      if (req.query.resolve === "1" && normalized?.unsupportedProtocol) {
        return res.json(buildResolveContract({
          normalized,
          direct: false,
          refreshUrl,
          relayAvailable: false,
          warnings: ["unsupported_protocol"],
        }));
      }
      if (!streamUrl) throw new Error("No URL");
      if (!(await isUrlAllowed(streamUrl))) return res.status(403).json({ error: 'Stream URL not allowed', code: 'url_not_allowed' });
      const streamKind = normalized?.streamKind || classifyNormalizedStreamKind(streamUrl, content_type === "vod" || content_type === "series" ? "file" : "live");
      if (req.query.resolve === "1") {
        const tokenizedLiveUrl = content_type === "live" && /(?:[?&])play_token=/i.test(streamUrl);
        const directUrl = directEnabled && !tokenizedLiveUrl && (streamKind === "hls" || streamKind === "ts" || streamKind === "file")
          ? await resolveDirectMediaUrl(streamUrl, session, req)
          : streamUrl;
        const warnings = [];
        if (directUrl.startsWith("http://")) warnings.push("cors_risk");
        const contract = buildResolveContract({
          normalized: { ...normalized, url: directUrl, streamKind },
          url: directUrl,
          direct: directEnabled,
          refreshUrl,
          relayAvailable: mediaRelayEnabled(),
          relayUrl: fallbackUrl,
          warnings,
        });
        stalkerMetrics.increment("stalker_direct_attempts_total");
        return res.json(contract);
      }

      if (!mediaRelayEnabled()) {
        stalkerMetrics.increment("stalker_media_relay_blocked_total");
        return res.status(409).json({ error: "Direct playback required; media relay is disabled", code: "media_relay_disabled" });
      }
      if (!verifyRelayGrant(req, rawCmd)) {
        return res.status(403).json({ error: "Explicit relay confirmation required", code: "relay_confirmation_required" });
      }
      let providerKey;
      try { providerKey = crypto.createHash("sha256").update(new URL(portal).host).digest("hex").slice(0, 16); }
      catch { providerKey = "invalid"; }
      const controller = new AbortController();
      const maxDurationMs = Math.min(14400000, Math.max(60_000, Number(process.env.STALKER_RELAY_MAX_DURATION_MS) || 4 * 60 * 60_000));
      const lease = relaySlots.acquire(providerKey, {
        limit: relayLimit(),
        timeoutMs: maxDurationMs,
        onTimeout: () => controller.abort(),
      });
      if (!lease) return res.status(429).json({ error: "Provider relay concurrency limit reached", code: "relay_concurrency_limited" });
      const releaseRelay = lease.release;
      releaseActiveRelay = releaseRelay;
      res.once("finish", releaseRelay);
      res.once("close", releaseRelay);
      stalkerMetrics.increment("stalker_media_relay_requests_total");
      const watchName = req.query.name || cmd || "Unknown";
      cache.trackWatch(watchName, content_type === "vod" ? "vod" : content_type === "series" ? "series" : "live");

      const rawFetchHeaders = buildStalkerStreamHeaders(session, req.headers);
      const fetchHeaders = mediaTargetHeaders(rawFetchHeaders, portal, streamUrl);
      const abortUpstream = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.once("close", abortUpstream);
      const { response: upstream, url: upstreamUrl } = await fetchWithRedirectCheck(streamUrl, {
        headers: fetchHeaders,
        signal: controller.signal,
      });
      const upstreamSummary = summarizeUpstreamHeaders(upstream.headers);
      if (!upstream.ok && upstream.status !== 206) {
        return res.status(upstream.status).json({ error: `Stream server returned ${upstream.status}`, code: 'provider_failure', status: upstream.status, upstreamHeaders: upstreamSummary });
      }
      Object.entries(STREAM_CORS).forEach(([k, v]) => res.set(k, v));
      const ct = upstream.headers.get("content-type") || "";
      if (upstream.status === 206) {
        res.status(206);
        const cr = upstream.headers.get("content-range");
        if (cr) res.set("Content-Range", cr);
      }
      let relayedBytes = 0;
      const maxRelayBytes = Math.max(1_000_000, Number(process.env.STALKER_RELAY_MAX_BYTES) || 2 * 1024 * 1024 * 1024);
      upstream.body?.on?.("data", chunk => {
        const bytes = chunk.length || 0;
        relayedBytes += bytes;
        stalkerMetrics.increment("stalker_media_relay_bytes_total", bytes);
        if (relayedBytes > maxRelayBytes) controller.abort();
      });
      const isPlaylist = ct.includes("mpegurl") || ct.includes("m3u") || upstreamUrl.endsWith(".m3u8");
      if (isPlaylist) {
        const parsedStreamUrl = new URL(upstreamUrl);
        const playOrigin = parsedStreamUrl.origin;
        const playBaseDir = upstreamUrl.substring(0, upstreamUrl.lastIndexOf("/") + 1);
        const selfBase = `${req.get("x-forwarded-proto") || req.protocol}://${req.get("host")}`;
        res.set("Content-Type", ct || "application/vnd.apple.mpegurl");
        let leftover = "";
        const rewriter = new Transform({
          transform(chunk, enc, cb) {
            const text = leftover + chunk.toString();
            const lines = text.split("\n");
            leftover = lines.pop();
            const rewritten = lines.map(line => {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith("#")) return line;
              if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return `${selfBase}/stream?url=${encodeURIComponent(trimmed)}`;
              if (trimmed.startsWith("/")) return `${selfBase}/stream?url=${encodeURIComponent(playOrigin + trimmed)}`;
              return `${selfBase}/stream?url=${encodeURIComponent(playBaseDir + trimmed)}`;
            }).join("\n") + "\n";
            cb(null, rewritten);
          },
          flush(cb) {
            if (leftover.trim()) {
              const trimmed = leftover.trim();
              if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) cb(null, `${selfBase}/stream?url=${encodeURIComponent(trimmed)}`);
              else if (trimmed.startsWith("/")) cb(null, `${selfBase}/stream?url=${encodeURIComponent(playOrigin + trimmed)}`);
              else if (!trimmed.startsWith("#")) cb(null, `${selfBase}/stream?url=${encodeURIComponent(playBaseDir + trimmed)}`);
              else cb(null, leftover);
            } else {
              cb();
            }
          }
        });
        await pipeline(upstream.body, rewriter, res);
      } else {
        if (ct) res.set("Content-Type", ct);
        const cl = upstream.headers.get("content-length");
        if (cl) res.set("Content-Length", cl);
        await pipeline(upstream.body, res);
      }
    } catch (e) {
      respondWithError(res, e);
    } finally {
      releaseActiveRelay();
    }
  });

  router.get("/epg", requireStalkerAuth, validateQuery("epg"), async (req, res) => {
    const { portal, mac, period = 4, serial, refresh } = req.query;
    const ck = cache.cacheKey(portal, mac, "epg", period);
    if (!refresh) { const cached = cache.get(ck); if (cached) return res.json(opaqueSeasonCommands(cached)); }
    try {
      const session = await getSession(portal, mac, { serial });
      const epgData = await portalFetchRetry(session, { type: "itv", action: "get_epg_info", period });
      const programs = {};
      for (const [id, shows] of Object.entries(epgData?.js?.data || {})) {
        if (Array.isArray(shows)) programs[id] = shows.map(s => ({ id: s.id || s.program_id || null, title: s.name || s.title, start: (s.start_timestamp || 0) * 1000, stop: (s.stop_timestamp || 0) * 1000, cmd: encodeOpaqueCommand(s.cmd || s.command) }));
      }
      const data = { programs, refreshed_at: Date.now() };
      cache.set(ck, data, CATALOG_TTL.epg);
      res.json(data);
    } catch (e) { respondWithError(res, e); }
  });

  router.get("/api", requireStalkerAuth, async (req, res) => {
    const { portal, mac, serial, deviceId, deviceId2 } = req.query;
    if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });
    let apiParams;
    try { apiParams = pickAndValidateStalkerParams(req.query, "api").params; }
    catch (e) { return res.status(e.status || 400).json({ error: e.message, code: e.code || "invalid_parameter" }); }
    try {
      const session = await getSession(portal, mac, { serial, deviceId, deviceId2 });
      const data = await portalFetchRetry(session, apiParams);
      res.json(data);
    } catch (e) {
      console.error("API error:", sanitizeStalkerUrl(e.message));
      respondWithError(res, e);
    }
  });

  router.post("/validate", validationIpLimit, validationGuestLimit, requireStalkerValidationAuth, async (req, res) => {
    const { portal, mac, serial, deviceId, deviceId2 } = req.body;
    if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });
    const start = Date.now();
    const result = {
      valid: false,
      status: "unknown",
      statusCode: null,
      expiry: null,
      daysLeft: null,
      serial: null,
      deviceId: null,
      deviceId2: null,
      maxConnections: null,
      tariff: null,
      phone: null,
      portalReachable: false,
      error: null,
    };

    function parseExpiryDate(expiryStr) {
      if (!expiryStr || expiryStr === "0000-00-00" || expiryStr === "0000-00-00 00:00:00") return null;
      let expDate = null;
      const m1 = expiryStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m1) expDate = new Date(parseInt(m1[1]), parseInt(m1[2]) - 1, parseInt(m1[3]));
      if (!expDate) {
        const m2 = expiryStr.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
        if (m2) expDate = new Date(parseInt(m2[3]), parseInt(m2[1]) - 1, parseInt(m2[2]));
      }
      if (!expDate) expDate = new Date(expiryStr);
      return expDate && !isNaN(expDate.getTime()) ? expDate : null;
    }

    try {
      const session = await getSession(portal, mac, { serial, deviceId, deviceId2 }, { forceRefresh: true });
      result.portalReachable = true;

      try {
        const profileParams = {
          type: "stb",
          action: "get_profile",
          auth_second_step: 1,
          hw_version_2: "8b80dfaa8cf83485567849b7202a79360fc988e3",
        };
        if (serial) profileParams.sn = serial;
        if (deviceId) profileParams.device_id = deviceId;
        if (deviceId2 || deviceId) profileParams.device_id2 = deviceId2 || deviceId;
        const profile = await portalFetchRetry(session, profileParams);
        const p = profile?.js || {};
        result.serial = p.serial_number || p.sn || serial || null;
        result.deviceId = p.device_id || deviceId || null;
        result.deviceId2 = p.device_id2 || deviceId2 || deviceId || null;
      } catch {}

      try {
        const account = await portalFetchRetry(session, { type: "account_info", action: "get_main_info" });
        const a = account?.js || {};
        const statusVal = a.status !== undefined ? parseFloat(a.status) : 0;
        if (statusVal === 0) result.status = "active";
        else if (statusVal === 1) result.status = "unregistered";
        else if (statusVal === 2) result.status = "suspended";
        else if (statusVal === 3) result.status = "expired";
        else if (statusVal === 4) result.status = "blocked";
        else result.status = `status:${statusVal}`;
        result.statusCode = statusVal;

        const expiryStr = a.expire_billing_date || a.expired_date || a.expire_date || null;
        const expDate = parseExpiryDate(expiryStr);
        if (expDate) {
          result.expiry = expDate.toISOString().slice(0, 10);
          result.daysLeft = Math.ceil((expDate.getTime() - Date.now()) / 86400000);
          if (result.daysLeft < 0) result.status = "expired";
        }

        result.tariff = a.tariff_plan || a.tariff || null;
        result.phone = a.phone || null;
        result.maxConnections = a.max_cur || a.max_connections || null;

        if (Object.keys(a).length === 0) {
          result.status = "blocked";
          result.error = "Account returned empty info - may be blocked";
        }

        const hasValidId = a.id || a.login || a.user_id || a.account_number || a.mac;
        if (!hasValidId && result.status === "active") {
          result.status = "unregistered";
          result.valid = false;
          result.error = "No valid user ID found - MAC may not be registered";
        }
      } catch (e) {
        result.error = "Could not fetch account info: " + e.message;
      }

      result.valid = (result.status === "active" && (result.daysLeft === null || result.daysLeft > 0));
      result.latency = Date.now() - start;
      res.json(result);
    } catch (e) {
      console.error("Validate error:", sanitizeStalkerUrl(e.message));
      result.error = safeStalkerError(e);
      result.latency = Date.now() - start;
      res.json(result);
    }
  });

  router.get("/stream", requireStalkerAuth, validateQuery("stream"), async (req, res) => {
    const { portal, mac, cmd, content_type, serial, deviceId, deviceId2 } = req.query;
    if (!portal || !mac || !cmd) return res.status(400).json({ error: "portal, mac and cmd required" });
    if (content_type && !mediaRelayEnabled()) return res.status(409).json({ error: "Direct playback required; media relay is disabled", code: "media_relay_disabled" });
    try {
      const session = await getSession(portal, mac, { serial, deviceId, deviceId2 });
      const data = await portalFetchRetry(session, {
        type: (content_type === "vod" || content_type === "series") ? "vod" : "itv",
        action: "create_link",
        cmd,
        series: 0,
        forced_storage: 0,
        disable_ad: 0,
        download: 0,
        force_ch_link_check: 0,
      });
      const normalized = normalizeCreateLinkResponse(data, { portal, mac, contentType: content_type === "vod" || content_type === "series" ? content_type : "live" });
      const streamUrl = normalized?.url || normalizeResolvedUrl(data?.js?.cmd, portal);
      if (!streamUrl) throw new Error("No stream URL returned");
      if (!(await isUrlAllowed(streamUrl))) {
        return res.status(403).json({ error: "Stream URL not allowed", code: "url_not_allowed" });
      }
      res.json({ url: streamUrl });
    } catch (e) {
      console.error("Stream error:", sanitizeStalkerUrl(e.message));
      respondWithError(res, e);
    }
  });

  async function fetchNormalizedSeasons(session, movieId) {
    let lastError;
    let fallbackResult = null;
    for (const type of ["series", "vod"]) {
      try {
        const data = await portalFetchRetry(session, {
          type, action: "get_ordered_list", movie_id: movieId, page: 1, p: 1,
        }, 20000);
        const normalized = normalizeSeasons(data);
        if (!fallbackResult && normalized.seasons.length) fallbackResult = normalized;
        if (normalized.supported) return { ...normalized, sourceType: type };
      } catch (error) {
        if (/429|rate limit/i.test(error?.message || "")) throw error;
        lastError = error;
      }
    }
    if (fallbackResult) return { ...fallbackResult, sourceType: null, error: "unsupported_series_api" };
    return { seasons: [], supported: false, sourceType: null, error: lastError ? "unsupported_series_api" : null };
  }

  router.get("/series/seasons", requireStalkerAuth, validateQuery("series"), async (req, res) => {
    const { portal, mac, seriesId, refresh, serial, deviceId, deviceId2 } = req.query;
    if (!portal || !mac || !seriesId) return res.status(400).json({ error: "portal, mac and seriesId required" });

    const ck = cache.cacheKey(portal, mac, "seasons", seriesId);
    if (!refresh) { const cached = cache.get(ck); if (cached) { cache.trackCacheHit(); return res.json(opaqueSeasonCommands(cached)); } } cache.trackCacheMiss();

    try {
      const session = await getSession(portal, mac, { serial, deviceId, deviceId2 });
      const movieId = seriesId.split(":")[0];
      const result = opaqueSeasonCommands(await fetchNormalizedSeasons(session, movieId));
      cache.set(ck, cacheSafeCatalog(result), CATALOG_TTL.content);
      res.json(result);
    } catch (e) {
      console.error("Series seasons error:", sanitizeStalkerUrl(e.message));
      respondWithError(res, e);
    }
  });

  router.get("/series/categories", requireStalkerAuth, validateQuery("channels"), async (req, res) => {
    const { portal, mac, refresh, serial, deviceId, deviceId2 } = req.query;
    if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });

    const ck = cache.cacheKey(portal, mac, "series-cats");
    if (!refresh) { const cached = cache.get(ck); if (cached) { cache.trackCacheHit(); return res.json(opaqueSeasonCommands(cached)); } } cache.trackCacheMiss();

    try {
      const session = await getSession(portal, mac, { serial, deviceId, deviceId2 });
      const catData = await portalFetchRetry(session, { type: "series", action: "get_categories" }, 10000);
      const categories = (catData?.js || []).map(c => ({
        id:    String(c.id),
        title: c.title,
        count: parseInt(c.count || c.videos_count || c.censored_count || 0),
      }));
      const data = { categories };
      cache.set(ck, data, CATALOG_TTL.categories);
      res.json(data);
    } catch (e) {
      console.error("Series categories error:", sanitizeStalkerUrl(e.message));
      respondWithError(res, e);
    }
  });

  router.get("/series", requireStalkerAuth, validateQuery("series"), async (req, res) => {
    const { portal, mac, cat, refresh, serial, deviceId, deviceId2 } = req.query;
    if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });
    if (!cat)            return res.status(400).json({ error: "cat (category id) required" });

    const ck = cache.cacheKey(portal, mac, "series", cat);
    if (!refresh) { const cached = cache.get(ck); if (cached) { cache.trackCacheHit(); return res.json(opaqueSeasonCommands(cached)); } } cache.trackCacheMiss();

    try {
      const session  = await getSession(portal, mac, { serial, deviceId, deviceId2 });
      const rawItems = await fetchAllPages(session, "series", cat);

      const items = rawItems.map(s => ({
        id:     s.id,
        name:   s.name,
        logo:   s.screenshot_uri || s.cover || null,
        year:   s.year,
        rating: s.rating_imdb || s.rating || null,
        type:   "series",
        plot:   s.description || s.plot || null,
        genre:  s.genre_str || s.genres_str || null,
        director: s.director || null,
        actors: s.actors || s.cast || null,
        duration: s.duration || s.time || null,
        age:    s.age || s.age_group || null,
        country: s.country || null,
      }));

      const data = { items, total: items.length };
      cache.set(ck, cacheSafeCatalog(data), CATALOG_TTL.content);
      res.json(data);
    } catch (e) {
      console.error("Series error:", sanitizeStalkerUrl(e.message));
      respondWithError(res, e);
    }
  });

  router.get("/series/episode/stream", requireStalkerAuth, validateQuery("series"), async (req, res) => {
    const { portal, mac, cmd, episode, serial, deviceId, deviceId2 } = req.query;
    if (!portal || !mac || !cmd || !episode) {
      return res.status(400).json({ error: "portal, mac, cmd and episode required" });
    }

    try {
      const session = await getSession(portal, mac, { serial, deviceId, deviceId2 });
      const data = await portalFetchRetry(session, {
        type: "vod", action: "create_link",
        cmd, series: episode, forced_storage: 0,
        disable_ad: 0, download: 0, force_ch_link_check: 0,
      });

      const normalized = normalizeCreateLinkResponse(data, { portal, mac, contentType: "series" });
      const streamUrl = normalized?.url || normalizeResolvedUrl(data?.js?.cmd, portal);
      if (!streamUrl) throw new Error("No stream URL returned for episode");

      const cleanUrl = streamUrl.replace(/^ffmpeg\s+/, "").trim();
      if (!(await isUrlAllowed(cleanUrl))) {
        return res.status(403).json({ error: "Stream URL not allowed", code: "url_not_allowed" });
      }
      console.log(`Series episode stream resolved: ep=${episode}`);
      res.json({ url: cleanUrl });
    } catch (e) {
      console.error("Series episode stream error:", sanitizeStalkerUrl(e.message));
      respondWithError(res, e);
    }
  });

  router.get("/series/:seriesId/seasons", requireStalkerAuth, validateQuery("channels"), async (req, res) => {
    const { portal, mac, serial, deviceId, deviceId2 } = req.query;
    const { seriesId } = req.params;
    if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });
    if (!seriesId)       return res.status(400).json({ error: "seriesId required" });

    try {
      const session = await getSession(portal, mac, { serial, deviceId, deviceId2 });
      const movieId = seriesId.split(":")[0];
      const result = opaqueSeasonCommands(await fetchNormalizedSeasons(session, movieId));
      res.json(result);
    } catch (e) {
      console.error("Series seasons error:", sanitizeStalkerUrl(e.message));
      respondWithError(res, e);
    }
  });

  router.get("/profile", requireStalkerAuth, validateQuery("channels"), async (req, res) => {
    const { portal, mac, serial, deviceId, deviceId2 } = req.query;
    if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });

    try {
      const session = await getSession(portal, mac, { serial });
      const params = {
        type: "stb", action: "get_profile",
        auth_second_step: 1,
        hw_version_2: "8b80dfaa8cf83485567849b7202a79360fc988e3",
      };
      if (serial) params.sn = serial;
      if (deviceId) params.device_id = deviceId;
      if (deviceId2 || deviceId) params.device_id2 = deviceId2 || deviceId;
      const data = await portalFetchRetry(session, params);
      res.json(data?.js || {});
    } catch (e) {
      console.error("Profile error:", sanitizeStalkerUrl(e.message));
      respondWithError(res, e);
    }
  });

  router.get("/account", requireStalkerAuth, validateQuery("channels"), async (req, res) => {
    const { portal, mac, serial, deviceId, deviceId2 } = req.query;
    if (!portal || !mac) return res.status(400).json({ error: "portal and mac required" });

    try {
      const session = await getSession(portal, mac, { serial, deviceId, deviceId2 });
      const data = await portalFetchRetry(session, {
        type: "account_info", action: "get_main_info",
      });
      res.json(data?.js || {});
    } catch (e) {
      console.error("Account error:", sanitizeStalkerUrl(e.message));
      respondWithError(res, e);
    }
  });

  router.post("/audit-event", express.json({ limit: "1kb" }), requireStalkerAuth, (req, res) => {
    const names = {
      direct_success: "stalker_direct_successes_total",
      direct_incompatible: "stalker_direct_incompatibilities_total",
    };
    const counter = names[req.body?.event];
    if (!counter) return res.status(400).json({ error: "Unsupported audit event", code: "invalid_event" });
    stalkerMetrics.increment(counter);
    res.status(204).end();
  });

  router.get("/audit-metrics", requireStalkerAuth, (req, res) => {
    res.json(stalkerMetrics.snapshot());
  });

  router.get("/", requireStalkerAuth, async (req, res) => {
    const { portal, mac } = req.query;
    if (!portal || !mac) return res.status(400).json({ error: "Portal and MAC required" });
    let params;
    try { params = pickAndValidateStalkerParams(req.query, "root").params; }
    catch (e) { return res.status(e.status || 400).json({ error: e.message, code: e.code || "invalid_parameter" }); }
    const start = Date.now();

    try {
      const session = await getSession(portal, mac);
      const data = await portalFetchRetry(session, params);
      const duration = Date.now() - start;
      cache.trackRequest("stalker", 200, duration);
      res.json(data);
    } catch (e) {
      const duration = Date.now() - start;
      const { status } = classifyProviderError(e);
      cache.trackRequest("stalker", status, duration);
      respondWithError(res, e);
    }
  });

  return router;
}

module.exports = { createStalkerRouter, CATALOG_TTL, LAZY_CATALOG_TTL };

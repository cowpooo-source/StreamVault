# Stalker Lazy Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce Stalker provider requests, VPS CPU/memory use, and rate-limit incidents by loading bounded catalog pages on demand while keeping playback direct whenever the provider and browser permit it.

**Architecture:** The VPS remains a control plane for Stalker authentication, bounded metadata requests, command protection, and playback-link resolution. A versioned catalog API returns normalized pages and provider capabilities; the browser caches pages in an isolated IndexedDB store and searches loaded pages locally. Provider search is used only after capability detection proves it works. Unpaginated live portals use one bounded metadata snapshot as a compatibility fallback; VOD and series are never automatically crawled in full.

**Tech Stack:** Node.js 22, Express 4, better-sqlite3, React 19, IndexedDB, Vitest, Testing Library, Playwright

**Spec:** This document is the approved architecture and implementation plan. It supersedes the previous short notes in this file.

## Context

Xtream normally returns JSON lists through a few API calls. Stalker requires a MAG-style handshake, device/session authorization, categories, provider-specific pagination, and `create_link` when an item is played.

The VPS becomes expensive when it downloads a complete catalog, parses it, normalizes it, encrypts every playback command, serializes it for SQLite, and serializes it again for the browser. Media bytes must remain direct whenever possible; only authentication and bounded metadata belong on the VPS control plane.

## Chosen Behavior

- Initial loading is sequential: live categories/page 1, VOD categories/first-category page 1, then series categories/first-category page 1.
- Selecting a category loads page 1. Scrolling or **Load more** requests the next page.
- Default page size is 100; the backend accepts 1-250.
- The UI distinguishes loaded results from provider-complete results.
- Global search shows cached matches immediately, then searches the provider after 400 ms only where search capability is proven.
- If provider search is unavailable, the UI explicitly says results cover loaded content only.
- Discovery runs only when opened and samples at most four categories per content kind, sequentially, reusing cached pages.
- `create_link` runs only when an item is selected. Resolved media URLs are never catalog-cached.
- Direct playback remains preferred. The relay remains an explicit, bounded compatibility fallback.
- An unpaginated live portal may use one bounded metadata snapshot capped at 50,000 items. There is no automatic full-catalog VOD/series fallback.

## Versioned API

Keep `/stalker/channels`, `/stalker/vod`, and `/stalker/series` for one rollout window. New frontend code uses only `/stalker/catalog/v1/*` when the feature flag is enabled.

### Categories

`GET /stalker/catalog/v1/categories?kind=live|vod|series&contentToken=...&refresh=0|1`

```json
{
  "kind": "vod",
  "categories": [{ "id": "14", "title": "Movies", "count": 1200 }],
  "capabilities": {
    "pagination": "supported",
    "search": "unsupported",
    "mode": "provider_pages"
  },
  "refreshedAt": 1780000000000
}
```

### Items

`GET /stalker/catalog/v1/items?kind=live|vod|series&category=14&page=1&pageSize=100&contentToken=...&refresh=0|1`

```json
{
  "kind": "vod",
  "category": "14",
  "items": [],
  "page": 1,
  "pageSize": 100,
  "hasMore": true,
  "nextPage": 2,
  "total": 1200,
  "totalKnown": true,
  "complete": false,
  "capabilities": {
    "pagination": "supported",
    "search": "unsupported",
    "mode": "provider_pages"
  },
  "refreshedAt": 1780000000000
}
```

Rules:

- `page` is positive; `pageSize` defaults to 100 and is capped at 250.
- `category` is required for VOD and series. Live accepts a genre ID or `all`; initial live loading uses `all`.
- `total` is `null` when the provider does not provide a trustworthy total.
- `hasMore=false` after an empty page, a short page with no total, the declared last page, or a repeated-page signature.
- `nextPage` is a positive integer or `null`.
- `complete` means the requested scope is provider-complete, not merely that the request finished.
- Normalized responses over 2 MiB fail with HTTP 502 and `catalog_page_too_large`.
- Identity uses `id`, then `stream_id`, then `ch_id`; command/name fallback is used only when no provider ID exists.
- Items contain protected `playRef`, never raw commands or resolved stream URLs.
- Provider page-number pagination is best-effort because Stalker has no stable cursor contract. Refresh always discards every loaded page for the affected category so pages from different provider revisions are not mixed.

### Search

`GET /stalker/catalog/v1/search?kind=live|vod|series&query=matrix&page=1&pageSize=100&contentToken=...`

- Query length is 2-128 trimmed characters.
- Response follows the item-page contract and adds `query`.
- Unsupported search returns HTTP 501 and `provider_search_unsupported`.
- A portal returning the same unfiltered signature for two distinct probes is marked unsupported for 48 hours.
- Search never triggers a complete catalog crawl.

### Capabilities

Each kind reports:

- `pagination`: `unknown`, `supported`, or `unsupported`
- `search`: `unknown`, `supported`, or `unsupported`
- `mode`: `provider_pages`, `bounded_live_snapshot`, or `first_page_only`

Capabilities are cached by normalized portal origin, MAC hash, serial, deviceId, and deviceId2 hash for 48 hours. Manual section refresh invalidates that kind's pages and capabilities, but never bypasses an active provider cooldown.

## Global Constraints

- Do not cache, index, or intentionally relay media payloads except through the existing compatibility relay.
- Never increase the 50 MiB buffered metadata limit to solve catalog failures.
- Never automatically crawl every VOD or series category.
- Preserve content-session authentication, SSRF checks, provider cooldowns, opaque commands, direct-play policy, and relay limits.
- Stop on provider 401, 403, or 429; do not continue probes, search, or discovery.
- Permit one active metadata operation and two queued operations per provider identity. Reject more with HTTP 429, `provider_metadata_busy`, and `Retry-After: 5`.
- Coalesce identical in-flight requests.
- Never place raw MACs, passwords, content tokens, commands, or search text in cache keys, metrics, or logs. Use SHA-256 hashes.
- Scope browser cache to user/guest ID and a SHA-256 connection fingerprint.
- Clear the active owner's Stalker cache on logout, guest reset, account change, or connection deletion.
- Lazy catalog TTL: live pages/snapshots and live capability records are retained for 30 days; VOD/series pages, categories, and VOD/series capability records are retained for 48 hours on the VPS and in the owner-scoped browser cache. EPG remains short-lived. Legacy non-lazy route TTLs are unchanged.
- Browser cache limit: 75 MiB and 1,000 page records with LRU eviction. Quota failure disables persistence for that session without breaking browsing.
- Use `STALKER_LAZY_CATALOG_ENABLED` and `VITE_STALKER_LAZY_CATALOG_ENABLED`, both defaulting to `false` until staging passes.
- Keep old endpoints for one release; remove aggregate loaders and old cache entries only in a separately reviewed cleanup.

## File Map

- Create `stalker-proxy/src/services/stalkerCatalogCapabilities.js` for capability detection and 24-hour policy.
- Create `stalker-proxy/src/services/stalkerCatalogPager.js` for normalization, identity, page boundaries, and live snapshot compatibility.
- Create `stalker-proxy/src/services/providerMetadataCoordinator.js` for concurrency, coalescing, queueing, aborts, and cooldown propagation.
- Modify `stalker-proxy/src/routes/stalker.js` to mount versioned routes and reuse existing auth/session helpers.
- Modify `stalker-proxy/src/services/stalkerRequestParams.js` for dedicated catalog validation.
- Modify `stalker-proxy/src/cache.js` for hashed page keys and targeted invalidation.
- Create `streamvault/src/stalker-catalog-api.js` for requests, validation, cancellation, and deduplication.
- Create `streamvault/src/stalker-catalog-cache.js` for IndexedDB v2, isolation, TTL, migration, local search, and LRU.
- Modify `streamvault/package.json` and `streamvault/package-lock.json` to add `fake-indexeddb` as a development-only test dependency.
- Expand `streamvault/src/stalker-catalog-loading.js` for sequential loading and cancellation.
- Modify `streamvault/src/App.jsx` for paginated state, loading UX, search, discovery, refresh, and cleanup.
- Add focused backend/frontend unit tests and deterministic Playwright tests.

---

### Task 1: Lock the API Contract

**Files:**
- Create: `stalker-proxy/tests/stalker-catalog-pager.test.js`
- Modify: `stalker-proxy/tests/stalker-router.test.js`
- Modify: `stalker-proxy/tests/stalker-request-params.test.js`

**Interfaces:**
- Consumes: `requireStalkerAuth`, `getSession`, `portalFetchRetry`, `respondWithError`
- Produces: tested contracts for `/categories`, `/items`, and `/search`

- [ ] Add validation tests for kinds, pages, page sizes, search length, arrays, objects, and unknown parameters.
- [ ] Add route tests asserting every response field, nullable totals, completeness, capabilities, and protected `playRef` output.
- [ ] Assert raw command, portal, MAC, content token, and resolved URL never appear.
- [ ] Add failures for unsupported search, oversized pages, auth failure, cooldown, repeated pages, and aborts.
- [ ] Run `cd stalker-proxy && npm test -- tests/stalker-request-params.test.js tests/stalker-catalog-pager.test.js tests/stalker-router.test.js`; expect new tests to fail before implementation.
- [ ] Commit with `git commit -m "test: define lazy Stalker catalog contract"`.

### Task 2: Implement Page Normalization and Capabilities

**Files:**
- Create: `stalker-proxy/src/services/stalkerCatalogPager.js`
- Create: `stalker-proxy/src/services/stalkerCatalogCapabilities.js`
- Create: `stalker-proxy/tests/stalker-catalog-capabilities.test.js`
- Test: `stalker-proxy/tests/stalker-catalog-pager.test.js`

**Interfaces:**
- `normalizeCatalogPage(payload, options)` returns the versioned page contract.
- `pageSignature(items)` hashes stable identities.
- `getCapabilities`, `recordPaginationProbe`, `recordSearchProbe`, and `invalidateCapabilities` manage capability records.

- [ ] Test explicit/missing totals, short pages, duplicates, malformed `js.data`, repeated pages, and the 2 MiB limit.
- [ ] Test supported/unsupported pagination and search plus 24-hour expiration with fake timers.
- [ ] Implement pure normalization with conservative `hasMore` and structured `catalog_page_too_large` errors.
- [ ] Persist only states, timestamps, and non-sensitive signatures through existing SQLite cache helpers.
- [ ] Run `cd stalker-proxy && npm test -- tests/stalker-catalog-pager.test.js tests/stalker-catalog-capabilities.test.js`.
- [ ] Commit with `git commit -m "feat: add bounded Stalker catalog paging"`.

### Task 3: Coordinate Provider Metadata Requests

**Files:**
- Create: `stalker-proxy/src/services/providerMetadataCoordinator.js`
- Create: `stalker-proxy/tests/provider-metadata-coordinator.test.js`
- Modify: `stalker-proxy/src/routes/stalker.js`

**Interfaces:**
- `runProviderMetadata({ providerKey, requestKey, signal, operation })`
- Throws `provider_metadata_busy` with `retryAfterMs=5000` after one active and two queued operations.

- [ ] Test identical-call coalescing, sequential different calls, queue limits, queued abort, active abort, and provider 429 cancelling queued work.
- [ ] Implement bounded Maps removed in `finally`, with a 60-second orphan safety timeout.
- [ ] Hash normalized provider origin/MAC for `providerKey`; hash kind/category/page/query for `requestKey`.
- [ ] Route all new catalog provider calls through the coordinator.
- [ ] Run `cd stalker-proxy && npm test -- tests/provider-metadata-coordinator.test.js tests/stalker-router.test.js`.
- [ ] Commit with `git commit -m "feat: coordinate Stalker metadata requests"`.

### Task 4: Implement Categories and Provider Pages

**Files:**
- Modify: `stalker-proxy/src/routes/stalker.js`
- Modify: `stalker-proxy/src/services/stalkerRequestParams.js`
- Modify: `stalker-proxy/src/cache.js`
- Test: `stalker-proxy/tests/stalker-router.test.js`
- Test: `stalker-proxy/tests/stalker-request-params.test.js`

- [ ] Add dedicated validation for `kind`, `category`, `page`, `pageSize`, `query`, and `refresh`; do not open generic passthrough.
- [ ] Map live categories through `get_genres` and VOD/series through `get_categories`; normalize missing counts to `null`.
- [ ] For VOD/series, request exactly one `get_ordered_list` page. If capability is unknown and more data is reported, probe page 2 once and cache that result.
- [ ] For live, probe `get_ichannels_via_api`, then paginated `get_all_channels`; stop on authorization or rate limiting.
- [ ] Cache safe normalized pages by hashed provider identity/kind/category/page/pageSize. Use the lazy-only 48-hour TTL policy; keep legacy endpoint TTLs unchanged.
- [ ] Make `refresh=1` invalidate only the selected kind/category and capability.
- [ ] Run `cd stalker-proxy && npm test`; assert page 1 never starts a full VOD/series crawl.
- [ ] Commit with `git commit -m "feat: expose lazy Stalker catalog routes"`.

### Task 5: Add Bounded Unpaginated Live Compatibility

**Files:**
- Modify: `stalker-proxy/src/services/stalkerCatalogPager.js`
- Modify: `stalker-proxy/src/routes/stalker.js`
- Modify: `stalker-proxy/tests/stalker-catalog-pager.test.js`
- Modify: `stalker-proxy/tests/stalker-router.test.js`

- [ ] Test a portal that repeats page 1 but supports `get_all_channels`: exactly one snapshot build, cached page slices, no second upstream download, and no VOD/series snapshot fallback.
- [ ] Activate snapshot mode only after live pagination is proven unsupported.
- [ ] Refactor the existing bounded parser to expose an async iterator or page callback. Abort at 50,000 items and coalesce snapshot creation.
- [ ] Normalize and persist fixed 250-item snapshot chunks as they stream. Hold at most one chunk plus parser state in memory; never build or serialize one 50,000-item JavaScript array or SQLite JSON value.
- [ ] Store encrypted safe command material in each chunk and issue protected `playRef` values only for the requested page to avoid encrypting 50,000 commands per response.
- [ ] Write a snapshot manifest only after all chunks succeed. On abort/failure, delete incomplete chunks so later readers cannot combine partial and complete revisions.
- [ ] Run focused tests and then `cd stalker-proxy && npm test`.
- [ ] Commit with `git commit -m "feat: add bounded live catalog compatibility"`.

### Task 6: Add Capability-Gated Provider Search

**Files:**
- Modify: `stalker-proxy/src/routes/stalker.js`
- Modify: `stalker-proxy/src/services/stalkerRequestParams.js`
- Modify: `stalker-proxy/src/services/stalkerCatalogCapabilities.js`
- Test: `stalker-proxy/tests/stalker-router.test.js`

- [ ] Test filtered search, ignored query parameters, unsupported actions, pagination, 429, authorization failure, and no catalog crawl.
- [ ] Add dedicated safe adapters. For VOD/series, use only verified `get_ordered_list` search fields. For live, report unsupported unless fixtures prove a read-only search action.
- [ ] Probe two distinct terms once; matching unfiltered signatures mark search unsupported for 48 hours.
- [ ] Stop sequential search immediately on 401, 403, or 429.
- [ ] Run `cd stalker-proxy && npm test`.
- [ ] Commit with `git commit -m "feat: add guarded Stalker provider search"`.

### Task 7: Add IndexedDB v2 Page Cache

**Files:**
- Create: `streamvault/src/stalker-catalog-cache.js`
- Create: `streamvault/tests/stalker-catalog-cache.test.js`
- Modify: `streamvault/src/App.jsx`
- Modify: `streamvault/package.json`
- Modify: `streamvault/package-lock.json`

**Interfaces:**
- `getPage`, `putPage`, `searchPages`, `invalidateScope`, `clearOwner`, and `enforceQuota`
- Scope is `{ ownerId, connectionFingerprint }`.

- [ ] Install `fake-indexeddb` with `cd streamvault && npm install --save-dev fake-indexeddb` and use it for deterministic cache tests.
- [ ] Test user/guest isolation, hashed fingerprints, TTL/stale reads, LRU, 75 MiB/1,000-record eviction, quota errors, logout cleanup, and v1 migration.
- [ ] Create `pages` and `meta` stores containing page metadata, normalized search text, byte estimate, expiry, and last access.
- [ ] Exclude resolved URLs, content tokens, raw portal/MAC strings, and raw commands.
- [ ] Fall back to an in-memory session cache if IndexedDB/quota fails, logging only one sanitized warning.
- [ ] Clear owner data on logout, guest reset, account change, and connection deletion; migrate away old `catitems:*` and combined Stalker `content:*` entries.
- [ ] Run `cd streamvault && npm test -- tests/stalker-catalog-cache.test.js`.
- [ ] Commit the cache, tests, App wiring, and package files with `git commit -m "feat: add isolated Stalker page cache"`.

### Task 8: Add Frontend API and Paginated State

**Files:**
- Create: `streamvault/src/stalker-catalog-api.js`
- Create: `streamvault/tests/stalker-catalog-api.test.js`
- Modify: `streamvault/src/stalker-catalog-loading.js`
- Modify: `streamvault/tests/stalker-catalog-loading.test.js`
- Modify: `streamvault/src/App.jsx`

**Interfaces:**
- API: `fetchCategories`, `fetchCatalogPage`, `searchProvider`, `abortScope`.
- State per category: `{ items, loadedPages, nextPage, hasMore, total, totalKnown, complete, status, error, capabilities }`.

- [ ] Test malformed responses, structured errors, call deduplication, category cancellation, and no automatic retry for 401/403/429.
- [ ] Test sequential initial loading and cancellation between each kind.
- [ ] Implement requests using `authFetch`, `contentToken`, and `AbortController`.
- [ ] Keep Xtream/M3U behavior unchanged; merge Stalker pages by stable ID and preserve favorites/history identity.
- [ ] Remove the timer that writes combined Stalker VOD/series arrays.
- [ ] Render stale cached pages immediately while one background refresh runs; retain stale content on refresh failure.
- [ ] Run `cd streamvault && npm test -- tests/stalker-catalog-api.test.js tests/stalker-catalog-loading.test.js tests/connection-lifecycle.test.js`.
- [ ] Commit with `git commit -m "feat: load Stalker catalogs by page"`.

### Task 9: Add Paging and Honest Loading UX

**Files:**
- Modify: `streamvault/src/App.jsx`
- Modify: `streamvault/src/App.css`
- Create: `streamvault/tests/stalker-catalog-ui.test.jsx`

- [ ] Test first-page spinner, category switching, Load more, one automatic request per page, duplicates, partial counts, terminal errors, retries, and cooldown copy.
- [ ] Abort the previous category request on selection and load cached/new page 1.
- [ ] Trigger auto-load only when enabled, the previous request completed, `hasMore=true`, and no cooldown exists.
- [ ] Show `100 loaded`, `100 of 1,200`, or `All 100 loaded` according to contract state.
- [ ] Category refresh reloads one category. Section refresh confirms and invalidates only that kind; it never crawls unopened categories.
- [ ] Run `cd streamvault && npm test -- tests/stalker-catalog-ui.test.jsx`, then `npm run lint && npm run build`.
- [ ] Commit with `git commit -m "feat: add Stalker catalog paging UI"`.

### Task 10: Add Local-First Global Search

**Files:**
- Modify: `streamvault/src/App.jsx`
- Modify: `streamvault/src/stalker-catalog-cache.js`
- Create: `streamvault/tests/stalker-global-search.test.jsx`

- [ ] Test immediate local results, 400 ms debounce, cancellation, minimum length, deduplication, sequential provider search, pagination, unsupported copy, and no full-catalog request.
- [ ] Search only active-owner pages, normalize case/diacritics, cap at 80 results per kind, and yield between cursor batches.
- [ ] Query supported provider kinds sequentially: live, VOD, series. Merge rather than replace local results.
- [ ] Label cached and provider results separately. Do not claim `No results` is complete unless all selected kinds support search and are exhausted.
- [ ] Run `cd streamvault && npm test -- tests/stalker-global-search.test.jsx tests/stalker-catalog-cache.test.js`.
- [ ] Commit with `git commit -m "feat: add local-first Stalker search"`.

### Task 11: Add Lazy Discovery

**Files:**
- Modify: `streamvault/src/App.jsx`
- Modify: `streamvault/src/components/DiscoverView.jsx`
- Modify: `streamvault/tests/DiscoverView.test.jsx`
- Create: `streamvault/tests/stalker-discovery.test.jsx`

- [ ] Test no more than four sequential category requests per kind, cache reuse, 429 stopping, deterministic daily selection, and abort on close.
- [ ] Select the first non-empty category plus up to three categories spread across the list using a daily connection-fingerprint seed.
- [ ] Show `Suggestions from loaded categories`; never imply full-provider analysis.
- [ ] Run `cd streamvault && npm test -- tests/DiscoverView.test.jsx tests/stalker-discovery.test.jsx`.
- [ ] Commit with `git commit -m "feat: sample Stalker discovery lazily"`.

### Task 12: Harden Cached Playback References

**Files:**
- Modify: `stalker-proxy/src/routes/stalker.js`
- Modify: `stalker-proxy/tests/stalker-router.test.js`
- Modify: `streamvault/src/App.jsx`
- Modify: `streamvault/tests/connection-playback-hardening.test.jsx`
- Modify: `streamvault/tests/Player.test.jsx`

- [ ] Test `playRef` expiry, connection binding, tampering, and absence of raw commands.
- [ ] Add issued-at, 30-minute expiry, and connection fingerprint to new references while retaining old-reference decoding for the rollout window.
- [ ] On `play_ref_expired`, refetch that item page once and resolve once. Never loop on auth/rate-limit errors.
- [ ] If the item disappeared, show terminal `Content is no longer available`.
- [ ] Preserve existing redirect resolution, stream classification, direct-first policy, and bounded relay fallback; never cache resolved output.
- [ ] Run backend route tests and frontend Player/hardening tests.
- [ ] Commit with `git commit -m "fix: refresh expired Stalker playback references"`.

### Task 13: Add Metrics and Flags

**Files:**
- Modify: `stalker-proxy/src/services/operationalMetrics.js`
- Modify: `stalker-proxy/tests/operationalMetrics.test.js`
- Modify: `stalker-proxy/src/routes/stalker.js`
- Modify: `stalker-proxy/.env.example`
- Modify: `streamvault/.env.example`

- [ ] Test metrics for upstream calls, latency, normalized bytes/items, cache hits, modes, coalescing, aborts, cooldowns, and queue rejection; verify labels contain no sensitive data.
- [ ] Record one route event and one event per actual upstream request.
- [ ] Aggregate Discord alerts for repeated metadata rate limits and queue saturation instead of alerting per request.
- [ ] Backend flag disabled returns 404 for new routes; frontend flag disabled keeps current behavior.
- [ ] Document rollout order: backend first, frontend second, frontend flag rollback first.
- [ ] Run `cd stalker-proxy && npm test`.
- [ ] Commit with `git commit -m "chore: instrument lazy Stalker catalogs"`.

### Task 14: Add Deterministic E2E Coverage

**Files:**
- Create: `streamvault/e2e/stalker-catalog.spec.js`
- Modify: `streamvault/e2e/stalker-playback.spec.js`
- Modify: `streamvault/playwright.config.js`

- [ ] Mock provider routes and test sequential initial load, paging, category cancellation, repeated pages, refresh, and live snapshot mode.
- [ ] Test local/provider search, unsupported messaging, partial discovery, and stopping after 429.
- [ ] Test logout/account cache isolation, connection deletion, and clean reconnect.
- [ ] Test playback from cache, expired reference refresh, direct playback, bounded fallback, and terminal recovery exhaustion.
- [ ] Run `cd streamvault && npx playwright test e2e/stalker-catalog.spec.js e2e/stalker-playback.spec.js`.
- [ ] Commit with `git commit -m "test: cover lazy Stalker catalog flows"`.

### Task 15: Verify and Roll Out

**Files:**
- Modify: `README.md`
- Modify: deployment documentation containing production environment flags
- Modify: `docs/stalker-vs-xtream-lazy-loading-notes.md`

- [ ] Run `cd stalker-proxy && npm test`.
- [ ] Run `cd streamvault && npm run lint && npm test && npm run build`.
- [ ] Run deterministic Stalker Playwright tests.
- [ ] Compare initial upstream calls, wall time, Node RSS, event-loop delay, response bytes, and cache bytes against the current implementation.
- [ ] Require: at most one categories call and one page call per kind plus one capability probe; responses under 2 MiB; no VOD/series loop beyond page 2; valid cache reopening causes zero upstream calls; five identical requests cause one upstream call; 429 causes no calls until cooldown ends.
- [ ] Deploy backend with flag off, enable and smoke-test new endpoints, then build staging frontend with its flag on.
- [ ] Test a paginated portal, unpaginated live portal, mocked rate limit, unsupported search, playback, logout, and account switch.
- [ ] Monitor staging for 24 hours. Roll back the frontend flag if CPU/RSS regress, provider calls materially increase, or supported live portals fail.
- [ ] Enable production only after acceptance; retain legacy endpoints for one release and file a separate cleanup issue.
- [ ] Update README/deployment docs with contracts, flags, cache privacy, metrics, rollback, and partial-search limitations.
- [ ] Commit with `git commit -m "docs: document lazy Stalker catalog rollout"`.

## Live Provider Compatibility Fallback

- Empty `get_ichannels_via_api` page one is not treated as a valid empty catalog when live genres exist.
- The backend switches only live catalogs to `bounded_live_snapshot` and streams one shared `get_all_channels` scan.
- VOD and series do not receive a full-catalog fallback.
- Snapshot mode and live capability state are cached for 30 days; completed zero-result fallbacks are negative-cached for five minutes.
- Manual live refresh clears pages, capability state, active snapshot work, and negative cache for the selected connection identity.
- Compatibility fallback is suppressed for authorization failures, rate limits, cooldowns, aborts, metadata-size failures, coordinator saturation, and generic provider failures.
- Monitor `stalker_live_snapshot_compatibility_*`, provider cooldowns, rate limits, CPU, RSS, and event-loop latency.

## Required Provider Matrix

- Correct pagination with trustworthy totals
- Correct pagination without totals
- Page ignored and page 1 repeated
- Empty page 2
- Duplicate IDs and unstable ordering
- `get_ichannels_via_api` unsupported but `get_all_channels` available
- Oversized unpaginated live catalog
- Oversized unpaginated VOD/series response
- Empty or malformed categories
- Search supported, ignored, and unsupported
- Authentication expiry during loading
- 429 with and without `Retry-After`
- Abort while queued and active
- Expired cached playback reference
- Direct playback failure with and without relay compatibility

## Release Contract

The lazy frontend and backend must be released from the same Git commit. The frontend build emits `streamvault/dist/release.json` with `commit`, `builtAt`, `lazyCatalogFrontend`, and `lazyCatalogBackend`, and adds the commit to `<meta name="sv-release">`. The backend exposes its configured `RELEASE_COMMIT` at `/health`. A release is invalid when these identifiers differ.

Use `scripts/verify-release.ps1` before deployment. It runs the backend and frontend regression suites, lint, production build, default Playwright coverage, and the dedicated lazy-catalog Playwright gate. Set `RELEASE_COMMIT` and `VITE_RELEASE_COMMIT` in CI/deployment; if omitted, the build derives the current Git commit. `VITE_STALKER_LAZY_CATALOG_ENABLED` controls the frontend gate and `STALKER_LAZY_CATALOG_ENABLED` controls the backend rollout.

Deploy backend and frontend from one release directory. Keep `/content`, Stalker catalog APIs, playback, and media network-only in the service worker. To roll back, select one previous release for both artifacts, restore its matching environment, reload the backend, and serve that release's frontend assets. Do not mix assets or `release.json` from different commits.

## Non-Goals

- Complete VPS-side VOD/series indexing
- Prefetching every category
- Caching media, playlists, segments, or resolved URLs
- Claiming complete search where provider search is unavailable
- Increasing concurrency to make initial loading appear faster
- Removing the compatibility relay in this project

## Completion Definition

The work is complete only when versioned APIs, page cache isolation, capability handling, local-first search, lazy discovery, playback-reference recovery, metrics, tests, and staged rollout checks pass. Merely loading one category without page contracts, cooldown behavior, and partial-result messaging does not satisfy this plan.

# Stalker Live Catalog Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make lazy Stalker live channels load for portals that return valid genres but empty or unsupported `get_ichannels_via_api` pages by activating one shared streaming `get_all_channels` snapshot per connection identity.

**Architecture:** Keep `provider_pages` for portals with usable live provider pages. For a live page-one compatibility failure, verify that the portal has at least one non-aggregate genre, switch the canonical connection identity to the existing `bounded_live_snapshot` mode, and stream one shared `get_all_channels` scan into chunked snapshot storage. The frontend keeps the category rail mounted and displays snapshot preparation while the requested page waits.

**Tech Stack:** Node.js, Express, Vitest, SQLite-backed cache, streaming JSON parser, React, Vite, IndexedDB, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-30-stalker-live-catalog-compatibility-design.md`

## Implementation Status (2026-08-30)

Tasks 1-5 are implemented and committed on `vps/http-static`. Task 6 browser coverage and operational documentation are implemented in the current working tree; automated release-gate checks pass, while sandbox-only manual verification remains outstanding.

- Task 1: PASS, commit `3fe347c`.
- Task 2: PASS, commit `9b48f32`.
- Task 3: PASS, commit `ef8f00c`.
- Task 4: PASS, commit `3ed7590`.
- Task 5: PASS, commit `4d17740`.
- Task 6: automated implementation and release-gate checks PASS; sandbox-only manual smoke verification BLOCKED because this local session did not deploy or access sandbox.

## Global Constraints

- Preserve all working-tree changes unrelated to this plan.
- Do not modify VOD, series, Xtream, M3U, direct playback, or media relay behavior.
- Do not change legacy Stalker behavior while `STALKER_LAZY_CATALOG_ENABLED` is disabled.
- Keep the live channel hard cap at the existing `STALKER_CHANNELS_MAX_ITEMS` / 50,000 maximum.
- Keep lazy catalog page size bounded to 1 through 250 items.
- Never persist raw commands, portal URLs, MAC addresses, device identifiers, content-session tokens, or resolved stream URLs in browser records or metrics.
- Preserve content-session authentication, SSRF checks, metadata coordinator limits, abort propagation, provider cooldowns, and structured error responses.
- Build backend and frontend from the same release commit before sandbox deployment.
- Do not deploy or commit unrelated changes automatically.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `stalker-proxy/src/services/stalkerCatalogCapabilities.js` | Persist live provider compatibility mode by canonical provider key. |
| `stalker-proxy/src/routes/stalker.js` | Obtain category evidence, classify provider-page compatibility, activate/join snapshots, and emit metrics. |
| `stalker-proxy/src/services/stalkerAuditMetrics.js` | Define sanitized compatibility-fallback counters. |
| `stalker-proxy/tests/stalker-catalog-services.test.js` | Test capability state transitions and TTL behavior. |
| `stalker-proxy/tests/stalker-router.test.js` | Test route activation, shared scans, terminal-error suppression, refresh, and legacy behavior. |
| `streamvault/src/stalker-catalog-loading.js` | Decide whether lazy live loading uses the local category loading state instead of a global overlay. |
| `streamvault/src/App.jsx` | Keep live categories visible while a selected snapshot page is pending and show the snapshot status. |
| `streamvault/tests/stalker-catalog-loading.test.js` | Test lazy live loading-state decisions and copy. |
| `streamvault/tests/stalker-connection-flow.test.jsx` | Test categories remain visible during lazy live snapshot loading. |
| `streamvault/e2e/stalker-lazy-flow.spec.js` | Add deployment-level coverage for category navigation and no legacy aggregate call. |
| `docs/stalker-vs-xtream-lazy-loading-notes.md` | Record compatibility-mode behavior, cache policy, monitoring, and rollback. |

## Interfaces

The implementation introduces only internal backend interfaces. The public endpoint remains:

```text
GET /stalker/catalog/v1/items?kind=live&category=<id>&page=<n>&pageSize=<1..250>&contentToken=<opaque>
```

The response retains the existing page contract. Compatibility pages use:

```js
{
  kind: 'live',
  category: '3010',
  items: [/* normalized command-free channel items plus ephemeral playRef */],
  page: 1,
  pageSize: 100,
  hasMore: true,
  nextPage: 2,
  total: null,
  totalKnown: false,
  complete: false,
  capabilities: {
    pagination: 'unsupported',
    mode: 'bounded_live_snapshot',
    search: 'unknown'
  }
}
```

Add these internal helpers in `stalker.js`:

```js
async function getLiveCategoryEvidence({
  portal, mac, catalogOpts, providerKey, categoryGenerationKey,
  operationGeneration, signal,
}) {
  // Returns { categories, hasNonAggregateCategory }.
}

function isLiveProviderPageCompatibilityError(error) {
  // True only for get_ichannels_via_api HTTP 404, 405, 501, or an explicit
  // unsupported-action payload. Never true for auth, cooldown, 429, abort,
  // coordinator, SSRF, malformed JSON, metadata-size, or generic 5xx errors.
}

async function resolveLiveCatalogPage({
  session, portal, mac, catalogOpts, providerKey, request,
  capabilities, operationGeneration, operationCapabilityGeneration,
  categoryGenerationKey, signal,
}) {
  // Returns { page, usedSnapshot } or throws the original structured error.
}
```

Add this capability API in `stalkerCatalogCapabilities.js`:

```js
recordLiveSnapshotMode(providerKey, options) {
  return set(providerKey, 'live', {
    pagination: 'unsupported',
    mode: 'bounded_live_snapshot',
  }, options);
}
```

Only call `recordLiveSnapshotMode` after the snapshot has produced one usable channel, or after a completed snapshot reports `total > 0`. A five-minute negative cache is used for a completed zero-channel fallback and does not persist snapshot mode for 30 days.

### Task 1: Capability State and Safe Cache Versioning

**Files:**

- Modify: `stalker-proxy/src/services/stalkerCatalogCapabilities.js`
- Modify: `stalker-proxy/src/routes/stalker.js`
- Modify: `stalker-proxy/tests/stalker-catalog-services.test.js`

**Consumes:** Canonical provider keys created by `catalogProviderKey(portal, mac, catalogOpts)`.

**Produces:** `recordLiveSnapshotMode()` and a fresh cache namespace so previously cached false-empty live pages cannot survive the compatibility fix.

- [ ] **Step 1: Write failing capability tests**

```js
it('records bounded live snapshot mode without changing search capability', () => {
  const records = new Map();
  const cache = { get: key => records.get(key), set: (key, value) => records.set(key, value) };
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
  const records = new Map();
  const cache = { get: key => records.get(key), set: (key, value) => records.set(key, value) };
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
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```powershell
cd stalker-proxy
npx vitest run tests/stalker-catalog-services.test.js
```

Expected: FAIL because `recordLiveSnapshotMode` does not exist.

- [ ] **Step 3: Add the minimal capability method and cache-key migration**

```js
recordLiveSnapshotMode(providerKey, options) {
  return set(providerKey, 'live', {
    pagination: 'unsupported',
    mode: 'bounded_live_snapshot',
  }, options);
}
```

Make capability expiration kind-aware: retain the existing 48-hour TTL for VOD and series capability records, but use `LAZY_CATALOG_TTL.live` (30 days) for live capability records. `set()` must write with the same per-kind TTL used by `get()`. Keep the complete canonical identity portion unchanged.

In `stalker.js`, change the lazy catalog page-cache prefix from `stalker-catalog-v2` to `stalker-catalog-v3` **both** in `catalogCacheKey()` and in the `invalidateCatalog()` page-prefix logic. This forces previously cached false-empty live pages to be rebuilt while leaving unrelated cache keys alone.

- [ ] **Step 4: Run focused service and route tests**

Run:

```powershell
cd stalker-proxy
npx vitest run tests/stalker-catalog-services.test.js tests/stalker-router.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit the isolated change**

```powershell
git add stalker-proxy/src/services/stalkerCatalogCapabilities.js stalker-proxy/src/routes/stalker.js stalker-proxy/tests/stalker-catalog-services.test.js
git commit -m "fix(stalker): record live snapshot compatibility mode"
```

### Task 2: Shared Category Evidence Loader

**Files:**

- Modify: `stalker-proxy/src/routes/stalker.js`
- Modify: `stalker-proxy/tests/stalker-router.test.js`

**Consumes:** `catalogCategoryCacheKey`, `catalogGenerations`, `metadataCoordinator`, `getSession`, `portalFetchRetry`, and `normalizeCatalogCategories`.

**Produces:** `getLiveCategoryEvidence()` that returns normalized live categories plus `hasNonAggregateCategory`, without duplicate `get_genres` calls.

- [ ] **Step 1: Add reusable router-test fixtures, then write failing route tests**

Add these fixtures beside `makeDeps()` in `stalker-router.test.js`; use them in every new compatibility test so the tests exercise cache persistence and streaming behavior rather than mock call counts alone:

```js
function cacheBackedBy(records) {
  return {
    get: key => records.get(key),
    set: (key, value) => records.set(key, value),
    del: key => records.delete(key),
    keysByPrefix: prefix => [...records.keys()].filter(key => key.startsWith(prefix)),
    deleteKeysByPrefix: prefix => {
      for (const key of [...records.keys()]) if (key.startsWith(prefix)) records.delete(key);
    },
    trackWatch: vi.fn(), trackCacheHit: vi.fn(), trackCacheMiss: vi.fn(),
    trackPortalHealth: vi.fn(), trackRequest: vi.fn(),
    cacheKey: vi.fn((portal, mac, endpoint, extra = '') => `${portal}|${mac}|${endpoint}|${extra}`),
  };
}

function stalkerSession() {
  return { portal: 'http://p.com/c', mac: '00:1A:79:AA:BB:CC', headers: {}, refresh: vi.fn() };
}

function streamCatalog(items) {
  return vi.fn(async (_session, _limit, _timeout, { onItem } = {}) => {
    for (const item of items) await onItem?.(item);
    return items;
  });
}
```

Then add:

```js
it('uses cached live categories as compatibility evidence without another provider call', async () => {
  const records = new Map();
  const deps = makeDeps({
    cache: cacheBackedBy(records),
    getSession: vi.fn().mockResolvedValue(stalkerSession()),
    portalFetchRetry: vi.fn().mockImplementation((_session, params) => {
      if (params.action === 'get_genres') return { js: [{ id: '3010', title: 'Sports' }] };
      return { js: { data: [] } };
    }),
  });
  const app = makeApp(deps);

  await request(app).get('/stalker/catalog/v1/categories?kind=live&portal=http://p.com/c&mac=00:1A:79:AA:BB:CC');
  await request(app).get('/stalker/catalog/v1/items?kind=live&category=3010&page=1&pageSize=100&portal=http://p.com/c&mac=00:1A:79:AA:BB:CC');

  expect(deps.portalFetchRetry.mock.calls.filter(([, params]) => params.action === 'get_genres')).toHaveLength(1);
});

it('does not activate compatibility fallback when live categories contain only All', async () => {
  // get_genres returns [{ id: '*', title: 'All' }]; live item page remains a valid empty page.
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```powershell
cd stalker-proxy
npx vitest run tests/stalker-router.test.js
```

Expected: FAIL because item requests neither load nor reuse category evidence.

- [ ] **Step 3: Extract a shared category loader without nested coordinator work**

Move the provider work currently inside `GET /catalog/v1/categories` into `getLiveCategoryEvidence()` for live requests. The helper must:

```js
const cached = cache.get(catalogCategoryCacheKey(portal, mac, 'live', catalogOpts));
if (cached?.categories) {
  return {
    categories: cached.categories,
    hasNonAggregateCategory: cached.categories.some(category => !category.aggregate),
  };
}

const data = await metadataCoordinator.runProviderMetadata({
  providerKey,
  requestKey: `categories|live|generation:${operationGeneration}`,
  signal,
  operation: async requestSignal => {
    const session = await getSession(portal, mac, catalogOpts);
    const payload = await portalFetchRetry(session, { type: 'itv', action: 'get_genres' }, undefined, requestSignal);
    const categories = normalizeCatalogCategories(Array.isArray(payload?.js) ? payload.js : payload?.data, {
      includeSyntheticAll: true,
    });
    const result = { kind: 'live', categories, capabilities: catalogCapabilities.get(providerKey, 'live'), refreshedAt: Date.now() };
    cache.set(categoryKey, result, LAZY_CATALOG_TTL.categories);
    return result;
  },
});
```

Keep the existing generation check immediately before `cache.set`. The categories endpoint must call this helper so both route paths deduplicate through the same metadata coordinator key.

`getLiveCategoryEvidence()` must be invoked **outside** an active `metadataCoordinator.runProviderMetadata()` operation. Do not call it from the items operation: the coordinator serializes work per provider, so queuing `get_genres` from inside the active `items` operation would deadlock. Task 3 makes the item operation return an un-cached compatibility candidate first, then invokes this helper in a second, sequential coordinator operation.

- [ ] **Step 4: Run focused tests**

Run:

```powershell
cd stalker-proxy
npx vitest run tests/stalker-router.test.js
```

Expected: PASS, including existing category endpoint tests.

- [ ] **Step 5: Commit the category evidence loader**

```powershell
git add stalker-proxy/src/routes/stalker.js stalker-proxy/tests/stalker-router.test.js
git commit -m "refactor(stalker): share live category compatibility evidence"
```

### Task 3: Activate Shared Streaming Fallback for Real Live Categories

**Files:**

- Modify: `stalker-proxy/src/routes/stalker.js`
- Modify: `stalker-proxy/src/services/stalkerAuditMetrics.js`
- Modify: `stalker-proxy/tests/stalker-router.test.js`

**Consumes:** `getLiveCategoryEvidence()`, `buildOrJoinLiveSnapshot()`, `recordLiveSnapshotMode()`, `itemsFromPayload()`, `catalogGenerations`, and the existing streaming `portalFetchChannelCatalog` dependency.

**Produces:** `resolveLiveCatalogPage()` and metrics that route compatible provider pages normally and incompatible provider pages through one shared snapshot.

- [ ] **Step 1: Replace obsolete false-empty tests with failing compatibility tests**

Delete the assertions that real category requests must not use the snapshot fallback. Replace them with:

```js
it('switches a real live category with genres and an empty provider page to one shared snapshot', async () => {
  const records = new Map();
  const deps = makeDeps({
    cache: cacheBackedBy(records),
    getSession: vi.fn().mockResolvedValue(stalkerSession()),
    portalFetchRetry: vi.fn().mockImplementation((_session, params) => {
      if (params.action === 'get_genres') return { js: [{ id: '3010', title: 'Sports' }] };
      if (params.action === 'get_ichannels_via_api') return { js: { data: [] } };
      throw new Error(`unexpected action ${params.action}`);
    }),
    portalFetchChannelCatalog: streamCatalog([
      { id: 1, name: 'Sports One', tv_genre_id: '3010', cmd: 'one' },
      { id: 2, name: 'Sports Two', tv_genre_id: '3010', cmd: 'two' },
    ]),
  });

  const response = await request(makeApp(deps))
    .get('/stalker/catalog/v1/items?kind=live&category=3010&page=1&pageSize=100&portal=http://p.com/c&mac=00:1A:79:AA:BB:CC');

  expect(response.status).toBe(200);
  expect(response.body.items.map(item => item.id)).toEqual([1, 2]);
  expect(response.body.capabilities).toMatchObject({ mode: 'bounded_live_snapshot', pagination: 'unsupported' });
  expect(deps.portalFetchChannelCatalog).toHaveBeenCalledTimes(1);
});

it('joins all and real-category requests to one live snapshot scan', async () => {
  // Start two requests before streamCatalog resolves its second item.
  // Assert portalFetchChannelCatalog was called once and both pages resolve.
});

it('keeps non-empty provider pages in provider_pages mode', async () => {
  // get_ichannels_via_api returns one channel; assert portalFetchChannelCatalog was never called.
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```powershell
cd stalker-proxy
npx vitest run tests/stalker-router.test.js
```

Expected: FAIL because category requests currently normalize the empty provider response instead of building the snapshot.

- [ ] **Step 3: Add explicit compatibility classification**

Implement `isLiveProviderPageCompatibilityError(error)` using this exact policy:

```js
function isLiveProviderPageCompatibilityError(error) {
  const status = Number(error?.status || error?.statusCode);
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '');
  if ([401, 403, 429, 499].includes(status)) return false;
  if (['UNAUTHORIZED', 'AUTHORIZATION_FAILURE', 'RATE_LIMITED', 'PROVIDER_COOLDOWN', 'ABORT_ERR', 'PROVIDER_METADATA_BUSY'].includes(code)) return false;
  if (/rate.?limit|cooldown|authorization|unauthori[sz]ed|device not found|access denied|metadata response exceeds|\b5\d\d\b/i.test(message)) return false;
  return [404, 405, 501].includes(status) || /unknown action|get_ichannels_via_api.*unsupported|unsupported.*get_ichannels_via_api/i.test(message);
}
```

Implement `resolveLiveCatalogPage()` so it:

1. Reads an already-recorded `bounded_live_snapshot` before calling `get_ichannels_via_api`.
2. Runs `get_ichannels_via_api` in one `metadataCoordinator.runProviderMetadata()` operation when mode is `provider_pages`. For a normal page it returns the unnormalized provider payload. For a safe compatibility error it returns an internal `{ compatibilityError }` candidate instead of caching or normalizing an empty page.
3. Calls `getLiveCategoryEvidence()` only after an empty response or an allowed compatibility error, and only after the item-coordinator operation has settled.
4. Falls back only when `hasNonAggregateCategory` is true.
5. Calls `buildOrJoinLiveSnapshot()` using the existing identity-only work key.
6. Records `recordLiveSnapshotMode()` only after the returned snapshot page contains items or reports a completed nonzero total.
7. Returns the original provider page or original structured error for every other case.

Inside `GET /catalog/v1/items`, delegate only live requests to `resolveLiveCatalogPage()`. Leave the existing VOD and series `metadataCoordinator.runProviderMetadata()` operation unchanged. `resolveLiveCatalogPage()` owns the sequential coordinator calls, so do **not** wrap that helper in an outer metadata-coordinator operation. Normalize and cache a provider-page payload only after `resolveLiveCatalogPage()` reports `usedSnapshot: false`; normalize/cache snapshot output only through the existing snapshot store. Do not call the page-two pagination probe for a request that switched to snapshot mode.

- [ ] **Step 4: Add sanitized counters**

Append these exact names to `COUNTERS` in `stalkerAuditMetrics.js`:

```js
'stalker_live_snapshot_compatibility_detected_total',
'stalker_live_snapshot_compatibility_activated_total',
'stalker_live_snapshot_compatibility_suppressed_total',
'stalker_live_snapshot_negative_cache_hits_total',
'stalker_live_snapshot_waiters_resolved_early_total',
```

Increment only by outcome class. Never include identity or provider values in a metric key, metric value, or log message.

- [ ] **Step 5: Run focused backend tests**

Run:

```powershell
cd stalker-proxy
npx vitest run tests/stalker-router.test.js tests/stalker-catalog-services.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit the route behavior**

```powershell
git add stalker-proxy/src/routes/stalker.js stalker-proxy/src/services/stalkerAuditMetrics.js stalker-proxy/tests/stalker-router.test.js
git commit -m "fix(stalker): fall back to shared live snapshot pages"
```

### Task 4: Snapshot Failure, Negative Cache, and Refresh Integrity

**Files:**

- Modify: `stalker-proxy/src/routes/stalker.js`
- Modify: `stalker-proxy/src/services/stalkerLiveSnapshot.js`
- Modify: `stalker-proxy/tests/stalker-router.test.js`
- Modify: `stalker-proxy/tests/stalker-catalog-services.test.js`

**Consumes:** Shared snapshot builds, catalog generations, existing provider cooldown errors, and the `cache` service.

**Produces:** Five-minute zero-result negative cache, reliable build cleanup, and refresh-safe snapshot publication.

- [ ] **Step 1: Write failing tests for negative cache and terminal errors**

```js
it('does not persist snapshot mode after a completed zero-channel fallback and suppresses retry for five minutes', async () => {
  // get_genres returns a real genre, provider page is empty, streaming catalog yields zero.
  // First request invokes one stream. Second request invokes no provider work.
  // Capability remains provider_pages until the negative cache expires.
});

it.each([
  Object.assign(new Error('rate limited'), { status: 429, code: 'RATE_LIMITED' }),
  Object.assign(new Error('access denied'), { status: 403, code: 'AUTHORIZATION_FAILURE' }),
  Object.assign(new Error('metadata response exceeds 20971520 bytes'), { status: 502, code: 'METADATA_TOO_LARGE' }),
])('does not invoke a snapshot for terminal provider error %#', async error => {
  // Assert portalFetchChannelCatalog was never called and the original error code is returned.
});

it('manual refresh invalidates the active snapshot generation and prevents stale completion publication', async () => {
  // Hold the first stream, request refresh=1, finish the old stream, then assert only refreshed generation is readable.
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```powershell
cd stalker-proxy
npx vitest run tests/stalker-router.test.js
```

Expected: FAIL because zero-result compatibility attempts currently have no negative cache and route fallback is not generation-complete.

- [ ] **Step 3: Implement bounded negative-cache and cleanup behavior**

Use one cache key per canonical identity:

```js
const liveFallbackNegativeKey = (portal, mac, catalogOpts = {}) =>
  `stalker-live-fallback-negative-v1|${catalogIdentityKey(portal, mac, catalogOpts)}`;
const LIVE_FALLBACK_NEGATIVE_TTL_MS = 5 * 60 * 1_000;
```

Before starting a compatibility scan, return a valid empty completed page only when this negative key exists. Increment `stalker_live_snapshot_negative_cache_hits_total`.

After a completed zero-item snapshot, set this key with `{ refreshedAt: Date.now() }` and `LIVE_FALLBACK_NEGATIVE_TTL_MS`. Do not set it for auth, cooldown, abort, malformed response, metadata-size, or other failed scans.

Ensure `buildOrJoinLiveSnapshot()` attaches a terminal rejection handler to the background promise so a late scan failure is recorded and releases waiters without producing an unhandled rejection:

```js
const promise = runSnapshot().catch(error => {
  // build.fail(error) has already released waiters.
  return null;
}).finally(() => liveSnapshotRuns.delete(buildKey));
```

Preserve the original error for the initiating request by awaiting `build.waitForPage()`; do not replace it with `null` before waiters are rejected. The compatibility classification and category-evidence lookup run sequentially, so a shared snapshot remains the only long-running upstream catalog scan for that identity.

On `refresh=1`, invalidate the negative key with the live snapshot, abort active builds for the identity, and preserve the existing generation check before every snapshot manifest/page publication.

- [ ] **Step 4: Run focused tests**

Run:

```powershell
cd stalker-proxy
npx vitest run tests/stalker-router.test.js tests/stalker-catalog-services.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit snapshot resilience**

```powershell
git add stalker-proxy/src/routes/stalker.js stalker-proxy/src/services/stalkerLiveSnapshot.js stalker-proxy/tests/stalker-router.test.js stalker-proxy/tests/stalker-catalog-services.test.js
git commit -m "fix(stalker): bound live snapshot compatibility retries"
```

### Task 5: Preserve Live Category Controls During Snapshot Loading

**Files:**

- Modify: `streamvault/src/stalker-catalog-loading.js`
- Modify: `streamvault/src/App.jsx`
- Modify: `streamvault/tests/stalker-catalog-loading.test.js`
- Modify: `streamvault/tests/stalker-connection-flow.test.jsx`

**Consumes:** The unchanged catalog page response with `capabilities.mode === 'bounded_live_snapshot'`.

**Produces:** A mounted category rail, a selected-category loading state, and clear snapshot preparation copy while live pages are pending.

- [ ] **Step 1: Write failing loading-state tests**

```js
it('keeps the category rail mounted for lazy live loading', () => {
  expect(shouldUseGlobalCatalogLoader({ lazyCatalogEnabled: true, kind: 'live' })).toBe(false);
});

it('uses snapshot preparation copy for a live snapshot page', () => {
  expect(describeStalkerCatalogLoading({
    kind: 'live',
    capabilities: { mode: 'bounded_live_snapshot' },
  })).toBe('Preparing live catalog for this provider');
});
```

In `stalker-connection-flow.test.jsx`, render the content view with live categories already present and a deferred live item promise. Assert that category labels remain visible while the empty-state spinner is shown, then resolve the promise and assert the returned channel appears.

- [ ] **Step 2: Run frontend focused tests to verify the new assertion fails**

Run:

```powershell
cd streamvault
npx vitest run tests/stalker-catalog-loading.test.js tests/stalker-connection-flow.test.jsx
```

Expected: FAIL because lazy live currently selects the global content loader.

- [ ] **Step 3: Use local category loading for every lazy Stalker kind**

Change the helper to:

```js
export function shouldUseGlobalCatalogLoader({ lazyCatalogEnabled = false, kind } = {}) {
  return !(lazyCatalogEnabled && ['live', 'vod', 'series'].includes(kind));
}
```

In `fetchStalkerChannels()`, after categories are loaded, set `catLoading` before `loadStalkerLiveCategoryItems()` and clear it in the existing `finally`. Do not clear `stalkerLiveCats` while the selected page waits. Pass the loading description from `describeStalkerCatalogLoading()` into the local loading state only after the capability response is available; before that, use `Loading live channels`.

Keep `beginContentLoad()` only for the initial connection-level catalog sequence. Category clicks and refreshes must use the local category loading state so the `cats` panel remains rendered.

- [ ] **Step 4: Run focused frontend tests**

Run:

```powershell
cd streamvault
npx vitest run tests/stalker-catalog-loading.test.js tests/stalker-connection-flow.test.jsx tests/stalker-category-navigation.test.jsx
```

Expected: PASS.

- [ ] **Step 5: Commit frontend loading behavior**

```powershell
git add streamvault/src/stalker-catalog-loading.js streamvault/src/App.jsx streamvault/tests/stalker-catalog-loading.test.js streamvault/tests/stalker-connection-flow.test.jsx
git commit -m "fix(stalker): keep live categories visible during snapshot loading"
```

### Task 6: Regression, Browser Smoke Coverage, and Operational Documentation

**Files:**

- Modify: `streamvault/e2e/stalker-lazy-flow.spec.js`
- Modify: `docs/stalker-vs-xtream-lazy-loading-notes.md`
- Modify: `README.md` only if the existing release verification command changes.

**Consumes:** Tasks 1 through 5.

**Produces:** A reproducible regression gate and current operational guidance for compatibility fallback, metrics, and rollback.

- [ ] **Step 1: Add a Playwright route-interception test**

Add a test that mocks:

```js
await page.route('**/stalker/catalog/v1/categories**', route => route.fulfill({
  contentType: 'application/json',
  body: JSON.stringify({ kind: 'live', categories: [
    { id: 'all', title: 'All', aggregate: true },
    { id: '3010', title: 'Sports', aggregate: false },
  ] }),
}));

await page.route('**/stalker/catalog/v1/items**', route => {
  const url = new URL(route.request().url());
  const category = url.searchParams.get('category');
  return route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      kind: 'live', category, items: [{ id: '1', name: 'Sports One', type: 'live', playRef: 'svopaque:test' }],
      page: 1, pageSize: 100, hasMore: false, nextPage: null,
      capabilities: { pagination: 'unsupported', mode: 'bounded_live_snapshot', search: 'unknown' },
    }),
  });
});
```

Assert categories remain visible, selecting `Sports` requests only the versioned items endpoint, and no request path contains `/stalker/channels`.

- [ ] **Step 2: Run the focused E2E test**

Run:

```powershell
cd streamvault
npx playwright test e2e/stalker-lazy-flow.spec.js
```

Expected: PASS.

- [ ] **Step 3: Update operational notes**

Add a `Live provider compatibility fallback` section to `docs/stalker-vs-xtream-lazy-loading-notes.md` that states:

```markdown
- Empty `get_ichannels_via_api` page one is not a valid empty catalog when live genres exist.
- The backend switches only live catalogs to `bounded_live_snapshot` and streams one shared `get_all_channels` scan.
- VOD and series do not receive a full-catalog fallback.
- Snapshot mode is cached with live metadata for 30 days; completed zero-result fallbacks are negative-cached for five minutes.
- Manual live refresh clears pages, capability state, active snapshot work, and negative cache for the selected connection identity.
- Monitor `stalker_live_snapshot_compatibility_*`, provider cooldowns, rate limits, CPU, RSS, and event-loop latency.
```

- [ ] **Step 4: Run the complete release gate**

Run:

```powershell
cd stalker-proxy
npm test

cd ..\streamvault
npm test
npm run lint
$env:VITE_SECURE_APP_BASE_URL='https://sandbox.portalheaven.stream'
$env:VITE_RELEASE_COMMIT=(git rev-parse HEAD)
$env:VITE_STALKER_LAZY_CATALOG_ENABLED='true'
npm run build
npx playwright test e2e/stalker-lazy-flow.spec.js
```

Expected: all tests pass, lint reports zero errors, the build emits `dist/release.json`, and Playwright confirms the lazy route contract.

- [ ] **Step 5: Perform sandbox-only manual smoke verification**

Use the known incompatible test portal only in sandbox:

```text
portal: http://main.light-ott.net:80/c
MAC: 00:1A:79:48:E5:50
```

Verify:

1. Connection validation reports active and reachable.
2. Live categories load.
3. `All` and two real categories load channel pages when the provider returns channels.
4. Browser network shows `/stalker/catalog/v1/categories` and `/stalker/catalog/v1/items`, never `/stalker/channels`.
5. Switching categories during first load creates one shared `get_all_channels` scan in sandbox logs.
6. A manual refresh clears the snapshot and starts one new scan.
7. VOD, series, a provider-page-compatible Stalker portal, an Xtream connection, and content-session login still work.

- [ ] **Step 6: Commit tests and documentation**

```powershell
git add streamvault/e2e/stalker-lazy-flow.spec.js docs/stalker-vs-xtream-lazy-loading-notes.md README.md
git commit -m "test(stalker): cover live catalog compatibility fallback"
```

If `README.md` was not changed, omit it from `git add`.

## Final Review Checklist

- [x] **AC-1**: The Task 3 empty-page compatibility test returns snapshot channels for a real category.
- [x] **AC-2**: The Task 3 concurrent `all` plus real-category test observes exactly one `portalFetchChannelCatalog` call.
- [x] **AC-3**: Shared snapshot waiters release matching pages before the full scan completes when enough items are indexed.
- [x] **AC-4**: Snapshot storage receives streamed items through chunk APIs; no route-level array collects the full catalog.
- [x] **AC-5**: The provider-page-success test asserts no `portalFetchChannelCatalog` call.
- [x] **AC-6**: Terminal provider errors suppress snapshot scans and preserve structured errors.
- [x] **AC-7**: Refresh generation checks reject stale publication and invalidate active snapshot state.
- [x] **AC-8**: Lazy-disabled behavior and existing VOD/series route paths remain covered by regression tests.
- [x] **AC-9**: Cache writes and metrics use normalized items and hashed identity keys.
- [ ] **AC-10**: Automated backend/frontend tests, lint, and production build PASS. BLOCKED: sandbox-only manual smoke verification was not run in this local session.
- [x] Confirm live provider-page success never calls `get_all_channels`.
- [x] Confirm incompatible live categories join the same identity-only snapshot build.
- [x] Confirm fallback suppression paths do not start a scan.
- [x] Confirm completed zero-channel fallback is negative-cached for five minutes and does not persist snapshot mode.
- [x] Confirm the frontend leaves categories visible during live snapshot loading.
- [ ] Inspect `git diff --check` and `git status --short` before deployment.
- [ ] Deploy to sandbox only after all release-gate commands pass; do not deploy to media production in this plan.

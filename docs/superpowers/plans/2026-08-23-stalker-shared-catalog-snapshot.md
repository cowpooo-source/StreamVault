# Stalker Shared Catalog Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cache lazy Stalker catalog metadata for 48 hours and make unsupported live portals perform one shared bounded scan per connection instead of one scan per selected category.

**Architecture:** Keep provider-page portals on the existing `/stalker/catalog/v1/items` page path. When a live portal returns an empty provider-specific page, persist `bounded_live_snapshot` capability and build one connection-scoped streaming snapshot. Store fixed-size global channel chunks and small category reference chunks in SQLite; all category/page requests read those chunks and join the same build. Browser IndexedDB remains an owner-scoped metadata cache only.

**Tech Stack:** Node.js 22, Express 4, better-sqlite3, React 19, IndexedDB, Vitest, Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-23-stalker-catalog-cache-and-snapshot-design.md`

## Global Constraints

- Preserve the current non-lazy Stalker routes and behavior when `STALKER_LAZY_CATALOG_ENABLED` or `VITE_STALKER_LAZY_CATALOG_ENABLED` is disabled.
- Do not cache resolved media URLs, `playRef`, raw commands, portal URLs, MACs, passwords, content tokens, or search text in browser records, cache keys, metrics, or logs.
- Keep direct playback, opaque command expiry, provider cooldowns, content-session authentication, SSRF protections, and relay limits unchanged.
- Live snapshot scans have a hard cap of 50,000 items and may not build one 50,000-item JavaScript array or one large SQLite JSON value.
- VOD and series must remain provider-page-only and must never use a full-catalog fallback.
- Use 48-hour TTLs only for lazy catalog metadata. Do not change TTLs used by legacy Stalker endpoints.
- Use test-first development: add a failing test, run it and confirm the expected failure, implement the smallest code change, then rerun focused tests before proceeding.
- Do not commit or deploy automatically. Preserve all unrelated working-tree changes.

---

## File Structure

- `stalker-proxy/src/services/stalkerLiveSnapshot.js`: connection-scoped live snapshot keys, fixed chunks, category reference chunks, build waiters, and manifest access.
- `stalker-proxy/src/routes/stalker.js`: chooses provider-pages versus snapshot mode, invokes the snapshot service, and applies lazy-only TTLs.
- `stalker-proxy/src/services/stalkerCatalogCapabilities.js`: persists 48-hour pagination capability state.
- `stalker-proxy/src/utils/proxyHelpers.js`: continues streaming `get_all_channels`; exposes records to the snapshot writer without retaining arrays.
- `stalker-proxy/tests/stalker-live-snapshot.test.js`: pure snapshot service behavior using an in-memory cache fake.
- `stalker-proxy/tests/stalker-router.test.js`: route-level mode selection, coalescing, and legacy-flag regressions.
- `streamvault/src/stalker-catalog-cache.js`: 48-hour browser metadata TTLs; retains owner/connection isolation and quota enforcement.
- `streamvault/src/stalker-catalog-loading.js`: loading-state helpers for snapshot preparation.
- `streamvault/src/App.jsx`: snapshot-aware loading copy and category requests without duplicate visible loads.
- `streamvault/tests/stalker-catalog-cache.test.js`: browser TTL and persisted-record safety tests.
- `streamvault/tests/stalker-catalog-loading.test.js`: loading-state copy tests.

---

### Task 1: Add Lazy-Only 48-Hour TTL Policy

**Files:**
- Modify: `stalker-proxy/src/routes/stalker.js`
- Modify: `stalker-proxy/src/services/stalkerCatalogCapabilities.js`
- Modify: `streamvault/src/stalker-catalog-cache.js`
- Test: `stalker-proxy/tests/stalker-catalog-services.test.js`
- Test: `streamvault/tests/stalker-catalog-cache.test.js`

**Interfaces:**
- Produces `LAZY_CATALOG_TTL = { live: 48h, content: 48h, categories: 48h }` used only by `/stalker/catalog/v1/*`.
- Produces `TTL_MS = 48h` for `createCatalogCapabilities`.
- Produces `LIVE_TTL = CONTENT_TTL = 48h` for browser lazy pages and categories.

- [ ] **Step 1: Add backend TTL tests before changing constants**

```js
it('keeps lazy live pages for 48 hours without changing legacy catalog TTLs', async () => {
  const { LAZY_CATALOG_TTL, CATALOG_TTL } = require('../src/routes/stalker');
  expect(LAZY_CATALOG_TTL.live).toBe(48 * 60 * 60_000);
  expect(CATALOG_TTL.channels).toBe(6 * 60 * 60_000);
});

it('keeps catalog capabilities for 48 hours', () => {
  expect(TTL_MS).toBe(48 * 60 * 60_000);
});
```

- [ ] **Step 2: Run the focused backend test and confirm it fails because `LAZY_CATALOG_TTL` is absent and capability TTL is still 24 hours**

Run: `cd stalker-proxy; npm test -- tests/stalker-catalog-services.test.js`

Expected: FAIL on the new TTL assertions.

- [ ] **Step 3: Add browser cache TTL tests before changing constants**

```js
it('keeps live and content metadata fresh for 48 hours', () => {
  expect(LIVE_TTL).toBe(48 * 60 * 60 * 1000);
  expect(CONTENT_TTL).toBe(48 * 60 * 60 * 1000);
});
```

- [ ] **Step 4: Run the focused browser test and confirm it fails at the current 30-minute/6-hour values**

Run: `cd streamvault; npm test -- tests/stalker-catalog-cache.test.js`

Expected: FAIL on the new TTL assertions.

- [ ] **Step 5: Implement lazy-only TTL constants**

```js
const LAZY_CATALOG_TTL = Object.freeze({
  live: 48 * 60 * 60_000,
  content: 48 * 60 * 60_000,
  categories: 48 * 60 * 60_000,
});
```

Use `LAZY_CATALOG_TTL` only at `/catalog/v1/categories`, `/catalog/v1/items`, and `/catalog/v1/search` cache writes. Keep existing `CATALOG_TTL` for legacy route cache writes. Set `stalkerCatalogCapabilities.TTL_MS`, `LIVE_TTL`, and `CONTENT_TTL` to `48 * 60 * 60 * 1000`.

- [ ] **Step 6: Run focused tests and confirm they pass**

Run: `cd stalker-proxy; npm test -- tests/stalker-catalog-services.test.js`

Run: `cd streamvault; npm test -- tests/stalker-catalog-cache.test.js`

Expected: PASS.

- [ ] **Step 7: Commit the isolated TTL change**

```bash
git add stalker-proxy/src/routes/stalker.js stalker-proxy/src/services/stalkerCatalogCapabilities.js stalker-proxy/tests/stalker-catalog-services.test.js streamvault/src/stalker-catalog-cache.js streamvault/tests/stalker-catalog-cache.test.js
git commit -m "feat: retain lazy Stalker catalog metadata for 48 hours"
```

### Task 2: Create Connection-Scoped Streaming Snapshot Storage

**Files:**
- Create: `stalker-proxy/src/services/stalkerLiveSnapshot.js`
- Create: `stalker-proxy/tests/stalker-live-snapshot.test.js`

**Interfaces:**
- `createLiveSnapshotStore({ cache, ttlMs, chunkSize = 250, maxItems = 50_000 })`.
- `begin({ identityHash, generation })` returns `{ append({ item, categoryId }), complete(), fail(error), waitForPage({ category, page, pageSize, signal }), readPage({ category, page, pageSize }), isBuilding() }`.
- `append({ item, categoryId })` writes one global item chunk and one category-reference chunk incrementally; `item` is already normalized through `mapCatalogItem`, so it contains an encrypted `_catalogPlayRef` and never a raw command.
- `waitForPage` resolves when the requested category has enough references or the build completes. Its page contract has `items`, `hasMore`, `nextPage`, `total`, `totalKnown`, and `complete`.

- [ ] **Step 1: Write failing tests for fixed chunks and category lookup**

```js
it('writes channels in fixed chunks and reads a category page without retaining all items', async () => {
  const cache = createCacheFake();
  const snapshots = createLiveSnapshotStore({ cache, ttlMs: 1_000, chunkSize: 2 });
  const build = snapshots.begin({ identityHash: 'connection-a-hash', generation: 1 });

  await build.append({ item: { id: '1', name: 'One' }, categoryId: 'sports' });
  await build.append({ item: { id: '2', name: 'Two' }, categoryId: 'news' });
  await build.append({ item: { id: '3', name: 'Three' }, categoryId: 'sports' });
  await build.complete();

  await expect(build.readPage({ category: 'sports', page: 1, pageSize: 100 }))
    .resolves.toMatchObject({ items: [{ id: '1' }, { id: '3' }], total: 2, complete: true });
  expect(cache.values()).not.toContainEqual(expect.arrayContaining([{ id: '1' }, { id: '2' }, { id: '3' }]));
});
```

- [ ] **Step 2: Add a failing test that concurrent categories join one build**

```js
it('shares one build for different live categories of the same connection', async () => {
  const snapshots = createLiveSnapshotStore({ cache: createCacheFake(), ttlMs: 1_000, chunkSize: 2 });
  const first = snapshots.begin({ identityHash: 'connection-a-hash', generation: 1 });
  const second = snapshots.begin({ identityHash: 'connection-a-hash', generation: 1 });

  expect(second).toBe(first);
});
```

- [ ] **Step 3: Run the snapshot tests and confirm they fail because the module does not exist**

Run: `cd stalker-proxy; npm test -- tests/stalker-live-snapshot.test.js`

Expected: FAIL with module-not-found.

- [ ] **Step 4: Implement bounded global and category-reference chunks**

```js
const itemKey = (identityHash, generation, chunk) => `stalker-live-snapshot-v1|${identityHash}|${generation}|items|${chunk}`;
const refsKey = (identityHash, generation, category, chunk) => `stalker-live-snapshot-v1|${identityHash}|${generation}|refs|${hashPart(category)}|${chunk}`;
const manifestKey = identityHash => `stalker-live-snapshot-v1|${identityHash}|manifest`;
```

Store global items in chunks of at most 250. For every item, append `{ chunk, index }` to its category reference chunk. Read `all` from global item chunks and a named category from reference chunks. The in-memory build state may hold only the active global chunk, active reference chunks for categories encountered in that chunk, counters, and unresolved page waiters. Flush a full chunk with `cache.set(key, value, ttlMs)` and clear it before accepting more records.

- [ ] **Step 5: Add failing tests for early page release, end-of-build completion, failure cleanup, and 50,000 cap**

```js
it('resolves a waiting category page once it has pageSize plus one references', async () => {
  const build = createLiveSnapshotStore({ cache: createCacheFake(), ttlMs: 1_000, chunkSize: 2 }).begin({ identityHash: 'a', generation: 1 });
  const page = build.waitForPage({ category: 'sports', page: 1, pageSize: 2 });
  await build.append({ item: { id: '1' }, categoryId: 'sports' });
  await build.append({ item: { id: '2' }, categoryId: 'sports' });
  await build.append({ item: { id: '3' }, categoryId: 'sports' });
  await expect(page).resolves.toMatchObject({ items: [{ id: '1' }, { id: '2' }], hasMore: true, complete: false });
});
```

- [ ] **Step 6: Implement waiters, cleanup, and manifest publication**

Only publish the manifest after `complete()`. On `fail(error)` delete every recorded chunk key and reject all waiters. At 50,000 accepted items, stop accepting new records, mark the manifest `truncated: true`, and finish cleanly. A request after completion returns `totalKnown: true`; an early request returns `total: null`, `totalKnown: false`, and `complete: false`.

- [ ] **Step 7: Run snapshot tests and commit**

Run: `cd stalker-proxy; npm test -- tests/stalker-live-snapshot.test.js`

Expected: PASS.

```bash
git add stalker-proxy/src/services/stalkerLiveSnapshot.js stalker-proxy/tests/stalker-live-snapshot.test.js
git commit -m "feat: store bounded shared live Stalker snapshots"
```

### Task 3: Select Snapshot Mode Immediately and Coalesce Provider Work

**Files:**
- Modify: `stalker-proxy/src/routes/stalker.js`
- Modify: `stalker-proxy/src/utils/proxyHelpers.js`
- Test: `stalker-proxy/tests/stalker-router.test.js`

**Interfaces:**
- Uses `createLiveSnapshotStore` from Task 2.
- Adds `isEmptyLiveProviderPage(payload)` that checks `itemsFromPayload(payload).length === 0`.
- Adds `buildOrJoinLiveSnapshot({ session, identityHash, binding, signal })`, which calls `portalFetchChannelCatalog` once with `onItem: snapshot.append`.

- [ ] **Step 1: Add a failing route test for empty live provider pages**

```js
it('builds one shared snapshot when two categories receive empty provider pages', async () => {
  const deps = makeDeps({
    portalFetchRetry: vi.fn().mockResolvedValue({ js: { data: [] } }),
    portalFetchChannelCatalog: vi.fn(async (_session, _limit, _timeout, { onItem }) => {
      await onItem({ id: '1', tv_genre_id: '1164', cmd: 'ffmpeg http://one' });
      await onItem({ id: '2', tv_genre_id: '1478', cmd: 'ffmpeg http://two' });
      return 2;
    }),
  });
  const app = makeApp(deps);

  const [first, second] = await Promise.all([
    request(app).get('/stalker/catalog/v1/items?kind=live&category=1164&page=1&pageSize=100'),
    request(app).get('/stalker/catalog/v1/items?kind=live&category=1478&page=1&pageSize=100'),
  ]);

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(deps.portalFetchChannelCatalog).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Add a failing regression test for provider-page portals**

```js
it('keeps a non-empty provider live page on provider_pages mode', async () => {
  const deps = makeDeps({
    portalFetchRetry: vi.fn().mockResolvedValue({ js: { data: [{ id: '1', tv_genre_id: '1164', cmd: 'ffmpeg http://one' }] } }),
    portalFetchChannelCatalog: vi.fn(),
  });
  const response = await request(makeApp(deps)).get('/stalker/catalog/v1/items?kind=live&category=1164&page=1&pageSize=100');

  expect(response.status).toBe(200);
  expect(response.body.capabilities.mode).toBe('provider_pages');
  expect(deps.portalFetchChannelCatalog).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run route tests and confirm the shared-scan assertion fails**

Run: `cd stalker-proxy; npm test -- tests/stalker-router.test.js`

Expected: FAIL because different category fallbacks invoke separate catalog streams.

- [ ] **Step 4: Replace category-scoped fallback with one connection-scoped snapshot**

When `fetchCatalogProviderPage` returns an empty live page, record `pagination: 'unsupported', mode: 'bounded_live_snapshot'` immediately. Do not make the page-two pagination probe. Call `buildOrJoinLiveSnapshot` with `catalogIdentityHash({ portal, mac, serial, deviceId, deviceId2 })`. Its work key must be `${identityHash}|live|generation:${generation}` and must not contain category or page size. Use `portalFetchChannelCatalog(..., 50_000, ..., { signal, onItem: raw => snapshot.append({ item: mapCatalogItem('live', raw, binding), categoryId: raw.tv_genre_id ?? raw.genre_id ?? raw.category_id ?? raw.group_id ?? 'all' }) })`.

Serve the current category through `snapshot.waitForPage`. Use the existing `mapCatalogItem` only when materializing the requested response so short-lived protected `playRef` values are generated for that response and never persisted in chunks.

- [ ] **Step 5: Preserve error and abort behavior with failing tests**

```js
it('does not start snapshot fallback after a rate limit', async () => {
  const deps = makeDeps({
    portalFetchRetry: vi.fn().mockRejectedValue(Object.assign(new Error('429'), { status: 429, code: 'RATE_LIMITED' })),
    portalFetchChannelCatalog: vi.fn(),
  });
  const response = await request(makeApp(deps)).get('/stalker/catalog/v1/items?kind=live&category=1164&page=1&pageSize=100');

  expect(response.status).toBe(429);
  expect(deps.portalFetchChannelCatalog).not.toHaveBeenCalled();
});
```

- [ ] **Step 6: Implement snapshot-safe error handling**

Preserve `canUseLiveCatalogFallback` for determining whether a fallback is allowed. For `401`, `403`, `429`, `ABORT_ERR`, provider cooldown, authorization failure, or metadata-queue rejection: return the structured existing error and do not create a snapshot. If a snapshot build fails, remove its chunks and return the error to all waiting requests.

- [ ] **Step 7: Run focused backend tests and commit**

Run: `cd stalker-proxy; npm test -- tests/stalker-router.test.js tests/proxyHelpers.test.js tests/stalker-live-snapshot.test.js`

Expected: PASS.

```bash
git add stalker-proxy/src/routes/stalker.js stalker-proxy/src/utils/proxyHelpers.js stalker-proxy/tests/stalker-router.test.js stalker-proxy/tests/proxyHelpers.test.js
git commit -m "fix: share unsupported Stalker live catalog scans"
```

### Task 4: Make Browser Cache and Loading UX Snapshot-Aware

**Files:**
- Modify: `streamvault/src/stalker-catalog-cache.js`
- Modify: `streamvault/src/stalker-catalog-loading.js`
- Modify: `streamvault/src/App.jsx`
- Test: `streamvault/tests/stalker-catalog-cache.test.js`
- Test: `streamvault/tests/stalker-catalog-loading.test.js`

**Interfaces:**
- `describeStalkerCatalogLoading({ kind, capabilities })` returns either normal loading copy or `Preparing live catalog for this provider`.
- Cached records retain `{ capabilities, refreshedAt }` and remain owner/connection scoped.

- [ ] **Step 1: Write a failing loading-copy test**

```js
it('labels bounded live snapshot preparation distinctly', () => {
  expect(describeStalkerCatalogLoading({
    kind: 'live',
    capabilities: { mode: 'bounded_live_snapshot' },
  })).toBe('Preparing live catalog for this provider');
});
```

- [ ] **Step 2: Run the test and confirm it fails because the helper is absent**

Run: `cd streamvault; npm test -- tests/stalker-catalog-loading.test.js`

Expected: FAIL with missing export.

- [ ] **Step 3: Implement the pure loading helper**

```js
export function describeStalkerCatalogLoading({ kind, capabilities } = {}) {
  if (kind === 'live' && capabilities?.mode === 'bounded_live_snapshot') {
    return 'Preparing live catalog for this provider';
  }
  if (kind === 'live') return 'Loading live channels';
  return kind === 'series' ? 'Loading series' : 'Loading movies';
}
```

- [ ] **Step 4: Update `App.jsx` to use the response capability and avoid duplicate visible loads**

Use `describeStalkerCatalogLoading` before and after the first response. Keep the current per-category `fetchingCatRef` guard. Do not start a browser-side prefetch loop, do not auto-click `Load more`, and do not invalidate a cached page merely because another category was selected. When a snapshot response reports `complete: false`, show loaded items normally and preserve its `hasMore` state.

- [ ] **Step 5: Add a failing browser-cache safety regression test**

```js
it('stores snapshot pages for 48 hours without playRef or raw command fields', async () => {
  const cache = await createStalkerCatalogCache({ indexedDBRef, ownerId: 'user:1', connection });
  await cache.putPage({ kind: 'live', category: '1164', page: 1, pageSize: 100, items: [{ id: '1', playRef: 'secret', cmd: 'ffmpeg http://secret' }] });
  const saved = await cache.getPage({ kind: 'live', category: '1164', page: 1, pageSize: 100 });

  expect(saved.items[0]).toEqual({ id: '1' });
  expect(saved.stale).toBe(false);
});
```

- [ ] **Step 6: Run focused frontend tests and commit**

Run: `cd streamvault; npm test -- tests/stalker-catalog-cache.test.js tests/stalker-catalog-loading.test.js`

Expected: PASS.

```bash
git add streamvault/src/stalker-catalog-cache.js streamvault/src/stalker-catalog-loading.js streamvault/src/App.jsx streamvault/tests/stalker-catalog-cache.test.js streamvault/tests/stalker-catalog-loading.test.js
git commit -m "feat: show shared Stalker snapshot loading state"
```

### Task 5: Add Sanitized Metrics and Full Regression Coverage

**Files:**
- Modify: `stalker-proxy/src/services/stalkerAuditMetrics.js`
- Modify: `stalker-proxy/src/routes/stalker.js`
- Modify: `stalker-proxy/tests/stalker-router.test.js`
- Modify: `streamvault/e2e/stalker-catalog.spec.js`
- Modify: `README.md`
- Modify: `docs/stalker-vs-xtream-lazy-loading-notes.md`

**Interfaces:**
- Metrics: `stalker_live_snapshot_started_total`, `stalker_live_snapshot_completed_total`, `stalker_live_snapshot_joined_total`, `stalker_live_snapshot_failed_total`, `stalker_live_snapshot_items_total`, `stalker_live_snapshot_duration_ms`.
- Metrics labels may contain only low-cardinality mode/result values; never connection identity, portal, MAC, command, or token.

- [ ] **Step 1: Write failing route metric tests**

```js
it('records one sanitized snapshot start and one join for concurrent categories', async () => {
  // Start two requests against the empty-provider-page fixture from Task 3.
  await Promise.all([firstRequest, secondRequest]);

  expect(stalkerMetrics.snapshot().stalker_live_snapshot_started_total).toBe(1);
  expect(stalkerMetrics.snapshot().stalker_live_snapshot_joined_total).toBe(1);
});
```

- [ ] **Step 2: Run the route tests and confirm metric assertions fail**

Run: `cd stalker-proxy; npm test -- tests/stalker-router.test.js`

Expected: FAIL because snapshot metrics are absent.

- [ ] **Step 3: Add metrics at actual build boundaries**

Increment `started` only when a new snapshot build begins; increment `joined` only when a request joins an existing build; increment `completed` after manifest publication; increment `failed` after cleanup; record item count and duration without sensitive labels. Do not increment metrics for browser cache hits or provider-page responses.

- [ ] **Step 4: Add deterministic Playwright coverage**

```js
test('switching unsupported live categories uses catalog responses without a second provider scan', async ({ page }) => {
  await mockUnsupportedLivePortal(page);
  await page.goto('/content');
  await expect(page.getByText('Preparing live catalog for this provider')).toBeVisible();
  await page.getByRole('button', { name: 'Sports' }).click();
  await expect(page.getByText('Sports One')).toBeVisible();
  expect(await providerCallCount('get_all_channels')).toBe(1);
});
```

Also add one provider-pages fixture that asserts no `get_all_channels` call, one VOD fixture that asserts only the selected page is requested, and one 429 fixture that asserts the snapshot never starts.

- [ ] **Step 5: Document behavior and rollback**

Document the 48-hour metadata TTL, 50,000 item cap, one-scan behavior, browser privacy rules, snapshot loading text, and rollback procedure: set `VITE_STALKER_LAZY_CATALOG_ENABLED=false` first, then `STALKER_LAZY_CATALOG_ENABLED=false` after frontend rollback is confirmed.

- [ ] **Step 6: Run complete verification**

Run: `cd stalker-proxy; npm test`

Run: `cd streamvault; npm run lint; npm test; $env:VITE_SECURE_APP_BASE_URL='https://media.portalheaven.stream'; npm run build`

Run: `cd streamvault; npx playwright test e2e/stalker-catalog.spec.js`

Expected: all commands PASS. If browser runtime or provider fixtures require credentials, mark only that command BLOCKED and report the exact missing dependency; do not weaken assertions.

- [ ] **Step 7: Review the diff before handoff**

Run: `git diff --check; git diff -- stalker-proxy/src/routes/stalker.js stalker-proxy/src/services/stalkerLiveSnapshot.js streamvault/src/stalker-catalog-cache.js streamvault/src/App.jsx`

Confirm: no raw provider credentials in cache keys, logs, metrics, or browser records; no legacy-route TTL change; no VOD/series aggregate fallback.

- [ ] **Step 8: Commit verified changes**

```bash
git add stalker-proxy/src/services/stalkerAuditMetrics.js stalker-proxy/src/routes/stalker.js stalker-proxy/tests/stalker-router.test.js streamvault/e2e/stalker-catalog.spec.js README.md docs/stalker-vs-xtream-lazy-loading-notes.md
git commit -m "test: verify shared lazy Stalker catalog snapshots"
```

## Acceptance Checklist

- [ ] Two simultaneous unsupported-live category requests result in one provider `get_all_channels` call.
- [ ] A completed snapshot serves category changes without provider calls for 48 hours.
- [ ] Live snapshot data is written as fixed chunks; no 50,000-item array or SQLite value exists.
- [ ] Provider-page live connections remain page-scoped.
- [ ] VOD and series remain page-scoped with no aggregate fallback.
- [ ] Browser records exclude sensitive playback and connection fields.
- [ ] Manual refresh, auth failure, connection edit, and deletion invalidate only affected metadata scopes.
- [ ] Lazy-disabled legacy behavior remains covered by tests.

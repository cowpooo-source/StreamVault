# Stalker Lazy Flow Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Stalker startup and section navigation genuinely lazy, prevent accidental aggregate catalog downloads, and make the deployed frontend/backend behavior reproducible.

**Architecture:** Treat category IDs as the canonical UI identity. Connection activation loads category metadata plus one non-aggregate Live page; VOD and Series item pages are deferred until their section is opened. Aggregate Live snapshot construction becomes an explicit, bounded operation rather than an automatic fallback, while legacy aggregate routes are gated by a client catalog-mode contract.

**Tech Stack:** React 19, Vite, Vitest, Express, Node.js, IndexedDB, PM2, nginx, Playwright.

**Spec:** `docs/stalker-vs-xtream-lazy-loading-notes.md`

## Global Constraints

- Preserve all existing working-tree changes; do not revert unrelated files.
- Keep `STALKER_LAZY_CATALOG_ENABLED` and `VITE_STALKER_LAZY_CATALOG_ENABLED` backward compatible.
- Legacy Stalker behavior must remain unchanged when lazy catalog mode is disabled.
- Do not change direct-play, playback-reference, content-session, or billing contracts unless a task explicitly requires it.
- Never select `all` or `*` implicitly for VOD or Series.
- A normal connection activation must not request VOD or Series item pages.
- A normal category click must make at most one provider page request after caches are considered; capability probing must not block the first page response.
- Provider metadata concurrency remains one active request per canonical Stalker identity.
- Implement test-first and commit after each task only when its focused tests pass.
- Do not deploy until the complete regression and release-gate task passes.

---

## File Structure

- Create `streamvault/src/stalker-category-selection.js`: canonical category normalization and non-aggregate selection helpers.
- Create `streamvault/src/stalker-import-validation.js`: bounded sequential import validation helper.
- Create `stalker-proxy/src/services/stalkerCatalogMode.js`: catalog-mode validation and legacy-route gating policy.
- Modify `streamvault/src/App.jsx`: deferred initialization, ID-based category state, refresh, and pagination wiring.
- Modify `streamvault/src/stalker-catalog-loading.js`: startup orchestration contract.
- Modify `stalker-proxy/src/routes/stalker.js`: category normalization, non-blocking probes, explicit snapshot fallback, and legacy-route gates.
- Modify release/deployment scripts or documentation discovered in Task 8 so one commit produces both frontend and backend artifacts.

### Task 1: Canonical Non-Aggregate Category Selection

**Files:**
- Create: `streamvault/src/stalker-category-selection.js`
- Create: `streamvault/tests/stalker-category-selection.test.js`
- Modify: `stalker-proxy/src/routes/stalker.js:961-1013`
- Test: `stalker-proxy/tests/stalker-router.test.js`

**Interfaces:**
- Produces frontend `normalizeStalkerCategory(category)` returning `{ id: string, title: string, count: number|null, aggregate: boolean }`.
- Produces frontend `firstBrowsableCategory(categories, { allowAggregate?: boolean })` returning a category or `null`.
- Backend category responses use canonical ID `all`, include `aggregate: true`, and contain at most one aggregate entry for all three kinds.

- [ ] **Step 1: Write failing frontend tests**

```js
import { describe, expect, it } from 'vitest';
import { firstBrowsableCategory, normalizeStalkerCategory } from '../src/stalker-category-selection.js';

describe('Stalker category selection', () => {
  it('normalizes star and All categories as aggregate', () => {
    expect(normalizeStalkerCategory({ id: '*', title: 'All' })).toMatchObject({ id: 'all', aggregate: true });
  });

  it('selects the first non-aggregate category', () => {
    expect(firstBrowsableCategory([
      { id: '*', title: 'All' },
      { id: '92', title: 'New Movies' },
    ])).toMatchObject({ id: '92', title: 'New Movies' });
  });

  it('returns null instead of implicitly selecting All', () => {
    expect(firstBrowsableCategory([{ id: '*', title: 'All' }])).toBeNull();
  });
});
```

- [ ] **Step 2: Run the frontend test and verify it fails**

Run: `cd streamvault && npm test -- --run tests/stalker-category-selection.test.js`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the frontend helpers**

```js
export function normalizeStalkerCategory(category = {}) {
  const rawId = String(category.id ?? category.category_id ?? '').trim();
  const title = String(category.title || category.name || 'Other').trim();
  const aggregate = rawId === '*' || rawId.toLowerCase() === 'all' || title.toLowerCase() === 'all';
  return {
    id: aggregate ? 'all' : rawId,
    title: aggregate ? 'All' : title,
    count: Number.isFinite(Number(category.count)) ? Number(category.count) : null,
    aggregate,
  };
}

export function firstBrowsableCategory(categories, { allowAggregate = false } = {}) {
  const normalized = (Array.isArray(categories) ? categories : []).map(normalizeStalkerCategory);
  return normalized.find(category => !category.aggregate)
    || (allowAggregate ? normalized.find(category => category.aggregate) : null)
    || null;
}
```

- [ ] **Step 4: Add backend tests for VOD/Series aggregate normalization**

Add route tests that return provider categories `*`, `all`, and a real category. Assert VOD and Series responses contain one canonical aggregate entry with `aggregate: true`, preserve the real category, and never return both `*` and `all`.

- [ ] **Step 5: Implement equivalent backend normalization once**

Create a local `normalizeCatalogCategories(raw, { includeSyntheticAll })` helper in `stalker.js`. Use it for Live, VOD, and Series. Live may prepend synthetic All; VOD/Series preserve provider All but deduplicate it.

- [ ] **Step 6: Run focused tests**

Run: `cd streamvault && npm test -- --run tests/stalker-category-selection.test.js`

Run: `cd stalker-proxy && npm test -- --run tests/stalker-router.test.js`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add streamvault/src/stalker-category-selection.js streamvault/tests/stalker-category-selection.test.js stalker-proxy/src/routes/stalker.js stalker-proxy/tests/stalker-router.test.js
git commit -m "fix(stalker): normalize aggregate catalog categories"
```

### Task 2: Defer VOD and Series Items Until Section Entry

**Files:**
- Modify: `streamvault/src/stalker-catalog-loading.js`
- Modify: `streamvault/src/App.jsx:2617-2692`
- Modify: `streamvault/src/App.jsx:2928-2953`
- Test: `streamvault/tests/stalker-catalog-loading.test.js`
- Test: `streamvault/tests/stalker-connection-flow.test.jsx`

**Interfaces:**
- `loadInitialStalkerCatalog({ loadLive, loadVodCategories, loadSeriesCategories, isCancelled })` loads Live first and category metadata only for VOD/Series.
- `loadStalkerCats(section, { force, selectInitial })` replaces positional booleans.

- [ ] **Step 1: Replace the orchestration test with the required call contract**

```js
it('does not load VOD or Series item pages during connection activation', async () => {
  const calls = [];
  await loadInitialStalkerCatalog({
    loadLive: async () => calls.push('live-items'),
    loadVodCategories: async () => calls.push('vod-categories'),
    loadSeriesCategories: async () => calls.push('series-categories'),
  });
  expect(calls).toEqual(['live-items', 'vod-categories', 'series-categories']);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `cd streamvault && npm test -- --run tests/stalker-catalog-loading.test.js`

- [ ] **Step 3: Change startup orchestration**

Update `loadInitialStalkerCatalog` to call `loadLive`, `loadVodCategories`, and `loadSeriesCategories` sequentially. In `App.jsx`, call `loadStalkerCats('vod', { selectInitial: false })` and the same for Series.

- [ ] **Step 4: Replace positional arguments**

Change:

```js
loadStalkerCats(sec, force, background)
```

to:

```js
loadStalkerCats(sec, { force = false, selectInitial = true } = {})
```

When `selectInitial` is false, update category state only. Never call `loadStalkerCatItems`.

- [ ] **Step 5: Add a component-level network contract test**

Mock `/catalog/v1/categories` and `/catalog/v1/items`. Activate a Stalker connection and assert:

```js
expect(requests).toContainEqual(expect.stringContaining('kind=live'));
expect(requests).not.toContainEqual(expect.stringContaining('kind=vod&category='));
expect(requests).not.toContainEqual(expect.stringContaining('kind=series&category='));
```

- [ ] **Step 6: Run focused tests**

Run: `cd streamvault && npm test -- --run tests/stalker-catalog-loading.test.js tests/stalker-connection-flow.test.jsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add streamvault/src/stalker-catalog-loading.js streamvault/src/App.jsx streamvault/tests/stalker-catalog-loading.test.js streamvault/tests/stalker-connection-flow.test.jsx
git commit -m "fix(stalker): defer vod and series item loading"
```

### Task 3: Store and Navigate Categories by ID

**Files:**
- Modify: `streamvault/src/App.jsx:2263-2295`
- Modify: `streamvault/src/App.jsx:2928-3105`
- Modify: `streamvault/src/App.jsx:3451-3465`
- Modify: `streamvault/src/App.jsx:4008-4178`
- Modify: `streamvault/src/App.jsx:4962-5060`
- Test: `streamvault/tests/stalker-category-navigation.test.jsx`

**Interfaces:**
- Add state `stalkerSelectedCategory = { live, vod, series }`, where each value is `{ id, title } | null`.
- `selectStalkerCategory(kind, category, { force?: boolean })` is the only category-click entry point.
- `loadNextStalkerPage(kind)` reads category ID directly from this state/ref and never defaults to `all`.

- [ ] **Step 1: Write tests for duplicate titles and missing selection**

Test two categories with title `Movies` and IDs `10` and `20`. Click ID `20` and assert the request contains `category=20`. Clear selection and assert `loadNextStalkerPage` makes no request rather than requesting `category=all`.

- [ ] **Step 2: Run the test and verify current title lookup fails**

Run: `cd streamvault && npm test -- --run tests/stalker-category-navigation.test.jsx`

- [ ] **Step 3: Add ID-backed selection state**

Keep display title separate from identity. Category elements use `key={category.id}` and call `selectStalkerCategory(section, category)` rather than mapping a title back to an ID.

- [ ] **Step 4: Make first section entry explicit**

On first VOD/Series section entry, use `firstBrowsableCategory(categories)`. If none exists, leave selection null and show `Select a category`; do not request All.

- [ ] **Step 5: Remove every implicit aggregate fallback**

Replace `category || 'all'` and title-based `.find(...)` in lazy pagination paths. If no selected ID exists, return without network activity and record a development warning.

- [ ] **Step 6: Run focused tests**

Run: `cd streamvault && npm test -- --run tests/stalker-category-navigation.test.jsx tests/VirtualGrid.test.jsx`

Expected: PASS, including no automatic pagination on initial render.

- [ ] **Step 7: Commit**

```bash
git add streamvault/src/App.jsx streamvault/tests/stalker-category-navigation.test.jsx
git commit -m "fix(stalker): key lazy category navigation by id"
```

### Task 4: Make Refresh Scope-Safe

**Files:**
- Modify: `streamvault/src/App.jsx:4818-4831`
- Modify: `streamvault/src/App.jsx:2928-3027`
- Test: `streamvault/tests/stalker-category-refresh.test.jsx`

**Interfaces:**
- `refreshStalkerSection(kind)` refreshes categories and only the currently selected real category.
- Refresh with no selected VOD/Series category refreshes category metadata only.

- [ ] **Step 1: Write failing refresh tests**

Assert that refreshing VOD with selected category `92` requests categories with `refresh=1` and items with `category=92&refresh=1`. Assert that refresh with no selection never requests `category=all`, `category=*`, `/stalker/vod?cat=*`, or `/stalker/series?cat=*`.

- [ ] **Step 2: Run and verify failure**

Run: `cd streamvault && npm test -- --run tests/stalker-category-refresh.test.jsx`

- [ ] **Step 3: Implement `refreshStalkerSection`**

Preserve category UI while loading. Invalidate only category metadata and the selected category page. Do not clear every VOD/Series item before refreshed data is available; replace the selected category atomically after success.

- [ ] **Step 4: Run focused tests**

Run: `cd streamvault && npm test -- --run tests/stalker-category-refresh.test.jsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add streamvault/src/App.jsx streamvault/tests/stalker-category-refresh.test.jsx
git commit -m "fix(stalker): scope lazy catalog refreshes"
```

### Task 5: Prevent Automatic Full Live Snapshot Builds

**Files:**
- Modify: `stalker-proxy/src/routes/stalker.js:350-443`
- Modify: `stalker-proxy/src/routes/stalker.js:1016-1129`
- Modify: `stalker-proxy/src/services/stalkerCatalogCapabilities.js`
- Test: `stalker-proxy/tests/stalker-live-snapshot.test.js`
- Test: `stalker-proxy/tests/stalker-router.test.js`

**Interfaces:**
- `fetchCatalogProviderPage` returns the requested provider page whenever possible.
- Unsupported pagination returns first-page-only mode for a real category without starting a global snapshot.
- Snapshot building is allowed only for explicit aggregate requests carrying `snapshot=1` or a dedicated internal global-search operation.

- [ ] **Step 1: Write a failing no-snapshot-on-category test**

Simulate a portal whose page endpoint repeats page one. Request `kind=live&category=1577&page=1`. Assert the response returns page-one items and `capabilities.mode === 'first_page_only'`; assert `portalFetchChannelCatalog` was not called.

- [ ] **Step 2: Write an explicit snapshot test**

Request `kind=live&category=all&page=1&pageSize=100&snapshot=1`. Assert one shared snapshot build starts and concurrent identical requests join it.

- [ ] **Step 3: Run and verify the first test fails**

Run: `cd stalker-proxy && npm test -- --run tests/stalker-live-snapshot.test.js tests/stalker-router.test.js`

- [ ] **Step 4: Change fallback policy**

For real category IDs, never call `buildOrJoinLiveSnapshot` automatically. Mark unsupported pagination and stop after the first provider page. Permit snapshots only when query validation accepts `snapshot=1`, the category is aggregate, and the caller explicitly requested it.

- [ ] **Step 5: Make capability probing non-blocking**

Return page one immediately. Queue the page-two probe through `metadataCoordinator` with a distinct deduplicated key. Cache the probe result and capability when it completes, but do not delay the browser response. Stop probing on 429 and honor provider cooldown.

- [ ] **Step 6: Run focused tests**

Run: `cd stalker-proxy && npm test -- --run tests/stalker-live-snapshot.test.js tests/stalker-catalog-services.test.js tests/stalker-router.test.js`

Expected: PASS; category page-one tests prove no full snapshot call.

- [ ] **Step 7: Commit**

```bash
git add stalker-proxy/src/routes/stalker.js stalker-proxy/src/services/stalkerCatalogCapabilities.js stalker-proxy/tests/stalker-live-snapshot.test.js stalker-proxy/tests/stalker-router.test.js
git commit -m "fix(stalker): require explicit live snapshot builds"
```

### Task 6: Pace Multi-Import Validation

**Files:**
- Create: `streamvault/src/stalker-import-validation.js`
- Create: `streamvault/tests/stalker-import-validation.test.js`
- Modify: `streamvault/src/App.jsx:4351-4429`

**Interfaces:**
- `validateImports(items, validateOne, { maxConcurrent = 1, signal, onProgress })` preserves input order.
- A response with `code` equal to `provider_cooldown` or `rate_limited` pauses further requests for that provider and returns structured skipped results.

- [ ] **Step 1: Write failing bounded-concurrency tests**

Use a deferred `validateOne` mock and assert active validations never exceed one. Add a 429 test proving subsequent items for the same normalized portal are not contacted and receive `{ valid: false, code: 'provider_cooldown', skipped: true }`.

- [ ] **Step 2: Run and verify failure**

Run: `cd streamvault && npm test -- --run tests/stalker-import-validation.test.js`

- [ ] **Step 3: Implement sequential validation**

Use an ordinary `for...of` loop; do not use `Promise.all`. Maintain a `Map` keyed by normalized provider origin for cooldown state. Report progress after each item.

- [ ] **Step 4: Wire `handleImportMultiple`**

Replace `Promise.all(items.map(validateImportItem))` with `validateImports`. Display the existing import-issues dialog with the provider cooldown duration when present.

- [ ] **Step 5: Run focused tests**

Run: `cd streamvault && npm test -- --run tests/stalker-import-validation.test.js tests/Setup.test.jsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add streamvault/src/stalker-import-validation.js streamvault/tests/stalker-import-validation.test.js streamvault/src/App.jsx
git commit -m "fix(stalker): pace imported connection validation"
```

### Task 7: Gate Legacy Aggregate Routes for Lazy Clients

**Files:**
- Create: `stalker-proxy/src/services/stalkerCatalogMode.js`
- Create: `stalker-proxy/tests/services/stalkerCatalogMode.test.js`
- Modify: `stalker-proxy/src/routes/stalker.js:1203-1307`
- Modify: `stalker-proxy/src/routes/stalker.js:1777-1835`
- Modify: `streamvault/src/stalker-catalog-api.js`
- Test: `stalker-proxy/tests/stalker-router.test.js`

**Interfaces:**
- Lazy frontend sends `X-StreamVault-Catalog-Mode: lazy-v1` on Stalker catalog requests.
- `catalogMode(req)` returns `lazy-v1` or `legacy`.
- Aggregate legacy routes return HTTP 409 `{ error, code: 'lazy_catalog_required' }` when called with `lazy-v1`.

- [ ] **Step 1: Write mode-policy unit tests**

Assert missing header means legacy, exact `lazy-v1` is accepted, and unknown values return 400 `invalid_catalog_mode`.

- [ ] **Step 2: Write route regression tests**

With lazy mode enabled and header `lazy-v1`, assert `/stalker/channels`, `/stalker/vod?cat=*`, and `/stalker/series?cat=*` return 409 without contacting the provider. Without the header, assert existing legacy behavior remains unchanged.

- [ ] **Step 3: Run and verify failure**

Run: `cd stalker-proxy && npm test -- --run tests/services/stalkerCatalogMode.test.js tests/stalker-router.test.js`

- [ ] **Step 4: Implement and wire the mode policy**

Do not globally remove legacy endpoints. Reject only aggregate legacy calls that identify as lazy-v1. Add a metric `stalker_lazy_legacy_route_blocked_total` with a route label from a fixed allowlist.

- [ ] **Step 5: Add the frontend header**

Set the header in `createStalkerCatalogApi` rather than at individual call sites. Add an API test asserting it is present.

- [ ] **Step 6: Run focused tests**

Run: `cd stalker-proxy && npm test -- --run tests/services/stalkerCatalogMode.test.js tests/stalker-router.test.js`

Run: `cd streamvault && npm test -- --run tests/stalker-catalog-api.test.js`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add stalker-proxy/src/services/stalkerCatalogMode.js stalker-proxy/tests/services/stalkerCatalogMode.test.js stalker-proxy/src/routes/stalker.js stalker-proxy/tests/stalker-router.test.js streamvault/src/stalker-catalog-api.js streamvault/tests/stalker-catalog-api.test.js
git commit -m "fix(stalker): gate legacy aggregate catalog routes"
```

### Task 8: Atomic Build, Observability, and Release Gate

**Files:**
- Modify: `deploy-vps.sh`
- Modify: `scripts/verify-release.ps1`
- Modify: `streamvault/public/sw.js`
- Modify: `README.md`
- Modify: `docs/stalker-vs-xtream-lazy-loading-notes.md`
- Create: `streamvault/e2e/stalker-lazy-flow.spec.js`

**Interfaces:**
- One release directory contains backend source and frontend assets built from the same Git commit.
- Release metadata file `release.json` contains `{ commit, builtAt, lazyCatalogFrontend, lazyCatalogBackend }`.
- Backend health response and frontend `<meta name="sv-release">` expose the same commit identifier.

- [ ] **Step 1: Add Playwright request-contract coverage**

Mock provider responses and cover:

1. Connect Stalker: Live first real category loads; VOD/Series item endpoints do not.
2. Open Movies: first non-All VOD category page loads once.
3. Open Series: first non-All Series category page loads once.
4. Refresh Movies: selected category refreshes; no aggregate or legacy URL appears.
5. Duplicate category titles: selected ID is preserved.
6. Provider 429: cooldown message appears and no automatic retries continue.

Capture requests and fail the test if any URL matches:

```js
/\/stalker\/(?:vod|series)\?[^ ]*cat=(?:\*|%2A)/i
/\/stalker\/channels\?/i
/\/stalker\/catalog\/v1\/items\?[^ ]*kind=(?:vod|series)[^ ]*category=(?:all|%2A|\*)/i
```

- [ ] **Step 2: Add atomic release metadata**

Build both applications from a clean checkout of one commit. Generate `release.json`; copy assets without manual byte edits. Fail deployment when frontend and backend release IDs differ.

- [ ] **Step 3: Add service-worker migration behavior**

Use a cache name derived from the release commit. On activation, delete older app-shell and script caches. Keep `/content` and Stalker API requests network-only.

- [ ] **Step 4: Document rollout and rollback**

Document environment variables, one-commit release layout, smoke tests, log queries for blocked legacy calls, rollback symlink procedure, and the requirement not to serve frontend assets from a separate historical release.

- [ ] **Step 5: Run all backend verification**

Run: `cd stalker-proxy && npm test`

Expected: all suites pass.

- [ ] **Step 6: Run all frontend verification**

Run: `cd streamvault && npm test`

Run: `cd streamvault && npm run lint`

Run: `cd streamvault && $env:VITE_SECURE_APP_BASE_URL='https://media.portalheaven.stream'; $env:VITE_STALKER_LAZY_CATALOG_ENABLED='true'; npm run build`

Expected: all tests pass, zero lint errors, production build succeeds.

- [ ] **Step 7: Run Playwright**

Run: `cd streamvault && npx playwright test e2e/stalker-lazy-flow.spec.js`

Expected: all lazy-flow request-contract cases pass.

- [ ] **Step 8: Review the complete diff**

Run: `git diff --check`

Run: `git status --short`

Verify only intended files are staged. Confirm no compiled bundle was manually edited and no provider credentials or content tokens appear in tests or docs.

- [ ] **Step 9: Commit the release gate**

```bash
git add deploy-vps.sh scripts/verify-release.ps1 streamvault/e2e/stalker-lazy-flow.spec.js streamvault/public/sw.js README.md docs/stalker-vs-xtream-lazy-loading-notes.md
git commit -m "test(stalker): enforce lazy catalog release contract"
```

## Acceptance Criteria

- [ ] **AC-01:** Connection activation makes no VOD or Series item request.
- [ ] **AC-02:** First VOD/Series entry selects the first non-aggregate category and requests page one only.
- [ ] **AC-03:** Refresh never implicitly requests `all`, `*`, or a legacy aggregate endpoint.
- [ ] **AC-04:** Duplicate category titles cannot change the selected category ID.
- [ ] **AC-05:** Missing category state cannot fall back to `all`.
- [ ] **AC-06:** A real Live category never starts a complete snapshot automatically.
- [ ] **AC-07:** Explicit aggregate snapshot requests are deduplicated, bounded, cached, and abortable.
- [ ] **AC-08:** Import validation never exceeds one active request per provider and stops on cooldown/rate limit.
- [ ] **AC-09:** Lazy clients are blocked from legacy aggregate routes; lazy-disabled clients retain legacy behavior.
- [ ] **AC-10:** Frontend and backend are built and deployed from the same commit without byte-patching compiled assets.
- [ ] **AC-11:** Backend, frontend, lint, build, and Playwright release-gate checks all pass.
- [ ] **AC-12:** No direct-play, playback-reference, authentication, guest, or content-session regression is introduced.

## Luna Execution Prompt

```text
Implement docs/superpowers/plans/2026-08-29-stalker-lazy-flow-hardening.md task-by-task.

Use test-driven development. Preserve every unrelated working-tree change. Do not deploy and do not rewrite history. Stop after each task, run its focused tests, review the diff against that task's interfaces and acceptance criteria, then commit only that task.

Important behavior:
- Lazy-disabled legacy behavior must remain unchanged.
- Never implicitly load VOD/Series All or *.
- Connection activation loads one real Live category page and VOD/Series category metadata only.
- Never start a full Live snapshot for a real category.
- Keep direct-play, content-session, playback-reference, auth, guest, and billing behavior unchanged.

Before reporting completion, run Task 8's complete release gate and report every acceptance criterion as PASS or BLOCKED: <reason>.
```

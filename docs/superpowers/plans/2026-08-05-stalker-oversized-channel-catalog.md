# Stalker Oversized Channel Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load oversized Stalker channel catalogs without raising the 50 MiB safety limit.

**Architecture:** Stream-parse `get_all_channels` with a hard item cap. Preserve buffered and paginated channel actions as compatibility fallbacks and normalize every successful path into the existing `/stalker/channels` response.

**Tech Stack:** Node.js 22, Express, Vitest, Supertest

## Global Constraints

- Never raise `STALKER_CHANNELS_MAX_BYTES` to solve this issue.
- Bound fallback output with `STALKER_CATALOG_MAX_ITEMS`.
- Preserve current caching, genre mapping, opaque command encoding, authentication, and abort behavior.
- Do not fall back for unrelated provider errors.

---

### Task 1: Add bounded oversized-catalog fallback

**Files:**
- Modify: `stalker-proxy/src/routes/stalker.js`
- Modify: `stalker-proxy/src/services/stalkerErrorClassifier.js`
- Test: `stalker-proxy/tests/stalker-router.test.js`

**Interfaces:**
- Consumes: `portalFetchRetry(session, params)` and `catalogItemLimit()`
- Produces: the unchanged `{ channels, total, refreshed_at }` route response

- [x] **Step 1: Write failing route tests**

Add route tests proving that a `Portal metadata response exceeds ... bytes` failure from `get_all_channels` invokes `get_ichannels_via_api` pages, combines their `js.data` arrays, and stops at the configured catalog limit. Add tests proving unrelated failures do not fall back and failed pagination yields `catalog_too_large`.

- [x] **Step 2: Run the focused tests and verify RED**

Run: `npm test -- stalker-router.test.js`

Expected: the oversized-catalog route test returns 502 instead of the combined channel response.

- [x] **Step 3: Implement the minimal fallback**

Add a size-error predicate and a bounded paginated channel loader in `stalker.js`. Call it only after `get_all_channels` fails with the bounded-reader error. Preserve the original error as the cause when pagination is unavailable.

- [x] **Step 4: Add the structured error classification**

Classify the terminal oversized-catalog condition as HTTP 502 with code `catalog_too_large`.

- [x] **Step 5: Run focused and full backend tests**

Run: `npm test -- stalker-router.test.js`

Run: `npm test`

Expected: all tests pass with zero failures.

- [x] **Step 6: Review the diff and commit**

Run: `git diff --check`

Commit the route, classifier, tests, design, and plan together after verification.

### Task 2: Add bounded streaming for portals that ignore pagination

**Files:**
- Modify: `stalker-proxy/package.json`
- Modify: `stalker-proxy/package-lock.json`
- Modify: `stalker-proxy/src/app.js`
- Modify: `stalker-proxy/src/routes/stalker.js`
- Modify: `stalker-proxy/src/utils/proxyHelpers.js`
- Test: `stalker-proxy/tests/proxyHelpers.test.js`
- Test: `stalker-proxy/tests/stalker-router.test.js`

- [x] **Step 1: Reproduce a portal that ignores channel pagination**

Verify that the portal reports a large `total_items`, leaves `cur_page` unchanged for `page` and `p`, and returns an empty `get_ichannels_via_api` body.

- [x] **Step 2: Add failing streaming and route tests**

Require the parser to stop at the requested item limit and require the route to use streaming before issuing the buffered request.

- [x] **Step 3: Implement bounded stream parsing**

Use `stream-json` to select `js.data`, collect at most `STALKER_CATALOG_MAX_ITEMS`, propagate request aborts, and close the upstream body at the limit.

- [x] **Step 4: Run focused and full backend tests**

Run `npm test -- tests/proxyHelpers.test.js`, `npm test -- tests/stalker-router.test.js`, and `npm test`.

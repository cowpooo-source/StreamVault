# Stalker Oversized Channel Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load oversized Stalker channel catalogs without raising the 50 MiB safety limit.

**Architecture:** Preserve `get_all_channels` as the primary compatibility path. On the specific bounded-reader size error, use `get_ichannels_via_api` pagination and normalize the collected items into the existing `/stalker/channels` response.

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

- [ ] **Step 6: Review the diff and commit**

Run: `git diff --check`

Commit the route, classifier, tests, design, and plan together after verification.

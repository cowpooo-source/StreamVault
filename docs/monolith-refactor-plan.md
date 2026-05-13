# Monolith Refactor Plan: Splitting index.js

## Objective
Split the massive `stalker-proxy/src/index.js` file into modular, testable routes to resolve the 4 remaining integration test failures ("The Mocking Wall"). The goal is to reach >80% backend coverage and enable robust dependency injection/mocking.

## Current Architecture Problem
`stalker-proxy/src/index.js` is over 1600 lines long. It currently handles Express configuration, global middleware, error handlers, AND all the business logic for `/proxy`, `/stream`, `/stalker/*`, `/api/tmdb/*`, etc. 
Because `index.test.js` imports `index.js`, it automatically spins up the whole monolith. When the test runner tries to mock `node-fetch` or `better-sqlite3`, the mocks either fail to apply or apply too late, causing 503 errors and integration failures.

## Execution Plan

### Phase 1: Shared Utilities
1. **`stalker-proxy/src/utils/proxyHelpers.js`**
   - Extract `isUrlAllowed`, `transferTimeout`, `SESSION_CACHE`, `getSession`, `portalFetchRetry`, `cacheKey`.
   - Export these so they can be consumed by the new route files.

### Phase 2: Extract General API Routes
1. **`stalker-proxy/src/routes/api.js`**
   - Move `/api/tmdb/*`, `/api/vast`, `/api/sync/*`, `/api/playback/*`.
   - Move proxy routes: `/proxy`, `/img`, `/stream`.
   - Import `fetch`, `cache`, `auth`, `proxyHelpers` as needed.

### Phase 3: Extract Stalker Routes
1. **`stalker-proxy/src/routes/stalker.js`**
   - Move all `/stalker/*` routes (`/stalker/handshake`, `/stalker/vod`, `/stalker/series`, `/stalker/live`, etc.).
   - Import `proxyHelpers` and `cache`.

### Phase 4: Refactor App Configuration
1. **`stalker-proxy/src/app.js`**
   - Create a clean `app.js` that ONLY configures Express (`cors`, `helmet`, `cookie-parser`).
   - Import and mount all routers (`authRoutes`, `ssoRoutes`, `analyticsRoutes`, `apiRoutes`, `stalkerRoutes`).
   - Export the un-listened `app` instance for testing.

### Phase 5: The New index.js
1. **`stalker-proxy/src/index.js`**
   - Import `app` from `app.js`.
   - Run `app.listen(PORT)` and handle graceful shutdown logic.

### Phase 6: Fix Tests
1. Refactor `index.test.js` and `routes.test.js` to import from `app.js` instead of `index.js`.
2. Ensure Supertest correctly hits the modular routes.
3. Run `npm run test` and verify the 4 failing integration tests now pass.
# Monolith Refactor Plan: Splitting `stalker-proxy/src/index.js`

## Objective

Split the large `stalker-proxy/src/index.js` Express monolith into smaller, testable modules without changing runtime behavior.

Primary goals:

- Keep production startup in `src/index.js`.
- Export an un-listened app from `src/app.js` for Supertest.
- Extract routes into focused routers.
- Use dependency injection where mocking matters.
- Restore passing integration tests.
- Make backend coverage easier to raise above 80%.

## Current Problem

`stalker-proxy/src/index.js` currently mixes:

- Express app creation.
- Middleware setup.
- Security configuration.
- Rate limits.
- Request analytics.
- Auth/session initialization.
- Timers and background jobs.
- `/api/*` routes.
- `/proxy`, `/img`, `/stream` routes.
- `/stalker/*` routes.
- Server startup and graceful shutdown.

Tests that import `src/index.js` load all of this at once. That makes mocking brittle because modules such as `node-fetch`, `better-sqlite3`, `cache`, and `auth` can be initialized before the test has control.

## Current Branch Repair Notes

The current partial extraction is not safe to build on until these are fixed:

- `stalker-proxy/src/routes/api.js` contains a literal `\nmodule.exports = router;\n` string and fails syntax check.
- `stalker-proxy/src/routes/stalker.js` contains corrupted copied text such as `router.ors");` and fails syntax check.
- `stalker-proxy/src/routes/stalker.js` appears to contain copied `index.js` app setup. A route module must not create its own Express app.
- `stalker-proxy/src/app.js` calls `app.get(...)` and `app.use(...)`, but currently lacks `const app = express()`.
- `stalker-proxy/src/app.js` imports many modules it does not use yet.

Before starting the refactor, either repair those files or replace them with clean minimal modules as described below.

## Target Architecture

```txt
stalker-proxy/src/
  index.js                    # production startup only
  app.js                      # createApp factory and middleware/router mounting
  cache.js
  auth.js
  email.js
  services/
    system.js
  utils/
    proxyHelpers.js
  routes/
    analytics.js
    auth.js
    sso.js
    api.js
    proxy.js
    playback.js
    stalker.js
```

Preferred module shape:

```js
function createSomeRouter(deps) {
  const router = require("express").Router();
  const { cache, auth, fetch } = deps;

  router.get("/example", async (req, res) => {
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createSomeRouter };
```

Use direct `module.exports = router` only for routers that do not need mocked dependencies.

## Refactor Rules

- Do not move all routes in one commit.
- Do not copy entire chunks blindly from `index.js`.
- Do not create `app` inside route modules.
- Do not call `app.listen()` outside `src/index.js`.
- Do not start intervals from `src/app.js`.
- Preserve route paths exactly.
- Preserve middleware order unless there is a specific reason to change it.
- Add or update tests after each route extraction.

## Phase 0: Stabilize The Current Branch

1. Run syntax checks:

   ```bash
   cd stalker-proxy
   node --check src/index.js
   node --check src/app.js
   node --check src/routes/api.js
   node --check src/routes/stalker.js
   ```

2. Replace corrupted route files with minimal valid placeholders:

   ```js
   const express = require("express");

   function createApiRouter() {
     const router = express.Router();
     return router;
   }

   module.exports = { createApiRouter };
   ```

3. Replace `src/app.js` with a valid app factory skeleton:

   ```js
   require("dotenv").config();
   const express = require("express");

   function createApp(deps) {
     const app = express();
     if (process.env.TRUST_PROXY !== "false") app.set("trust proxy", 1);

     app.get("/health", (req, res) => {
       res.json({ status: "ok", uptime: process.uptime() });
     });

     return app;
   }

   module.exports = { createApp };
   ```

4. Keep `src/index.js` unchanged until the app factory is proven with tests.

Exit criteria:

- All files pass `node --check`.
- Existing tests still run, even if the same integration tests fail as before.

## Phase 1: Extract Shared Utilities

Create or clean up `stalker-proxy/src/utils/proxyHelpers.js`.

Move only pure/shared helpers first:

- `transferTimeout`
- `agentFor`
- `isPrivateIP`
- `isUrlAllowedSync`
- `isUrlAllowed`
- `cacheKey`
- `summarizeUpstreamHeaders`
- `buildStalkerStreamHeaders`
- `safeError`

Be careful with stateful helpers:

- `SESSION_CACHE`
- `getSession`
- `portalFetchRetry`
- portal cooldown maps

Stateful helpers can live in `proxyHelpers.js`, but tests must be able to reset them. Export a test-only reset helper if needed:

```js
function resetProxyHelperStateForTests() {
  SESSION_CACHE.clear();
}
```

Validation:

```bash
cd stalker-proxy
node --check src/utils/proxyHelpers.js
npm run test -- tests/cache.test.js
```

## Phase 2: Build `createApp`

Move Express setup from `index.js` into `src/app.js`.

`createApp(deps)` should configure:

- `trust proxy`
- `cookieParser`
- CORS
- `passport.initialize()`
- Helmet
- Rate limits
- JSON body limits
- Compression
- request/visitor/guest tracking middleware
- portal usage tracking middleware
- health route
- router mounting

`createApp` must not:

- call `app.listen`
- call `auth.init`
- start `setInterval`
- call graceful shutdown handlers

Suggested shape:

```js
function createApp(deps = {}) {
  const app = express();
  const cache = deps.cache || require("./cache");
  const auth = deps.auth || require("./auth");
  const fetch = deps.fetch || require("node-fetch");

  configureMiddleware(app, { cache, auth });
  mountRoutes(app, { cache, auth, fetch });

  return app;
}

module.exports = { createApp };
```

Validation:

```bash
cd stalker-proxy
node --check src/app.js
```

Add a smoke test:

```js
const { createApp } = require("../src/app");

it("GET /health returns ok", async () => {
  const app = createApp();
  const res = await request(app).get("/health");
  expect(res.status).toBe(200);
});
```

## Phase 3: Slim Down `index.js`

After `createApp` works, reduce `src/index.js` to startup-only responsibilities:

- load environment
- create real dependencies
- call `auth.init(cache.db)`
- start cleanup intervals
- start bandwidth interval
- call `app.listen(PORT)`
- register graceful shutdown

Suggested shape:

```js
require("dotenv").config();
const { createApp } = require("./app");
const cache = require("./cache");
const auth = require("./auth");
const { trackDailyBandwidth } = require("./services/system");

const PORT = process.env.PORT || 3001;
const app = createApp({ cache, auth });

auth.init(cache.db);
setInterval(() => auth.cleanupSessions(), 60 * 60 * 1000);
setInterval(trackDailyBandwidth, 60000);

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`Proxy listening on ${PORT}`);
  });

  process.on("SIGTERM", () => server.close(() => process.exit(0)));
  process.on("SIGINT", () => server.close(() => process.exit(0)));
}

module.exports = app;
```

Validation:

```bash
cd stalker-proxy
node --check src/index.js
npm run test -- tests/index.test.js
```

Then update tests to import from `app.js`:

```js
const { createApp } = require("../src/app");
```

## Phase 4: Extract Simple API Routes First

Create `stalker-proxy/src/routes/api.js` for low-risk routes:

- `POST /api/track`
- `POST /api/feedback`
- `GET /api/feedback`
- `PUT /api/sync/:type`
- `GET /api/sync/:type`

Use a factory:

```js
function createApiRouter({ cache, auth }) {
  const router = express.Router();

  router.post("/api/track", (req, res) => {
    // existing behavior
  });

  return router;
}
```

Mount in `app.js`:

```js
app.use("/", createApiRouter({ cache, auth }));
```

Validation:

```bash
cd stalker-proxy
npm run test -- tests/index.test.js tests/routes.test.js
```

## Phase 5: Extract Playback Routes

Create `stalker-proxy/src/routes/playback.js`.

Move:

- `POST /api/playback/heartbeat`
- `GET /api/playback/summary`

Keep authentication resolution in one helper:

```js
function resolveUserId(req, auth) {
  const token = req.cookies?.sv_auth || req.headers.authorization?.slice(7);
  if (!token) return null;
  const user = auth.verifyToken(token);
  return user?.id || null;
}
```

Validation:

```bash
cd stalker-proxy
npm run test -- tests/index.test.js
```

Add tests for:

- heartbeat with guest id
- heartbeat with auth cookie
- heartbeat without identity returns 400
- summary without identity returns 401

## Phase 6: Extract Proxy And Media Routes

Create `stalker-proxy/src/routes/proxy.js`.

Move:

- `GET /proxy`
- `GET /img`
- `GET /stream`
- `OPTIONS /stream` if present
- VAST proxy route if it shares fetch/proxy behavior
- TMDB proxy route if it shares fetch/proxy behavior

Use injected `fetch`:

```js
function createProxyRouter({ fetch, cache, auth, proxyHelpers }) {
  const router = express.Router();
  return router;
}
```

This is where the mocking problem matters most. Tests should pass a fake fetch directly:

```js
const fetch = vi.fn();
const app = createApp({ fetch, cache: fakeCache, auth: fakeAuth });
```

Validation:

```bash
cd stalker-proxy
npm run test -- tests/index.test.js tests/routes.test.js
```

## Phase 7: Extract Stalker Routes Last

Create `stalker-proxy/src/routes/stalker.js`.

Move all `/stalker/*` routes only after simpler routes are stable.

Expected route groups:

- handshake
- live channels
- VOD categories/items
- series categories/items
- EPG
- Stalker stream resolution

Important:

- `stalker.js` must export `createStalkerRouter`.
- It must not call `express()`.
- It must not mount analytics/auth/sso routes.
- It must not call `app.listen`.
- It must not start timers.

Validation:

```bash
cd stalker-proxy
node --check src/routes/stalker.js
npm run test -- tests/routes.test.js
```

Add focused tests for:

- missing portal/mac validation
- invalid portal blocked by SSRF guard
- successful mocked handshake
- failed upstream returns controlled error
- category/item endpoint maps upstream response correctly

## Phase 8: Test Cleanup

Update tests so they no longer import `src/index.js` unless testing startup export behavior.

Preferred pattern:

```js
const { createApp } = require("../src/app");

function makeTestApp(overrides = {}) {
  return createApp({
    cache: fakeCache(),
    auth: fakeAuth(),
    fetch: vi.fn(),
    ...overrides,
  });
}
```

Keep one small test for `src/index.js`:

- importing it returns an app
- it does not call `listen` when imported by tests

Validation:

```bash
cd stalker-proxy
npm run test
npm run test -- --coverage
```

## Execution Checklist

Use this checklist for implementation commits:

1. Repair current broken route files to syntax-valid placeholders.
2. Add `createApp` skeleton and smoke test.
3. Move middleware from `index.js` to `app.js`.
4. Slim `index.js` to startup-only code.
5. Update tests to import `createApp`.
6. Extract simple API routes.
7. Extract playback routes.
8. Extract proxy/media routes.
9. Extract Stalker routes.
10. Remove duplicated dead code from `index.js`.
11. Run full backend test suite.
12. Run coverage.

## Done Criteria

The refactor is complete when:

- `node --check` passes for all backend source files.
- `npm run test` passes in `stalker-proxy`.
- Tests import `createApp` for integration coverage.
- `src/index.js` only starts the server and background jobs.
- `src/app.js` owns middleware and route mounting.
- Route modules export routers or router factories.
- No route module creates its own Express app.
- No duplicate route definitions remain in `index.js`.
- Coverage is above 80%, or remaining uncovered areas are documented.

## Suggested Commit Order

```txt
chore: repair backend route placeholders
refactor: add createApp factory for stalker proxy
refactor: move express middleware into app factory
refactor: make index startup-only
refactor: extract basic api routes
refactor: extract playback routes
refactor: extract proxy media routes
refactor: extract stalker routes
test: update backend integration tests for createApp
chore: remove dead monolith route code
```

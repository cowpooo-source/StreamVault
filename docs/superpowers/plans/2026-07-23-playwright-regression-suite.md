# Portal Heaven Automated Regression Suite

## Implementation Plan

**Date:** 2026-07-23  
**Target branch:** `feature/direct-play-no-proxy`  
**Primary application:** `streamvault`  
**Backend:** `stalker-proxy`

This document is the authoritative implementation plan for expanding the existing
Vitest, Supertest, and Playwright coverage into a repeatable release-validation
system. Implement the tasks in order. Do not deploy to production as part of this
plan.

## Objective

Reduce release validation from two or three days of manual testing to:

1. A deterministic automated regression run that completes in 10-15 minutes.
2. A staging smoke run that completes in 5 minutes.
3. A focused manual acceptance pass that completes in 15-30 minutes.

The suite must catch regressions in:

- Marketing versus application routing.
- Login, guest access, logout, and SSO error handling.
- Connection import, validation, persistence, switching, and disconnection.
- Direct HTTP content-session creation and hydration.
- Xtream, M3U, and Stalker catalog loading.
- Live, VOD, HLS, MPEG-TS, and native file playback selection.
- Playback recovery without reconnect loops.
- Browser console, service worker, and failed-network behavior.
- Non-production deployment routing and health.

## Existing Baseline

Reuse the existing infrastructure:

- `streamvault/playwright.config.js`
- `streamvault/e2e/playback.spec.js`
- `streamvault/e2e/direct-content.spec.js`
- Frontend Vitest tests in `streamvault/tests`
- Backend Vitest/Supertest tests in `stalker-proxy/tests`
- Local Docker gateway at `http://localhost:3201`
- Application route at `/app`
- Direct content route at `/content?token=...`
- Marketing route at `/`

Do not build a second test runner or duplicate backend integration coverage that
already exists in Supertest.

## Non-Negotiable Test Rules

- Normal CI tests must not call real IPTV providers.
- Provider credentials, MAC addresses, tokens, and stream URLs must never be
  committed to fixtures, snapshots, reports, screenshots, or traces.
- Every test must use an isolated browser context.
- Do not use fixed sleeps except when simulating an intentional media timeout.
- Prefer role, label, and visible-text selectors. Add `data-testid` only where the
  UI has no stable accessible selector.
- Mocked browser tests must fail on unexpected page errors, console errors,
  failed requests, and application API responses with status 400 or greater.
- Expected failures must be explicitly allowlisted by the individual test.
- Real-provider checks run only against staging and never block pull requests.
- Playwright must not write, delete, or alter production user data.
- Test-only authentication behavior must be gated by `NODE_ENV=test` or an
  explicit non-production environment variable. Never add a production bypass.

## Route Contract

The suite must treat these routes as distinct contracts:

| Route | Expected document | Purpose |
|---|---|---|
| `/` | Marketing `index.html` | Public landing page |
| `/app` | Application `app.html` | Login and setup |
| `/app/*` | Application `app.html` | App-compatible deep links |
| `/content?token=...` | Application `app.html` | HTTP direct-content mode |
| `/features` | `features.html` | Public marketing page |
| `/privacy` | `privacy.html` | Public policy page |
| Unknown route | 404 | No SPA fallback |

The secure return target for disconnect, switch connection, logout, expired
content session, and authentication failure is:

```text
https://media.portalheaven.stream/app
```

Local tests may use:

```text
http://localhost:3201/app
```

## Test Pyramid

### Frontend Unit and Component Tests

Use Vitest and Testing Library for:

- URL builders and routing policy.
- Connection normalization and validation.
- Stream classification.
- Playback state transitions.
- Retry counters and cancellation.
- React rendering and click behavior.

### Backend Contract Tests

Use Vitest and Supertest for:

- Authentication and authorization.
- Content-session lifecycle.
- Provider response normalization.
- Redirect and SSRF validation.
- Error response contracts.
- Timeout and abort handling.

### Browser End-to-End Tests

Use Playwright for:

- Real navigation and browser storage.
- Cross-screen user journeys.
- Connection setup and switching.
- Player engine selection.
- Browser errors and loading states.
- Staging deployment smoke checks.

## Proposed File Structure

Create or update:

```text
streamvault/
  e2e/
    fixtures/
      app.fixture.js
      auth.fixture.js
      console-monitor.js
      media-stubs.js
      provider-mocks.js
      storage.fixture.js
    helpers/
      assertions.js
      connection-builders.js
      route-builders.js
    auth.spec.js
    connection-import.spec.js
    connection-lifecycle.spec.js
    content-session.spec.js
    deployment-smoke.spec.js
    navigation.spec.js
    playback-hls.spec.js
    playback-mpegts.spec.js
    playback-native.spec.js
    playback-recovery.spec.js
    service-worker.spec.js
    stalker-playback.spec.js
    xtream-playback.spec.js
  playwright.config.js
  playwright.staging.config.js
  package.json
```

Keep the existing specs until their behavior has been migrated and verified.
Delete or consolidate them only in the final cleanup task.

---

# Task 1: Repair the Existing Playwright Baseline

## Files

- Modify `streamvault/playwright.config.js`
- Modify `streamvault/e2e/playback.spec.js`
- Modify `streamvault/e2e/direct-content.spec.js`
- Modify `streamvault/package.json`

## Required Changes

1. Replace hardcoded base URLs with:

```js
const baseURL = process.env.E2E_BASE_URL || "http://127.0.0.1:5173";
```

2. Keep the local Vite web server only when `E2E_BASE_URL` is absent.

3. Add:

```js
outputDir: "test-results/playwright",
reporter: [
  ["list"],
  ["html", { outputFolder: "playwright-report", open: "never" }],
],
use: {
  baseURL,
  trace: "retain-on-failure",
  screenshot: "only-on-failure",
  video: "retain-on-failure",
},
```

4. Set:

```js
fullyParallel: true
workers: process.env.CI ? 2 : undefined
```

5. Change app-flow navigation from `/` to `/app`.

6. Fix the malformed same-line assertion in `direct-content.spec.js`:

```js
expect(authMeRequests).toBe(0);
await expect(...);
```

7. Add package scripts:

```json
"e2e": "playwright test",
"e2e:headed": "playwright test --headed",
"e2e:debug": "playwright test --debug",
"e2e:report": "playwright show-report",
"verify": "npm run lint && npm test && npm run build && npm run e2e"
```

8. Do not add Firefox or WebKit yet. Stabilize Chromium first.

## Verification

```powershell
cd streamvault
npm run e2e
```

## Acceptance Criteria

- Existing Playwright specs pass from a clean browser context.
- `/app` is used for login/setup tests.
- `/content` remains the direct-content entry.
- A failed test creates a trace, screenshot, and video.

---

# Task 2: Add Shared Browser Error Monitoring

## Files

- Add `streamvault/e2e/fixtures/console-monitor.js`
- Add `streamvault/e2e/fixtures/app.fixture.js`
- Add `streamvault/e2e/helpers/assertions.js`

## Console Monitor Contract

Collect:

- `pageerror`
- `console.error`
- `requestfailed`
- Same-origin API responses with status 400 or greater
- Unhandled promise rejection messages

The monitor returns:

```js
{
  pageErrors: [],
  consoleErrors: [],
  failedRequests: [],
  badResponses: []
}
```

Add an assertion:

```js
assertNoUnexpectedBrowserErrors(errors, allowlist = [])
```

The allowlist entries must be exact strings or narrowly scoped regular
expressions. Do not globally ignore:

- 401
- 403
- 404
- CORS
- `ERR_BLOCKED_BY_ORB`
- `Failed to fetch`
- service-worker errors

For media providers, ignore expected browser failures only within the test that
is asserting fallback behavior.

## Fixture Behavior

Extend Playwright `test` with:

- `appPage`
- `browserErrors`
- `allowBrowserError`

After each test, automatically call `assertNoUnexpectedBrowserErrors`.

Do not fail on:

- Browser favicon requests.
- Deliberately aborted requests from a channel switch.
- A failure explicitly registered by the current test.

## Verification

Add a temporary test that emits `console.error` and verify Playwright fails.
Remove the temporary test before completing the task.

## Acceptance Criteria

- Unexpected runtime errors fail browser tests.
- Expected simulated failures can be narrowly allowlisted.
- Error output includes URL, method, status, and message without credentials.

---

# Task 3: Add Deterministic Auth Fixtures

## Files

- Add `streamvault/e2e/fixtures/auth.fixture.js`
- Add `streamvault/e2e/auth.spec.js`

## Required Mock Endpoints

Mock:

```text
GET  /api/auth/me
POST /api/auth/login
POST /api/auth/guest
POST /api/auth/logout
POST /api/auth/activate
POST /api/auth/reset-password
```

Create fixture helpers:

```js
mockAuthenticatedUser(page, overrides)
mockGuestUser(page, overrides)
mockLoggedOutUser(page)
mockTurnstile(page, { token: "e2e-turnstile-token" })
```

Use a fake user:

```js
{
  id: 9001,
  username: "e2e-user",
  role: "regular",
  maxConnections: 5
}
```

Do not persist a real password in the repository.

## Test Cases

1. `/app` displays login when `/api/auth/me` returns 401.
2. Valid login reaches setup.
3. Invalid login shows a readable error.
4. Guest login reaches setup.
5. Logout returns to `/app`.
6. `?error=sso_failed` displays the SSO error and cleans the URL.
7. `?error=email_exists` displays the account-linking message.
8. `?action=activate&token=test-token` displays activation behavior.
9. `?action=reset-password&token=test-token` displays reset behavior.
10. Turnstile unavailable shows the expected UI and does not throw.
11. Turnstile reset/remove is not called with an unknown widget.

## Acceptance Criteria

- Auth tests do not call Cloudflare.
- Auth tests do not call real OAuth providers.
- Query-parameter flows run under `/app`.
- No auth test depends on another test's cookies or storage.

---

# Task 4: Add Provider Mock Library

## Files

- Add `streamvault/e2e/fixtures/provider-mocks.js`
- Add `streamvault/e2e/helpers/connection-builders.js`
- Add `streamvault/e2e/helpers/route-builders.js`

## Connection Builders

Implement:

```js
buildXtreamConnection(overrides)
buildM3UConnection(overrides)
buildStalkerConnection(overrides)
```

All values must use reserved test domains:

```text
provider.test
media.test
portal.test
images.test
```

## Xtream Mock

Support:

```text
player_api.php
get_live_categories
get_live_streams
get_vod_categories
get_vod_streams
get_series_categories
get_series
xmltv.php
```

Allow scenarios:

```js
installXtreamMock(page, {
  auth: "valid" | "invalid" | "expired",
  delayMs: 0,
  malformedJson: false,
  emptyCatalog: false,
  catalogSize: 3,
});
```

## M3U Mock

Support:

- Basic playlist.
- `tvg-id`, `tvg-name`, `tvg-logo`, and `group-title`.
- HLS URL.
- TS URL.
- MP4 URL.
- Malformed playlist.
- Empty playlist.
- Large playlist generated in memory.

## Stalker Mock

Support:

```text
handshake
get_profile
get_main_info
get_genres
get_all_channels
get_ordered_list
create_link
get_epg_info
```

Allow scenarios:

```js
installStalkerMock(page, {
  handshake: "valid" | "unauthorized" | "rate-limited",
  createLink: "direct-hls" | "direct-ts" | "direct-file" | "relay" | "failure",
  redirects: [],
  catalogSize: 3,
});
```

## Security Requirements

- Mock request logs must redact `username`, `password`, `mac`, `token`, and
  `play_token`.
- Tests may inspect sanitized request summaries.
- Never snapshot raw URLs containing credentials.

## Acceptance Criteria

- Provider setup is one or two lines in each spec.
- Tests can simulate success, failure, timeout, and malformed responses.
- Fixtures do not require internet access.

---

# Task 5: Connection Setup and Import Tests

## Files

- Add `streamvault/e2e/connection-import.spec.js`
- Add `streamvault/e2e/connection-lifecycle.spec.js`
- Modify setup components only if stable selectors are missing.

## Add Test IDs Only If Needed

Preferred identifiers:

```text
setup-screen
connection-list
connection-card
switch-connection
disconnect-connection
import-submit
import-issues-dialog
content-loading
```

Prefer accessible names when they already exist.

## Test Cases

### Xtream

1. Add a valid Xtream connection.
2. Invalid credentials show validation failure.
3. Expired account does not enter content.
4. Connection label is visible after save.
5. Connection persists after reload.

### M3U

1. Add a URL playlist.
2. Paste raw M3U.
3. Import multiple detected connections.
4. Malformed M3U shows an error.
5. Imported connection opens the same content application, not `/player`.

### Stalker

1. Add a valid portal and MAC.
2. Failed handshake shows validation failure.
3. Saved connection persists after reload.

### Import

1. Import one valid connection.
2. Import two valid connections.
3. Mixed valid/invalid import displays:

```text
Import Issues Found
1 of 2 connections failed validation
```

4. Account connection limits are enforced.
5. Export contains all saved connections, not only the active connection.
6. Import restores exported connections.

### Lifecycle

1. Open connection from setup.
2. Open switch-connection UI.
3. Saved connection list is complete.
4. Switch connection returns to:

```text
https://media.portalheaven.stream/app
```

5. Disconnect returns to the same secure app URL.
6. Logout returns to the secure app URL.

For local tests, assert pathname `/app`. Add one unit test for the configured
absolute production host.

## Acceptance Criteria

- No test opens the legacy `/player` route unless specifically testing backward
  compatibility.
- Connection validation runs during both form submission and import.
- Storage is clean between tests.

---

# Task 6: Direct Content-Session Browser Tests

## Files

- Expand `streamvault/e2e/direct-content.spec.js`
- Add `streamvault/e2e/content-session.spec.js`

## Mock Endpoints

```text
POST   /api/content-session
GET    /api/content-session/validate
POST   /api/content-session/refresh
DELETE /api/content-session
```

## Test Cases

1. Creating a session navigates to `/content?token=...`.
2. Valid token hydrates the correct connection.
3. `/api/auth/me` is not required on HTTP content mode.
4. Token is stored only in session storage.
5. Provider username/password/MAC are not stored in local or session storage.
6. Unknown token returns to `/app?reason=auth`.
7. Expired token returns to `/app?reason=auth`.
8. Refresh extends an active token.
9. Refresh failure returns to `/app`.
10. Disconnect deletes the session and returns to `/app`.
11. Switch connection deletes the session and returns to `/app`.
12. Guest content-session headers include a valid `X-Guest-Id`.

## Required Assertions

- Validate endpoint is called once per initial content load.
- No polling loop repeatedly calls `/api/auth/me`.
- No provider credentials appear in:

```text
localStorage
sessionStorage
IndexedDB
document.cookie
window.location
console output
```

## Acceptance Criteria

- All content-session lifecycle branches are covered in a browser.
- Secure return URL behavior has a regression test.

---

# Task 7: Media Engine Test Harness

## Files

- Add `streamvault/e2e/fixtures/media-stubs.js`
- Add `streamvault/e2e/playback-hls.spec.js`
- Add `streamvault/e2e/playback-mpegts.spec.js`
- Add `streamvault/e2e/playback-native.spec.js`

## Browser Media Stubs

Install stubs with `page.addInitScript` before navigation:

```js
stubNativeMedia(page)
stubHls(page)
stubMpegts(page)
```

Record:

```js
window.__e2eMedia = {
  nativePlayCalls: [],
  hlsLoadCalls: [],
  hlsStartLoadCalls: [],
  mpegtsLoadCalls: [],
  mpegtsAttachCalls: [],
  mpegtsDestroyCalls: []
};
```

The stubs must support triggering:

- `loadedmetadata`
- `canplay`
- `playing`
- `waiting`
- `stalled`
- `error`
- `ended`
- HLS fatal network error.
- HLS fatal media error.
- MPEG-TS error.
- MPEG-TS ended.

Do not use empty TS bytes as proof that playback works. Assert the selected
engine and state transitions.

## HLS Test Cases

1. `.m3u8` selects HLS.
2. Manifest loads once.
3. Successful `playing` removes the loading overlay.
4. Fatal manifest network error attempts allowed fallback.
5. 404 manifest produces terminal error.
6. Manual retry creates a new playback generation.

## MPEG-TS Test Cases

1. `.ts` and extensionless live TS select MPEG-TS.
2. `load` and `play` are called once.
3. Short waiting event does not reconnect.
4. Confirmed stall performs bounded recovery.
5. Ended event does not start an infinite reconnect loop.
6. Channel switch destroys the previous player.

## Native File Test Cases

1. `.mp4` and `.mkv` metadata select native playback.
2. VOD resume restores the saved position.
3. Network interruption preserves position.
4. Retry does not restart from zero when duration and position are known.
5. `ERR_BLOCKED_BY_ORB` follows the configured fallback policy.

## Acceptance Criteria

- Engine-selection tests are deterministic.
- No real codec support is required in CI.
- Loading overlay and terminal error behavior are asserted.

---

# Task 8: Playback Recovery State-Machine Tests

## Files

- Add `streamvault/e2e/playback-recovery.spec.js`
- Expand frontend unit tests where state transitions can be tested without a
  browser.

## Required State Model

Test this sequence:

```text
resolve direct URL
  -> direct playback
  -> short engine recovery
  -> one fresh URL resolution
  -> optional relay fallback
  -> terminal error
  -> manual retry creates new generation
```

## Test Cases

1. Healthy playback does not trigger refresh.
2. A single short `waiting` event does not trigger refresh.
3. Confirmed stall triggers at most one quick engine recovery.
4. Direct 401/403/404/410 requests a fresh URL immediately.
5. Fresh resolution cancels the previous request.
6. Late result from an old channel is ignored.
7. Relay fallback happens at most once per generation.
8. Relay never automatically switches back to direct in the same generation.
9. Successful `playing` clears the loading state.
10. Terminal 404 stops the spinner.
11. Repeated segment URLs in a live HLS playlist are not mistaken for reconnects.
12. No more than the expected number of `create_link` or resolve calls occurs.
13. Closing the player aborts pending recovery.
14. Switching channels resets recovery counters.
15. Manual Retry starts a clean generation.

## Loop Guard

Add a test-level assertion:

```js
expect(resolveRequests.length).toBeLessThanOrEqual(expectedMaximum);
```

Never accept a test that passes merely because it times out after repeated
requests.

## Acceptance Criteria

- Previously observed restart loops become deterministic failing tests.
- Spinner behavior is tested for both recovery and terminal failure.
- Recovery request counts are bounded.

---

# Task 9: Stalker Browser Coverage

## Files

- Add `streamvault/e2e/stalker-playback.spec.js`

## Test Cases

1. Handshake and profile load.
2. Channel categories load.
3. Large channel response is paged or accepted within configured limits.
4. Live item calls `create_link`.
5. `ffmpeg`, `ffrt`, and `auto` command prefixes normalize correctly.
6. `localhost/ch/...` provider result is resolved before playback.
7. 301 then 302 redirect produces the final edge URL.
8. Direct HLS edge URL is attempted first.
9. Direct TS URL is attempted first.
10. CORS/network failure follows the configured fallback policy.
11. VOD lookup resolves the clicked movie ID, not another item.
12. VOD `get_ordered_list` result is used before `create_link` when required.
13. VOD Range behavior preserves position.
14. Expired Stalker token refreshes through the content session.
15. Stalker image paths use the active portal context.
16. Image 403 results in a placeholder without crashing the catalog.
17. Credentials do not appear in browser storage.

## Acceptance Criteria

- Live and VOD selection are independently tested.
- Provider-specific command normalization is covered.
- Direct-first behavior and bounded fallback are asserted.

---

# Task 10: Xtream and M3U Browser Coverage

## Files

- Add `streamvault/e2e/xtream-playback.spec.js`
- Add or expand M3U tests in `connection-import.spec.js`

## Xtream Test Cases

1. Valid account loads Live, Movies, and Series.
2. Disabled or expired account does not pass validation.
3. Empty VOD categories do not leave an infinite spinner.
4. Provider timeout shows retry UI.
5. Global search finds Live, VOD, and Series.
6. Favorites persist after reload.
7. Continue Watching restores VOD.
8. Direct live TS is attempted before `/stream`.
9. HLS CORS failure follows the configured fallback policy.
10. VOD multi-audio/subtitle track metadata reaches the player.

## M3U Test Cases

1. HLS item.
2. MPEG-TS item.
3. Native MP4 item.
4. Group/category navigation.
5. Logo URL handling.
6. Missing logo fallback.
7. Malformed entry is skipped without failing the playlist.

## Acceptance Criteria

- All supported connection types have at least one complete setup-to-player
  browser test.
- Loading and empty-state behavior is asserted.

---

# Task 11: Service Worker and Cache Tests

## Files

- Add `streamvault/e2e/service-worker.spec.js`
- Expand `streamvault/tests/service-worker.test.js`

## Test Cases

1. Manifest starts at `/app`.
2. Service worker caches the application shell.
3. Marketing root is not used as the offline app shell.
4. `/api/auth/*` is network-only.
5. `/api/content-session/*` is network-only.
6. `/stream`, `/proxy`, `/stalker`, and media responses are not cached.
7. Failed asset fetch does not reject the entire service-worker install.
8. Old cache version is deleted during activation.
9. Offline `/app` uses cached app shell.
10. Offline unknown marketing route returns 503 or 404, not the application.

Run service-worker browser tests in a separate Playwright project with:

```js
serviceWorkers: "allow"
```

Keep service workers blocked in normal mocked browser tests to avoid
cross-test caching.

## Acceptance Criteria

- Service worker cannot hide stale API behavior.
- A failed cache operation does not create an unhandled rejection.

---

# Task 12: Deployment Smoke Suite

## Files

- Add `streamvault/playwright.staging.config.js`
- Add `streamvault/e2e/deployment-smoke.spec.js`
- Add a non-destructive script under `scripts/`, such as
  `scripts/run-staging-smoke.ps1`

## Configuration

Use:

```text
E2E_BASE_URL=https://media.portalheaven.stream
E2E_CONTENT_URL=http://40.233.113.76
E2E_RUN_STAGING=1
```

The staging configuration must:

- Disable `webServer`.
- Run Chromium only.
- Use one worker.
- Use retries once.
- Record trace on first retry.
- Never use production credentials.

## HTTPS Host Checks

1. `/` returns marketing title.
2. `/app` returns application title.
3. `/features` returns features page.
4. `/privacy` returns privacy page.
5. `/manifest.json` has `start_url: /app`.
6. Unknown route returns 404.
7. `/health` returns 200.

## HTTP Content Host Checks

1. `/content?token=test-invalid` returns the application document.
2. Invalid token returns to:

```text
https://media.portalheaven.stream/app?reason=auth
```

3. `/app` returns the application document.
4. Unknown route returns 404.
5. No HSTS header is present on the bare IP host.

## Browser Journey

Use a dedicated staging test account or guest:

1. Open `/app`.
2. Authenticate.
3. Verify setup screen.
4. Create a content session using a synthetic/mock connection if supported.
5. Verify navigation to HTTP `/content`.
6. Disconnect.
7. Verify return to HTTPS media `/app`.
8. Logout.

If a synthetic connection endpoint does not exist, keep this journey mocked in
the browser and use separate API health checks against staging.

## Acceptance Criteria

- Smoke suite is non-destructive.
- It verifies both HTTPS app and HTTP content origins.
- It prints deployed commit or build version when available.

---

# Task 13: Real-Provider Canary Suite

## Scope

This suite is optional and runs nightly or manually. It must not run on pull
requests.

## Files

- Add `streamvault/e2e/canary/provider-canary.spec.js`
- Add `streamvault/playwright.canary.config.js`

## Credentials

Read only from environment variables or CI secrets:

```text
CANARY_XTREAM_SERVER
CANARY_XTREAM_USER
CANARY_XTREAM_PASS
CANARY_STALKER_PORTAL
CANARY_STALKER_MAC
CANARY_M3U_URL
```

Never print these values. Attach only sanitized request summaries.

## Canary Assertions

For each configured provider:

1. Validation succeeds.
2. At least one category loads.
3. At least one item appears.
4. Resolve endpoint returns a structurally valid result.
5. Browser attempts the expected direct URL.
6. Do not require sustained playback in CI.

Provider unavailability should mark the canary as degraded and notify, but it
must not block normal code merges.

## Acceptance Criteria

- Canary failures are clearly separated from product regressions.
- Reports identify provider type and failed phase without exposing credentials.

---

# Task 14: CI and Release Gate

## Files

- Add or modify the repository CI workflow.
- Add `scripts/verify-release.ps1` if no CI provider is currently configured.

## Pull Request Gate

Run:

```powershell
cd streamvault
npm ci
npm run lint
npm test
npm run build
npx playwright install --with-deps chromium
npm run e2e

cd ../stalker-proxy
npm ci
npm test
```

Order can be parallelized after initial stabilization.

## Staging Deployment Gate

After deployment:

```powershell
$env:E2E_BASE_URL="https://media.portalheaven.stream"
$env:E2E_CONTENT_URL="http://40.233.113.76"
npx playwright test --config playwright.staging.config.js
```

Deployment is accepted only when:

- Build succeeds.
- Backend tests pass.
- Frontend tests pass.
- Mocked browser suite passes.
- Staging smoke suite passes.
- `/health` returns 200 after restart.

## Artifacts

Retain for failed runs:

- Playwright HTML report.
- Trace zip.
- Screenshot.
- Video.
- Sanitized browser-error report.
- Deployed commit SHA.

Retention recommendation:

- Successful runs: 7 days.
- Failed runs: 30 days.

## Acceptance Criteria

- A failed staging smoke run prevents promotion to production.
- Reports are usable without rerunning the test locally.

---

# Task 15: Manual Acceptance Checklist

Create `docs/testing/manual-release-checklist.md`.

The checklist should contain only workflows that still require human judgment:

```text
[ ] Marketing homepage looks correct on desktop and mobile
[ ] Login and Turnstile look correct
[ ] One real Xtream connection loads
[ ] One real Stalker connection loads
[ ] One live stream starts and remains stable
[ ] One VOD item starts and seeks
[ ] Audio/subtitle menu looks correct when tracks exist
[ ] Disconnect returns to media.portalheaven.stream/app
[ ] Switch connection returns to media.portalheaven.stream/app
[ ] Logout returns to media.portalheaven.stream/app
[ ] No unexpected browser console errors
```

Record:

```text
Commit:
Environment:
Browser:
Tester:
Date:
Result:
Notes:
```

## Acceptance Criteria

- Manual checklist takes no more than 30 minutes.
- Manual checks do not duplicate deterministic automated tests.

---

# Task 16: Final Cleanup and Documentation

## Actions

1. Remove duplicated helper code from the original Playwright specs.
2. Keep or delete the original specs based on whether all behavior has migrated.
3. Update `streamvault/README.md` with:

```text
npm test
npm run e2e
npm run e2e:headed
npm run e2e:report
```

4. Document environment variables without values.
5. Document how to run a single test:

```powershell
npx playwright test e2e/auth.spec.js
npx playwright test -g "disconnect returns"
```

6. Document trace viewing:

```powershell
npx playwright show-trace test-results/path-to-trace.zip
```

7. Run the complete suite three consecutive times.
8. Fix any flakiness. Do not hide it with extra retries or longer sleeps.

## Final Verification

```powershell
cd streamvault
npm run lint
npm test
npm run build
npm run e2e

cd ../stalker-proxy
npm test
```

Run staging smoke once after deploying to the non-production environment.

## Final Acceptance Criteria

- Three consecutive local mocked runs pass.
- One staging smoke run passes.
- No test contains real provider credentials.
- No broad console or network error allowlist exists.
- No fixed sleep longer than two seconds exists outside explicit timeout tests.
- Critical journeys have clear failure artifacts.
- Manual release checklist is under 30 minutes.

---

# Suggested Implementation Commits

Use small commits so failures can be isolated:

```text
test(e2e): stabilize playwright configuration
test(e2e): add browser error monitoring fixtures
test(e2e): add deterministic authentication flows
test(e2e): add provider mock library
test(e2e): cover connection import and lifecycle
test(e2e): cover direct content sessions
test(e2e): add media engine harness
test(e2e): cover bounded playback recovery
test(e2e): cover stalker playback
test(e2e): cover xtream and m3u playback
test(e2e): cover service worker behavior
test(e2e): add staging deployment smoke suite
ci: enforce regression and staging gates
docs: add release testing checklist
```

# Guidance for a Lower-Cost Implementation Model

For every task:

1. Read only the files listed for that task plus directly imported helpers.
2. Do not refactor production behavior unless the test exposes a confirmed bug.
3. Add the smallest stable selector needed.
4. Run the task-specific verification command.
5. Run all previously completed E2E specs before committing.
6. Report exact passing and failing test counts.
7. Do not deploy unless explicitly instructed after the plan is complete.
8. Stop and report if a required behavior is ambiguous instead of encoding an
   assumption into the test.

When a test exposes a product bug:

1. Add or keep the failing regression test.
2. Explain the observed versus expected behavior.
3. Fix the smallest relevant production area.
4. Run unit, integration, and affected E2E tests.
5. Do not weaken the assertion to make the test pass.


# StreamVault Frontend

React SPA built with Vite. The entire app lives in a single file (`src/App.jsx`).

## Setup

```bash
cp .env.example .env
npm install
npm run dev
# Opens at http://localhost:5173
```

## Build

```bash
npm run build
# Output: dist/
```

The production build includes both modern and legacy bundles.

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_PROXY_URL` | `http://localhost:3001` | Backend proxy URL |
| `VITE_CATALOG_URL` | same as PROXY | CF Worker catalog API (optional) |
| `VITE_STREAM_PROXY_URL` | same as PROXY | Stream proxy URL (optional) |

## Deploy to Cloudflare Pages

1. Connect your GitHub repo
2. Root directory: `streamvault`
3. Build command: `npm run build`
4. Build output: `dist`
5. Add env vars as needed

## Testing

### Unit Tests

```bash
npm test
```

### End-to-End Browser Tests

```bash
npm run e2e              # Run all E2E tests (headless)
npm run e2e:headed       # Run with browser visible
npm run e2e:debug        # Run with Playwright Inspector
npm run e2e:report       # Open the last HTML report
```

The local E2E suite uses Playwright and starts Vite automatically at
`http://localhost:5173` unless `E2E_BASE_URL` is set. Provider APIs, auth,
content sessions, media engines, images, and Turnstile are mocked, so the
normal suite does not contact real IPTV providers or require real credentials.
The default Chromium run currently contains 68 tests. Deployment smoke tests
and provider canaries are intentionally excluded from this command.

#### What the E2E Tests Cover

| Area | Coverage |
|------|----------|
| Authentication | Login, guest access, logout, SSO errors, password reset, Turnstile failure |
| Connections | Xtream, M3U, Stalker validation, import, disconnect, and switching |
| Content sessions | Token hydration, expiration, refresh, guest headers, credential storage, return-to-setup behavior |
| Catalogs | Live TV, VOD, series, categories, favorites, empty catalogs, and search/navigation flows |
| Playback | HLS, MPEG-TS, native MP4/MKV, direct-first routing, fallback, reconnect, loading states, and player cleanup |
| Service worker | Cache policy, offline `/app`, cache invalidation, and protection against caching auth or media responses |

#### How the Suite Works

`playwright.config.js` defines two projects:

- `chromium` runs the normal application tests with service workers blocked.
- `service-worker` runs only `e2e/service-worker.spec.js` with service workers enabled.

The shared fixture in `e2e/fixtures/app.fixture.js` starts a browser error
monitor, mocks common backend routes, blocks accidental unmocked `/api/**`
requests, and provides the `appPage` fixture. Tests add provider-specific
routes through `e2e/fixtures/provider-mocks.js`. HLS and MPEG-TS behavior is
simulated by `e2e/fixtures/media-stubs.js`, allowing tests to verify engine
selection and recovery without downloading media.

Tests should assert user-visible behavior first. They may also inspect a
navigation URL, request count, mocked engine log, or storage contents when that
is the behavior under test. Unexpected page errors, console errors, failed
requests, and bad application responses fail the test automatically.

### Run a Single Test

```bash
npx playwright test e2e/auth.spec.js
npx playwright test -g "disconnect returns"
npx playwright test e2e/service-worker.spec.js --project=service-worker
npx playwright test e2e/playback-mpegts.spec.js --headed
```

Useful PowerShell equivalents for this Windows workspace are:

```powershell
npm run e2e -- e2e/auth.spec.js
npm run e2e -- --grep "content session"
npm run e2e -- --project=service-worker
```

#### Adding a New E2E Test

1. Put the test in the matching file under `e2e/`, or create a new `*.spec.js`
   file for a distinct feature.
2. Import `test` and `expect` from `e2e/fixtures/app.fixture.js` so the shared
   network guard and browser-error checks are active.
3. Mock auth and backend routes before navigation. Use the existing provider
   mock helpers instead of real provider credentials.
4. Navigate with `page.goto("/app")`, interact through roles, labels, and
   placeholders, and assert the resulting screen or state.
5. If the test intentionally creates an expected browser error, register a
   narrow pattern with `allowBrowserError`; do not disable the global monitor.

Example:

```js
import { test, expect } from "./fixtures/app.fixture.js";
import {
  mockLoggedOutUser,
  mockLoginSuccess,
  mockTurnstile,
} from "./fixtures/auth.fixture.js";
import { installXtreamMock } from "./fixtures/provider-mocks.js";

test("expired Xtream accounts stay on setup", async ({ appPage }) => {
  await mockLoggedOutUser(appPage);
  await mockLoginSuccess(appPage);
  await mockTurnstile(appPage);
  installXtreamMock(appPage, { auth: "expired" });

  await appPage.goto("/app");
  await appPage.getByPlaceholder("Username").fill("test-user");
  await appPage.getByPlaceholder("Password").fill("test-pass");
  await appPage.getByRole("button", { name: "Login" }).last().click();
  await expect(appPage.getByText("Portal Heaven")).toBeVisible();

  await appPage.getByPlaceholder("http://server.com:8080").fill("http://provider.test");
  await appPage.getByPlaceholder("username").fill("expired-user");
  await appPage.getByPlaceholder("password").fill("expired-pass");
  await appPage.getByRole("button", { name: /Connect/ }).click();

  await expect(appPage.getByText(/account has expired/i)).toBeVisible();
});
```

Keep tests deterministic: mock every external request, avoid arbitrary long
timeouts, do not share state between tests, and never put real provider URLs,
MAC addresses, usernames, passwords, or tokens in the repository.

#### Staging Smoke Tests

The deployment smoke suite is separate because it makes real HTTP requests to
the deployed hosts. It requires both the HTTPS application URL and the HTTP
content URL:

```powershell
$env:E2E_BASE_URL = "https://staging.example.com"
$env:E2E_CONTENT_URL = "http://40.233.113.76"
npx playwright test --config=playwright.staging.config.js
```

#### Provider Canary Tests

Canary tests contact real providers and must only run manually or in a
protected nightly job. Supply credentials through environment variables, then
run:

```powershell
$env:E2E_BASE_URL = "http://localhost:5173"
$env:CANARY_XTREAM_SERVER = "..."
$env:CANARY_XTREAM_USER = "..."
$env:CANARY_XTREAM_PASS = "..."
$env:CANARY_STALKER_PORTAL = "..."
$env:CANARY_STALKER_MAC = "..."
$env:CANARY_M3U_URL = "..."
npx playwright test --config=playwright.canary.config.js
```

Do not commit these values or run canaries as part of pull-request validation.

### Full Verification

```bash
npm run verify           # lint + test + build + e2e
```

### Viewing Traces

After a failed test, traces are saved in `test-results/playwright/`:

```bash
npx playwright show-trace test-results/playwright/path-to-trace.zip
```

## E2E Environment Variables

| Variable | Purpose |
|---|---|
| `E2E_BASE_URL` | Override the base URL for E2E tests (skips local Vite server) |
| `E2E_CONTENT_URL` | HTTP content host for staging smoke tests |
| `E2E_RUN_STAGING` | Set to `1` to enable staging smoke tests |
| `CANARY_XTREAM_SERVER` | Xtream server URL for canary tests |
| `CANARY_XTREAM_USER` | Xtream username for canary tests |
| `CANARY_XTREAM_PASS` | Xtream password for canary tests |
| `CANARY_STALKER_PORTAL` | Stalker portal URL for canary tests |
| `CANARY_STALKER_MAC` | Stalker MAC address for canary tests |
| `CANARY_M3U_URL` | M3U playlist URL for canary tests |
| `CI` | Set automatically by CI providers; enables retries and limits workers |

## Static Hosting

If you host this frontend on a VPS or any static server, point it at `dist/` after running `npm run build`. No extra runtime switch is required for the legacy bundle.

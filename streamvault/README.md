# StreamVault Frontend

The frontend is a React 19 single-page application built with Vite. It provides authentication, connection setup, catalog browsing, direct-first playback, optional compatibility fallback, and account settings.

## Setup

~~~powershell
copy .env.example .env
npm ci
npm run dev
~~~

The default development server is http://localhost:5173. The frontend expects the backend proxy at http://localhost:3001 unless VITE_API_URL is set.

## Build

~~~powershell
$env:VITE_SECURE_APP_BASE_URL = 'https://media.portalheaven.stream/app'
npm run build
npm run preview
~~~

The build emits modern and legacy browser bundles. Deploy the complete dist/ directory, including the generated asset manifest and service worker. Do not copy assets from an older build into a newer HTML shell.

## Environment

| Variable | Purpose |
| --- | --- |
| VITE_API_URL | Backend URL; leave empty for same-origin production routing |
| VITE_SECURE_APP_BASE_URL | HTTPS application URL used for auth, logout, and content return navigation |
| VITE_TURNSTILE_SITE_KEY | Cloudflare Turnstile frontend site key |
| VITE_GA_MEASUREMENT_ID | Optional GA4 measurement ID |
| VITE_VAST_URL | Optional HilltopAds VAST XML source; do not load this URL as a JavaScript tag |
| VITE_ENABLE_VAST | Enable VAST playback for eligible accounts |
| VITE_ENABLE_ADSTERRA | Enable the Adsterra integration |
| VITE_ENABLE_HILLTOP | Enable the Hilltop integration |
| VITE_ENABLE_HILLTOP_POPUNDER | Enable the Hilltop popunder loader |
| VITE_HILLTOP_INPAGE_PUSH_URL | HilltopAds in-page push script URL |
| VITE_HILLTOP_POPUNDER_URL | HilltopAds popunder script URL |
| VITE_STALKER_LAZY_CATALOG_ENABLED | Enable bounded, on-demand Stalker catalog loading |

VAST playback is limited to eligible guest/free accounts and runs after successful content starts on plays 1, 5, 10, 15, and so on. Failed starts and reconnects do not consume a frequency slot.

The HilltopAds popunder loader is opt-in and runs only on eligible app pages. The application prevents duplicate loader insertion during rerenders, but it does not control ad impressions after the provider script is loaded. Configure frequency capping and the delay between impressions in HilltopAds campaign settings, or ask HilltopAds support/account management to change the publisher trigger frequency. The supplied popunder snippet does not expose a documented client-side delay option.

Production configuration belongs in the deployment environment. Never commit .env, provider credentials, CAPTCHA secrets, or analytics API secrets.

## Playback model

The app classifies provider URLs before selecting a playback engine:

- HLS uses HLS.js where required and native playback where supported.
- MPEG-TS uses mpegts.js.
- Progressive files use the native video element.
- Direct browser playback is preferred when protocol, CORS, response type, and provider behavior allow it.
- A relay fallback is bounded and feature-controlled. It is not the default path for the direct-play deployment.

Stalker resolution uses an opaque content-session token. Provider credentials and MAC/device values should not be placed in browser-visible playback URLs.

## Tests

Unit and component tests:

~~~powershell
npm test
npm run lint
~~~

Full local verification:

~~~powershell
$env:VITE_SECURE_APP_BASE_URL = 'https://media.portalheaven.stream/app'
npm run verify
~~~

The Playwright suite starts Vite automatically and mocks backend, provider, media, image, and Turnstile requests. It covers authentication, guest access, account limits, imports, connection switching, content sessions, Stalker and Xtream flows, playback engines, recovery, service-worker behavior, and error handling.

Useful commands:

~~~powershell
npm run e2e
npm run e2e:headed
npm run e2e:debug
npx playwright test e2e/auth.spec.js
npx playwright test -g disconnect-returns
npx playwright test --project=service-worker
npx playwright test --config=playwright.lazy.config.js
~~~

Deployment smoke tests and provider canaries are intentionally separate:

~~~powershell
$env:E2E_BASE_URL=staging.example.com
$env:E2E_CONTENT_URL=http://content-host.example
npx playwright test --config=playwright.staging.config.js
~~~

Canary credentials must be supplied through environment variables and must never be committed.

## E2E conventions

1. Import fixtures from e2e/fixtures/app.fixture.js.
2. Mock every external request before navigation.
3. Use provider mock helpers instead of real credentials.
4. Assert visible behavior before implementation details.
5. Keep tests independent and deterministic.
6. Register only narrow expected browser-error exceptions.

## Analytics

GA4 is optional and consent-gated. The frontend reports privacy-safe events for screen views, validation, playback requests, playback starts, playback failures, and recovery attempts. Provider URLs, credentials, tokens, MAC addresses, account identifiers, content titles, and query strings must not be sent as analytics parameters.

## Static pages

The marketing and legal pages are static files in the frontend build. portalheaven.stream is the public marketing host; /app is the application entry point. The landing.html compatibility URL is retained only for old links and should not be treated as the canonical page.

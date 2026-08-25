# Portal Heaven

Portal Heaven is a browser media player for provider accounts that the user is authorized to access. It does not provide channels, movies, subscriptions, or source content.

**Try it now:** https://portalheaven.stream/

The application supports Stalker portals, Xtream-compatible APIs, M3U playlists, and direct HLS or file URLs. Direct browser playback is preferred. The backend handles authentication, provider metadata, content-session authorization, and compatibility operations. Media relay is an explicit fallback and is disabled by default in the direct-play deployment.

## Current deployment model

| Host | Purpose |
| --- | --- |
| portalheaven.stream | Public marketing and documentation site |
| media.portalheaven.stream | HTTPS application, authentication, setup, browsing, and account settings |
| Legacy host | Temporary old application during migration |
| HTTP content host | Token-gated content shell used when the browser must play HTTP provider media |

The exact content host and deployment paths are environment configuration, not source-code constants. The HTTPS application should never be used to proxy provider media unless the configured compatibility fallback is required.

## Repository layout

~~~text
streamvault/                   React and Vite frontend
stalker-proxy/                 Express backend and SQLite-backed account/cache services
docker/                        Local Nginx gateway
docs/                          Release, testing, and historical design documentation
docker-compose.yml             Local development stack
docker-compose.feature.yml     Non-production direct-play stack
~~~

## Requirements

- Node.js 22 LTS
- npm
- Docker and Docker Compose for the container workflow
- A persistent writable data directory for the backend database
- HTTPS and correctly scoped secrets for hosted deployments

## Local development

Run the backend and frontend separately when debugging source changes:

~~~powershell
cd stalker-proxy
npm ci
npm test
npm run dev
~~~

In another terminal:

~~~powershell
cd streamvault
npm ci
npm test
npm run dev
~~~

The frontend runs on http://localhost:5173 and the backend on http://localhost:3001. Copy the .env.example files before starting and use only local test credentials.

## Docker development

The compose files require secrets instead of embedding credentials in source control:

~~~powershell
$env:ADMIN_PASS = 'local-test-password'
$env:TOKEN_MASTER_KEY = 'replace-with-a-random-64-character-hex-key'
docker compose -f docker-compose.yml up --build
~~~

For the direct-play feature stack:

~~~powershell
$env:ADMIN_PASS = 'local-test-password'
$env:TOKEN_MASTER_KEY = 'replace-with-a-random-64-character-hex-key'
docker compose -f docker-compose.feature.yml up --build
~~~

Never use production passwords, JWT secrets, Turnstile secrets, provider credentials, or webhook URLs in local compose files.

## Verification

Backend:

~~~powershell
cd stalker-proxy
npm test
~~~

Frontend:

~~~powershell
cd streamvault
npm run lint
npm test
$env:VITE_SECURE_APP_BASE_URL = 'https://media.portalheaven.stream/app'
npm run build
npm run e2e
~~~

The Playwright suite uses mocked provider and media routes. Staging smoke tests and provider canaries are separate and must be run deliberately with credentials supplied through environment variables. See streamvault/README.md for test commands and fixtures.

## Configuration

Backend configuration is documented in stalker-proxy/.env.example. Frontend build configuration is documented in streamvault/.env.example.

Important production settings include:

- JWT_SECRET and TOKEN_MASTER_KEY must be stable, random, and stored outside Git.
- ALLOWED_ORIGIN must list the real HTTPS application origin.
- APP_URL and VITE_SECURE_APP_BASE_URL must point to the media application.
- DEFAULT_ROLE=free must remain explicit for new registrations.
- STALKER_PLAYBACK_MODE=direct_only and STALKER_MEDIA_RELAY_ENABLED=false preserve the direct-first audit requirement.
- STALKER_LAZY_CATALOG_ENABLED and VITE_STALKER_LAZY_CATALOG_ENABLED default to false; enable the backend first, verify the versioned catalog endpoints, then enable the frontend.
- Turnstile and OAuth credentials must be configured for the production hostnames.

## Data and account behavior

Authentication and the account/cache database are currently SQLite-backed. Content sessions can use the configured PostgreSQL store, but this does not automatically migrate account data. Review docs/production-release.md before copying production data or running separate legacy and media deployments.

New registrations are assigned the free role by the backend. Existing roles are not changed automatically. Guest and free accounts are subject to their configured limits and advertising policy.

## Stalker catalog loading

The optional lazy catalog mode loads bounded pages instead of downloading every VOD or series item during connection setup. It retains lazy catalog metadata for 48 hours on the VPS and in an owner-scoped browser IndexedDB store, searches loaded pages locally, and uses provider search only when capability detection confirms it works. A provider that ignores live pagination uses one connection-scoped bounded snapshot capped at 50,000 items; VOD and series never use a full-catalog fallback. Playback links are resolved only when selected and direct playback remains preferred. Legacy non-lazy endpoint TTLs are unchanged.

Enable it for staging with `STALKER_LAZY_CATALOG_ENABLED=true` in the backend and `VITE_STALKER_LAZY_CATALOG_ENABLED=true` at frontend build time. Roll back by rebuilding the frontend with the flag false; legacy catalog endpoints remain available during the rollout window.

## Release documentation

- Production release and migration runbook: docs/production-release.md
- Documentation index: docs/README.md
- Manual release checklist: docs/testing/manual-release-checklist.md
- Frontend and E2E guide: streamvault/README.md
- Backend and API guide: stalker-proxy/README.md

Dated files under docs/superpowers/ are design and implementation history. They may describe earlier hosts or deployment experiments and are not the current production runbook.

## License

This repository is distributed under the license in LICENSE. Review the license and applicable law before operating a hosted service.

# StreamVault Backend

Express backend for Portal Heaven. It provides account authentication, connection synchronization, provider metadata requests, Stalker portal compatibility, content-session authorization, analytics, and bounded compatibility routes.

## Setup

~~~powershell
copy .env.example .env
npm ci
npm test
npm start
~~~

The default port is 3001. The backend creates SQLite account and cache tables on startup. Use a persistent CACHE_DB path in any deployment.

## Runtime data model

- SQLite stores users, sessions, email tokens, provider cache, sync data, and operational records.
- DATABASE_URL is optional and is used for the content-session store when configured.
- The PostgreSQL migration files that existed in this branch were not used by the running application and have been removed.
- Setting DATABASE_URL does not automatically migrate SQLite account data.
- Back up SQLite using a consistent database backup while the service is quiesced. Include WAL state when applicable.

## Main routes

| Route | Purpose |
| --- | --- |
| /api/auth/* | Login, registration, logout, password, account status, and SSO support |
| /api/billing/* | Public config, Checkout, Customer Portal, Cancellation, Refunds, Orders |
| /api/support/* | Authenticated ticket creation, retrieval, and status |
| /api/account/connections/* | HMAC-backed connection reconciliation and plan-limit swaps |
| /api/admin/entitlements/* | Admin-only Friend & Family grant/revoke and target reconciliation |
| /api/content-session | Create, validate, refresh, and revoke token-gated content sessions |
| /api/sync/* | Account and guest connection, favorite, and history synchronization |
| /stalker/handshake | Portal device handshake |
| /stalker/validate | Validate a Stalker connection |
| /stalker/channels | Load live channels and metadata |
| /stalker/vod* | Load VOD categories and items |
| /stalker/series* | Load series categories, seasons, and episodes |
| /stalker/play | Resolve a Stalker link and use an explicitly authorized fallback when enabled |
| /stalker/epg | Load EPG data |
| /proxy | Metadata and playlist compatibility proxy |
| /img | Image compatibility proxy |
| /stream | Compatibility media relay; keep disabled unless explicitly required |
| /health | Service health check |

## Direct playback controls

The direct-play deployment should use:

~~~env
STALKER_PLAYBACK_MODE=direct_only
STALKER_DIRECT_PLAY_ENABLED=true
STALKER_MEDIA_RELAY_ENABLED=false
~~~

Direct URLs are classified and validated before they are returned. Stalker credentials are carried in opaque content-session data rather than query parameters. Redirect targets, protocols, range behavior, response limits, concurrency, and relay grants are bounded server-side.

## Environment

Use .env.example as the source of configuration names. Production must provide stable random values for JWT_SECRET and TOKEN_MASTER_KEY, a restrictive ALLOWED_ORIGIN, the real APP_URL, Turnstile credentials, and OAuth callback configuration. Never commit .env or provider credentials.

New public registrations receive the free role. Existing roles remain unchanged unless an administrator updates them. Account limits are enforced by the backend and must not be trusted from frontend input.

## Verification

~~~powershell
npm test
npm run test:coverage
~~~

Tests use local fixtures and mocked upstream responses. Live provider canaries belong in a protected environment and must be run manually with credentials supplied through environment variables.

## Operations

The files under ops/ target the non-production stalker-proxy-play service. They are not a production deployment script. Review the release runbook before copying them to another host, especially the service name, working directory, port, database path, log path, and alert webhook.

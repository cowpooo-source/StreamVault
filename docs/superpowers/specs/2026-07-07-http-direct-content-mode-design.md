# HTTP Direct Content Mode Design

## Goal

Move direct-provider browsing and playback into a dedicated HTTP content shell while keeping login, account management, connection creation, billing, and admin flows on HTTPS.

The feature is limited to direct providers first: Xtream and M3U. Stalker, Jellyfin, Plex, and account-level areas stay in the existing HTTPS app unless a separate migration is approved.

## Problem

Direct provider streams are often HTTP-only. When the main app runs on HTTPS, browser mixed-content rules block HTTP media requests. The current workaround opens a token-gated HTTP `/player` page only at playback time. That works for some streams, but the user experience is split: browsing stays in HTTPS, playback jumps to a separate minimal player, and returning to catalog/navigation is awkward.

The desired experience is: after the user selects a direct provider connection, the whole content browsing surface runs over HTTP so live, movies, series, EPG, icons, navigation, and playback all stay in one screen.

## Architecture

The HTTPS app remains the authenticated control plane. The HTTP app becomes a limited direct-content plane.

1. User authenticates and manages connections on HTTPS.
2. User opens an Xtream or M3U connection.
3. HTTPS app calls `POST /api/content-session` with the selected connection id.
4. Backend verifies the normal auth token and checks the connection belongs to the user.
5. Backend creates a short-lived content-session token scoped to that user and connection.
6. Browser navigates to `http://40.233.113.76/content?token=<content-token>`.
7. HTTP content shell validates the token and loads only the scoped connection's catalog, EPG, icons, and playback helpers.
8. Media bytes still flow directly from browser to provider, not through the VPS.

## Security Model

The normal auth token or cookie must not be used as the authority for HTTP content mode.

The content-session token is intentionally limited:

- Scope: one user id and one connection id.
- Provider types: Xtream and M3U only.
- Allowed actions: content-session validation, catalog loading for the scoped connection, icon proxy, EPG loading, and playback token creation for URLs belonging to that scoped connection.
- Forbidden actions: account profile, password, billing, admin, connection mutation, connection export, and global sync.
- TTL: 30 minutes for the first implementation.
- Storage: in-memory initially, matching existing play-token behavior.
- Revocation: token expires naturally; logout does not need to revoke content-session tokens in the first implementation because the token is scoped and short-lived.

This does not make HTTP private. Network observers can still see HTTP metadata and steal the content-session token. The mitigation is limiting what that token can do and keeping its lifetime short.

## Backend Components

### Content Session Router

Add a new focused router at `stalker-proxy/src/routes/contentSession.js`.

Responsibilities:

- `POST /api/content-session`
  - Requires normal HTTPS auth.
  - Accepts `{ connectionId }`.
  - Requires the HTTPS client to send the selected connection object for the first implementation. The backend validates the normal auth token, rejects unsupported provider types, stores only this submitted connection config inside the short-lived content-session token, and does not persist it.
  - Rejects unsupported provider types.
  - Creates a content token.
  - Returns `{ token, contentUrl, expiresAt }`.

- `GET /api/content-session/validate?token=...`
  - Validates token.
  - Returns limited bootstrap data: provider type, connection id, safe display label, and connection config needed by the HTTP content shell.
  - Must not return account-level auth data.

- Internal helper `requireContentSession(req)` for scoped HTTP endpoints if needed.

### Existing Player Router

Keep `/api/play-token`, `/api/validate-token`, and `/api/refresh-playback` for actual playback URL signing/refresh. In the first implementation, the HTTP content shell may call `/api/play-token` for URLs generated from its scoped connection; account-level auth is not required inside HTTP mode.

### Image and Metadata Routes

Keep `/img` for icons. Keep `/proxy` for provider XMLTV/M3U/Xtream metadata where needed. The HTTP content host must route these endpoints to the feature backend.

## Frontend Components

### HTTPS App

Modify the direct-provider connection open path:

- If connection type is `xtream` or `m3u`, call `POST /api/content-session` instead of fully loading that connection inside HTTPS.
- Navigate to `contentUrl` returned by the backend.
- Non-direct providers keep the existing HTTPS flow.

This should be triggered on connection switch/open, not only on channel playback.

### HTTP Content Shell

Add a `/content` mode in the React app. It should be reusable rather than a completely separate app when practical.

Responsibilities:

- Read `token` from URL.
- Call `/api/content-session/validate` on the HTTP origin.
- Bootstrap the scoped connection.
- Load live, VOD, series, EPG, and icons using existing loaders where possible.
- Render the existing content navigation and grids.
- Keep playback in the same HTTP screen.
- Do not show account/admin/settings requiring full auth.
- Provide a visible way back to the HTTPS app.

### Playback Behavior

For Xtream and M3U inside HTTP content mode:

- Use direct provider URLs when possible.
- Do not use `/stream` for normal media bytes.
- Reuse current hls.js/mpegts.js/native fallback handling.
- Keep `/api/play-token` available if token-gated playback remains useful for refresh/session logic.

## Nginx and Deployment

Bare IP `40.233.113.76` must serve the HTTP content shell and proxy required backend routes to `127.0.0.1:3201`.

Required routes:

- `/content` and SPA fallback/static assets for the HTTP content shell.
- `/api/content-session`
- `/api/content-session/validate`
- `/api/play-token`
- `/api/validate-token`
- `/api/refresh-playback`
- `/img`
- `/proxy`
- `/health`

For Stalker to remain out of scope, `/stalker/` does not need to be exposed for the direct-provider shell except where existing feature UI still needs it. It can stay available on the bare IP if already needed for icons/EPG experiments, but direct-mode implementation should not depend on it for Xtream/M3U.

Avoid `portalheaven.stream` subdomains for this HTTP shell while HSTS `includeSubDomains` is active.

## Error Handling

The HTTP content shell should distinguish:

- Expired content session: show a message and link back to HTTPS app to reopen the connection.
- Unsupported provider type: redirect or show unsupported message.
- Provider catalog failure: show provider-specific error without exposing secrets.
- EPG failure: content still loads; EPG area shows no-data/error state.
- Icon failure: hide the failed image and use the existing UI fallback element where one exists.
- Playback failure: use existing detailed player errors.

## Testing Strategy

Backend tests:

- Content-session creation requires auth.
- Content-session rejects missing/unknown connection id.
- Content-session rejects Stalker/Jellyfin/Plex initially.
- Content-session validate rejects missing, expired, and unknown tokens.
- Valid content-session returns scoped bootstrap data only.

Frontend tests:

- Direct-provider connection open requests a content session and navigates to returned HTTP URL.
- Non-direct connection open keeps existing HTTPS behavior.
- `/content` validates token and renders content navigation.
- Expired token shows return-to-HTTPS message.

Integration/manual checks:

- HTTPS login still works.
- Xtream connection opens `http://40.233.113.76/content?token=...`.
- Live/VOD/series navigation remains on HTTP.
- Channel playback stays in same HTTP app screen.
- Browser devtools show media bytes go to provider host, not `/stream`.
- Production PM2 process is not touched when deploying feature service.

## Rollout Plan

Phase 1: Local implementation behind direct-provider detection.
Phase 2: Deploy only to `/home/opc/StreamVault-Feature` and restart `stalker-proxy-play`.
Phase 3: Verify on bare IP with one Xtream and one M3U connection.
Phase 4: Keep old `/player` route as fallback until HTTP content shell is stable.

## Non-Goals

- Do not move login to HTTP.
- Do not move account, billing, admin, profile, or password flows to HTTP.
- Do not proxy media bytes through the VPS for Xtream/M3U.
- Do not migrate Stalker/Jellyfin/Plex into HTTP content mode in the first version.
- Do not solve provider-side expired/offline stream URLs beyond current refresh/error handling.
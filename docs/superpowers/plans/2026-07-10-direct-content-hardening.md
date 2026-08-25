# Direct Content Hardening Implementation Plan

## Goal

Harden the HTTPS-to-HTTP direct-content feature without routing provider media bytes through the VPS. Fix credential persistence, session reliability, logout behavior, Continue Watching, connection validation, error handling, Turnstile loading, and stale build artifacts.

Implement one task at a time. Preserve unrelated working-tree changes, add focused tests, run those tests, and do not deploy until the final quality gate passes.

## Baseline

Before changing code:

1. Run the focused frontend tests:

   ```powershell
   cd streamvault
   npm test -- --run tests/direct-content-session.test.js tests/useStreamVault.test.js tests/Setup.test.jsx
   ```

2. Run the backend route tests:

   ```powershell
   cd stalker-proxy
   npm test -- --run tests/routes.test.js
   ```

3. Do not include generated `streamvault/dist` files in intermediate commits.
4. Keep direct provider media requests browser-to-provider. Do not reintroduce `/stream` for Xtream or M3U playback.

## Task 1: Keep HTTP Session Credentials Ephemeral

### Problem

`App.jsx` validates the content token and calls the normal `setConnections()` and `setActiveConnId()` actions. Those actions persist data, which can leave Xtream credentials or an M3U URL on the HTTP player origin.

### Files

- `streamvault/src/App.jsx`
- `streamvault/src/useStreamVault.js`
- `streamvault/src/direct-content-session.js`
- `streamvault/tests/direct-content-session.test.js`
- Add an App integration test if no suitable test exists

### Implementation

1. Add dedicated ephemeral state in `App.jsx`:

   ```js
   const [ephemeralConnection, setEphemeralConnection] = useState(null);
   ```

2. In HTTP content mode, place the validated connection only in `ephemeralConnection`.
3. Derive the effective connection from ephemeral state in HTTP mode and persisted state in HTTPS mode.
4. Do not call these actions for a content-session connection:
   - `setConnections`
   - persistent `setActiveConnId`
   - connection synchronization
   - `db.set("sv-connections", ...)`
   - `db.set("sv-activeConn", ...)`
5. Do not show the ephemeral connection in Settings or the connection manager.
6. Clear ephemeral state on navigation/unmount.
7. Keep favorites and Continue Watching separate from connection credentials.

### Tests

- Validating `/content` loads the connection into memory.
- `sv-connections` and `sv-activeConn` are not written.
- Provider password and M3U URL are absent from local storage and IndexedDB connection records.
- Normal HTTPS connection persistence still works.
- Refresh requires token/session restoration rather than persisted credentials.

### Acceptance

- Closing the HTTP tab leaves no provider credentials on that origin.
- Content browsing and playback continue to work.

### Commit

`fix(content): keep direct session credentials ephemeral`

## Task 2: Fix VAST and Continue Watching Interaction

### Problem

The resume `loadedmetadata` listener is installed before the VAST preroll. It can seek the advertisement and mark resume as applied before the requested VOD loads.

### Files

- `streamvault/src/components/Player.jsx`
- Player component tests

### Implementation

1. Track playback phase with a ref: `idle`, `ad`, or `content`.
2. Set phase to `ad` before loading VAST media.
3. Suppress resume and history reporting while phase is `ad`.
4. Set phase to `content` immediately before loading the requested media.
5. Apply resume only after content metadata is available.
6. Use a stable identity such as `${type}:${id || url}`.
7. Reset the resume marker when the content identity changes.
8. Never resume live content.
9. Ignore positions at or below five seconds.
10. Treat content within 30 seconds of completion as completed.
11. Clamp resume position to the media seekable range.
12. If the initial seek fails, retry on `canplay` or `durationchange` once.

### Tests

- VOD without an ad resumes.
- Preroll is never seeked.
- VOD resumes after the preroll finishes.
- Live streams never seek.
- Near-complete VOD starts from zero.
- Switching items applies each item's own position.

### Commit

`fix(player): apply resume only to requested content`

## Task 3: Throttle Progress Persistence

### Problem

Progress is reported about every five seconds and each report can update React state, local persistence, and server synchronization with the complete history.

### Files

- `streamvault/src/components/Player.jsx`
- `streamvault/src/App.jsx`
- `streamvault/src/useStreamVault.js` if persistence belongs there
- Progress/history tests

### Implementation

1. Have `Player` emit a reason with progress:

   ```js
   onProgress(item, {
     position,
     duration,
     completed,
     reason: "interval" | "pause" | "close" | "ended" | "hidden",
   });
   ```

2. Track position in memory every five seconds without persisting every event.
3. Persist locally every 20-30 seconds.
4. Synchronize to the server at most every 60 seconds.
5. Flush immediately on pause, player close, item switch, visibility hidden, and completion.
6. Do not rely on React state updates during `beforeunload`.
7. Keep `sendBeacon` only for telemetry or a purpose-built progress endpoint.
8. Avoid sending the complete 60-item history when only one entry changed if the backend supports item-level updates.
9. Cancel timers when the player unmounts or changes item.

### Tests

- Ten minutes of simulated playback creates no more than roughly 30 local writes and 10 server writes.
- Pause and close flush progress.
- Completion resets position to zero.
- Live streams create no Continue Watching writes.
- Timers are cleaned up.

### Commit

`perf(history): throttle continue-watching persistence`

## Task 4: Dispatch Connection Validation by Provider

### Problem

Saved providers other than Xtream and M3U fall through to Stalker validation. Jellyfin and direct HLS can therefore fail with undefined Stalker fields.

### Files

- `streamvault/src/components/Setup.jsx`
- Existing provider adapters/services
- `streamvault/tests/Setup.test.jsx`

### Implementation

1. Replace fall-through behavior with an explicit provider switch.
2. Implement provider-specific functions:
   - Xtream: authenticate and reject `user_info.auth === 0`.
   - M3U: verify URL, M3U header, and at least one entry.
   - Stalker: use `/stalker/validate` and existing account status handling.
   - Jellyfin: use the existing server/auth adapter.
   - Plex: use the existing identity/server check if Plex is supported here.
   - Direct HLS: reconnect directly or perform a lightweight CORS-safe check.
3. Unknown provider types must produce `Unsupported connection type` rather than using Stalker.
4. Preserve an explicit `Connect Anyway` action for unreachable/expired/blocked Stalker connections.
5. Do not automatically connect after failed validation.

### Tests

- One reconnect test per supported provider.
- Assert that each provider invokes only its own validator.
- Assert Jellyfin/HLS never call `/stalker/validate`.
- Assert unknown providers fail clearly.

### Commit

`fix(setup): validate saved connections by provider type`

## Task 5: Handle Direct Session Creation Errors

### Problem

Connection switching awaits content-session creation without visible loading/error handling. Failures can become unhandled promise rejections.

### Files

- `streamvault/src/App.jsx`
- `streamvault/src/direct-content-session.js`
- Tests

### Implementation

1. Wrap `maybeOpenDirectContentSession()` in `try/catch`.
2. Add a session-creation loading state.
3. Disable repeated connection clicks while a session is being created.
4. Show a retryable network error without credentials or raw response bodies.
5. On HTTP 401, return to the HTTPS login screen with a safe reason code.
6. Never put connection data in redirect parameters.
7. Normalize backend errors into stable categories: unauthorized, invalid connection, rate limited, network failure, and server failure.

### Tests

- Network failure displays retry UI.
- 401 redirects to HTTPS login.
- Double-click creates one session.
- Retry succeeds after an initial failure.
- No unhandled promise rejection occurs.

### Commit

`fix(content): handle direct session creation failures`

## Task 6: Bound Turnstile Loading

### Problem

The authentication screen polls every 100 ms indefinitely if the Turnstile script is blocked or fails.

### Files

- `streamvault/src/components/AuthScreen.jsx`
- Authentication tests

### Implementation

1. Prefer Turnstile script `load` and `error` events, or limit polling to approximately five seconds.
2. Track `loading`, `ready`, and `unavailable` states.
3. Stop all timers on unmount and mode change.
4. Keep widget-ID-specific reset and removal.
5. Never call `turnstile.reset()` without a valid widget ID.
6. Show a clear unavailable message when CAPTCHA is required by the backend.
7. Do not silently submit without a CAPTCHA when server policy requires it.

### Tests

- Script already loaded.
- Delayed script load.
- Script failure/timeout.
- Mode switch removes old widget.
- Unmount cancels retries.
- Reset receives the rendered widget ID.

### Commit

`fix(auth): bound Turnstile loading and cleanup`

## Task 7: Add a Durable Shared Content Session Store

### Problem

Content sessions are stored in a module-level `Map`. Restarts invalidate all sessions, and multiple workers cannot share tokens.

### Files

- `stalker-proxy/src/routes/contentSession.js`
- Add `stalker-proxy/src/services/contentSessionStore.js`
- Add `stalker-proxy/tests/contentSessionStore.test.js`
- `stalker-proxy/tests/routes.test.js`

### Store Interface

```js
create({ tokenHash, userId, encryptedConnection, expiresAt })
findByTokenHash(tokenHash)
deleteByTokenHash(tokenHash)
deleteByUserId(userId)
deleteExpired(now)
```

### Implementation

1. Generate at least 24 random bytes for the client token.
2. Store only a SHA-256 hash of the token.
3. Store the authenticated user ID.
4. Encrypt the connection payload with the existing server encryption utility.
5. Use an isolated in-memory store only for tests/local fallback.
6. Use the application's existing durable database in production.
7. Support multiple workers sharing the same database.
8. Create indexes for token hash, user ID, and expiration.
9. Delete expired sessions periodically and during lookup.

### Suggested Schema

```sql
CREATE TABLE IF NOT EXISTS content_sessions (
  token_hash VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  connection_payload TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
```

### Tests

- Raw token is never stored.
- Session survives Express app recreation.
- Two app instances can validate the same session.
- Expired sessions are deleted.
- Corrupt encrypted payload fails without leaking details.
- Tests do not share state.

### Commit

`feat(content-session): add durable shared session store`

## Task 8: Harden Content Session Endpoints

### Files

- `stalker-proxy/src/routes/contentSession.js`
- `stalker-proxy/src/app.js`
- `stalker-proxy/tests/routes.test.js`

### Implementation

1. Normalize `CONTENT_BASE_URL` with `new URL()`.
2. Permit only HTTP and HTTPS schemes.
3. Strip trailing slashes before appending `/content`.
4. Validate required Xtream fields: server, user, and pass.
5. Validate the required M3U URL.
6. Reuse existing URL/SSRF validation.
7. Bound connection ID and label lengths.
8. Store the authenticated user ID with each session.
9. Limit active sessions per user, defaulting to five.
10. Add a dedicated rate limit for creation and validation.
11. Add these headers to creation and validation responses:

    ```text
    Cache-Control: no-store, private
    Pragma: no-cache
    Referrer-Policy: no-referrer
    ```

12. Add authenticated revocation:

    ```text
    DELETE /api/content-session
    { "token": "..." }
    ```

13. Read TTL from configuration and constrain it to 5-120 minutes.
14. Do not extend TTL during validation.
15. Return 401, not 500, for invalid authentication tokens.

### Tests

- Base URL trailing slash normalization.
- Invalid scheme/configuration.
- Missing provider fields.
- No-cache headers.
- Per-user limit.
- Rate limit.
- Revocation.
- Authentication verification errors.

### Commit

`fix(content-session): validate, limit and revoke direct sessions`

## Task 9: Complete Logout on the HTTPS Origin

### Problem

The HTTP origin cannot reliably clear an HTTPS Secure cookie.

### Files

- `streamvault/src/App.jsx`
- `streamvault/src/direct-content-session.js`
- Backend auth routes only if a helper endpoint is required
- Tests

### Implementation

1. Separate navigation actions:
   - Return/change connection: HTTPS setup, still authenticated.
   - Logout: HTTPS app performs logout.
   - Close player: remain in HTTP app.
2. For logout from HTTP, revoke the content token where possible and redirect to:

   ```text
   https://secure-app.example/?action=logout
   ```

3. On HTTPS startup, detect `action=logout`.
4. Call the normal HTTPS `/api/auth/logout` endpoint.
5. Clear local auth state after the request completes.
6. Remove the query parameter using `history.replaceState`.
7. Show the login screen.
8. Do not log out when the user only chooses another connection.

### Tests

- HTTP logout redirects to HTTPS logout intent.
- HTTPS processes logout and `/api/auth/me` becomes 401.
- Change connection preserves authentication.
- Guest logout still clears guest state.

### Commit

`fix(auth): complete direct-content logout on secure origin`

## Task 10: Improve Session URL and Error States

### Files

- `streamvault/src/App.jsx`
- `streamvault/src/direct-content-session.js`
- UI tests

### Implementation

1. Add explicit states: loading, ready, expired, invalid, and network error.
2. Add `Try Again` for network errors.
3. Add `Return to Secure Setup` for all terminal errors.
4. Move the token from the visible query string into `sessionStorage`:
   - Read token from URL.
   - Save to `sessionStorage`.
   - Replace URL with `/content`.
   - Read from `sessionStorage` on same-tab refresh.
5. Opening `/content` in a new tab without a token must fail safely.
6. Clear the stored token on logout, return to setup, revocation, or expiration.

### Tests

- Token disappears from address bar.
- Same-tab refresh works.
- New tab without token fails safely.
- Network validation can retry.
- Expired token clears session storage.

### Commit

`feat(content): add recoverable direct session states`

## Task 11: Avoid Duplicate M3U Downloads

### Files

- `streamvault/src/components/Setup.jsx`
- `streamvault/src/App.jsx`
- M3U utilities/tests

### Implementation

Choose one approach:

1. Preferred: validate a bounded initial response chunk (for example 64 KB), checking for `#EXTM3U` and `#EXTINF`, then let activation perform one full download.
2. Alternative: return parsed validation data to activation and reuse it instead of downloading again.

Add a timeout and abort handling. Large playlists must not block the UI indefinitely.

### Tests

- Valid playlist downloads fully no more than once.
- Invalid M3U is rejected.
- Large playlist validation is bounded.
- Timeout produces a useful error.

### Commit

`perf(m3u): avoid duplicate playlist downloads`

## Task 12: Centralize Direct-Mode Configuration

### Files

- `streamvault/src/direct-content-session.js`
- `stalker-proxy/src/routes/contentSession.js`
- `.env.example` files
- `docker-compose.feature.yml`
- Deployment documentation

### Configuration

```text
VITE_SECURE_APP_BASE_URL=https://media.portalheaven.stream
CONTENT_BASE_URL=http://40.233.113.76
CONTENT_SESSION_TTL_MINUTES=30
CONTENT_SESSION_MAX_PER_USER=5
```

### Implementation

1. Remove production domains and VPS IPs as source-code defaults.
2. Permit localhost defaults only in development.
3. Validate required production variables at startup/build time.
4. Log normalized origins at startup without tokens or credentials.
5. Keep Docker local mode on localhost and VPS feature mode on the configured bare IP.

### Tests

- Development defaults.
- Production missing configuration.
- Invalid scheme.
- Correct normalized secure and content origins.

### Commit

`chore(config): centralize direct content origins`

## Task 13: Fix Service Worker and Build Hygiene

### Files

- `streamvault/public/sw.js`
- `streamvault/vite.config.js`
- `.gitignore`
- Deployment scripts/documentation
- `streamvault/dist` only during final build

### Implementation

1. Decide and document whether `dist` is built during deployment or tracked.
2. Prefer building during deployment and not committing generated assets.
3. Do not precache nonexistent hashed assets.
4. Increment service-worker cache version when shell behavior changes.
5. Use network-only behavior for:
   - `/api/content-session*`
   - `/api/auth/*`
   - tokenized player/content routes
6. Ensure sensitive responses never enter Cache Storage.
7. Avoid making one optional shell asset break service-worker installation.

### Tests

- Service worker installs without a missing asset.
- Auth/session responses are not cached.
- A new deployment does not serve an old JS bundle.
- Hard refresh loads the current build.

### Commit

`fix(build): prevent stale sensitive service-worker caches`

## Task 14: Integration and End-to-End Coverage

### Backend Coverage

- Restart/app recreation.
- Shared store across app instances.
- Expiry and revocation.
- Raw token absence and encrypted payload.
- Session count and rate limits.
- Base URL normalization.
- Provider validation.
- No-cache headers.

### Frontend Coverage

- No credential persistence on HTTP.
- Token migration to `sessionStorage`.
- Retry and expiration UI.
- HTTPS logout handoff.
- VAST plus resume.
- Progress throttling.
- Every supported connection validator.
- Direct session creation failures.
- Turnstile timeout and cleanup.

### End-to-End Scenarios

1. HTTPS login, choose Xtream, and enter HTTP content mode.
2. Browse live, movies, and series on HTTP.
3. Play media inside the same app screen.
4. Refresh the HTTP page.
5. Restart the backend and confirm the durable session remains valid.
6. Return to setup and remain authenticated.
7. Open content again and log out.
8. Confirm HTTPS `/api/auth/me` returns 401.
9. Confirm provider credentials are absent from browser storage.
10. Confirm provider media requests do not use backend `/stream`.

### Commit

`test(content): cover direct-mode security and lifecycle`

## Final Quality Gate

Run the complete suites and build:

```powershell
cd streamvault
npm test
npm run build
npm run lint

cd ..\stalker-proxy
npm test
```

Then rebuild the feature Docker stack:

```powershell
docker compose -f docker-compose.feature.yml up -d --build
docker compose -f docker-compose.feature.yml ps
docker compose -f docker-compose.feature.yml logs --tail 200
```

Manually verify:

- No browser console exceptions.
- No `App is not defined` error.
- No invalid regular-expression error.
- No Turnstile reset error.
- No unexplained content-session 404.
- No provider media bytes through `/stream`.
- Continue Watching resumes content rather than the advertisement.
- Logout ends the HTTPS session.
- Credentials are absent from HTTP-origin storage.
- Service worker serves the current bundle.

Do not deploy to the VPS until this gate passes locally.

## Recommended Execution Order

1. Ephemeral credentials.
2. VAST/resume correctness.
3. Progress throttling.
4. Provider validation dispatch.
5. Session creation error handling.
6. Turnstile loading.
7. Durable session store.
8. Endpoint hardening.
9. HTTPS logout handoff.
10. Session URL/error states.
11. M3U optimization.
12. Configuration cleanup.
13. Service worker/build hygiene.
14. Integration and end-to-end coverage.

For each task, instruct the implementing model: implement only the named task, preserve unrelated changes, add focused tests, run those tests, report failures, and do not deploy.

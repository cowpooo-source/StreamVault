# Stalker HTTP Content Hybrid Playback Plan

## Authoritative Implementation Specification

This is the authoritative implementation specification. The supporting original design appears afterward for context only; where wording differs, this section wins.

### Current Baseline: Reuse, Do Not Rebuild

This is an incremental hardening task. The current branch already contains:

- GET /stalker/play?resolve=1, which calls create_link and returns a URL.
- resolveStalkerStream in App.jsx.
- Existing _direct, _stalkerFallbackUrl, and _stalkerFallbackUsed fields.
- A one-way direct-to-relay fallback in Player.jsx.
- Mixed-content routing in stream-routing.js.
- Lazy second-stage device authentication after authorization failure.
- Tests for resolve mode, URL normalization, relay streaming, and HLS rewriting.

Do not create a second resolve endpoint, retry loop, or duplicate metadata. Extend the existing flow.

Known gaps:

- Resolve mode returns only a URL, so transport metadata is inconsistent.
- Direct retry may reuse an expired generated URL.
- Player.jsx cannot ask App.jsx for a fresh direct URL.
- Relay playback uses unchecked automatic redirects.
- Stalker routes trust browser-supplied portal and MAC values.
- A Player.jsx comment incorrectly says all Stalker media is relayed.
- stream-routing.js is currently untracked and must be committed deliberately with this work.
- Existing rendered Player tests cover direct-to-relay fallback, but fresh resolution, cancellation, generation handling, and the complete state machine are not covered.

### Required Invariants

- Direct URLs may be visible in DevTools, but must not be saved to connection records, synchronized data, catalog caches, analytics, or long-lived logs.
- Never log MAC, serial, device IDs, handshake tokens, full provider URLs, or tokenized query strings.
- Do not cache generated URLs without a reliable provider expiry.
- Do not use HEAD preflight by default; providers may reject it or consume one-time links.
- Do not cache media bytes on the VPS or in the service worker.
- Keep /stream and /stalker/play as fallbacks.
- Add STALKER_DIRECT_PLAY_ENABLED. Keep it off in production until feature testing is accepted.

### Exact Resolve Contract

The existing resolve response should become:

    {
      "url": "https://provider.example/live/generated-token",
      "streamKind": "ts",
      "direct": true,
      "fallbackUrl": "/stalker/play?connection=opaque-id&content=opaque-id",
      "expiresAt": null
    }

Map it once at the frontend boundary:

    {
      url: result.url,
      streamKind: result.streamKind,
      _direct: result.direct,
      _stalkerFallbackUrl: result.fallbackUrl,
      _stalkerFallbackUsed: false
    }

Rules:

- Provider URLs are absolute; application endpoints are relative to the current API/content origin.
- expiresAt remains null unless the provider supplies it reliably.
- Classification precedence is explicit metadata, HLS hint or .m3u8, TS hint or .ts or extension=ts, known file extension, extensionless live as TS, then unknown.
- If server-only headers or cookies are explicit, return direct false. Otherwise attempt direct and use bounded fallback.
- Errors return credential-free error, code, and retryable fields.

### Bounded Playback State Machine

App.jsx owns link resolution. Player.jsx owns media-engine recovery and requests a fresh link through onRefreshStream(item, reason).

    item click
      -> resolve fresh link
      -> direct playback
           -> short engine recovery, maximum two attempts
           -> request one fresh direct link
           -> relay fallback, which performs fresh create_link
           -> terminal error with manual Retry

Rules:

- Reset counters only when the item/playback generation changes.
- Abort superseded resolves and ignore late responses after channel switch or close.
- Never transition relay back to direct automatically in one generation.
- Manual Retry creates a new generation.
- Direct 401, 403, 404, 410, 459, or 462 requests a fresh link immediately.
- Network failures may use short engine recovery first.
- Player.jsx must not reconstruct portal/MAC API URLs.
- Persist stable item identity and _stalkerCmd, not generated URLs.

### Backend Retry Contract

Authorization recovery is limited to:

1. One normal portal request.
2. One lazy device-auth attempt and one retry if it succeeds.
3. One clean-handshake retry if authorization still fails.

A provider 429 activates cooldown and must not trigger device authentication or repeated handshakes. Concurrent refreshes for one session key share one in-flight handshake.

### Relay Hardening

- Replace automatic redirects with fetchWithRedirectCheck and keep the final URL for HLS base resolution.
- Forward only Range, required Stalker/MAG User-Agent, and required Referer/Origin.
- Never forward browser cookies or arbitrary authorization upstream.
- Preserve 200/206, Content-Type, Content-Range, and Accept-Ranges.
- Do not forward Content-Length after transforming HLS.
- Abort upstream work and release concurrency on browser disconnect.
- Use connect/idle protection without a short total timeout on healthy live streams.
- Standardize statuses: 400 malformed input, 401/403 authorization or URL denial, 410 expired session, 429 cooldown, 502 provider failure, and 504 timeout.

### Authorization and Abuse Controls

- Require authenticated ownership or a scoped guest content session for catalog, resolve, and relay calls.
- Resolve credentials server-side from an opaque identifier. Do not authorize only by portal/MAC.
- Limit handshake/catalog calls per connection, create_link calls per playback, and relays per user, globally, and per provider.
- Release slots on completion, error, timeout, and disconnect.
- Redact Stalker query strings in request logs.
- Successful direct playback must not consume relay accounting.

### Additional Automated Tests

Backend:

- Legacy portal works without device-auth POST.
- Authorization failure attempts device auth once.
- Rejected device auth performs one clean handshake.
- 429 does not cause authentication loops.
- Concurrent refreshes share one handshake.
- Resolve response includes classification and fallback metadata.
- Relay redirect to private IP is rejected.
- Browser cookies and authorization are not forwarded.
- Transformed HLS omits stale Content-Length.
- Disconnect aborts upstream and releases concurrency.
- Users and guests access only their own connection.
- Responses and logs contain no credentials.

Frontend:

- HTTP content plays an HTTPS direct URL without /stream.
- HTTPS content never directly requests HTTP media.
- Auth/expiry errors request a fresh link before relay.
- Late resolution cannot replace a newer channel.
- Close aborts resolution.
- Relay occurs at most once per generation.
- Manual Retry creates a generation.
- Catch-up preserves start/end and series preserves episode.
- Persisted history strips generated URLs.
- Multi-audio, subtitles, ranges, and continue-watching remain functional.

Use deterministic mocks, fake timers, exact call counts, and abort assertions. Live providers belong only in a credential-free manual matrix.

### Implementation Order

1. Add baseline contract/state-machine tests without behavior changes.
2. Extend resolve metadata and consolidate classification.
3. Harden relay redirects, headers, aborts, ranges, and concurrency release.
4. Bind routes to content-session authorization and redact credentials.
5. Add frontend mapping and stale-request cancellation.
6. Add onRefreshStream and bounded fresh-link/relay transitions.
7. Verify live, catch-up, VOD, series, history, subtitles, and audio parity.
8. Run full tests and build with the feature flag.
9. Deploy only to /home/opc/StreamVault-Feature and restart only stalker-proxy-play.

Use small commits and run affected tests after each step.

### Manual Verification Matrix

Verify HTTP provider, HTTPS provider, relative HLS, extensionless TS, ranged VOD, multi-audio/subtitles, relay-only provider, expired link reconnect, invalid account, rapid channel switching, and close during resolution.

For direct-compatible playback, DevTools media requests must target the provider host. Only catalog, authentication, and resolve traffic should target the VPS.

Monitor credential-free aggregate counts for resolves, starts, fresh links, relay fallbacks by bounded reason, relay failures by HTTP class, create_link latency, active relays, bytes relayed, and handshake/device-auth attempts.

Rollback for handshake storms, growing handles, cross-user access, credential leakage, provider bans/rate limits, or relay regressions. Disabling the feature flag must restore relay behavior without rebuilding the frontend.

## Supporting Original Design

This section preserves the original phase breakdown for context. Implement from the authoritative specification above. In particular, reuse the existing resolve endpoint, use the single classification contract above, and do not treat the current connection-playback-hardening test as full state-machine coverage.

## Objective

Make Stalker connections use the same user-facing flow as Xtream:

- The user logs in on HTTPS and enters the HTTP content screen at `http://40.233.113.76/content`.
- Catalog navigation stays inside the content screen.
- Clicking a Stalker item first attempts to obtain a fresh provider stream URL.
- The browser plays the provider URL directly when the provider permits it, so media bytes do not pass through the VPS.
- If the provider requires VPS-bound authentication, headers, cookies, or CORS handling, playback falls back to the existing VPS relay without breaking the UI.
- Reconnects obtain a fresh Stalker link instead of retrying an expired URL.

## Constraints

- Do not modify `/home/opc/StreamVault` or the production PM2 process.
- Feature deployment target is `/home/opc/StreamVault-Feature` and `stalker-proxy-play` on port `3201`.
- Keep SSRF protection and redirect validation enabled for every server-side request.
- Never expose Stalker MAC credentials, portal tokens, or raw provider credentials in analytics or error messages.
- Do not assume every Stalker portal implements the same authentication sequence.

## Existing Areas

Inspect these files before editing:

- `streamvault/src/App.jsx`
- `streamvault/src/components/Player.jsx`
- `streamvault/src/stream-routing.js`
- `streamvault/src/utils.js`
- `stalker-proxy/src/routes/stalker.js`
- `stalker-proxy/src/utils/proxyHelpers.js`
- `stalker-proxy/src/app.js`
- `stalker-proxy/src/routes/contentSession.js`
- `stalker-proxy/tests/stalker-router.test.js`
- `stalker-proxy/tests/routes.test.js`
- `stalker-proxy/tests/proxyHelpers.test.js`
- `stalker-proxy/test/security.test.js`

Read the current tests and preserve unrelated working-tree changes.

## Phase 1: Define Playback Contracts

1. Document the result shape for Stalker resolution:

   ```js
   {
     url: "https://provider.example/live/abc.ts",
     streamKind: "ts|hls|file|unknown",
     direct: true,
     fallbackUrl: "/stalker/play?...",
     expiresAt: null | number
   }
   ```

2. Use `streamKind` consistently. Do not infer a transport only from a missing file extension.
3. Preserve the existing item fields used by history, continue watching, subtitles, and multi-audio playback.
4. Provider media URLs are normally absolute. Keep application endpoints such as the relay fallback relative to the current content/API origin; do not hardcode the production domain.

## Phase 2: Backend Stalker Session Safety

1. Keep the handshake token, random value, portal path, MAC, and device options together in the session object.
2. Use normal handshake-only sessions by default. Do not run optional second-stage device authentication for every portal.
3. If a catalog or `create_link` call returns an authorization failure:

   - Attempt the portal-specific device-auth step once.
   - Retry the original request using the same session if device auth succeeds.
   - If device auth is rejected or invalidates the token, perform a clean handshake and retry once.
   - Stop after the bounded retry count.

4. Keep session refresh and failure caches bounded.
5. Never cache a generated media URL longer than its known provider lifetime. Cache portal path discovery separately from playback links.
6. Return structured errors for:

   - handshake failure
   - provider authorization failure
   - rate limiting
   - missing `create_link` URL
   - invalid or expired content session

## Phase 3: Stalker Stream Resolution

1. Extend the existing Stalker play route and resolve mode; do not create a duplicate endpoint.
2. In resolve mode, call the provider `create_link` endpoint and return JSON rather than piping media bytes:

   ```json
   {
     "url": "https://provider.example/path",
     "streamKind": "ts",
     "direct": true,
     "fallbackUrl": "/stalker/play?..."
   }
   ```

3. Validate the returned URL before returning it, and use checked redirect validation for every server-side relay fetch.
4. Preserve the existing relay route for providers that need VPS-side headers or session state.
5. Do not return a direct URL when the provider response requires private cookies or a server-only authorization header. Return a relay fallback instead.
6. Normalize relative, `ffmpeg`, and protocol-relative provider URLs safely.

## Phase 4: Frontend Content Flow

1. Ensure imported and saved Stalker connections enter `/content` directly, matching Xtream behavior.
2. Ensure a newly imported connection is hydrated before navigation. If validation fails, remain on setup and show the existing import-validation dialog.
3. In `App.jsx`, resolve Stalker playback on click:

   - request a fresh URL with `resolve=1`;
   - create a playing item containing `streamKind`, direct status, and relay fallback;
   - keep playback in the same content/player screen;
   - add the resolved item to history only after a usable URL exists.

4. For reconnect and media errors:

   - retry the direct URL only once if it may be transient;
   - request a fresh `create_link` URL on the next attempt;
   - use the relay fallback if direct playback fails;
   - prevent infinite direct/relay loops;
   - show a clear error with a retry action when both paths fail.

5. Apply the same behavior to live, catch-up, VOD, and series episodes.
6. Keep logout, disconnect, expired-session, and invalid-connection navigation consistent with production.

## Phase 5: Player Behavior

1. In `Player.jsx`, select HLS, MPEG-TS, or native file playback from `streamKind` and URL classification.
2. On HTTP content pages, allow HTTPS provider URLs to play directly.
3. On HTTPS pages, always proxy HTTP mixed content; HTTPS HLS/TS may also require proxy or relay because of CORS or provider policy. The primary direct-play target is the HTTP content page.
4. Do not proxy a Stalker URL merely because the connection type is Stalker; proxy only when the URL or provider requirements require it.
5. Preserve HLS manifest rewriting for relay playback so relative segments remain valid.
6. Preserve support for multi-audio tracks, subtitles, VOD files, and byte-range requests.
7. Surface useful diagnostics without logging credentials or full tokenized URLs.

## Phase 6: Tests

Add or update tests before deployment.

Backend tests:

- handshake preserves `random` and session metadata;
- legacy portal works without device-auth POST;
- authorization failure triggers one device-auth attempt;
- rejected device auth causes a clean handshake;
- rate limits stop retries and activate cooldown;
- `create_link` returns a validated direct URL;
- invalid, private, and redirect-to-private URLs are rejected;
- relative and `ffmpeg` URLs normalize correctly;
- resolve mode returns JSON and relay mode still streams;
- generated URLs are refreshed after expiration.

Frontend tests:

- imported Stalker connection opens `/content`;
- valid Stalker item opens the same player screen;
- direct playback is selected for a public HTTPS URL;
- relay fallback is selected after direct media failure;
- reconnect requests a new link;
- catch-up and series playback preserve start/end or episode parameters;
- invalid connection returns to setup with the validation dialog;
- logout and disconnect return to the HTTPS setup/login flow.

Run at minimum:

```text
npm test -- --run tests/proxyHelpers.test.js tests/stalker-router.test.js tests/routes.test.js
npm test -- --run tests/connection-playback-hardening.test.jsx
```

Also run the SSRF/security tests before deployment.

## Phase 7: Deployment and Verification

1. Review `git diff` and isolate only the intended files.
2. Build the frontend and verify every asset referenced by `streamvault/dist/index.html` exists.
3. Ensure frontend directories are executable/traversable by Nginx (`755`) and files are readable (`644`).
4. Copy only changed files to `/home/opc/StreamVault-Feature`.
5. Restart only `stalker-proxy-play` and reload the feature frontend if required.
6. Verify:

   - `http://127.0.0.1:3201/health` returns `200`;
   - `http://40.233.113.76/content` loads the current asset manifest;
   - a Stalker catalog request returns `200`;
   - resolve mode returns a fresh URL without streaming bytes through the resolve request;
   - direct playback is attempted from the browser;
   - relay fallback works for a provider requiring VPS headers;
   - production PM2 and `/home/opc/StreamVault` are unchanged.

7. Monitor feature logs for authorization loops, repeated handshakes, `502`, `ERR_CONTENT_LENGTH_MISMATCH`, and CPU growth.

## Rollback

Rollback only the changed feature files and restart `stalker-proxy-play`. Do not use `git reset --hard` on the shared worktree or VPS. If direct playback is unstable, disable direct resolution behind a feature flag and retain the existing relay flow.

## Completion Criteria

The work is complete when a Stalker user can import a connection, enter the HTTP content screen, browse content, play a valid stream in the same screen, reconnect using a fresh link, and fall back to relay when provider requirements prevent direct playback. All focused tests pass, feature health is green, and production remains untouched.

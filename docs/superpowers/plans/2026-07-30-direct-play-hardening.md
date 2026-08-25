# Direct Play Hardening and Test Plan

Date: 2026-07-30
Branch: feature/direct-play-no-proxy

## Objective

Harden Stalker authentication, passthrough parameters, SSRF responses, session extension, relay cleanup, error contracts, and playback recovery without changing the default direct-play path. Relay remains an explicit fallback.

## Recommended Order

Authentication must fail closed before parameter filtering. The allowlist must be built from existing provider requests and fixtures because Stalker portals use different fields for live, VOD, series, EPG, and catch-up.

1. Fail closed when Stalker authentication is unavailable.
2. Restrict and validate Stalker passthrough parameters.
3. Return structured SSRF rejection responses.
4. Make content-session TTL extension best effort.
5. Guarantee relay slot cleanup.
6. Normalize Stalker error codes.
7. Add backend security and relay-grant tests.
8. Extract and test Player recovery decisions.
9. Add critical playback lifecycle E2E coverage.
10. Add focused App orchestration tests.

## Phase 0: Baseline

Run backend and frontend tests. Add characterization coverage for current valid Stalker live, VOD, series, EPG, catch-up, resolve, relay, and relay-grant requests before changing contracts. Ensure test router factories provide explicit auth.verifyToken mocks.

Files:

- stalker-proxy/src/routes/stalker.js
- stalker-proxy/tests/stalker-router.test.js
- stalker-proxy/tests/routes.test.js

## Phase 1: Fail-Closed Authentication

Remove the silent auth.verifyToken bypass. If the auth dependency is missing or malformed, return HTTP 503 with code auth_unavailable. Use explicit dependency injection in tests instead of a production-sensitive NODE_ENV bypass. Preserve cookie, Bearer, and content-session authentication.

Tests must cover missing auth, missing verifyToken, invalid credentials, valid cookie/Bearer tokens, and valid content-session tokens.

## Phase 2: Parameter Allowlisting

Create stalker-proxy/src/services/stalkerRequestParams.js with route-specific pickStalkerParams and validateStalkerParams helpers.

Metadata fields should include type, action, category, page, p, period, fav, sortby, hd, not_ended, from_ch_id, and JsHttpRequest.

VOD and series fields should include movie_id, video_id, season_id, series, episode, episode_id, series_number, forced_storage, disable_ad, download, and force_ch_link_check.

Live and catch-up fields should include cmd, content_type, channel_id, program_id, start, end, utc, duration, and archive.

Reject unknown fields with HTTP 400 and code invalid_parameter. Validate lengths, numeric values, arrays, nested objects, and prototype-pollution keys. Do not forward portal, mac, serial, or device credentials as arbitrary upstream parameters. Do not log tokens or credentials.

Use non-production observation mode only if needed to discover legitimate fields, then enable strict rejection after provider verification.

## Phase 3: Structured SSRF Responses

Replace blank 403 responses from stream URL validation with JSON containing error Stream URL not allowed and code url_not_allowed. Apply consistently to portals, resolved streams, redirects, images, and relay targets.

Test loopback, private targets, redirects to private targets, valid public targets, and sanitized responses.

## Phase 4: Best-Effort Session Extension

Wrap near-expiry extendByTokenHash calls in try/catch. A transient database failure must not turn a valid request into 502. Log sanitized context and increment a metric. Do not extend expired sessions.

Test successful extension, false return, database rejection, expired sessions, and corrupted encrypted JSON.

## Phase 5: Relay Slot Cleanup

Refactor relay accounting into an idempotent lease helper, preferably stalker-proxy/src/services/stalkerRelaySlots.js. Release on finish, close, upstream abort, fetch failure, pipeline error, and timeout. The timeout must abort the controller and release the slot. Clamp relay duration to safe minimum and maximum values.

Use fake timers to test normal completion, client close, fetch failure, timeout, double cleanup, and reacquisition after timeout.

## Phase 6: Error Contracts

Create a shared Stalker error mapper. Preserve frontend-compatible status codes while returning stable codes such as malformed, unauthorized, authorization_failure, url_not_allowed, content_not_found, media_relay_disabled, expired, rate_limited, relay_concurrency_limited, provider_failure, auth_unavailable, and provider_timeout.

When headers are already sent, record sanitized metrics, abort the stream, and release resources instead of attempting another JSON response.

## Phase 7: Backend Tests

Test relay-grant creation and verification: authentication, disabled relay, missing confirmation, missing secret, valid grants, expired grants, modified grants, command mismatch, session binding, and direct resolve without a grant.

Add tests for all error codes, SSRF rejection, malformed sessions, route parameter rejection, content-session extension failure, and relay cleanup.

## Phase 8: Player Recovery

Existing Player tests cover several callbacks but not the complete state machine. Extract pure recovery decisions from Player.jsx into streamvault/src/player-recovery.js.

Cover bounded HLS retry, MPEG-TS reconnect, fresh URL refresh, explicit relay request, terminal failure, manual retry, healthy-progress counter reset, channel generation cancellation, player-close cancellation, VOD position preservation, and live/VOD position separation.

Use fake timers and deferred promises to prove stale callbacks cannot replace a newer channel.

## Phase 9: Playback E2E

Use mocked providers for deterministic CI and real providers only in canary tests. Add tests for channel switching during playback, VOD seeking and resume, disconnect during playback, logout during playback, recovery exhaustion, spinner termination, and manual retry. Confirm old media requests stop after navigation or logout.

## Phase 10: App Tests

Add focused App orchestration tests with mocked child components and APIs for login to Setup, connection selection, content-session creation, expired-session return to secure Setup, disconnect, switch connection, logout, settings propagation, social account links, and guest/free account restrictions.

If direct App mounting is too brittle, extract session/navigation logic into a focused hook and retain a small App smoke suite.

## Verification

Backend:

- cd stalker-proxy
- npm test
- npm run lint

Frontend:

- cd streamvault
- npm test
- npm run lint
- npm run build with VITE_SECURE_APP_BASE_URL set

E2E:

- npm run e2e
- npx playwright test --config=playwright.canary.config.js

## Commit Order

1. security: fail closed when Stalker auth is unavailable
2. security: validate Stalker passthrough parameters
3. api: return structured Stalker security errors
4. fix: tolerate content-session extension failures
5. fix: guarantee Stalker relay slot cleanup
6. refactor: normalize Stalker route errors
7. test: cover Stalker relay grants
8. refactor: extract Player recovery decisions
9. test: cover Player recovery state transitions
10. test: add critical playback lifecycle E2E flows
11. test: cover App authentication and content sessions

## Rollout

Deploy phases 1 through 7 to non-production first. Verify at least two Stalker portals across live, VOD, series, EPG, catch-up, direct playback, and explicit relay fallback. Monitor authentication failures, rejected parameters, SSRF rejections, session extension failures, relay acquisition and release counts, relay timeouts, provider failures, and recovery exhaustion.

Do not deploy production until non-production shows no legitimate provider fields being rejected and relay slots remain stable during long-running playback.

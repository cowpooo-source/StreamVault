# Stalker Live Catalog Compatibility Design

## Status

Approved design direction. This specification is ready for implementation planning after user review.

## Problem

Some Stalker portals authenticate successfully and return live genres, but return an empty successful response from `get_ichannels_via_api` for both the aggregate category and real genre IDs. The lazy catalog currently treats that response as a valid empty page.

The sandbox reproduction against `main.light-ott.net` demonstrated the failure precisely:

- validation succeeded and the account was active;
- live categories returned HTTP 200 with a populated genre list;
- live item requests for `all`, `3010`, and `5` returned HTTP 200 with `items: []`;
- no authorization, cooldown, timeout, or provider error was reported.

The repository already contains a streaming `get_all_channels` parser and a shared `bounded_live_snapshot` store. However, the route only activates that fallback for an explicit aggregate snapshot request. Tests currently require real-category requests to return an empty page without trying the fallback. That behavior conflicts with the shared-snapshot design and makes valid portals appear to have no channels.

## Goal

Load live channels from portals that do not implement usable `get_ichannels_via_api` pages while preserving lazy user experience, bounded VPS memory, provider cooldown behavior, and one shared upstream scan per Stalker connection identity.

## Non-Goals

- Do not change VOD or series loading.
- Do not change Xtream or M3U behavior.
- Do not buffer a complete live catalog in one JavaScript array or SQLite value.
- Do not start one `get_all_channels` scan per category.
- Do not bypass content-session authorization, SSRF policy, rate limits, or provider cooldowns.
- Do not change legacy Stalker behavior when lazy catalog is disabled.
- Do not increase the existing bounded live-channel item limit as part of this change.

## Chosen Architecture

Reuse the existing two live catalog modes:

- `provider_pages`: `get_ichannels_via_api` returns usable pages.
- `bounded_live_snapshot`: provider pages are unsupported or empty, so one shared streaming `get_all_channels` scan supplies every live category.

Do not add a third compatibility mode. The existing `bounded_live_snapshot` contract already describes the required fallback and is understood by the backend cache, frontend, metrics, and tests.

The fallback uses the existing streaming parser. It normalizes channels incrementally, stores bounded channel chunks plus category references, and releases a waiting page as soon as enough matching items are available. The scan may continue in the background to complete the shared snapshot, but all later category requests join or read that same snapshot instead of calling the provider again.

## Connection Identity

Capability and snapshot state remain scoped by the canonical Stalker identity:

- normalized portal URL;
- normalized MAC address;
- serial;
- `deviceId`;
- `deviceId2`.

Two device profiles using the same portal and MAC must not share capability decisions, cached pages, snapshot references, or playback-reference bindings.

## Compatibility Detection

For live page 1 in `provider_pages` mode:

1. Call `get_ichannels_via_api` with the requested category and page.
2. If it returns one or more channel items, keep `provider_pages` mode and return the normalized page.
3. If it returns an empty successful payload, treat the result as inconclusive until live genres are considered.
4. If the connection has one or more non-aggregate live genres, classify live pagination as unsupported and switch the connection identity to `bounded_live_snapshot`.
5. Build or join the shared live snapshot and return the requested category page from it.

An empty page must not activate the fallback when the provider genuinely has no live genres. This avoids turning an actually empty account into an expensive scan.

For page 2 or later, a repeated or empty provider page continues to use the existing pagination capability logic. If page 1 was previously non-empty, normal end-of-pagination must not be reclassified as provider incompatibility.

## Category Evidence

The categories response is the authoritative evidence that live content is expected. The backend category cache should expose enough internal metadata to answer whether at least one non-aggregate genre exists without making another provider call.

The public categories response remains unchanged. Internal evidence may be stored alongside the category cache entry or derived from its normalized category array.

If a live item request arrives before categories have been loaded, the backend may fetch or join the normal categories request through the metadata coordinator. It must not issue duplicate concurrent `get_genres` calls for the same connection identity.

## Shared Snapshot Flow

When compatibility fallback activates:

1. Persist capability `{ pagination: "unsupported", mode: "bounded_live_snapshot" }` for the connection identity and live kind.
2. Use a work key containing only the connection identity and live snapshot generation. Category and browser page size must not be part of the work key.
3. Start or join one `get_all_channels` streaming request.
4. For each channel, store a command-free normalized item and append references for both `all` and its provider category ID.
5. Resolve a waiting request once its requested page is available, or when the scan completes with fewer items.
6. Continue the shared scan within existing limits so later categories are served from the same snapshot.
7. Materialize short-lived opaque playback references only when returning a page to an authorized content session.

The process must retain only parser state and the current bounded chunk in memory. It must not accumulate every raw or normalized channel in process memory.

## Caching and Freshness

- Keep the existing 30-day live catalog TTL unless manually refreshed.
- Persist the unsupported provider capability for the same live TTL so each request does not reprobe `get_ichannels_via_api`.
- Keep browser IndexedDB pages owner- and connection-scoped under existing storage limits.
- Do not persist raw commands, content tokens, portal credentials, MAC addresses, or resolved media URLs in browser catalog records.
- Manual live refresh invalidates provider-page caches, capability state, snapshot manifest/chunks, and the live snapshot generation for only that connection identity.
- A failed manual refresh retains previously completed cached data and reports a retryable error instead of replacing it with an empty catalog.

## Concurrency and Resource Limits

- The metadata coordinator remains the gate for provider metadata work.
- Concurrent category requests for one incompatible connection join one snapshot build.
- The existing provider cooldown and request queue limits apply before starting fallback work.
- The existing live catalog item limit remains the hard cap.
- The streaming response must be aborted when the cap is reached, the build generation is invalidated, the provider times out, or the service shuts down.
- Client disconnect must detach that waiter without cancelling a shared build still needed by other waiters.
- A failed build must release all waiters and remove its in-flight registration.

## Error Handling

Do not fallback for terminal or protective failures:

- `401` or provider authorization failure;
- `403` or device rejection;
- `429` or active provider cooldown;
- request abort;
- metadata coordinator saturation;
- SSRF rejection;
- malformed content-session authorization.

Fallback is allowed only for:

- an empty successful live provider-page response when populated live genres prove that content is expected;
- HTTP `404`, `405`, or `501` returned specifically for the `get_ichannels_via_api` action;
- an explicit provider payload stating that `get_ichannels_via_api` is unknown or unsupported.

Generic network failures, malformed non-empty JSON, HTTP `5xx`, and metadata-size failures must not independently switch capability mode. They retain their existing structured error behavior.

If `get_all_channels` also returns no channels, return a valid empty completed page and retain a five-minute negative-cache result to prevent immediate repeated scans. Persist the 30-day unsupported capability only after the fallback yields at least one usable channel. A failed, malformed, or genuinely empty fallback remains provisional and may be retried after the five-minute negative cache expires.

If the shared scan exceeds its limit, return the bounded items already indexed with `truncated: true` and expose a sanitized warning. If no usable page can be produced, return the existing structured provider or catalog error with `Retry-After` when available.

## User Experience

- Categories remain visible while channels are loading.
- The selected category shows `Preparing live catalog for this provider` when a shared fallback scan is active.
- Other category clicks do not start new provider scans; they wait on the same build and may display their own bounded loading state.
- Empty results are shown only after the provider-page path and compatibility fallback both establish that the selected category has no channels.
- Manual refresh clearly reports cooldown duration and keeps stale channels visible when available.

No frontend API contract changes are required. Existing page fields, capabilities, `hasMore`, `nextPage`, and `playRef` behavior remain intact.

## Security and Privacy

- All catalog routes continue to require an authorized content session or authenticated direct request.
- Snapshot and capability keys use only the canonical identity hash.
- Logs and metrics must not contain portal URLs, MAC addresses, device IDs, raw commands, playback tokens, or content-session tokens.
- Opaque playback references remain bound to the same canonical connection identity.
- Provider redirects and URLs continue through existing SSRF and protocol validation.

## Metrics

Add or verify sanitized counters for:

- empty provider-page compatibility detections;
- switches from `provider_pages` to `bounded_live_snapshot`;
- shared snapshot starts, joins, completions, failures, and aborts;
- waiters resolved before full snapshot completion;
- channels indexed and snapshots truncated;
- cached capability and snapshot hits;
- fallback suppression for authorization, cooldown, rate limit, and coordinator saturation.

Metrics must be keyed by route/result class only, never provider identity.

## Rollout

1. Implement behind the existing `STALKER_LAZY_CATALOG_ENABLED` gate.
2. Run focused backend unit and route tests, full backend regression, frontend lazy-catalog tests, lint, and production build.
3. Deploy to sandbox only.
4. Verify the known incompatible portal loads categories and channels, while a known provider-page portal still makes only page requests.
5. Monitor snapshot duration, item counts, provider failures, rate limits, CPU, RSS, and event-loop latency.
6. Promote only after sandbox confirms one shared scan and no regression to VOD, series, playback, or content-session behavior.

Rollback consists of deploying the previous release. The feature flag may also be disabled to restore legacy catalog behavior, but frontend and backend lazy flags must remain aligned.

## Test Strategy

### Backend unit and route tests

- Empty `get_ichannels_via_api` page plus populated live genres activates one shared snapshot.
- A real category request can activate the shared snapshot; it no longer returns a cached false-empty page.
- `all` and real-category requests join the same work key.
- Concurrent categories create exactly one `get_all_channels` call.
- A waiting category page resolves before full snapshot completion when enough matches are indexed.
- A non-empty provider page remains in `provider_pages` mode and never calls `get_all_channels`.
- Empty provider page plus no non-aggregate genres returns a valid empty page without a snapshot.
- Page 2 end-of-pagination does not switch a previously valid provider-page portal to snapshot mode.
- Authorization, `403`, `429`, cooldown, abort, and coordinator-busy errors do not trigger fallback.
- Manual refresh invalidates all live snapshot page sizes and generations without allowing stale publication.
- Snapshot failure releases the in-flight entry and permits a later bounded retry.
- Cache records and returned pages contain no raw commands or credentials.
- Lazy-disabled route behavior remains unchanged.

### Frontend tests

- Categories remain rendered while a live snapshot page is pending.
- The compatibility loading message appears only for `bounded_live_snapshot` work.
- Category changes during one build do not trigger legacy aggregate endpoints.
- A cooldown response retains stale items and displays the retry duration.
- Empty-state UI appears only after the final completed response.

### Sandbox verification

- `main.light-ott.net` with the supplied test MAC validates successfully.
- Live genres load.
- `all` and at least two real categories return non-empty pages when the provider has channels.
- Browser requests use `/stalker/catalog/v1/*`; no `/stalker/channels` aggregate request appears.
- Only one `get_all_channels` scan is recorded while switching among categories.
- CPU, RSS, and event-loop latency remain within the existing sandbox alert thresholds.

## Acceptance Criteria

- AC-1: A portal with populated live genres and empty `get_ichannels_via_api` pages loads channels through `bounded_live_snapshot`.
- AC-2: Two simultaneous categories for one connection identity create one upstream `get_all_channels` scan.
- AC-3: A requested category page can become available before the complete snapshot finishes.
- AC-4: The fallback never creates a complete in-memory channel array or one oversized SQLite value.
- AC-5: Provider-page-compatible portals remain lazy and do not call `get_all_channels`.
- AC-6: Authorization, rate-limit, cooldown, SSRF, and abort failures never trigger compatibility scans.
- AC-7: Manual refresh cannot republish stale snapshot data and does not erase usable stale data on failure.
- AC-8: VOD, series, Xtream, M3U, playback routing, and legacy lazy-disabled behavior are unchanged.
- AC-9: Catalog and browser caches contain no raw commands, credentials, or session tokens.
- AC-10: Focused tests, full backend and frontend tests, lint, production build, and sandbox smoke verification pass before production deployment.

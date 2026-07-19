# Stalker Direct Browser Compatibility Plan

## Objective

Build a browser-based Stalker client where the VPS handles authentication and metadata only. Live, VOD, series, and catch-up media should flow directly from the provider or CDN to the user's browser.

Media relay through `/stream` is disabled by default and available only as an explicit emergency compatibility option.

## Architecture

| Layer | Responsibility | Media bytes allowed |
|---|---|---:|
| HTTPS application | Login, setup, connections, content-session creation | No |
| VPS Stalker API | Handshake, profile, catalogs, EPG, `create_link`, URL normalization | No |
| HTTP content application | Content browsing and browser player | No |
| Provider/CDN | HLS manifests, segments, MPEG-TS, MP4/MKV | Yes |
| VPS `/stream` relay | Exceptional compatibility fallback | Disabled by default |

## Playback Policy

Add these settings:

```env
STALKER_PLAYBACK_MODE=direct_only
STALKER_DIRECT_PLAY_ENABLED=true
STALKER_MEDIA_RELAY_ENABLED=false
STALKER_REDIRECT_RESOLUTION=head
STALKER_ALLOW_RANGE_REDIRECT_PROBE=false
```

Supported modes:

| Mode | Behavior |
|---|---|
| `direct_only` | Never relay media through VPS |
| `direct_preferred` | Attempt direct playback and offer relay only after explicit confirmation |
| `relay_allowed` | Automatic compatibility relay for controlled environments only |

The feature branch defaults to `direct_only`.

## 1. Establish Baseline Fixtures

Create sanitized fixtures in `stalker-proxy/tests/fixtures/stalker/`:

```text
handshake-standard.json
handshake-random.json
profile-legacy.json
profile-device-bound.json
channels-standard.json
channels-internal-id.json
create-link-cmd.json
create-link-url.json
create-link-id-token.json
create-link-live-token.json
create-link-localhost.json
create-link-ffrt.json
vod-movie-standard.json
vod-numeric-catalog.json
series-array.json
series-episode-records.json
redirect-hls.json
```

Remove real MAC addresses, credentials, active tokens, customer URLs, and personal data. Tests must not depend on live providers.

## 2. Extract a Stalker Link Resolver

Create:

```text
stalker-proxy/src/services/stalkerLinkResolver.js
stalker-proxy/src/services/stalkerResponseNormalizer.js
stalker-proxy/src/services/stalkerDirectPolicy.js
```

`normalizeCreateLinkResponse(payload, context)` must support:

- `js.cmd`
- `js.url`
- `js.id` plus `js.play_token`
- Constructed `/play/movie.php?mac=...&stream=...&play_token=...` URLs

Return:

```js
{
  url,
  streamKind,
  commandKind,
  expiresAt,
  tokenized,
  headersRequired,
  sourceShape
}
```

Strip `ffmpeg` and `ffrt`, preserve query strings, resolve protocol-relative URLs, replace `localhost` only after `create_link`, reject UDP/RTP/RTSP, and never log complete tokenized URLs.

## 3. Implement Bounded `create_link` Strategies

### Live

1. Submit the original `get_all_channels.cmd`.
2. Preserve the provider's internal `/ch/{id}` instead of substituting the catalog ID.
3. Refresh `get_all_channels` once for stale tokenized links.
4. Select by catalog `channel_id`.
5. Submit the refreshed command.
6. Try fabricated `ffrt http:///ch/{id}` only as a legacy fallback.
7. Stop after the bounded strategy list.

### VOD

1. Submit the original item command.
2. For `/media/{catalogId}.mpg`, load the selected movie record.
3. Submit the record's actual command.
4. Try `ffmpeg {cmd}` if needed.
5. Support `/media/file_{id}.mpg` when a file ID is exposed.
6. Normalize `js.url` and `js.id` plus `js.play_token`.

### Series

1. Use an episode's `cmd` when present.
2. Preserve `episode_id`, `season_id`, `series_number`, and `video_id`.
3. Use `series={series_number}` only for numeric episode portals.
4. Use episode IDs only when the provider makes them playable.
5. Never assume catalog IDs equal storage IDs.

Maximum three portal calls per resolution. Stop immediately on HTTP `429`.

## 4. Define a Stable Resolve Contract

Update `GET /stalker/play?resolve=1` to return:

```json
{
  "url": "http://provider-or-cdn/stream.m3u8",
  "streamKind": "hls",
  "direct": true,
  "directCapability": "browser_candidate",
  "expiresAt": 1784429982,
  "refreshable": true,
  "generation": "opaque-generation-id",
  "relayAvailable": false,
  "warnings": []
}
```

Capability values:

```text
browser_candidate
cors_risk
headers_required
ip_bound_suspected
unsupported_protocol
unsupported_codec
invalid_response
```

Do not return a media relay URL when relay is disabled. Return an opaque control-plane refresh URL instead.

## 5. Separate Redirect Resolution From Streaming

Create `POST /stalker/resolve-redirect`.

Rules:

1. Use `HEAD` with manual redirects.
2. Validate every destination for SSRF.
3. Limit redirects to five.
4. Preserve the provider's HTTP or HTTPS scheme.
5. Reject private, loopback, metadata, and link-local destinations.
6. Do not forward portal authorization headers to CDN hosts.
7. Do not download response bodies.
8. Do not use range GET in `direct_only` mode.

If a provider rejects `HEAD`, return `redirect_resolution_unsupported` rather than silently relaying media. Range probing is allowed only in `direct_preferred` mode.

## 6. Complete Device Authentication Compatibility

In `stalker-proxy/src/utils/proxyHelpers.js`, create `buildStalkerProfileParams(session, device)` and support:

```text
sn
stb_type
client_type
image_version
video_out
device_id
device_id2
signature
auth_second_step
hw_version
hw_version_2
not_valid_token
metrics
timestamp
ver
num_banks
```

Authentication sequence:

1. Handshake.
2. Store token, random, and not-valid state.
3. Attempt a normal catalog request.
4. Run second-step authentication only when required.
5. Retry once.
6. Perform one new handshake if authorization still fails.
7. Stop after the refreshed request.
8. Respect `429` cooldown.

POST requests must use `application/x-www-form-urlencoded; charset=utf-8`.

## 7. Rebuild Series and Episode Normalization

Create `stalker-proxy/src/services/stalkerSeriesNormalizer.js`.

Normalize seasons and episodes while supporting numeric arrays, episode objects, flat episode rows, null commands, parent movie commands, and series exposed through VOD.

Fallback order:

1. `type=series`.
2. `type=vod` with series metadata.
3. VOD categories identified as series categories.
4. Mark unsupported without an infinite loading state.

The frontend must pass the complete episode object instead of only an episode number.

## 8. Add Catch-Up Strategy Support

Create `stalker-proxy/src/services/stalkerCatchupResolver.js`.

Normalize channel ID, command, start timestamp, end timestamp, duration, and program ID. Support `start/end`, `utc/duration`, archive, timeshift, and provider commands from EPG records. Return the same direct playback contract as live streams.

## 9. Make Frontend Playback Direct-Only Aware

Update:

```text
streamvault/src/App.jsx
streamvault/src/components/Player.jsx
streamvault/src/stream-routing.js
streamvault/src/stream-classifier.js
```

Playback states:

```text
RESOLVING
DIRECT_LOADING
DIRECT_PLAYING
DIRECT_REFRESHING
DIRECT_RETRYING
DIRECT_INCOMPATIBLE
FAILED
```

Recovery order:

1. Restart HLS or MPEG-TS.
2. Request one fresh provider link.
3. Resolve a redirect through the metadata endpoint.
4. Load the fresh direct URL.
5. Retry at most three times in 60 seconds.
6. Show a compatibility error instead of automatically activating `/stream`.

VOD reloads preserve `currentTime`; normal `ended` events never trigger reconnection. Live playback refreshes at the live edge.

## 10. Remove Automatic Relay Paths

Audit and remove automatic Stalker transitions to `/stream?url=` and media relay fallbacks. Replace `_stalkerFallbackUrl` with `_stalkerRefreshUrl`.

If emergency relay is enabled, require explicit user confirmation, a short-lived signed grant, a visible compatibility-relay indicator, bandwidth limits, duration limits, and concurrency limits. Unsigned Stalker media relay requests must be rejected.

## 11. Improve Caching

Recommended TTLs:

| Data | TTL |
|---|---:|
| Portal path | 24 hours |
| Handshake session | 5–15 minutes |
| Live channels | 6 hours |
| Categories | 24 hours |
| VOD and series lists | 12 hours |
| EPG | 15–60 minutes |
| Resolved media URL | Never |
| Playback token | Never persist |

Use stale-while-refresh for catalogs. Never persist signed media URLs or play tokens. Replace the fixed 500-item limit with incremental pagination and a configurable safety ceiling.

## 12. Add Security Controls

Required controls:

- Content-session authorization on every Stalker endpoint.
- Opaque content tokens; never expose portal or MAC on the HTTP content page.
- SSRF and DNS-rebinding protection on portals and redirects.
- No authorization forwarding across host changes.
- Token and MAC redaction in logs.
- Catalog response-size limits.
- Redirect count limits.
- Per-provider concurrency and `429` cooldowns.
- Abort metadata requests when the browser disconnects.

Add `sanitizeStalkerUrl(url)` to redact MACs, tokens, authorization, serials, device IDs, usernames, and passwords.

## 13. Add Media-Flow Audit Metrics

Track control requests, create-link calls, direct attempts, direct successes, refreshes, incompatibilities, redirect resolutions, relay requests, and relay bytes.

In `direct_only` mode, the required invariant is:

```text
stalker_media_relay_requests_total = 0
stalker_media_relay_bytes_total = 0
```

Do not use provider URLs or credentials as metric labels.

## 14. Test Matrix

### Backend

- Every create-link response shape.
- `ffmpeg` and `ffrt` normalization.
- Catalog ID versus internal channel ID.
- `localhost` replacement.
- ID plus play-token construction.
- Numeric and object-based series episodes.
- Series-through-VOD fallback.
- Device profile parameter generation.
- Redirect SSRF rejection.
- Strict mode refusing range probes.
- POST form content type.
- URL and credential redaction.
- `429`, HTML responses, empty responses, and unsupported series APIs.

### Frontend

- Direct HLS, MPEG-TS, and VOD playback.
- Silent live stall refresh.
- Expired VOD refresh with position restoration.
- Redirect-resolution requests.
- Three-attempt recovery ceiling.
- Normal VOD completion without reconnect.
- No automatic `/stream` requests.
- Direct-incompatible error display.
- Multi-audio and subtitle retention after refresh.

### Browser verification

Confirm in Chrome DevTools that media requests target only the provider/CDN, HLS segments remain direct, VOD range requests remain direct, refresh returns a new provider URL, and credentials never appear in browser URLs or IndexedDB.

## 15. Rollout

1. Deploy response normalization with existing relay behavior unchanged.
2. Enable direct-only mode for internal accounts.
3. Record direct success and incompatibility reasons.
4. Test multiple portal response families.
5. Enable direct-only for guest accounts.
6. Keep emergency relay disabled.
7. Monitor for seven days.
8. Enable direct-only for all feature users.
9. Compare feature metrics against production.
10. Promote only after relay requests and relay bytes remain zero.

## Suggested Commits

```text
1. Add Stalker playback fixtures and normalized link contract
2. Normalize all Stalker create_link response variants
3. Add bounded live and VOD link strategies
4. Complete Stalker profile and device authentication
5. Normalize Stalker seasons and episodes
6. Add series-through-VOD compatibility fallback
7. Add direct catch-up link resolution
8. Enforce direct-only frontend playback state machine
9. Remove automatic Stalker media relay fallback
10. Add cache TTL and incremental pagination
11. Add SSRF, credential-redaction, and relay-blocking tests
12. Add direct-play audit metrics and rollout controls
```

## Definition Of Done

- Stalker media never travels through VPS in `direct_only` mode.
- Every playback starts from a normalized provider/CDN URL.
- Reconnection obtains a fresh direct URL without activating `/stream`.
- Common create-link response formats work.
- Catalog and provider stream IDs remain distinct.
- VOD ID/token responses work.
- Series supports numeric and object-based episodes.
- Strict device-auth portals have a compatible profile flow.
- Unsupported browser/provider combinations fail clearly.
- Metrics prove zero VPS relay requests and zero relay bytes.

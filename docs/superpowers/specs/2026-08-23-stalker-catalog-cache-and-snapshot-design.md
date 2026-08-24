# Stalker Catalog Cache and Shared Snapshot Design

## Goal

Make Stalker catalog browsing responsive while preventing duplicate provider scans, excess VPS CPU/RSS use, and provider rate-limit incidents. Catalog metadata is cached for 48 hours; resolved media URLs and playback commands are never catalog-cached.

## Current Problem

Some Stalker portals return an empty or unsupported response from `get_ichannels_via_api`. The current fallback streams `get_all_channels` and filters it for the requested category. It keeps only the requested page in memory, but each category request can independently parse most or all of the upstream live catalog. Opening two categories therefore creates two expensive scans.

## Chosen Design

### Provider Modes

Each normalized Stalker connection and catalog kind has a persisted capability record:

- `provider_pages`: the provider returns usable category/page results; requests fetch and cache only the requested page.
- `bounded_live_snapshot`: the live provider ignores or does not implement category/page queries. A single shared scan produces page chunks and a category index for the whole connection.
- `first_page_only`: reserved for VOD/series providers that demonstrably ignore pagination. VOD and series never receive a full-catalog fallback.

An empty live page from the provider-specific endpoint immediately selects `bounded_live_snapshot`; the system does not require separate category scans or a page-two probe before doing so.

### Shared Live Snapshot

The snapshot identity includes normalized portal, MAC, serial, `deviceId`, and `deviceId2`. Its work key excludes category and page size, so all live-category requests for the same connection join one scan.

The scan streams `get_all_channels` and:

- stores normalized, command-free items in bounded SQLite page chunks;
- records an index from category ID to chunk/page references;
- keeps only parser state and the current output chunk in process memory;
- is capped at 50,000 items;
- releases waiting category requests when their requested page is available, or after the scan completes;
- rejects additional provider work through the existing metadata coordinator rather than starting concurrent scans.

The first unsupported-portal category may still take one provider scan. Subsequent categories, reconnects, and browsers use the completed shared snapshot.

### Cache Policy

All TTLs apply to catalog metadata only.

| Data | VPS SQLite | Browser IndexedDB |
| --- | --- | --- |
| Live snapshot/pages | 48 hours | 48 hours |
| VOD pages | 48 hours | 48 hours |
| Series pages | 48 hours | 48 hours |
| Categories | 48 hours | 48 hours |
| Provider capability | 48 hours | Not stored |
| EPG | 30 minutes | Optional transient cache only |

The browser cache remains owner- and connection-scoped, has its existing 75 MiB/1,000-record limits, and contains no raw commands, portal credentials, content tokens, or resolved stream URLs. It is not uploaded to the VPS. The VPS SQLite cache is shared only through the connection identity hash.

### Freshness and Invalidation

- Cached metadata is shown immediately when available.
- Manual refresh invalidates only the selected kind/category or the live snapshot scope.
- Authentication failures, provider authorization failures, connection edits, and connection deletion invalidate the affected scope.
- Playback references are rehydrated from the current catalog page and retain their existing short expiry; they are excluded from persisted browser records.
- Failed refreshes retain the prior catalog and present a non-blocking stale-data message.

### User Experience

- Initial Stalker loading remains sequential: live, VOD, series.
- Provider-page portals show a normal category spinner.
- Snapshot portals show `Preparing live catalog for this provider` while the one shared scan runs.
- Category controls remain usable, but duplicate requests join the scan rather than creating work.
- Completed category pages appear as soon as their snapshot data is available.
- VOD and series remain explicit page/category loading; no automatic crawl.

### Metrics and Safety

Record sanitized metrics for snapshot start/completion/failure, duration, item count, response bytes, joined waiters, cache hits, and queue rejections. Do not include portal URLs, MACs, commands, tokens, or search text. Preserve existing provider cooldowns, rate-limit handling, content-session authorization, and 50,000-item cap.

## Xtream Alignment

Xtream currently has browser-only catalog caches with no enforced automatic expiry and no catalog cache on the VPS. This change does not alter Xtream. A later separate change may apply the same 48-hour stale-while-refresh policy to Xtream browser data.

## Acceptance Criteria

- Two simultaneous live category requests for an unsupported portal create one upstream `get_all_channels` scan.
- The scan does not create a 50,000-item JavaScript array or a single large SQLite value.
- A second category request during or after the scan does not call the provider again.
- Provider-page live portals continue to request only the selected page.
- VOD and series never fall back to a complete provider crawl.
- Server and browser catalog TTLs are 48 hours; EPG remains short-lived.
- Manual refresh and connection changes invalidate only affected catalog scopes.
- Legacy behavior remains unchanged when lazy catalog flags are disabled.
- Tests cover coalescing, partial snapshot availability, TTL, invalidation, category switching, 429/cooldown, and no sensitive browser persistence.

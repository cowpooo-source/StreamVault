# Stalker Oversized Channel Catalog Design

## Problem

Some Stalker portals return more than 50 MiB from `get_all_channels`. The proxy correctly stops reading at `STALKER_CHANNELS_MAX_BYTES`, but `/stalker/channels` currently exposes that protection as a terminal 502 even when the portal offers the paginated `get_ichannels_via_api` action.

## Design

Keep `get_all_channels` as the primary path for compatibility and cache behavior. If that request fails specifically because its response exceeds the configured metadata limit, fetch `get_ichannels_via_api` page by page. Stop at the provider's reported last page, an empty page, or `STALKER_CATALOG_MAX_ITEMS`, whichever comes first.

Each fallback request remains subject to `STALKER_METADATA_MAX_BYTES`, upstream timeouts, metadata concurrency limits, request deduplication, and the request abort signal. Unrelated provider failures are returned unchanged rather than being hidden by the fallback.

Normalize both response shapes into the existing channel response contract and keep genre mapping, opaque commands, cache sanitation, and catalog TTL behavior unchanged.

## Error Handling

If the paginated action is unsupported or fails, return the original oversized-catalog error with a `catalog_too_large` code so clients can distinguish it from generic provider failures. Do not increase the 50 MiB channel response limit.

## Tests

- A normal `get_all_channels` response does not invoke the fallback.
- A size-limit failure falls back to multiple `get_ichannels_via_api` pages and combines their channels.
- Pagination stops at `STALKER_CATALOG_MAX_ITEMS`.
- A non-size provider failure does not invoke the fallback.
- A failed fallback returns `catalog_too_large`.

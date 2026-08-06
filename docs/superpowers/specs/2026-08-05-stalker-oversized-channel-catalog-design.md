# Stalker Oversized Channel Catalog Design

## Problem

Some Stalker portals return more than 50 MiB from `get_all_channels`. Some of those portals also ignore pagination parameters and return an empty response from `get_ichannels_via_api`, so neither buffered loading nor server-side pagination is reliable.

## Design

Stream-parse `get_all_channels` as the primary production path and stop after `STALKER_CATALOG_MAX_ITEMS` channel objects. This avoids buffering the full response and closes the upstream body once the bounded catalog is complete.

If streaming is unavailable or malformed, preserve the buffered `get_all_channels`, paginated `get_all_channels`, and paginated `get_ichannels_via_api` paths as compatibility fallbacks. All requests retain upstream timeouts and browser abort propagation.

Normalize both response shapes into the existing channel response contract and keep genre mapping, opaque commands, cache sanitation, and catalog TTL behavior unchanged.

## Error Handling

If the paginated action is unsupported or fails, return the original oversized-catalog error with a `catalog_too_large` code so clients can distinguish it from generic provider failures. Do not increase the 50 MiB channel response limit.

## Tests

- A chunked `get_all_channels` response is stream-parsed and stops at the item limit.
- Production routing uses streaming before buffered or paginated fallbacks.
- A size-limit failure can still fall back to paginated provider actions.
- Pagination stops at `STALKER_CATALOG_MAX_ITEMS`.
- A non-size provider failure does not invoke the fallback.
- A failed fallback returns `catalog_too_large`.

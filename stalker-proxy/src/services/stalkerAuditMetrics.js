const COUNTERS = [
  'stalker_control_requests_total',
  'stalker_create_link_calls_total',
  'stalker_direct_attempts_total',
  'stalker_direct_successes_total',
  'stalker_direct_refreshes_total',
  'stalker_direct_incompatibilities_total',
  'stalker_redirect_resolutions_total',
  'stalker_media_relay_requests_total',
  'stalker_media_relay_bytes_total',
  'stalker_media_relay_blocked_total',
  'stalker_catalog_requests_total',
  'stalker_catalog_upstream_calls_total',
  'stalker_catalog_cache_hits_total',
  'stalker_catalog_coalesced_total',
  'stalker_catalog_aborted_total',
  'stalker_catalog_rate_limited_total',
  'stalker_live_snapshot_started_total',
  'stalker_live_snapshot_joined_total',
  'stalker_live_snapshot_completed_total',
  'stalker_live_snapshot_failed_total',
  'stalker_live_snapshot_items_total',
  'stalker_live_snapshot_duration_ms',
];
const counters = new Map(COUNTERS.map(name => [name, 0]));

function increment(name, amount = 1) {
  counters.set(name, (counters.get(name) || 0) + amount);
}

function snapshot() {
  return Object.fromEntries(counters);
}

function reset() {
  counters.clear();
  for (const name of COUNTERS) counters.set(name, 0);
}

module.exports = { increment, reset, snapshot };

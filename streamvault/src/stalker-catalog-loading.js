export async function loadInitialStalkerCatalog({
  loadLive,
  loadVodCategories,
  loadSeriesCategories,
  isCancelled = () => false,
}) {
  await loadLive();
  if (isCancelled()) return;

  await loadVodCategories();
  if (isCancelled()) return;

  await loadSeriesCategories();
}

export function describeStalkerCatalogLoading({ kind, capabilities } = {}) {
  if (kind === 'live' && capabilities?.mode === 'bounded_live_snapshot') {
    return 'Preparing live catalog for this provider';
  }
  if (kind === 'live') return 'Loading live channels';
  return kind === 'series' ? 'Loading series' : 'Loading movies';
}

export function shouldUseGlobalCatalogLoader({ lazyCatalogEnabled = false, kind } = {}) {
  return !(lazyCatalogEnabled && (kind === 'vod' || kind === 'series'));
}

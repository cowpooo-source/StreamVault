export async function loadInitialStalkerCatalog({
  loadChannels,
  loadVod,
  loadSeries,
  isCancelled = () => false,
}) {
  await loadChannels();
  if (isCancelled()) return;

  await loadVod();
  if (isCancelled()) return;

  await loadSeries();
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

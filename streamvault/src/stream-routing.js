export function shouldProxyStreamUrl(url, {
  origin = location.origin,
  pageProtocol = location.protocol,
  direct = false,
  kind = "unknown",
} = {}) {
  const value = String(url || "");
  if (!value) return false;
  if (value.startsWith("/") || value.startsWith(origin)) return false;

  const isSecurePage = pageProtocol === "https:";
  const isHttpUrl = value.startsWith("http://");
  if (isSecurePage && isHttpUrl) return true;

  // Direct Stalker playback can still hit mixed-content through playlists or segments.
  // On HTTPS pages, force those media types through the same-origin proxy.
  if (isSecurePage && direct && (kind === "hls" || kind === "ts")) return true;

  return !direct;
}

export function stripTransientStreamFields(item) {
  if (!item?._stalkerCmd) return item;
  const {
    url,
    directUrl,
    expiresAt,
    _direct,
    _stalkerFallbackUrl,
    _stalkerFallbackUsed,
    ...stableItem
  } = item;
  return stableItem;
}
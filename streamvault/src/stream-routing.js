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

function stripPlaybackTokens(command) {
  const value = String(command || "");
  const prefix = value.match(/^(?:ffmpeg|ffrt)\s+/i)?.[0] || "";
  const raw = prefix ? value.slice(prefix.length) : value;
  try {
    const parsed = new URL(raw);
    for (const key of ["play_token", "token", "st", "expires", "e"]) parsed.searchParams.delete(key);
    return prefix + parsed.toString();
  } catch {
    return value.replace(/([?&](?:play_token|token|st|expires|e)=)[^&\s]*/ig, "$1");
  }
}

export function stripTransientStreamFields(item) {
  if (!item?._stalkerCmd) return item;
  const stableItem = { ...item };
  for (const field of [
    "url", "directUrl", "expiresAt", "streamGeneration", "streamWarnings",
    "directCapability", "_direct", "_stalkerRefreshUrl", "_stalkerFallbackUrl",
    "_stalkerFallbackUsed", "_stalkerRelayAvailable", "_stalkerRelayUrl",
    "_stalkerRelayActive", "_stalkerDirectOnly",
  ]) delete stableItem[field];
  stableItem._stalkerCmd = stripPlaybackTokens(item._stalkerCmd);
  return stableItem;
}
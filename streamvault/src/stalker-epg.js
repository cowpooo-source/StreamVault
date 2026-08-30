export const STALKER_EPG_CHANNEL_LIMIT = 20;

export function selectStalkerEpgChannels(channels, limit = STALKER_EPG_CHANNEL_LIMIT) {
  const max = Math.max(0, Math.floor(Number(limit) || 0));
  const seen = new Set();
  const selected = [];

  for (const channel of Array.isArray(channels) ? channels : []) {
    const id = String(channel?.id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    selected.push(channel);
    if (selected.length >= max) break;
  }

  return selected;
}

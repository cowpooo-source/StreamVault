// EPG-related utility functions

export function getEPGNow(programs, epgId) {
  if (!programs || !epgId) return null;
  const key = epgId.toLowerCase().trim();
  const list = programs[key] || programs[epgId] || [];
  const now = Date.now();
  return list.find(p => p.start <= now && p.stop > now) || null;
}

export function epgLookup(epgData, ch) {
  if (!epgData) return null;
  // Try normalized epgId (xmltv_id), then raw, then channel numeric id
  const norm = ch.epgId?.toLowerCase().trim();
  return (norm && epgData[norm]) || (ch.epgId && epgData[ch.epgId]) || (ch.id && epgData[ch.id]) || null;
}

export function parseEPGDate(s) {
  if (!s) return 0;
  // Try ISO format first
  const d = new Date(s);
  if (d.getTime()) return d.getTime();
  // Try "YYYYMMDDHHmmss" format
  if (/^\d{14}$/.test(s)) {
    return new Date(
      s.slice(0,4), s.slice(4,6)-1, s.slice(6,8),
      s.slice(8,10), s.slice(10,12), s.slice(12,14)
    ).getTime();
  }
  return 0;
}

// EPG-related utility functions

// TimelineGrid constants
export const PX_PER_MIN = 3;
export const TOTAL_HOURS = 8;
export const TOTAL_MS = TOTAL_HOURS * 3600000;
export const TOTAL_PX = TOTAL_HOURS * 60 * PX_PER_MIN; // 1440px
export const CH_COL_W = 160;
export const ROW_H = 48;

// Helper functions for TimelineGrid
export function msToPx(ms, windowStart) {
  return ((ms - windowStart) / 60000) * PX_PER_MIN;
}

export function fmtT(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

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

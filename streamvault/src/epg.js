// EPG-related utility functions
// Jellyfin LiveTV mapping helpers

export function mapJellyfinChannel(ch) {
  return {
    id: ch.Id,
    name: ch.Name,
    number: ch.Number || ch.ChannelNumber,
    logo: ch.ImageUrl || null,
  };
}

export function mapJellyfinProgram(prog) {
  return {
    id: prog.Id,
    channel: prog.ChannelId,
    title: prog.Name || prog.Title,
    description: prog.Overview || '',
    startMs: new Date(prog.StartTime).getTime(),
    endMs: new Date(prog.EndTime).getTime(),
    image: prog.ImageUrl || null,
  };
}

export function mergeJellyfinEPG(channels, programs) {
  const channelMap = {};
  for (const ch of channels) {
    channelMap[ch.Id] = { ...mapJellyfinChannel(ch), programs: [] };
  }
  for (const prog of programs) {
    if (!channelMap[prog.ChannelId]) continue;
    channelMap[prog.ChannelId].programs.push(mapJellyfinProgram(prog));
  }
  return Object.values(channelMap);
}

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

export function getEPGNow(programs, epgId, nowMs = Date.now()) {
  if (!programs || !epgId) return null;
  const key = epgId.toLowerCase().trim();
  const list = programs[key] || programs[epgId] || [];
  return list.find(p => p.start <= nowMs && p.stop > nowMs) || null;
}

export function epgLookup(epgData, ch) {
  if (!epgData) return null;
  const norm = ch.epgId?.toLowerCase().trim();
  return (norm && epgData[norm]) || (ch.epgId && epgData[ch.epgId]) || (ch.id && epgData[ch.id]) || null;
}

export function parseEPGDate(s) {
  if (!s) return 0;
  const d = new Date(s);
  if (d.getTime()) return d.getTime();
  if (/^\d{14}$/.test(s)) {
    return new Date(
      s.slice(0,4), s.slice(4,6)-1, s.slice(6,8),
      s.slice(8,10), s.slice(10,12), s.slice(12,14)
    ).getTime();
  }
  return 0;
}

// Merge multiple EPG sources and deduplicate overlapping programs for each channel.
// Sorts by start time then longest duration, then skips programs with the same
// normalized title within 60 seconds — these are duplicate entries from different
// sources or provider refresh cycles.
export function mergeEpgSources(sources) {
  const merged = {};
  for (const source of sources) {
    if (!source?.data) continue;
    for (const [chId, progs] of Object.entries(source.data)) {
      if (!merged[chId]) merged[chId] = [];
      merged[chId].push(...progs);
    }
  }

  const result = {};
  for (const [chId, progs] of Object.entries(merged)) {
    if (!progs || !progs.length) continue;

    const sorted = [...progs].sort((a, b) => {
      if (a.start === b.start) return b.stop - a.stop;
      return a.start - b.start;
    });

    const clean = [];
    for (const p of sorted) {
      const last = clean[clean.length - 1];
      if (
        last &&
        Math.abs(last.start - p.start) < 60000 &&
        (last.title || "").trim().toLowerCase() === (p.title || "").trim().toLowerCase()
      ) {
        continue; // same title within 60s — skip as duplicate
      }
      clean.push({ ...p }); // clone to avoid mutation
    }

    if (clean.length) result[chId] = clean;
  }

  return result;
}
function normalizeEpisode(value, index, season = {}) {
  if (typeof value === 'number' || typeof value === 'string') {
    return {
      id: String(value),
      num: Number(value) || index + 1,
      title: `Episode ${value}`,
      cmd: season.cmd || null,
      episode_id: value,
      season_id: season.id ?? null,
      series_number: Number(value) || index + 1,
      video_id: null,
    };
  }
  const episode = value || {};
  return {
    ...episode,
    id: String(episode.id ?? episode.episode_id ?? episode.video_id ?? index + 1),
    num: Number(episode.num ?? episode.episode_num ?? episode.series_number ?? index + 1),
    title: episode.title || episode.name || `Episode ${index + 1}`,
    cmd: episode.cmd || episode.command || season.cmd || null,
    episode_id: episode.episode_id ?? episode.id ?? null,
    season_id: episode.season_id ?? season.id ?? null,
    series_number: episode.series_number ?? episode.episode_num ?? episode.num ?? index + 1,
    video_id: episode.video_id ?? null,
  };
}

function payloadRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.js?.data)) return payload.js.data;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.js)) return payload.js;
  return [];
}

function isFlatEpisode(row) {
  return row && typeof row === 'object'
    && !Array.isArray(row.series)
    && !Array.isArray(row.episodes)
    && ['episode_id', 'video_id', 'season_id', 'series_number'].some(key => row[key] != null);
}

function makeSeason(row, index, parent) {
  const rawEpisodes = Array.isArray(row.series) ? row.series : Array.isArray(row.episodes) ? row.episodes : [];
  const season = {
    id: String(row.id ?? row.season_id ?? index + 1),
    name: row.name || row.title || `Season ${index + 1}`,
    cmd: row.cmd || parent.cmd || null,
    logo: row.screenshot_uri || row.cover || parent.logo || null,
  };
  return { ...season, episodes: rawEpisodes.map((episode, episodeIndex) => normalizeEpisode(episode, episodeIndex, season)) };
}

function normalizeSeasons(payload, parent = {}) {
  const rows = payloadRows(payload);
  let seasons;

  if (rows.length > 0 && rows.every(row => typeof row === 'number' || typeof row === 'string')) {
    const season = { id: '1', name: 'Season 1', cmd: parent.cmd || null, logo: parent.logo || null };
    seasons = [{ ...season, episodes: rows.map((episode, index) => normalizeEpisode(episode, index, season)) }];
  } else if (rows.some(isFlatEpisode)) {
    const grouped = new Map();
    for (const row of rows) {
      const seasonId = String(row?.season_id ?? 1);
      if (!grouped.has(seasonId)) grouped.set(seasonId, []);
      grouped.get(seasonId).push(row);
    }
    seasons = [...grouped].map(([id, episodes], index) => {
      const season = { id, name: `Season ${id || index + 1}`, cmd: parent.cmd || null, logo: parent.logo || null };
      return { ...season, episodes: episodes.map((episode, episodeIndex) => normalizeEpisode(episode, episodeIndex, season)) };
    });
  } else {
    seasons = rows.filter(row => row && typeof row === 'object').map((row, index) => makeSeason(row, index, parent));
  }

  return {
    seasons,
    supported: seasons.some(season => season.episodes.length > 0 || season.cmd),
  };
}

module.exports = { normalizeEpisode, normalizeSeasons };
/**
 * Stalker request parameter allowlists and validation.
 *
 * Every parameter not in the relevant allowlist is rejected with HTTP 400
 * and code "invalid_parameter" before it reaches the upstream portal.
 */

// ── Locally consumed keys (never forwarded upstream) ─────────────────────

const LOCAL_ONLY_KEYS = new Set([
  "portal", "mac", "contentToken", "refresh",
  "resolve", "name", "relayGrant",
  "serial", "deviceId", "deviceId2",
]);

// ── Read-only action allowlist + type/field schemas ──────────────────────
//
// requiredTypes:  exact set of allowed type values.  Empty array means the
//                 action works without a type parameter.
// extraFields:    parameters accepted beyond "action" and "type".

const SAFE_ACTIONS = new Set([
  "get_genres", "get_all_channels", "get_ichannels_via_api", "get_epg_info",
  "get_categories", "get_ordered_list", "get_series", "get_seasons",
  "get_main_info", "get_profile",
  "get_full_info", "get_user_packages", "get_simple_data_table",
]);

const ACTION_SCHEMAS = {
  get_genres:            { requiredTypes: ["itv"],          extraFields: ["category", "page", "p"] },
  get_all_channels:      { requiredTypes: ["itv"],          extraFields: ["page", "p", "fav", "sortby", "hd", "not_ended", "from_ch_id"] },
  get_ichannels_via_api: { requiredTypes: ["itv"],          extraFields: ["page", "p", "fav", "sortby"] },
  get_epg_info:          { requiredTypes: ["itv"],          extraFields: ["period"] },
  get_categories:        { requiredTypes: ["vod", "series", "itv"], extraFields: [] },
  get_ordered_list:      { requiredTypes: ["vod", "series"], extraFields: ["category", "movie_id", "season_id", "page", "p", "per_page"] },
  get_series:            { requiredTypes: ["series"],       extraFields: ["category", "page", "p"] },
  get_seasons:           { requiredTypes: ["series"],       extraFields: ["movie_id"] },
  get_main_info:         { requiredTypes: ["account_info"], extraFields: [] },
  get_profile:           { requiredTypes: ["stb"],          extraFields: ["stb_type", "JsHttpRequest"] },
  get_full_info:         { requiredTypes: [],               extraFields: [] },
  get_user_packages:     { requiredTypes: [],               extraFields: [] },
  get_simple_data_table: { requiredTypes: [],               extraFields: ["period"] },
};

// ── Per-route parameter allowlists ───────────────────────────────────────

const MULTI = new Set([
  "action", "type", "category", "category_id", "ch_id",
  "page", "p", "period", "per_page", "limit", "offset",
  "fav", "sortby", "sort_by",
  "hd", "not_ended", "from_ch_id", "JsHttpRequest", "stb_type",
  "video_id", "season_id", "season", "genre",
  "id", "search", "need_epg", "epg_limit",
]);

const VOD_SERIES = new Set([
  "movie_id", "series", "episode", "episode_id",
  "series_number", "season_number",
  "forced_storage", "disable_ad", "download",
  "force_ch_link_check",
]);

const LIVE_CATCHUP = new Set([
  "cmd", "content_type", "channel_id",
  "program_id", "start", "end", "utc", "duration", "archive",
]);

const ROUTE_SPECIFIC = {
  channels: new Set(),
  epg: new Set(["period", "ch_id"]),
  vod: new Set(["cat"]),
  series: new Set(["cat", "seriesId", "cmd", "episode"]),
  play: new Set([...MULTI, ...VOD_SERIES, ...LIVE_CATCHUP]),
  stream: new Set([...MULTI, ...VOD_SERIES, ...LIVE_CATCHUP]),
};

const ALL_ALLOWED = new Set([
  ...MULTI, ...VOD_SERIES, ...LIVE_CATCHUP,
]);

// ── Fields that accept non-negative integer strings ─────────────────────
// Uses regex /^(0|[1-9]\d*)$/ — rejects decimals, exponents, leading zeros

const NUMERIC = new Set([
  "category_id", "page", "p", "per_page", "limit", "offset",
  "period", "season", "season_number", "series_number",
  "movie_id", "video_id", "season_id", "episode_id",
  "channel_id", "program_id",
  "forced_storage", "disable_ad", "download",
  "force_ch_link_check",
]);

const INTEGER_RE = /^(0|[1-9]\d*)$/;
const COMPOSITE_SEASON_RE = /^(0|[1-9]\d*):(0|[1-9]\d*)$/;
const MAX_STRING_LEN = 256;
const MAX_STRING_LENGTHS = {
  cmd: 4096,
  search: 512,
};
const MAX_SAFE_INT = 1_000_000_000;

// ── Helpers ──────────────────────────────────────────────────────────────

function fail(msg) {
  const err = new Error(msg);
  err.code = "invalid_parameter";
  err.status = 400;
  throw err;
}

function stripCredentials(params) {
  const safe = { ...params };
  for (const key of LOCAL_ONLY_KEYS) delete safe[key];
  return safe;
}

function resolveAllowedSet(route) {
  return ROUTE_SPECIFIC[route] || ALL_ALLOWED;
}

// ── Main entry point ────────────────────────────────────────────────────

function pickAndValidateStalkerParams(query, route) {
  const allowedKeys = resolveAllowedSet(route);
  const isSimpleRoute = route === "api" || route === "root";

  const params = {};
  const unknown = [];

  for (const key of Object.keys(query)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      unknown.push(key);
      continue;
    }
    if (LOCAL_ONLY_KEYS.has(key)) continue;
    if (!allowedKeys.has(key)) { unknown.push(key); continue; }

    const raw = query[key];

    if (Array.isArray(raw)) {
      fail(`Stalker parameter "${key}" must be a single value, not an array`);
    }
    if (raw !== null && typeof raw === "object") {
      fail(`Stalker parameter "${key}" does not accept object values`);
    }

    const str = String(raw).trim();
    const maxLength = MAX_STRING_LENGTHS[key] || MAX_STRING_LEN;
    if (str.length > maxLength) {
      fail(`Stalker parameter "${key}" exceeds maximum length`);
    }

    if (NUMERIC.has(key)) {
      const validNumeric = key === "season_id"
        ? INTEGER_RE.test(str) || COMPOSITE_SEASON_RE.test(str)
        : INTEGER_RE.test(str);
      if (!validNumeric) {
        fail(`Stalker parameter "${key}" must be a non-negative integer`);
      }
      const numericParts = str.split(":").map(Number);
      if (numericParts.some(value => value > MAX_SAFE_INT)) {
        fail(`Stalker parameter "${key}" exceeds maximum value`);
      }
      params[key] = str;
      continue;
    }

    params[key] = str;
  }

  if (unknown.length) {
    fail(`Unknown Stalker parameter(s): ${unknown.join(", ")}`);
  }

  if (isSimpleRoute) {
    if (!params.action) {
      fail('The "action" parameter is required for generic Stalker passthrough');
    }
    if (!SAFE_ACTIONS.has(params.action)) {
      const err = new Error(
        `Stalker action "${params.action}" is not available through generic passthrough`
      );
      err.code = "action_forbidden";
      err.status = 403;
      throw err;
    }

    const schema = ACTION_SCHEMAS[params.action];
    if (schema) {
      if (schema.requiredTypes.length) {
        if (!params.type) {
          fail(
            `Stalker action "${params.action}" requires type, one of: ${schema.requiredTypes.join(", ")}`
          );
        }
        if (!schema.requiredTypes.includes(params.type)) {
          fail(
            `Stalker action "${params.action}" does not support type "${params.type}". Must be one of: ${schema.requiredTypes.join(", ")}`
          );
        }
      }
      const allowedFields = new Set(["action", "type", ...schema.extraFields]);
      const extras = [];
      for (const k of Object.keys(params)) {
        if (!allowedFields.has(k)) extras.push(k);
      }
      if (extras.length) {
        fail(`Stalker action "${params.action}" does not support: ${extras.join(", ")}`);
      }
    }
  }

  return { params: stripCredentials(params) };
}

module.exports = { pickAndValidateStalkerParams, ALL_ALLOWED };

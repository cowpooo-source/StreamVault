- [x] **BUG: VirtualGrid — `header` prop silently dropped and `scrollRef` prop unused**
  The `header` prop (recommendations row) passed from App.jsx was never rendered in VirtualGrid.jsx. Additionally, `scrollRef` was received as a prop but never used — the component used a local `scrollRef` instead. Fixed: VirtualGrid now renders `{header}` and uses the local `scrollRef` correctly.

- [x] **BUG: EPG programs overlapping on top of each other (All sources merge)**
  When multiple EPG sources are loaded and "All" is selected, programs for the same channel and time window appear as duplicate overlapping blocks. Fixed with 60-second title-based deduplication in `mergeEpgSources()`. Connection-scoped EPG sources now include `connectionId` tags to prevent cross-contamination.

- [ ] **FEATURE: Preserve EPG sources across connection switches**
  Currently, switching connections calls `setEpgSources([])`, throwing away all loaded XMLTV/Stalker EPG sources. EPG data is provider-agnostic — an XMLTV file from one portal works for another. Preserve `epgSources` on connection switch; only clear `epgData` (the merged map). See `docs/advanced-epg-plan.md` Task 1.

- [x] **PERF: Move `LANGS` translation object outside App component**
  `LANGS` is a ~570-line object defined inline in App.jsx's render body. It is recreated on every render (every keystroke, every state change). Move it to module scope — it never needs to be reactive. Use a `useCallback`-wrapped `t()` function that reads from the module-level constant with `lang` as the only dependency.

- [ ] **BUG: Language switch during playback resets HLS track state**
  When `lang` changes in App.jsx, the `t` prop passed to `Player.jsx` changes. Since Player is mounted via `createPortal` and receives `t` as a prop, any re-render of components that pass `t` down can cause HLS re-initialization or track state loss. Memoize `t` at the App level so only leaf components that use it re-render on language change, or pass `t` as a stable reference.

- [x] **BUG: Catch-up TV button shown for Xtream connections that don't support it**
  The `↩️` button appears whenever `current.type === "live"` and `epgData` exists, regardless of connection type. The `&start=N` timeshift parameter only works for Stalker portals. For Xtream connections, the button silently fails. Fix: either guard the button with `connType === "stalker"`, or implement a backend endpoint that rewrites the stream URL with proper Xtream timeshift parameters.

- [x] **PERF: Grid Virtualization — implemented with `@tanstack/react-virtual`**

- [ ] **BUG: M3U import — channel data not auto-refreshed on connect, no refresh for Movies/Series (P1)**
  When an M3U connection is added, the channel list loads once but does not auto-refresh on subsequent visits. The Movies and Series sections for M3U connections show no content and have no refresh button — unlike Xtream connections which have a manual refresh trigger. For M3U, the parsed channels are saved to IDB on connect but content is not re-fetched on revisit. Fix: either call `loadM3UContent()` on M3U connection load, or add a Refresh button to the Movies/Series headers for M3U type connections. See `App.jsx` around line 2241 (M3U branch).

- [ ] **BUG: App.jsx:3061 — stale closure in connection/effects useEffect (P1)**
  `useEffect` at line 3061 is missing many function dependencies (`fetchLive`, `fetchStalkerChannels`, `fetchVOD`, `loadEPG`, `loadStalkerCats`, `loadStalkerEPG`, `autoConnected`, `epgURL`, `lastSynced`). This means the effect won't re-run when connection state changes if those functions are recreated, leading to fetches using stale logic or missing updates. Fix: wrap the dependent functions in `useCallback` with proper deps, then add them to the effect dependency array.

- [ ] **BUG: Player.jsx:594 — stale closure in player init useEffect (P1)**
  `useEffect` at line 594 (player initialization) is missing `current.*` fields (`connId`, `epgId`, `group`, `id`, `name`, `title`, `type`) plus `initPlayer`, `destroyPlayers`, `isAdEligible`, `showOSD`. This can cause the player to not re-init or re-destroy when the channel changes, leading to incorrect playback state. Fix: wrap dependent values/funcs in `useCallback`/`useMemo` or restructure the effect to use a single `item.id` dep for channel-change detection.

- [ ] **BUG: App.jsx:3346 — stale closure in EPG load useEffect (P2)**
  `useEffect` missing `conn?.type` and `loadStalkerEPG`. If the connection type changes, this effect won't re-trigger Stalker EPG loading.

- [ ] **BUG: App.jsx:2656 — `isCatHidden` causes stale closure in useEffect (P2)**
  The `isCatHidden` function is in the dependency array of a useEffect (at line 2656), causing the effect to re-run on every render. Wrap `isCatHidden` in `useCallback` or move it outside the component.

- [ ] **BUG: App.jsx:5346 — stale closure in multi-import useEffect (P2)**
  `useEffect` missing `loadAll`. Affects the bulk connection import flow.

- [ ] **BUG: Player.jsx:649 — stale closure in prev/next channel useEffect (P2)**
  `useEffect` missing `nextChannel`, `prevChannel`, `onClose`, `showOSD`. Can cause arrow-key channel navigation to miss re-renders.

- [ ] **BUG: App.jsx:2 — unused `useVirtualizer` import in App.jsx**
  `useVirtualizer` is imported but never used in App.jsx. Remove the import.

- [ ] **TECH DEBT: Fix Exhaustive Hook Dependencies**
  Surgically resolve all `react-hooks/exhaustive-deps` warnings in `App.jsx` and `Player.jsx` to prevent stale closure bugs. 8 total warnings found via eslint. See individual tasks above for priority ordering.

- [ ] **FEATURE: Multi-Portal Global Search**
  Search across all saved user connections simultaneously instead of just the active one.
  - Implement an async aggregator that queries `idbCache` for all items in the `connections` array.
  - Add "Source" badges to search results to identify which portal a result belongs to.
  - Implement automatic connection switching when a result from a non-active portal is selected for playback.
  - (Optional) Use a Web Worker for filtering to prevent UI lag with large datasets.

- [ ] **SECURITY: Sandbox third-party ad scripts (Adsterra, HilltopAds)**
  `AdsterraSocialBar` and `HilltopPushAd` inject unsanitized third-party JavaScript from external domains on every allowed page. Consider: (1) load in an iframe with `sandbox="allow-scripts"` only, (2) add a timeout/abort so a slow ad network response doesn't block player controls from appearing, (3) move ad injection entirely outside the React component tree so a failed load can't break the UI.

- [x] **BUG: Playback heartbeat continues after media stops**
  The heartbeat ping initiated in `Player.jsx` is not stopping even after the media has stopped playing or the player is closed. Investigate the cleanup logic and ensure all timers/intervals are cleared.

- [x] **Bug: Ad banner issue when navigating between categories.**
  When navigating from "Live TV" to "Movies" or "Series", the native banner is not displayed. It appears only after a page refresh, but disappears again upon navigating back from another category. Ad ID: 5731560.
- [x] **Bug: Settings navigation layout broken on desktop.**
  The layout for the settings navigation appears broken on desktop view. It might be acceptable in mobile portrait view. Please investigate and fix.
- [x] **User Login Limits**: Implement login restrictions: Guest and Free accounts allow only 1 concurrent login. Basic accounts allow up to 3 concurrent logins.
- [x] **Analytics Enhancement 1: System Performance (Real-time)**
  - Real-time CPU usage and Load Averages.
  - Network Throughput (Mbps Up/Down) with real-time gauges.
  - Disk usage monitoring.
- [x] **Analytics Enhancement 2: Auth & Security Metrics**
  - Active session tracking (valid JWTs).
  - Failed login attempt monitor and brute-force detection.
  - User role distribution (Free vs Basic vs Pro).
- [x] **Analytics Enhancement 3: Streaming Health Deep Dive**
  - Portal Latency Leaderboard.
  - Top error sources and 404/Timeout heatmaps.
- [x] **Analytics Enhancement 4: User Engagement**
  - Geo-Location breakdown (Countries).
  - Device type distribution (Mobile vs Desktop vs Smart TV).
- [ ] **REFACTOR: Component Extraction from App.jsx** *(partially done — AuthScreen, Player, TimelineGrid, VirtualGrid extracted; SettingsView, DiscoverView, Setup, StalkerPlayer remain)*
  Extract large sub-components (`SettingsView`, `DiscoverView`, `Setup`, `StalkerPlayer`, etc.) into standalone files in `src/components/` to improve maintainability and hot-reloading speed. AuthScreen, Player, TimelineGrid, and VirtualGrid have already been extracted.

- [ ] **Architectural Debt: Split `stalker-proxy/src/index.js` — PARTIALLY DONE**
  The following are complete: `src/routes/stalker.js`, `src/routes/api.js`, `src/routes/auth.js`, `src/app.js` for Express configuration. Remaining: implement unit/integration tests for new modules to reach 80% backend coverage.

- [x] **Feature: Media Playback Duration Heartbeat**
  60-second heartbeat ping implemented in `Player.jsx`. Backend endpoint `/api/playback/heartbeat` receives pings with session_id, position, and duration. `watch_duration` tracking via `playback_sessions` table. Analytics dashboard integrates duration metrics.
# Reminder: review docs/stalker-vs-xtream-lazy-loading-notes.md before the next Stalker catalog/search performance change.

- [ ] **BUG: VirtualGrid — `header` prop silently dropped and `scrollRef` prop unused**
  The `header` prop (recommendations row) passed from App.jsx is never rendered in VirtualGrid.jsx — it goes to nothing. Additionally, `scrollRef` is received as a prop but never used; the component uses a local `scrollRef` instead. Fix: render `{header}` in the JSX and remove the dead prop.

- [ ] **BUG: EPG programs overlapping on top of each other (All sources merge)**
  When multiple EPG sources are loaded and "All" is selected, programs for the same channel and time window appear as duplicate overlapping blocks. The merge logic blindly accepts all programs without deduplication. See `docs/advanced-epg-plan.md` for the full fix plan covering Task 2 (dedup logic) and Task 3 (deferred search).

- [ ] **FEATURE: Preserve EPG sources across connection switches**
  Currently, switching connections calls `setEpgSources([])`, throwing away all loaded XMLTV/Stalker EPG sources. EPG data is provider-agnostic — an XMLTV file from one portal works for another. Preserve `epgSources` on connection switch; only clear `epgData` (the merged map). See `docs/advanced-epg-plan.md` Task 1.

- [x] **PERF: Move `LANGS` translation object outside App component**
  `LANGS` is a ~570-line object defined inline in App.jsx's render body. It is recreated on every render (every keystroke, every state change). Move it to module scope — it never needs to be reactive. Use a `useCallback`-wrapped `t()` function that reads from the module-level constant with `lang` as the only dependency.

- [ ] **BUG: Language switch during playback resets HLS track state**
  When `lang` changes in App.jsx, the `t` prop passed to `Player.jsx` changes. Since Player is mounted via `createPortal` and receives `t` as a prop, any re-render of components that pass `t` down can cause HLS re-initialization or track state loss. Memoize `t` at the App level so only leaf components that use it re-render on language change, or pass `t` as a stable reference.

- [x] **BUG: Catch-up TV button shown for Xtream connections that don't support it**
  The `↩️` button appears whenever `current.type === "live"` and `epgData` exists, regardless of connection type. The `&start=N` timeshift parameter only works for Stalker portals. For Xtream connections, the button silently fails. Fix: either guard the button with `connType === "stalker"`, or implement a backend endpoint that rewrites the stream URL with proper Xtream timeshift parameters.

- [x] **PERF: Grid Virtualization — implemented with `@tanstack/react-virtual`**
  VOD/Series grids now use `useVirtualizer` to render only visible rows. Note: VirtualGrid has active bugs — see "VirtualGrid header prop and scrollRef unused" above.

- [ ] **TECH DEBT: Fix Exhaustive Hook Dependencies**
  Surgically resolve all `react-hooks/exhaustive-deps` warnings in `App.jsx` and `Player.jsx` to prevent stale closure bugs.

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
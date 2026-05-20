- [ ] **REFACTOR: Component Extraction from App.jsx**
  Extract large sub-components (`SettingsView`, `DiscoverView`, `Setup`, `StalkerPlayer`, etc.) into standalone files in `src/components/` to improve maintainability and hot-reloading speed.

- [ ] **PERF: Implement Grid Virtualization**
  Use `react-window` or a similar technique for VOD and Series grids to ensure only visible items are rendered, preventing browser crashes with 100k+ item libraries.

- [ ] **TECH DEBT: Fix Exhaustive Hook Dependencies**
  Surgically resolve all `react-hooks/exhaustive-deps` warnings in `App.jsx` and `Player.jsx` to prevent stale closure bugs.

- [ ] **FEATURE: Multi-Portal Global Search**
  Search across all saved user connections simultaneously instead of just the active one.
  - Implement an async aggregator that queries `idbCache` for all items in the `connections` array.
  - Add "Source" badges to search results to identify which portal a result belongs to.
  - Implement automatic connection switching when a result from a non-active portal is selected for playback.
  - (Optional) Use a Web Worker for filtering to prevent UI lag with large datasets.

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
- [ ] **Architectural Debt: Split `stalker-proxy/src/index.js`**
  - Extract Stalker proxy logic into `src/routes/stalker.js`.
  - Extract general API (VAST, TMDB) into `src/routes/api.js`.
  - Create `src/app.js` for Express configuration and middleware.
  - Implement unit/integration tests for new modules to reach 80% backend coverage.
- [ ] **Feature: Media Playback Duration Heartbeat**
  - Implement a 60-second heartbeat ping in the frontend `Player.jsx` while media is actively playing.
  - Create a new backend endpoint (e.g., `/api/track/duration`) to securely receive and validate these pings against the user's JWT/Guest ID.
  - Add a new `watch_duration` table to the SQLite database to store accumulated watch time per user, per day/hour.
  - Integrate these new duration metrics into the Analytics Dashboard.


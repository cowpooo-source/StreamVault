- [ ] **Bug: Ad banner issue when navigating between categories.**
  When navigating from "Live TV" to "Movies" or "Series", the native banner is not displayed. It appears only after a page refresh, but disappears again upon navigating back from another category. Ad ID: 5731560.
- [ ] **Bug: Settings navigation layout broken on desktop.**
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

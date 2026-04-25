# Portal Heaven (vps/self-hosted branch)

## Overview
This project is an IPTV client architecture optimized for self-hosting on a VPS. It provides a "TiviMate-like" user experience for Stalker, Xtream, and M3U portals.

## Project Guidelines
- **Core Branch**: All development and research should focus strictly on the `vps/self-hosted` branch.
- **Privacy & Security**: Adhere to the client-side encryption (AES-GCM) pattern for user credentials.
- **Architectural Integrity**: Maintain the separation between the React frontend (`Portal Heaven`) and the Node.js backend (`stalker-proxy`).

## Architecture Details
1. **Frontend (`Portal Heaven`)**: 
   - Vite-based React SPA.
   - Features: Multi-language support (i18n), multiple themes, and a responsive player.
   - Security: Encrypts connection details (passwords, MAC addresses) before syncing to the backend.
2. **Backend (`stalker-proxy`)**:
   - Express.js server acting as a middleware/proxy for IPTV portals.
   - Responsibilities: Stalker handshake, CORS bypassing, and HLS manifest rewriting for streaming stability.
   - Data Storage: Uses SQLite (`better-sqlite3`) for user data and caching.

## Deployment
Typically deployed using the provided `deploy-vps.sh` script to a VPS environment.

## Recent Progress (April 25, 2026)
- **Branch Strategy**: Locked development focus to the `vps/self-hosted` branch.
- **Features**: 
  - Overhauled Live TV navigation with a horizontal scrolling EPG Timeline.
  - Implemented advanced analytics (Hardware tracking, Active JWT Sessions, User Engagement, Portal Latency Leaderboards).
  - Introduced Role-Based Concurrent Login Limits (Pro, Regular, Free, Guest).
- **Performance**: 
  - Optimized EPG and Channel caching with a 24h TTL and MAC-independent portal-level sharing to dramatically reduce VPS bandwidth.
- **Bug Fixes**: 
  - Fixed cross-origin image loading (CORP headers).
  - Resolved `last_watched` database missing column error.
- **VPS Deployment**:
  - Successfully deployed all features to `40.233.113.76`.
  - Refined deployment process with robust `rsync` syncing directly to the Nginx document root.

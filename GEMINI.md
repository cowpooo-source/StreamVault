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

## Recent Progress (April 7, 2026)
- **Branch Strategy**: Locked development focus to the `vps/self-hosted` branch.
- **Architecture Review**: Mapped the interaction between the React frontend and Node.js proxy backend.
- **Bug Fixes**: 
  - Fixed guest logout visibility in `App.jsx`.
  - Added an automatic fallback in `mpegts.js` to native `<video>` playback for "Unsupported media type" errors.
- **VPS Deployment**:
  - Successfully deployed to `40.233.113.76`.
  - Verified with a 43-test security suite (SSRF, Auth, Rate Limiting, etc.).
  - Established a "Hard Reset" deployment workflow to avoid `dist` folder conflicts.
- **Documentation**: Created a manual deployment guide for VPS updates.

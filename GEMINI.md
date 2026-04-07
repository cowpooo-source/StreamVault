# StreamVault (vps/self-hosted branch)

## Overview
This project is an IPTV client architecture optimized for self-hosting on a VPS. It provides a "TiviMate-like" user experience for Stalker, Xtream, and M3U portals.

## Project Guidelines
- **Core Branch**: All development and research should focus strictly on the `vps/self-hosted` branch.
- **Privacy & Security**: Adhere to the client-side encryption (AES-GCM) pattern for user credentials.
- **Architectural Integrity**: Maintain the separation between the React frontend (`streamvault`) and the Node.js backend (`stalker-proxy`).

## Architecture Details
1. **Frontend (`streamvault`)**: 
   - Vite-based React SPA.
   - Features: Multi-language support (i18n), multiple themes, and a responsive player.
   - Security: Encrypts connection details (passwords, MAC addresses) before syncing to the backend.
2. **Backend (`stalker-proxy`)**:
   - Express.js server acting as a middleware/proxy for IPTV portals.
   - Responsibilities: Stalker handshake, CORS bypassing, and HLS manifest rewriting for streaming stability.
   - Data Storage: Uses SQLite (`better-sqlite3`) for user data and caching.

## Deployment
Typically deployed using the provided `deploy.sh` script to a VPS environment.

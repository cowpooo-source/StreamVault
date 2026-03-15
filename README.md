# StreamVault

A personal IPTV client that runs in the browser. Supports Xtream Codes, M3U playlists, Stalker/Ministra portals, and direct HLS/MP4 URLs.

## Features

- **Live TV** — channel grid with logos, EPG now-playing, favorites
- **Movies & Series** — poster grid, year/rating, resume progress
- **TV Guide** — XMLTV-based EPG grid
- **Global Search** — searches across live, movies and series simultaneously
- **Multi-profile** — per-profile favorites (up to 4 profiles)
- **Continue Watching** — history with resume support
- **4 themes** — Dark, Navy, AMOLED, Forest
- **Keyboard shortcuts** — Space, F, M, arrows, P (PiP), Esc

## Project structure

```
StreamVault/
├── streamvault/        # React frontend (Vite)
└── stalker-proxy/      # Node.js proxy for Stalker portals
```

## Quick start

### 1. Start the Stalker proxy (required for Stalker Portal connections)

```bash
cd stalker-proxy
npm install
npm start
# Runs on http://localhost:3001
```

### 2. Start the frontend

```bash
cd streamvault
npm install
npm run dev
# Runs on http://localhost:5173
```

### 3. Connect

Open the app and choose your connection type:

| Type | Details |
|------|---------|
| **Xtream Codes** | Server URL + username + password |
| **M3U Playlist** | Direct `.m3u` / `.m3u8` URL |
| **Stalker Portal** | Portal URL + MAC address (requires proxy) |
| **Direct HLS** | Paste any stream URL |

## Environment variables

### streamvault

Copy `streamvault/.env.example` to `streamvault/.env`:

```env
VITE_PROXY_URL=http://localhost:3001
```

### stalker-proxy

Copy `stalker-proxy/.env.example` to `stalker-proxy/.env`:

```env
PORT=3001
ALLOWED_ORIGIN=*
```

## Deploying the proxy

The stalker-proxy can be deployed for free on Railway or Render — see [`stalker-proxy/README.md`](stalker-proxy/README.md) for instructions. Once deployed, set `VITE_PROXY_URL` in your frontend environment to the deployed URL.

## License

MIT

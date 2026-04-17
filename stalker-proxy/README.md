# Stalker Proxy

A lightweight Node.js proxy that handles Stalker/Ministra portal authentication and CORS so Portal Heaven can talk to IPTV portals from a browser.

## Why is this needed?

Stalker portals require:
1. A **token handshake** — the portal issues a session token tied to your MAC address
2. Specific **User-Agent and Cookie headers** that browsers won't send cross-origin
3. **CORS headers** that most portal servers don't include

This proxy handles all three transparently.

## Setup

```bash
cp .env.example .env
# Set ADMIN_PASS and optionally TMDB_API_KEY in .env
npm install
npm start
# Runs at http://localhost:3001
```

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/stalker/handshake` | POST | Token handshake `{ portal, mac }` → `{ token }` |
| `/stalker/channels` | GET | All channels with genres merged |
| `/stalker/vod/categories` | GET | VOD category list |
| `/stalker/vod` | GET | VOD items by category |
| `/stalker/series/categories` | GET | Series category list |
| `/stalker/series` | GET | Series items by category |
| `/stalker/series/seasons` | GET | Seasons and episodes |
| `/stalker/stream` | GET | Resolve `cmd` to stream URL |
| `/stalker/epg` | GET | EPG program data |
| `/stalker/api` | GET | Generic portal API passthrough |
| `/stream` | GET | HTTP stream proxy with HLS rewriting |
| `/proxy` | GET | Generic CORS proxy |
| `/health` | GET | Health check |

## Deploy

### Koyeb (recommended)

`koyeb.yaml` is pre-configured. Set `ALLOWED_ORIGIN` to your frontend URL and add `TMDB_API_KEY` if you want server-side TMDB metadata.

### Railway

`railway.json` is pre-configured. Add env vars `ALLOWED_ORIGIN` and `TMDB_API_KEY` if you want server-side TMDB metadata.

### Render

Build: `npm install` · Start: `npm start` · Free tier works.

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `ALLOWED_ORIGIN` | `*` | CORS origin — lock down in production |
| `TMDB_API_KEY` | — | TMDB v3 API key used by `/api/tmdb/*` for all users |

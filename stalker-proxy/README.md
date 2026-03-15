# Stalker Proxy

A lightweight Node.js proxy that handles the Stalker/Ministra portal handshake and
CORS so StreamVault can talk to your IPTV provider's portal from a browser.

## Why is this needed?

Stalker portals require:
1. A **token handshake** — the portal issues a session token tied to your MAC address
2. Specific **User-Agent and Cookie headers** that browsers won't send cross-origin
3. **CORS headers** that most portal servers don't include

This proxy handles all three transparently.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env if needed — defaults work for local dev
```

### 3. Run locally

```bash
npm start
# or for auto-reload during development:
npm run dev
```

Proxy runs at: `http://localhost:3001`

---

## API Endpoints

### `GET /health`
Check the proxy is alive.

### `POST /stalker/handshake`
```json
{ "portal": "http://your-portal.com/c", "mac": "00:1A:79:XX:XX:XX" }
```
Returns: `{ "token": "abc123..." }`

### `GET /stalker/channels?portal=...&mac=...`
Fetches all live channels with genre names merged in.
Returns: `{ "channels": [...], "total": 287 }`

### `GET /stalker/vod?portal=...&mac=...&page=1`
Fetches VOD items (paginated).

### `GET /stalker/stream?portal=...&mac=...&cmd=...`
Resolves a Stalker stream `cmd` to a playable HLS/RTSP URL.
Returns: `{ "url": "http://..." }`

### `GET /stalker/api?portal=...&mac=...&type=...&action=...`
Generic passthrough — any Stalker portal API call.

---

## Deploy free on Railway

1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select the repo — Railway auto-detects Node.js
4. Set env var `ALLOWED_ORIGIN` to your StreamVault URL
5. Done — you get a URL like `https://stalker-proxy-production.up.railway.app`

## Deploy free on Render

1. Push to GitHub
2. Go to [render.com](https://render.com) → New Web Service
3. Connect repo, set Build Command: `npm install`, Start Command: `npm start`
4. Free tier is enough for personal use

---

## StreamVault integration

In StreamVault, when connecting via Stalker Portal, enter:
- **Proxy URL**: `http://localhost:3001` (or your deployed URL)
- **Portal URL**: your provider's portal URL  
- **MAC Address**: your registered MAC

The proxy URL field is shown in the Stalker tab of the connection screen.

# StreamVault

> A personal IPTV client that runs entirely in the browser — no app install, no subscription, bring your own service.

Supports **Xtream Codes**, **M3U playlists**, **Stalker/Ministra portals**, and **direct HLS/MP4 URLs**.

---

## Features

| Category | Details |
|----------|---------|
| Live TV | Channel grid with logos, live EPG now-playing, channel switching |
| Movies & Series | Poster grid with year, rating, and resume progress bar |
| TV Guide | XMLTV EPG grid (load any provider's XML feed) |
| Global Search | Searches live, movies, and series simultaneously |
| Favorites | Per-profile favorites across all content types |
| Continue Watching | Watch history with resume support (last 60 items) |
| Themes | Dark · Navy · AMOLED · Forest |
| Player | HLS.js, keyboard shortcuts, Picture-in-Picture, OSD, quick channel switcher |

**Keyboard shortcuts in player:**
`Space` play/pause · `F` fullscreen · `M` mute · `←→` channels / ±10s · `↑↓` channels / volume · `P` PiP · `Esc` close

---

## Project structure

```
StreamVault/
├── streamvault/        # React + Vite frontend
│   ├── src/App.jsx     # Entire app (single-file architecture)
│   └── .env.example
└── stalker-proxy/      # Node.js CORS proxy for Stalker portals
    ├── src/index.js
    └── .env.example
```

---

## Quick start

### 1. Clone

```bash
git clone https://github.com/your-username/StreamVault.git
cd StreamVault
```

### 2. Start the Stalker proxy *(only needed for Stalker Portal connections)*

```bash
cd stalker-proxy
cp .env.example .env
npm install
npm start
# Proxy runs at http://localhost:3001
```

### 3. Start the frontend

```bash
cd streamvault
cp .env.example .env
npm install
npm run dev
# App runs at http://localhost:5173
```

### 4. Open and connect

Go to `http://localhost:5173` and choose your connection type:

| Type | What you need |
|------|--------------|
| **Xtream Codes** | Server URL · username · password |
| **M3U Playlist** | Direct `.m3u` or `.m3u8` URL |
| **Stalker Portal** | Portal URL · MAC address · proxy running |
| **Direct HLS** | Any `.m3u8`, DASH, or media URL |

---

## Environment variables

### `streamvault/.env`

```env
# URL of the stalker-proxy (local or deployed)
VITE_PROXY_URL=http://localhost:3001
```

### `stalker-proxy/.env`

```env
PORT=3001
# Lock down to your frontend origin in production
ALLOWED_ORIGIN=*
```

---

## Build for production

```bash
cd streamvault
npm run build
# Output in streamvault/dist/
```

---

## Deploying the proxy

The stalker-proxy is a plain Express app and deploys anywhere Node.js runs. Free options:

- **Railway** — connect GitHub repo, auto-detects Node, set `ALLOWED_ORIGIN`
- **Render** — New Web Service, build: `npm install`, start: `npm start`

Once deployed, set `VITE_PROXY_URL` in your frontend environment to the proxy's public URL.

Full deploy instructions: [`stalker-proxy/README.md`](stalker-proxy/README.md)

---

## Tech stack

- **Frontend** — React 19, Vite 8, HLS.js (lazy-loaded)
- **Proxy** — Node.js 18+, Express, node-fetch
- **Styling** — CSS-in-JS via template literal, injected as `<style>` tag (no build-time CSS)
- **Storage** — `localStorage` (browser) with `window.storage` fallback (custom runtimes)

---

## License

[MIT](LICENSE)

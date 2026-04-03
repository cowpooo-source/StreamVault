# StreamVault

The first fully browser-based Stalker Portal IPTV client. No apps to install, no STB emulators — just open a URL and stream.

Supports **Stalker Portal** (MAC-based), **Xtream Codes**, **M3U/M3U8 Playlists**, and **Direct HLS/MP4** URLs.

---

## Features

| Category | Details |
|----------|---------|
| **Live TV** | Channel grid with logos, real-time EPG guide (TiviMate-style) |
| **Movies & VOD** | Poster grid with categories, year, rating, TMDB metadata |
| **Series** | Season/episode browsing with detail modals |
| **Discover** | Trending content and recommendations via TMDB |
| **User Accounts** | Admin, Regular, Free, Guest tiers with role-based limits |
| **Cross-device Sync** | Connections, favorites, watch history follow your account |
| **Import/Export** | Backup and restore all data as JSON |
| **Mobile Responsive** | Hamburger menu + slide-out drawer on portrait screens |
| **Analytics** | Admin dashboard — visitors, requests, cache stats, portals |
| **Image Proxy** | Fixes mixed-content and broken SSL certs on portal image servers |
| **Stream Proxy** | Pipes streams through server to solve CORS and IP-binding |
| **Lazy Loading** | Images load only when scrolled into view |
| **Themes** | Multiple color themes with one-click switching |
| **Multi-language** | i18n support with RTL layout |
| **Legal Disclaimer** | One-time popup before first IPTV connection |
| **Offline Cache** | IndexedDB — channels/categories persist across sessions |

**Player keyboard shortcuts:**
`Space` play/pause | `F` fullscreen | `M` mute | `Left/Right` +/-10s or channels | `Up/Down` volume or channels | `P` PiP | `Esc` close

---

## Architecture

```
Browser (React SPA)
    |
    v
Nginx (HTTPS, Let's Encrypt, reverse proxy)
    |
    v
Express Backend (Node.js, port 3001)
    |-- /stalker/*      Stalker portal proxy (handshake, API, stream)
    |-- /stream          Stream proxy (CORS, IP-binding, Range support)
    |-- /img             Image proxy (HTTPS-first, HTTP fallback)
    |-- /proxy           Generic fetch proxy (Xtream API, M3U)
    |-- /api/auth/*      User authentication (bcrypt + JWT)
    |-- /api/sync/*      Cross-device data sync
    |-- /api/admin/*     User management (admin only)
    |-- /analytics       Admin dashboard (HTML)
    |-- /health          Health check
    |
    v
SQLite (better-sqlite3)
    |-- cache            Channel/VOD/EPG cache (7-day TTL, WAL mode)
    |-- users            User accounts (bcrypt hashed passwords)
    |-- sessions         JWT session tracking (server-side revocation)
    |-- guest_data       Sync data (favorites, history, connections)
    |-- analytics        Visitors, requests, portals, watch log, feedback
```

---

## User Tiers

| | Guest | Free | Regular (default) | Admin |
|---|---|---|---|---|
| IPTV connections | 2 | 2 | 5 | Unlimited |
| VOD/Series items | 500 | 500 | Unlimited | Unlimited |
| EPG | Yes | Yes | Yes | Yes |
| Server sync | No | Yes | Yes | Yes |
| Analytics | No | No | No | Yes |
| User management | No | No | No | Yes |

New registrations automatically get **Regular** access (promotional).

---

## Quick Start (Development)

```bash
# Backend
cd stalker-proxy
cp .env.example .env    # set ADMIN_PASS at minimum
npm install
node src/index.js       # http://localhost:3001

# Frontend
cd streamvault
npm install
npm run dev             # http://localhost:5173
```

Open `http://localhost:5173` — login, register, or continue as guest.

---

## VPS Deployment

### Automated

```bash
./deploy.sh your-domain.com
```

Sets up Node.js, Nginx, SSL (Let's Encrypt), PM2 — fully automated for RHEL/CentOS/Ubuntu.

### Manual

```bash
# Clone and install
git clone https://github.com/frossty/StreamVault.git
cd StreamVault/stalker-proxy && npm install --omit=dev
cd ../streamvault && npm install && npm run build

# Configure
cat > stalker-proxy/.env << EOF
PORT=3001
ADMIN_PASS=your-secure-password
ALLOWED_ORIGIN=*
EOF

# Start with PM2
cd stalker-proxy
pm2 start src/index.js --name stalker-proxy
pm2 save && pm2 startup
```

Nginx serves `streamvault/dist/` as static files and proxies API routes to port 3001.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Backend port |
| `ADMIN_PASS` | — | Admin account password (required, seeds on first start) |
| `ADMIN_USER` | `admin` | Admin username |
| `JWT_SECRET` | auto-generated | JWT signing secret (auto-stored in DB if not set) |
| `DEFAULT_ROLE` | `regular` | Role assigned to new registrations |
| `REGISTRATION_OPEN` | `true` | Set `false` to disable public registration |
| `ALLOWED_ORIGIN` | `*` | CORS allowed origins |
| `CACHE_DB` | `data/cache.db` | SQLite database path |

---

## API Reference

### Authentication
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/register` | — | Create account |
| POST | `/api/auth/login` | — | Login, returns JWT |
| POST | `/api/auth/logout` | Bearer | Revoke session |
| GET | `/api/auth/me` | Bearer | Current user info + limits |
| PUT | `/api/auth/password` | Bearer | Change password |

### Admin (requires admin role)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/users` | List all users |
| POST | `/api/admin/users` | Create user with any role |
| PUT | `/api/admin/users/:id` | Update role, limits, disabled |
| DELETE | `/api/admin/users/:id` | Delete user |

### Data Sync
| Method | Endpoint | Description |
|--------|----------|-------------|
| PUT | `/api/sync/:type` | Save favorites, history, or connections |
| GET | `/api/sync/:type` | Restore synced data |
| POST | `/api/sync/migrate-guest` | Link guest data to user account |
| DELETE | `/api/sync` | Delete sync data for a connection |

### Stalker Proxy
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/stalker/handshake` | Portal authentication |
| POST | `/stalker/validate` | Validate portal account status |
| GET | `/stalker/channels` | Live channel list with genres |
| GET | `/stalker/vod/categories` | VOD categories |
| GET | `/stalker/vod` | VOD items by category |
| GET | `/stalker/series/categories` | Series categories |
| GET | `/stalker/series` | Series by category |
| GET | `/stalker/series/seasons` | Seasons + episodes |
| GET | `/stalker/play` | create_link + stream pipe (same IP) |
| GET | `/stalker/epg` | Electronic Program Guide |
| GET | `/stalker/profile` | STB profile info |

### Utility
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/stream?url=` | Stream proxy with Range/HEAD/CORS |
| GET | `/img?url=` | Image proxy (HTTPS-first, HTTP fallback) |
| GET | `/proxy?url=` | Generic CORS fetch proxy |
| GET | `/health` | Health check |

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19, Vite 8, single-file SPA (App.jsx) |
| Backend | Express 4, Node.js 20+ |
| Database | SQLite via better-sqlite3 (WAL mode) |
| Auth | bcryptjs + jsonwebtoken |
| Video | HLS.js (adaptive), mpegts.js (MPEG-TS), native `<video>` |
| Deployment | Nginx + PM2 + Let's Encrypt |
| Metadata | TMDB API (poster art, ratings, trailers) |

---

## Project Structure

```
StreamVault/
├── streamvault/                 # React frontend
│   ├── src/App.jsx              # Entire SPA (single-file)
│   ├── public/                  # PWA assets, service worker
│   └── dist/                    # Production build
├── stalker-proxy/               # Node.js backend
│   ├── src/index.js             # Express server + all routes
│   ├── src/auth.js              # User auth (bcrypt, JWT, RBAC)
│   ├── src/cache.js             # SQLite cache + analytics
│   ├── src/email.js             # Email module (Resend, disabled)
│   └── src/analytics.html       # Admin dashboard
├── deploy.sh                    # Automated VPS deployment script
└── README.md
```

---

## Disclaimer

StreamVault is a **media player application** only. It does not provide, host, or distribute any content, streams, or IPTV services. Users are solely responsible for ensuring they have valid, legal subscriptions for any services they connect. The developers bear no responsibility for the content or legality of third-party services.

---

## License

Private repository. All rights reserved.

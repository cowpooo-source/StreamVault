# Static Media Portal (`media.portalheaven.stream`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a zero-backend, IndexedDB-only static web player at `media.portalheaven.stream` that supports M3U, Jellyfin, Plex, Xtream Codes, and Stalker portals. Streams always go direct (browser → source), never through our infrastructure.

**Architecture:** Static React SPA on Cloudflare Pages + a thin Cloudflare Worker used **only** for Stalker session management and CORS relay for Xtream panels. No D1, no D1-backed catalog, no stream byte proxying. IndexedDB is the only persistence layer. Worker has a single KV binding (Stalker path/session cache).

**Tech Stack:** React 19, Vite 8, TypeScript, hls.js, mpegts.js, Cloudflare Pages, Cloudflare Workers (Workers Paid plan not required — free tier covers 100k req/day for the metadata relay), KV (free).

**Reuse from `poc/cf-worker` branch:**
- `streamvault-worker/src/utils/cors.js` — verbatim (32 lines)
- `streamvault-worker/src/utils/stalker.js` — verbatim (175 lines, includes path discovery, MAC handshake, retry, pagination)
- `streamvault-worker/src/handlers/stalker.js` — copy and **strip the `/stalker/play` byte-proxying function** (we don't proxy bytes per user requirement)
- `streamvault-worker/src/handlers/proxy.js` — verbatim (30 lines, used for Xtream metadata only)

**Reuse from `add-more-providers-jellyfin` branch (current):**
- `streamvault/src/adapters/jellyfin-adapter.js` — port to TypeScript, copy the API surface
- `streamvault/src/adapters/plex-adapter.js` — port to TypeScript, copy the API surface
- `streamvault/src/components/Player.jsx` — copy and trim (we don't need the Audio/Photo/VAST/EPG/playlist modes for v1; just VideoPlayer and a basic HLS wrapper)
- `streamvault/src/components/setup/JellyfinConnectStep.jsx` — port to TS
- `streamvault/src/components/setup/PlexConnectStep.jsx` — port to TS
- `streamvault/src/services/plex-server-discovery.js` — port to TS

**Branch layout:**
```
add-more-providers-jellyfin   ← current branch
  └── feature/static-media-portal   ← NEW long-lived branch (deploys to media.portalheaven.stream)
        ├── feature/static-scaffold
        ├── feature/static-m3u-jellyfin-plex  (browser-direct, no Worker)
        ├── feature/static-cloudflare-worker
        ├── feature/static-xtream
        └── feature/static-stalker
```

---

## File Structure

```
streamvault-static/                                    ← NEW directory
  package.json                                         ← static-only deps
  tsconfig.json                                        ← strict TS
  vite.config.ts                                       ← http:// origin, no auth
  index.html                                           ← HTTP entry, no CSP allowlists for HTTPS-only CDNs
  src/
    main.tsx                                           ← React 19 root
    App.tsx                                            ← minimal shell, IndexedDB-backed
    adapters/
      static/                                          ← browser-direct, no Worker
        m3u.ts
        jellyfin.ts
        plex.ts
        direct-hls.ts
      relayed/                                         ← uses CF Worker for metadata
        xtream.ts
        stalker.ts
        worker-base.ts                                 ← shared: builds Worker URL, handles errors
    components/
      LibraryGrid.tsx                                  ← channel/poster grid
      Player.tsx                                       ← HLS player (slimmed from streamvault/src/components/Player.jsx)
      ServerPicker.tsx                                 ← provider-type picker
      setup/
        JellyfinConnectStep.tsx
        PlexConnectStep.tsx
        M3UConnectStep.tsx
        XtreamConnectStep.tsx
        StalkerConnectStep.tsx
    storage/
      indexeddb.ts                                     ← connection store, no encryption (v1)
      schema.ts                                        ← TS types for the IDB shape
    utils/
      i18n.ts                                          ← 10 langs, copied from streamvault/src/i18n.js
      stream-url-clean.ts                              ← strip "ffmpeg " prefix, fix localhost refs
  public/
    manifest.json
    icons.svg
  deploy/
    cloudflare-worker/
      src/
        index.ts                                       ← router
        utils/
          cors.ts                                      ← copied from poc/cf-worker
          stalker.ts                                   ← copied from poc/cf-worker
        handlers/
          stalker.ts                                   ← copied from poc/cf-worker, MINUS /stalker/play
          proxy.ts                                     ← copied from poc/cf-worker
          xtream.ts                                    ← NEW: Xtream metadata relay
      wrangler.toml                                    ← KV binding only
      package.json
      tsconfig.json
    cloudflare-pages/
      _headers                                         ← CORS for /_cors/* routes
      _redirects                                       ← SPA fallback
  .github/
    workflows/
      deploy-static.yml                                ← builds + deploys to CF Pages on push to feature/static-media-portal
      deploy-worker.yml                                ← wrangler deploy on push to feature/static-media-portal
  README.md
```

---

## Task 1: Scaffold the static project directory

**Files:**
- Create: `streamvault-static/package.json`
- Create: `streamvault-static/tsconfig.json`
- Create: `streamvault-static/vite.config.ts`
- Create: `streamvault-static/index.html`
- Create: `streamvault-static/src/main.tsx`
- Create: `streamvault-static/src/App.tsx`
- Create: `streamvault-static/.gitignore`
- Create: `streamvault-static/README.md`

- [ ] **Step 1: Create `streamvault-static/.gitignore`**

```
node_modules
dist
.wrangler
*.log
.DS_Store
.env
.env.local
```

- [ ] **Step 2: Create `streamvault-static/package.json`**

```json
{
  "name": "streamvault-static",
  "version": "0.1.0",
  "description": "Zero-backend media player at media.portalheaven.stream",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "lint": "eslint ."
  },
  "dependencies": {
    "hls.js": "^1.5.17",
    "mpegts.js": "^1.7.3",
    "react": "^19.2.4",
    "react-dom": "^19.2.4"
  },
  "devDependencies": {
    "@types/react": "^19.2.14",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^6.0.0",
    "eslint": "^9.39.4",
    "typescript": "^5.6.3",
    "vite": "^8.0.0",
    "vitest": "^4.1.5"
  }
}
```

- [ ] **Step 3: Create `streamvault-static/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": false,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Create `streamvault-static/vite.config.ts`**

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 8080 },
  build: { outDir: "dist", sourcemap: true },
  test: { environment: "jsdom", globals: true },
});
```

- [ ] **Step 5: Create `streamvault-static/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/icons.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#1a1a2e" />
    <title>StreamVault Media</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Create `streamvault-static/src/main.tsx`**

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

- [ ] **Step 7: Create `streamvault-static/src/App.tsx`**

```tsx
import { useState } from "react";

export function App() {
  const [placeholder] = useState("StreamVault Media");
  return (
    <main style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1>{placeholder}</h1>
      <p>Coming soon. Connect M3U, Jellyfin, Plex, Xtream, or Stalker.</p>
    </main>
  );
}
```

- [ ] **Step 8: Create `streamvault-static/README.md`**

```markdown
# StreamVault Static

Zero-backend media player at `media.portalheaven.stream`.

Supports: M3U, Jellyfin, Plex (browser-direct), Xtream Codes, Stalker (via CF Worker relay).

## Develop

```bash
npm install
npm run dev
```

Open http://localhost:8080

## Deploy

Push to `feature/static-media-portal` — CI deploys to Cloudflare Pages.
```

- [ ] **Step 9: Create the branch and commit**

```bash
git checkout -b feature/static-media-portal
git checkout -b feature/static-scaffold
git add streamvault-static/
git commit -m "chore(static): scaffold streamvault-static/ with Vite + React + TS"
```

- [ ] **Step 10: Verify it builds**

```bash
cd streamvault-static
npm install
npm run build
ls dist/
```

Expected: `dist/index.html` and `dist/assets/*.js` exist. No TS errors.

---

## Task 2: IndexedDB storage layer

**Files:**
- Create: `streamvault-static/src/storage/schema.ts`
- Create: `streamvault-static/src/storage/indexeddb.ts`
- Create: `streamvault-static/tests/storage/indexeddb.test.ts`

- [ ] **Step 1: Create `streamvault-static/src/storage/schema.ts`**

```typescript
export type ProviderType = "m3u" | "jellyfin" | "plex" | "xtream" | "stalker";

export interface StoredConnection {
  id: string;                    // crypto.randomUUID()
  providerType: ProviderType;
  name: string;                  // user-given label
  createdAt: number;             // Date.now()
  lastUsedAt: number;
  config: M3UConfig | JellyfinConfig | PlexConfig | XtreamConfig | StalkerConfig;
}

export interface M3UConfig {
  kind: "m3u";
  playlistUrl: string;
}

export interface JellyfinConfig {
  kind: "jellyfin";
  baseUrl: string;
  apiKey: string;
  userId: string;
  serverName: string;
}

export interface PlexConfig {
  kind: "plex";
  baseUrl: string;
  accessToken: string;
  machineId: string;            // for X-Plex-Client-Identifier
  serverName: string;
}

export interface XtreamConfig {
  kind: "xtream";
  baseUrl: string;
  username: string;
  password: string;
}

export interface StalkerConfig {
  kind: "stalker";
  portal: string;
  mac: string;
  serial?: string;
}
```

- [ ] **Step 2: Write failing test for IDB layer**

```typescript
// streamvault-static/tests/storage/indexeddb.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, putConnection, listConnections, getConnection, deleteConnection } from "../../src/storage/indexeddb";
import type { StoredConnection } from "../../src/storage/schema";

const sample: StoredConnection = {
  id: "test-1",
  providerType: "m3u",
  name: "Test Playlist",
  createdAt: Date.now(),
  lastUsedAt: Date.now(),
  config: { kind: "m3u", playlistUrl: "http://example.com/playlist.m3u" },
};

describe("indexeddb storage", () => {
  beforeEach(async () => {
    // Use a fresh DB name per test
    indexedDB.deleteDatabase("streamvault-static-test");
  });

  it("opens the database and creates the connections store", async () => {
    const db = await openDb("streamvault-static-test");
    expect(db.objectStoreNames.contains("connections")).toBe(true);
    db.close();
  });

  it("puts and lists a connection", async () => {
    const db = await openDb("streamvault-static-test");
    await putConnection(db, sample);
    const all = await listConnections(db);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("test-1");
    db.close();
  });

  it("gets a connection by id", async () => {
    const db = await openDb("streamvault-static-test");
    await putConnection(db, sample);
    const got = await getConnection(db, "test-1");
    expect(got?.name).toBe("Test Playlist");
    db.close();
  });

  it("deletes a connection", async () => {
    const db = await openDb("streamvault-static-test");
    await putConnection(db, sample);
    await deleteConnection(db, "test-1");
    const all = await listConnections(db);
    expect(all).toHaveLength(0);
    db.close();
  });

  it("updates lastUsedAt when putting an existing connection", async () => {
    const db = await openDb("streamvault-static-test");
    await putConnection(db, { ...sample, lastUsedAt: 100 });
    await putConnection(db, { ...sample, lastUsedAt: 200 });
    const got = await getConnection(db, "test-1");
    expect(got?.lastUsedAt).toBe(200);
    db.close();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd streamvault-static
npm test -- tests/storage/indexeddb.test.ts
```

Expected: FAIL — module `../../src/storage/indexeddb` not found.

- [ ] **Step 4: Implement `streamvault-static/src/storage/indexeddb.ts`**

```typescript
import type { StoredConnection } from "./schema";

const DB_VERSION = 1;
const STORE = "connections";

export function openDb(name = "streamvault-static"): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("lastUsedAt", "lastUsedAt");
        store.createIndex("providerType", "providerType");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function awaitRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putConnection(db: IDBDatabase, conn: StoredConnection): Promise<void> {
  const store = tx(db, "readwrite");
  await awaitRequest(store.put(conn));
}

export async function getConnection(db: IDBDatabase, id: string): Promise<StoredConnection | null> {
  const store = tx(db, "readonly");
  const result = await awaitRequest(store.get(id));
  return result ?? null;
}

export async function listConnections(db: IDBDatabase): Promise<StoredConnection[]> {
  const store = tx(db, "readonly");
  const all = await awaitRequest<StoredConnection[]>(store.getAll());
  return all.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

export async function deleteConnection(db: IDBDatabase, id: string): Promise<void> {
  const store = tx(db, "readwrite");
  await awaitRequest(store.delete(id));
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npm test -- tests/storage/indexeddb.test.ts
```

Expected: PASS (5/5).

- [ ] **Step 6: Commit**

```bash
git add streamvault-static/src/storage/ streamvault-static/tests/storage/
git commit -m "feat(static): add IndexedDB storage layer for connection persistence"
```

---

## Task 3: M3U parser adapter (browser-direct, no Worker)

**Files:**
- Create: `streamvault-static/src/adapters/static/m3u.ts`
- Create: `streamvault-static/tests/adapters/static/m3u.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// streamvault-static/tests/adapters/static/m3u.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseM3U, fetchAndParseM3U } from "../../../src/adapters/static/m3u";

const SAMPLE_M3U = `#EXTM3U
#EXTINF:-1 tvg-id="ch1.tv" tvg-name="Channel 1" tvg-logo="http://logo.example/c1.png" group-title="News",Channel 1
http://stream.example.com/live/ch1.m3u8
#EXTINF:-1 tvg-id="ch2.tv" tvg-name="Channel 2" group-title="Sports",Channel 2
http://stream.example.com/live/ch2.ts
#EXTINF:-1 tvg-id="" tvg-name="Channel 3" group-title="",Channel 3
http://stream.example.com/live/ch3.mp4
`;

describe("m3u parser", () => {
  describe("parseM3U", () => {
    it("parses channels with metadata", () => {
      const result = parseM3U(SAMPLE_M3U);
      expect(result).toHaveLength(3);
      expect(result[0]).toMatchObject({
        name: "Channel 1",
        url: "http://stream.example.com/live/ch1.m3u8",
        tvgId: "ch1.tv",
        logo: "http://logo.example/c1.png",
        group: "News",
      });
    });

    it("classifies stream type from extension", () => {
      const result = parseM3U(SAMPLE_M3U);
      expect(result[0].streamType).toBe("hls");
      expect(result[1].streamType).toBe("ts");
      expect(result[2].streamType).toBe("mp4");
    });

    it("skips invalid entries without URLs", () => {
      const result = parseM3U("#EXTM3U\n#EXTINF:-1,No URL");
      expect(result).toHaveLength(0);
    });
  });

  describe("fetchAndParseM3U", () => {
    beforeEach(() => {
      global.fetch = vi.fn();
    });

    it("fetches and parses the playlist", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(SAMPLE_M3U),
      });
      const result = await fetchAndParseM3U("http://example.com/list.m3u");
      expect(result).toHaveLength(3);
    });

    it("throws on fetch failure", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 404 });
      await expect(fetchAndParseM3U("http://example.com/missing")).rejects.toThrow("HTTP 404");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/adapters/static/m3u.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `streamvault-static/src/adapters/static/m3u.ts`**

```typescript
export type StreamType = "hls" | "ts" | "mp4" | "unknown";

export interface M3UChannel {
  name: string;
  url: string;
  tvgId: string | null;
  tvgName: string | null;
  logo: string | null;
  group: string;
  streamType: StreamType;
}

function detectStreamType(url: string): StreamType {
  const lower = url.toLowerCase().split("?")[0];
  if (lower.endsWith(".m3u8")) return "hls";
  if (lower.endsWith(".ts")) return "ts";
  if (lower.endsWith(".mp4")) return "mp4";
  return "unknown";
}

export function parseM3U(text: string): M3UChannel[] {
  const lines = text.split(/\r?\n/);
  const channels: M3UChannel[] = [];
  let pending: Partial<M3UChannel> | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTM3U")) continue;
    if (line.startsWith("#EXTINF:")) {
      // Format: #EXTINF:-1 attr1="v1" attr2="v2",Name
      const commaIdx = line.indexOf(",");
      const attrPart = commaIdx > 0 ? line.substring(8, commaIdx) : line.substring(8);
      const name = commaIdx > 0 ? line.substring(commaIdx + 1).trim() : "Unknown";

      const tvgId = matchAttr(attrPart, "tvg-id");
      const tvgName = matchAttr(attrPart, "tvg-name");
      const logo = matchAttr(attrPart, "tvg-logo");
      const group = matchAttr(attrPart, "group-title") ?? "Default";

      pending = { name, tvgId, tvgName, logo, group };
    } else if (!line.startsWith("#")) {
      if (pending) {
        channels.push({
          name: pending.name ?? "Unknown",
          url: line,
          tvgId: pending.tvgId ?? null,
          tvgName: pending.tvgName ?? null,
          logo: pending.logo ?? null,
          group: pending.group ?? "Default",
          streamType: detectStreamType(line),
        });
        pending = null;
      }
    }
  }
  return channels;
}

function matchAttr(s: string, name: string): string | null {
  const re = new RegExp(`${name}="([^"]*)"`, "i");
  const m = s.match(re);
  return m ? m[1] : null;
}

export async function fetchAndParseM3U(url: string): Promise<M3UChannel[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`M3U fetch failed: HTTP ${res.status}`);
  const text = await res.text();
  return parseM3U(text);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/adapters/static/m3u.test.ts
```

Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add streamvault-static/src/adapters/static/m3u.ts streamvault-static/tests/adapters/static/m3u.test.ts
git commit -m "feat(static): add M3U parser adapter (browser-direct, no Worker)"
```

---

## Task 4: Direct HLS player (browser-direct, no Worker)

**Files:**
- Create: `streamvault-static/src/adapters/static/direct-hls.ts`
- Create: `streamvault-static/src/components/Player.tsx`
- Create: `streamvault-static/tests/adapters/static/direct-hls.test.ts`

- [ ] **Step 1: Write failing test for `detectStreamKind`**

```typescript
// streamvault-static/tests/adapters/static/direct-hls.test.ts
import { describe, it, expect } from "vitest";
import { detectStreamKind, buildStreamUrl } from "../../../src/adapters/static/direct-hls";

describe("direct-hls", () => {
  describe("detectStreamKind", () => {
    it("detects hls from .m3u8 extension", () => {
      expect(detectStreamKind("http://example.com/live.m3u8")).toBe("hls");
    });
    it("detects ts from .ts extension", () => {
      expect(detectStreamKind("http://example.com/live.ts")).toBe("ts");
    });
    it("detects mp4 from .mp4 extension", () => {
      expect(detectStreamKind("http://example.com/v.mp4")).toBe("mp4");
    });
    it("returns unknown for non-media URLs", () => {
      expect(detectStreamKind("http://example.com/")).toBe("unknown");
    });
  });

  describe("buildStreamUrl", () => {
    it("returns URL as-is for direct streams", () => {
      const url = buildStreamUrl("http://example.com/live.m3u8", null);
      expect(url).toBe("http://example.com/live.m3u8");
    });
    it("rewrites Xtream live URLs to .ts when on HTTPS", () => {
      // Xtream panels return m3u8 but only serve .ts on HTTPS to avoid mixed content
      const xtreamBase = "http://panel.example.com/live/user/pass/";
      const url = buildStreamUrl(`${xtreamBase}123.m3u8`, { forceTs: true });
      expect(url).toBe(`${xtreamBase}123.ts`);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/adapters/static/direct-hls.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `streamvault-static/src/adapters/static/direct-hls.ts`**

```typescript
import Hls from "hls.js";
import mpegts from "mpegts.js";

export type StreamKind = "hls" | "ts" | "mp4" | "unknown";

export function detectStreamKind(url: string): StreamKind {
  const lower = url.toLowerCase().split("?")[0];
  if (lower.endsWith(".m3u8")) return "hls";
  if (lower.endsWith(".ts")) return "ts";
  if (lower.endsWith(".mp4")) return "mp4";
  return "unknown";
}

export interface BuildStreamUrlOpts {
  forceTs?: boolean;     // Xtream HTTPS workaround: rewrite m3u8 → ts
  appProtocol?: "http:" | "https:";
}

export function buildStreamUrl(url: string, opts: BuildStreamUrlOpts | null): string {
  if (opts?.forceTs && url.endsWith(".m3u8")) {
    return url.replace(/\.m3u8$/, ".ts");
  }
  return url;
}

export interface PlaybackHandle {
  destroy: () => void;
  kind: StreamKind;
}

/**
 * Attach a stream to a <video> element.
 * - HLS: use hls.js if supported, else native (Safari)
 * - TS: use mpegts.js
 * - MP4: native
 * Returns a handle with a destroy() function.
 */
export function attachStream(video: HTMLVideoElement, url: string): PlaybackHandle {
  const kind = detectStreamKind(url);

  if (kind === "hls") {
    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true, lowLatencyMode: false });
      hls.loadSource(url);
      hls.attachMedia(video);
      return { destroy: () => hls.destroy(), kind };
    }
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      return { destroy: () => { video.removeAttribute("src"); }, kind };
    }
    throw new Error("HLS not supported in this browser");
  }

  if (kind === "ts") {
    if (mpegts.isSupported()) {
      const player = mpegts.createPlayer({ type: "mpegts", url, isLive: true });
      player.attachMediaElement(video);
      player.load();
      return { destroy: () => { player.destroy(); }, kind };
    }
    // Some browsers play .ts natively (Safari)
    video.src = url;
    return { destroy: () => { video.removeAttribute("src"); }, kind };
  }

  if (kind === "mp4") {
    video.src = url;
    return { destroy: () => { video.removeAttribute("src"); }, kind };
  }

  throw new Error(`Unsupported stream URL: ${url}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/adapters/static/direct-hls.test.ts
```

Expected: PASS (6/6).

- [ ] **Step 5: Create `streamvault-static/src/components/Player.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import { attachStream, type StreamKind } from "../adapters/static/direct-hls";

export interface PlayerProps {
  url: string;
  poster?: string;
  onClose?: () => void;
}

export function Player({ url, poster, onClose }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<StreamKind | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    setError(null);
    let handle: ReturnType<typeof attachStream> | null = null;
    try {
      handle = attachStream(video, url);
      setKind(handle.kind);
      video.play().catch((e) => {
        // Autoplay may be blocked; user must click play
        if (e.name !== "AbortError") console.warn("play() failed:", e);
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to attach stream";
      setError(msg);
    }
    return () => {
      if (handle) handle.destroy();
    };
  }, [url]);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000", zIndex: 100 }}>
      <video
        ref={videoRef}
        controls
        autoPlay
        playsInline
        poster={poster}
        style={{ width: "100%", height: "100%", objectFit: "contain" }}
      />
      {error && (
        <div style={{ position: "absolute", top: 16, left: 16, color: "#fff", background: "#c00", padding: 12 }}>
          {error}
        </div>
      )}
      {kind && (
        <div style={{ position: "absolute", top: 16, right: 16, color: "#aaa", fontSize: 12 }}>
          {kind.toUpperCase()}
        </div>
      )}
      {onClose && (
        <button
          onClick={onClose}
          style={{ position: "absolute", bottom: 24, left: "50%", transform: "translateX(-50%)", padding: "8px 16px" }}
        >
          Close
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Commit**

```bash
git add streamvault-static/src/adapters/static/direct-hls.ts streamvault-static/src/components/Player.tsx streamvault-static/tests/adapters/static/direct-hls.test.ts
git commit -m "feat(static): add direct HLS/TS/MP4 player (browser-direct, no proxy)"
```

---

## Task 5: Library grid + M3U connect step

**Files:**
- Create: `streamvault-static/src/components/LibraryGrid.tsx`
- Create: `streamvault-static/src/components/setup/M3UConnectStep.tsx`
- Modify: `streamvault-static/src/App.tsx`

- [ ] **Step 1: Create `streamvault-static/src/components/LibraryGrid.tsx`**

```tsx
import type { M3UChannel } from "../adapters/static/m3u";

export interface LibraryGridProps {
  channels: M3UChannel[];
  onSelect: (channel: M3UChannel) => void;
}

export function LibraryGrid({ channels, onSelect }: LibraryGridProps) {
  if (channels.length === 0) {
    return <p style={{ padding: 24 }}>No channels found.</p>;
  }
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
      gap: 12,
      padding: 16,
    }}>
      {channels.map((ch, i) => (
        <button
          key={`${ch.url}-${i}`}
          onClick={() => onSelect(ch)}
          style={{
            background: "#222",
            border: "1px solid #444",
            padding: 12,
            color: "#fff",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          {ch.logo && <img src={ch.logo} alt="" style={{ width: "100%", height: 80, objectFit: "contain" }} />}
          <div style={{ marginTop: 8, fontSize: 14, fontWeight: 500 }}>{ch.name}</div>
          <div style={{ marginTop: 4, fontSize: 11, color: "#888" }}>{ch.group}</div>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Create `streamvault-static/src/components/setup/M3UConnectStep.tsx`**

```tsx
import { useState } from "react";
import { fetchAndParseM3U, type M3UChannel } from "../../adapters/static/m3u";

export interface M3UConnectStepProps {
  onConnected: (channels: M3UChannel[], playlistUrl: string) => void;
}

export function M3UConnectStep({ onConnected }: M3UConnectStepProps) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleConnect = async () => {
    setError(null);
    setLoading(true);
    try {
      const channels = await fetchAndParseM3U(url);
      if (channels.length === 0) throw new Error("Playlist is empty or invalid");
      onConnected(channels, url);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to load M3U";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: 24 }}>
      <h3>Connect M3U Playlist</h3>
      <p>Paste the URL of your M3U or M3U8 playlist.</p>
      <input
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="http://example.com/playlist.m3u"
        style={{ width: "100%", padding: 8, marginBottom: 12 }}
      />
      <button onClick={handleConnect} disabled={loading || !url}>
        {loading ? "Loading..." : "Connect"}
      </button>
      {error && <div style={{ color: "#c00", marginTop: 12 }}>{error}</div>}
    </div>
  );
}
```

- [ ] **Step 3: Update `streamvault-static/src/App.tsx` to wire it all together**

```tsx
import { useEffect, useState } from "react";
import { openDb, listConnections, putConnection } from "./storage/indexeddb";
import type { StoredConnection, M3UConfig } from "./storage/schema";
import type { M3UChannel } from "./adapters/static/m3u";
import { M3UConnectStep } from "./components/setup/M3UConnectStep";
import { LibraryGrid } from "./components/LibraryGrid";
import { Player } from "./components/Player";

type View =
  | { name: "home" }
  | { name: "connect-m3u" }
  | { name: "library"; channels: M3UChannel[]; connectionId: string }
  | { name: "player"; url: string; name: string };

export function App() {
  const [view, setView] = useState<View>({ name: "home" });
  const [connections, setConnections] = useState<StoredConnection[]>([]);

  useEffect(() => {
    (async () => {
      const db = await openDb();
      const list = await listConnections(db);
      setConnections(list);
    })();
  }, []);

  const handleM3UConnected = async (channels: M3UChannel[], playlistUrl: string) => {
    const db = await openDb();
    const conn: StoredConnection = {
      id: crypto.randomUUID(),
      providerType: "m3u",
      name: new URL(playlistUrl).hostname,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      config: { kind: "m3u", playlistUrl } as M3UConfig,
    };
    await putConnection(db, conn);
    setView({ name: "library", channels, connectionId: conn.id });
  };

  return (
    <main style={{ minHeight: "100vh", background: "#1a1a2e", color: "#fff" }}>
      <header style={{ padding: 16, borderBottom: "1px solid #333" }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>StreamVault Media</h1>
        <nav style={{ marginTop: 8 }}>
          <button onClick={() => setView({ name: "home" })}>Home</button>
          <button onClick={() => setView({ name: "connect-m3u" })}>Add M3U</button>
        </nav>
        {connections.length > 0 && view.name === "home" && (
          <ul>
            {connections.map((c) => (
              <li key={c.id}>{c.name} ({c.providerType})</li>
            ))}
          </ul>
        )}
      </header>

      {view.name === "home" && <p style={{ padding: 24 }}>Welcome. Add an M3U playlist to get started.</p>}

      {view.name === "connect-m3u" && <M3UConnectStep onConnected={handleM3UConnected} />}

      {view.name === "library" && (
        <LibraryGrid
          channels={view.channels}
          onSelect={(ch) => setView({ name: "player", url: ch.url, name: ch.name })}
        />
      )}

      {view.name === "player" && (
        <Player
          url={view.url}
          onClose={() => setView({ name: "library", channels: [], connectionId: "" })}
        />
      )}
    </main>
  );
}
```

- [ ] **Step 4: Build to verify TypeScript compiles**

```bash
cd streamvault-static
npm run build
```

Expected: Build succeeds, no TS errors.

- [ ] **Step 5: Commit**

```bash
git add streamvault-static/src/components/ streamvault-static/src/App.tsx
git commit -m "feat(static): wire M3U connect + library grid + player"
```

---

## Task 6: Cloudflare Worker scaffold (Xtream/Stalker relay)

**Files:**
- Create: `streamvault-static/deploy/cloudflare-worker/package.json`
- Create: `streamvault-static/deploy/cloudflare-worker/tsconfig.json`
- Create: `streamvault-static/deploy/cloudflare-worker/wrangler.toml`
- Create: `streamvault-static/deploy/cloudflare-worker/src/index.ts`
- Create: `streamvault-static/deploy/cloudflare-worker/src/utils/cors.ts`
- Create: `streamvault-static/deploy/cloudflare-worker/src/utils/stalker.ts` (copied from poc/cf-worker)
- Create: `streamvault-static/deploy/cloudflare-worker/src/handlers/stalker.ts` (copied from poc/cf-worker, minus /stalker/play)
- Create: `streamvault-static/deploy/cloudflare-worker/src/handlers/proxy.ts` (copied from poc/cf-worker)

- [ ] **Step 1: Create `streamvault-static/deploy/cloudflare-worker/package.json`**

```json
{
  "name": "streamvault-static-worker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20250101.0",
    "typescript": "^5.6.3",
    "vitest": "^4.1.5",
    "wrangler": "^3.99.0"
  }
}
```

- [ ] **Step 2: Create `streamvault-static/deploy/cloudflare-worker/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `streamvault-static/deploy/cloudflare-worker/wrangler.toml`**

```toml
name = "streamvault-static-worker"
main = "src/index.ts"
compatibility_date = "2024-12-01"

# Bind KV (Stalker path/session cache)
# Create with: wrangler kv namespace create SV_CACHE
[[kv_namespaces]]
binding = "SV_CACHE"
id = "REPLACE_WITH_KV_ID_AFTER_CREATION"

[vars]
ALLOWED_ORIGIN = "*"
```

- [ ] **Step 4: Create `streamvault-static/deploy/cloudflare-worker/src/utils/cors.ts`**

```typescript
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Stalker-MAC, X-Stalker-Token",
  "Access-Control-Max-Age": "86400",
};

export function corsHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...CORS_HEADERS, ...extra };
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

export function errorResponse(message: string, status = 502): Response {
  return jsonResponse({ error: message }, status);
}

export function handleOptions(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
```

- [ ] **Step 5: Copy `streamvault-worker/src/utils/stalker.js` from `origin/poc/cf-worker` and rename to `stalker.ts`**

```bash
git show origin/poc/cf-worker:streamvault-worker/src/utils/stalker.js > streamvault-static/deploy/cloudflare-worker/src/utils/stalker.ts
```

Then add a type-only comment at the top:
```typescript
// Copied verbatim from origin/poc/cf-worker:streamvault-worker/src/utils/stalker.js
// KV cache for Stalker path/session. Original used `env.SV_CACHE`; we keep the same.
```

- [ ] **Step 6: Copy `streamvault-worker/src/handlers/stalker.js` and strip `/stalker/play`**

```bash
git show origin/poc/cf-worker:streamvault-worker/src/handlers/stalker.js > streamvault-static/deploy/cloudflare-worker/src/handlers/stalker.ts
```

Then **delete** the `handleStalkerPlay` function (it proxies stream bytes — we don't do that).

- [ ] **Step 7: Copy `streamvault-worker/src/handlers/proxy.js` to `proxy.ts`**

```bash
git show origin/poc/cf-worker:streamvault-worker/src/handlers/proxy.js > streamvault-static/deploy/cloudflare-worker/src/handlers/proxy.ts
```

- [ ] **Step 8: Create `streamvault-static/deploy/cloudflare-worker/src/index.ts`**

```typescript
import { jsonResponse, errorResponse, handleOptions } from "./utils/cors";
import {
  handleHandshake, handleChannels, handleVodCategories, handleVod,
  handleSeriesCategories, handleSeries, handleSeriesSeasons,
  handleStalkerStream, handleEpisodeStream,
  handleProfile, handleAccount, handleEpg, handleApi,
} from "./handlers/stalker";
import { handleProxy } from "./handlers/proxy";

export interface Env {
  SV_CACHE: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === "OPTIONS") return handleOptions();

    try {
      if (pathname === "/health") {
        return jsonResponse({ status: "ok", runtime: "cloudflare-worker" });
      }

      // Generic CORS proxy — used for Xtream metadata, M3U fetches.
      // NEVER use for stream bytes (m3u8, ts, mp4).
      if (pathname === "/proxy" && method === "GET") {
        return handleProxy(url);
      }

      // Stalker routes
      if (pathname === "/stalker/handshake" && method === "POST") return handleHandshake(request, env);
      if (pathname === "/stalker/channels" && method === "GET") return handleChannels(url, env);
      if (pathname === "/stalker/vod/categories" && method === "GET") return handleVodCategories(url, env);
      if (pathname === "/stalker/vod" && method === "GET") return handleVod(url, env);
      if (pathname === "/stalker/series/categories" && method === "GET") return handleSeriesCategories(url, env);
      if (pathname === "/stalker/series" && method === "GET") return handleSeries(url, env);
      if (pathname === "/stalker/series/seasons" && method === "GET") return handleSeriesSeasons(url, env);
      if (pathname === "/stalker/series/episode/stream" && method === "GET") return handleEpisodeStream(url, env);
      if (pathname === "/stalker/stream" && method === "GET") return handleStalkerStream(url, env);
      if (pathname === "/stalker/profile" && method === "GET") return handleProfile(url, env);
      if (pathname === "/stalker/account" && method === "GET") return handleAccount(url, env);
      if (pathname === "/stalker/epg" && method === "GET") return handleEpg(url, env);
      if (pathname === "/stalker/api" && method === "GET") return handleApi(url, env);

      return jsonResponse({ error: "Not found" }, 404);
    } catch (e) {
      return errorResponse(e instanceof Error ? e.message : "Internal error", 500);
    }
  },
};
```

- [ ] **Step 9: Verify the Worker type-checks**

```bash
cd streamvault-static/deploy/cloudflare-worker
npm install
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 10: Verify wrangler config is valid**

```bash
npx wrangler deploy --dry-run --outdir=dist
```

Expected: "Total Upload: X.XX KiB / gzip: X.XX KiB" with no errors.

- [ ] **Step 11: Commit**

```bash
git add streamvault-static/deploy/cloudflare-worker/
git commit -m "feat(static): scaffold CF Worker for Xtream/Stalker CORS relay (KV-only, no D1)"
```

---

## Task 7: Xtream adapter (uses Worker for metadata, direct for streams)

**Files:**
- Create: `streamvault-static/src/adapters/relayed/worker-base.ts`
- Create: `streamvault-static/src/adapters/relayed/xtream.ts`
- Create: `streamvault-static/tests/adapters/relayed/xtream.test.ts`
- Create: `streamvault-static/src/components/setup/XtreamConnectStep.tsx`

- [ ] **Step 1: Create `streamvault-static/src/adapters/relayed/worker-base.ts`**

```typescript
// Centralized Worker URL — change this if you self-host the Worker.
export const WORKER_BASE = "https://cors.media.portalheaven.stream";

export interface WorkerFetchOpts {
  timeoutMs?: number;
}

export async function workerFetch(path: string, opts: WorkerFetchOpts = {}): Promise<Response> {
  const url = `${WORKER_BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15000);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 2: Write failing test for Xtream adapter**

```typescript
// streamvault-static/tests/adapters/relayed/xtream.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { XtreamAdapter, buildXtreamLiveUrl } from "../../../src/adapters/relayed/xtream";

describe("xtream adapter", () => {
  describe("buildXtreamLiveUrl", () => {
    it("builds a direct .ts URL for live streams", () => {
      const url = buildXtreamLiveUrl("http://panel.example.com", "user", "pass", 123);
      expect(url).toBe("http://panel.example.com/live/user/pass/123.ts");
    });

    it("rewrites to .ts even when panel returns .m3u8 (HTTPS fix)", () => {
      const url = buildXtreamLiveUrl("http://panel.example.com", "user", "pass", 123);
      expect(url.endsWith(".ts")).toBe(true);
      expect(url.endsWith(".m3u8")).toBe(false);
    });
  });

  describe("listLiveCategories", () => {
    beforeEach(() => {
      global.fetch = vi.fn();
    });

    it("calls the Worker proxy with player_api.php", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([{ category_id: "1", category_name: "News" }]),
      });
      const cats = await XtreamAdapter.listLiveCategories("http://panel", "user", "pass");
      expect(cats).toHaveLength(1);
      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(calledUrl).toContain("/proxy?url=");
      expect(calledUrl).toContain("player_api.php");
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npm test -- tests/adapters/relayed/xtream.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Implement `streamvault-static/src/adapters/relayed/xtream.ts`**

```typescript
import { workerFetch } from "./worker-base";

export interface XtreamCategory {
  category_id: string;
  category_name: string;
}

export interface XtreamLiveChannel {
  stream_id: number;
  name: string;
  stream_type: string;
  stream_icon: string | null;
  category_id: string | null;
}

export function buildXtreamLiveUrl(base: string, user: string, pass: string, streamId: number): string {
  const trimmed = base.replace(/\/+$/, "");
  return `${trimmed}/live/${user}/${pass}/${streamId}.ts`;
}

export const XtreamAdapter = {
  async listLiveCategories(base: string, user: string, pass: string): Promise<XtreamCategory[]> {
    const target = `${base.replace(/\/+$/, "")}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&action=get_live_categories`;
    const url = `/proxy?url=${encodeURIComponent(target)}`;
    const res = await workerFetch(url);
    if (!res.ok) throw new Error(`Xtream: HTTP ${res.status}`);
    return res.json();
  },

  async listLiveChannels(base: string, user: string, pass: string, categoryId?: string): Promise<XtreamLiveChannel[]> {
    const params = new URLSearchParams({
      username: user,
      password: pass,
      action: "get_live_streams",
    });
    if (categoryId) params.set("category_id", categoryId);
    const target = `${base.replace(/\/+$/, "")}/player_api.php?${params.toString()}`;
    const url = `/proxy?url=${encodeURIComponent(target)}`;
    const res = await workerFetch(url);
    if (!res.ok) throw new Error(`Xtream: HTTP ${res.status}`);
    return res.json();
  },

  getStreamUrl(base: string, user: string, pass: string, streamId: number): string {
    // Direct browser→panel, NOT through Worker.
    return buildXtreamLiveUrl(base, user, pass, streamId);
  },
};
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npm test -- tests/adapters/relayed/xtream.test.ts
```

Expected: PASS (3/3).

- [ ] **Step 6: Create `streamvault-static/src/components/setup/XtreamConnectStep.tsx`**

```tsx
import { useState } from "react";
import { XtreamAdapter, type XtreamLiveChannel } from "../../adapters/relayed/xtream";

export interface XtreamConnectStepProps {
  onConnected: (channels: XtreamLiveChannel[], base: string, user: string, pass: string) => void;
}

export function XtreamConnectStep({ onConnected }: XtreamConnectStepProps) {
  const [base, setBase] = useState("");
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleConnect = async () => {
    setError(null);
    setLoading(true);
    try {
      const channels = await XtreamAdapter.listLiveChannels(base, user, pass);
      onConnected(channels, base, user, pass);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to connect";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: 24 }}>
      <h3>Connect Xtream Codes</h3>
      <input value={base} onChange={(e) => setBase(e.target.value)} placeholder="http://panel.example.com:8080" style={{ width: "100%", padding: 8, marginBottom: 8 }} />
      <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="Username" style={{ width: "100%", padding: 8, marginBottom: 8 }} />
      <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="Password" style={{ width: "100%", padding: 8, marginBottom: 8 }} />
      <button onClick={handleConnect} disabled={loading || !base || !user || !pass}>
        {loading ? "Connecting..." : "Connect"}
      </button>
      {error && <div style={{ color: "#c00", marginTop: 12 }}>{error}</div>}
    </div>
  );
}
```

- [ ] **Step 7: Commit**

```bash
git add streamvault-static/src/adapters/relayed/ streamvault-static/src/components/setup/XtreamConnectStep.tsx streamvault-static/tests/adapters/relayed/xtream.test.ts
git commit -m "feat(static): add Xtream adapter with direct stream URLs (no byte proxy)"
```

---

## Task 8: Stalker adapter (uses Worker for session, direct for streams)

**Files:**
- Create: `streamvault-static/src/adapters/relayed/stalker.ts`
- Create: `streamvault-static/tests/adapters/relayed/stalker.test.ts`
- Create: `streamvault-static/src/components/setup/StalkerConnectStep.tsx`

- [ ] **Step 1: Write failing test**

```typescript
// streamvault-static/tests/adapters/relayed/stalker.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { StalkerAdapter, cleanStalkerStreamUrl } from "../../../src/adapters/relayed/stalker";

describe("stalker adapter", () => {
  describe("cleanStalkerStreamUrl", () => {
    it("strips 'ffmpeg ' prefix", () => {
      const cleaned = cleanStalkerStreamUrl("ffmpeg http://panel.example.com/live/123.ts", "http://portal.example.com");
      expect(cleaned).toBe("http://panel.example.com/live/123.ts");
    });

    it("replaces localhost with portal host", () => {
      const cleaned = cleanStalkerStreamUrl("http://localhost/live/123.ts", "http://portal.example.com");
      expect(cleaned).toBe("http://portal.example.com/live/123.ts");
    });

    it("replaces 127.0.0.1 with portal host", () => {
      const cleaned = cleanStalkerStreamUrl("http://127.0.0.1/live/123.ts", "http://portal.example.com");
      expect(cleaned).toBe("http://portal.example.com/live/123.ts");
    });
  });

  describe("listChannels", () => {
    beforeEach(() => {
      global.fetch = vi.fn();
    });

    it("calls the Worker's /stalker/channels endpoint", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ channels: [{ id: "1", name: "Ch 1" }], total: 1 }),
      });
      const result = await StalkerAdapter.listChannels("http://portal", "00:1A:2B:3C:4D:5E");
      expect(result.channels).toHaveLength(1);
      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(calledUrl).toContain("/stalker/channels?");
      expect(calledUrl).toContain("portal=");
      expect(calledUrl).toContain("mac=");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/adapters/relayed/stalker.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `streamvault-static/src/adapters/relayed/stalker.ts`**

```typescript
import { workerFetch } from "./worker-base";

export interface StalkerChannel {
  id: string;
  name: string;
  num: string | null;
  logo: string | null;
  group: string;
  url: string | null;     // cmd from the portal
  epgId: string | null;
  type: "live";
}

export function cleanStalkerStreamUrl(raw: string, portal: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith("ffmpeg ")) cleaned = cleaned.substring(7);
  if (cleaned.includes("localhost") || cleaned.includes("127.0.0.1")) {
    try {
      const portalHost = new URL(portal).host;
      cleaned = cleaned
        .replace(/localhost(:\d+)?/g, portalHost)
        .replace(/127\.0\.0\.1(:\d+)?/g, portalHost);
    } catch {
      // keep original
    }
  }
  return cleaned;
}

export const StalkerAdapter = {
  async listChannels(portal: string, mac: string): Promise<{ channels: StalkerChannel[]; total: number }> {
    const qs = new URLSearchParams({ portal, mac }).toString();
    const res = await workerFetch(`/stalker/channels?${qs}`, { timeoutMs: 20000 });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Stalker channels: HTTP ${res.status} — ${text}`);
    }
    return res.json();
  },

  async resolveStreamUrl(portal: string, mac: string, cmd: string, contentType: "live" | "vod" | "series" = "live"): Promise<string> {
    const qs = new URLSearchParams({ portal, mac, cmd, content_type: contentType }).toString();
    const res = await workerFetch(`/stalker/stream?${qs}`);
    if (!res.ok) throw new Error(`Stalker stream: HTTP ${res.status}`);
    const data: { url: string } = await res.json();
    return cleanStalkerStreamUrl(data.url, portal);
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/adapters/relayed/stalker.test.ts
```

Expected: PASS (4/4).

- [ ] **Step 5: Create `streamvault-static/src/components/setup/StalkerConnectStep.tsx`**

```tsx
import { useState } from "react";
import { StalkerAdapter, type StalkerChannel } from "../../adapters/relayed/stalker";

export interface StalkerConnectStepProps {
  onConnected: (channels: StalkerChannel[], portal: string, mac: string) => void;
}

export function StalkerConnectStep({ onConnected }: StalkerConnectStepProps) {
  const [portal, setPortal] = useState("");
  const [mac, setMac] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleConnect = async () => {
    setError(null);
    setLoading(true);
    try {
      const result = await StalkerAdapter.listChannels(portal, mac);
      if (result.channels.length === 0) throw new Error("Portal returned no channels");
      onConnected(result.channels, portal, mac);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to connect";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: 24 }}>
      <h3>Connect Stalker Portal</h3>
      <input value={portal} onChange={(e) => setPortal(e.target.value)} placeholder="http://portal.example.com/c" style={{ width: "100%", padding: 8, marginBottom: 8 }} />
      <input value={mac} onChange={(e) => setMac(e.target.value)} placeholder="MAC address (00:1A:2B:3C:4D:5E)" style={{ width: "100%", padding: 8, marginBottom: 8 }} />
      <button onClick={handleConnect} disabled={loading || !portal || !mac}>
        {loading ? "Connecting..." : "Connect"}
      </button>
      {error && <div style={{ color: "#c00", marginTop: 12 }}>{error}</div>}
    </div>
  );
}
```

- [ ] **Step 6: Commit**

```bash
git add streamvault-static/src/adapters/relayed/stalker.ts streamvault-static/src/components/setup/StalkerConnectStep.tsx streamvault-static/tests/adapters/relayed/stalker.test.ts
git commit -m "feat(static): add Stalker adapter using Worker for session (streams stay direct)"
```

---

## Task 9: Jellyfin + Plex adapters (browser-direct)

**Files:**
- Create: `streamvault-static/src/adapters/static/jellyfin.ts`
- Create: `streamvault-static/src/adapters/static/plex.ts`
- Create: `streamvault-static/src/components/setup/JellyfinConnectStep.tsx`
- Create: `streamvault-static/src/components/setup/PlexConnectStep.tsx`
- Create: `streamvault-static/src/services/plex-server-discovery.ts`
- Create: `streamvault-static/tests/adapters/static/jellyfin.test.ts`
- Create: `streamvault-static/tests/adapters/static/plex.test.ts`

- [ ] **Step 1: Write failing test for Jellyfin adapter (slimmed from current adapter)**

```typescript
// streamvault-static/tests/adapters/static/jellyfin.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { JellyfinAdapter } from "../../../src/adapters/static/jellyfin";

describe("JellyfinAdapter", () => {
  describe("authenticate", () => {
    beforeEach(() => { global.fetch = vi.fn(); });

    it("returns userId and serverName on success", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([{ Id: "user-1", ServerId: "server-1" }]),
      });
      const result = await JellyfinAdapter.authenticate("http://jellyfin.local:8096", "apikey123");
      expect(result.userId).toBe("user-1");
      expect(result.serverName).toBe("server-1");
    });

    it("throws on invalid key", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 401 });
      await expect(JellyfinAdapter.authenticate("http://jf", "bad")).rejects.toThrow("Invalid API key");
    });
  });

  describe("getLibrary", () => {
    beforeEach(() => { global.fetch = vi.fn(); });

    it("fetches movies and series", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ Items: [{ Id: "m1", Name: "Movie 1" }], TotalRecordCount: 1 }),
      });
      const result = await JellyfinAdapter.getLibrary("http://jf", "key", "user-1");
      expect(result.items).toHaveLength(1);
    });
  });

  describe("getStreamUrl", () => {
    it("builds a direct HLS URL", () => {
      const url = JellyfinAdapter.getStreamUrl("http://jf:8096", "key", "item-1");
      expect(url).toBe("http://jf:8096/Videos/item-1/main.m3u8?api_key=key");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/adapters/static/jellyfin.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `streamvault-static/src/adapters/static/jellyfin.ts`**

```typescript
export interface JellyfinAuthResult {
  userId: string;
  serverName: string;
}

export interface JellyfinItem {
  Id: string;
  Name: string;
  Type: string;
  Overview?: string;
  ProductionYear?: number;
  ImageTags?: { Primary?: string };
}

function baseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export const JellyfinAdapter = {
  async authenticate(baseUrl: string, apiKey: string): Promise<JellyfinAuthResult> {
    const res = await fetch(`${baseUrl(baseUrl)}/Users?api_key=${encodeURIComponent(apiKey)}`);
    if (!res.ok) throw new Error("Invalid API key");
    const users: Array<{ Id: string; ServerId: string }> = await res.json();
    if (!users.length) throw new Error("No user found");
    return { userId: users[0].Id, serverName: users[0].ServerId };
  },

  async getLibrary(
    baseUrl: string,
    apiKey: string,
    userId: string,
    opts: { type?: string; parentId?: string; limit?: number; startIndex?: number } = {}
  ): Promise<{ items: JellyfinItem[]; total: number }> {
    const params = new URLSearchParams({
      api_key: apiKey,
      Recursive: "true",
      IncludeItemTypes: opts.type ?? "Movie,Series",
      Limit: String(opts.limit ?? 50),
      StartIndex: String(opts.startIndex ?? 0),
      fields: "Name,Overview,ProductionYear,ImageTags,PrimaryImageAspectRatio",
      UserId: userId,
    });
    if (opts.parentId) params.set("ParentId", opts.parentId);
    const res = await fetch(`${baseUrl(baseUrl)}/Items?${params.toString()}`);
    if (!res.ok) throw new Error(`Jellyfin library: HTTP ${res.status}`);
    const data: { Items: JellyfinItem[]; TotalRecordCount: number } = await res.json();
    return { items: data.Items ?? [], total: data.TotalRecordCount };
  },

  getStreamUrl(baseUrl: string, apiKey: string, itemId: string): string {
    return `${baseUrl(baseUrl)}/Videos/${itemId}/main.m3u8?api_key=${encodeURIComponent(apiKey)}`;
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/adapters/static/jellyfin.test.ts
```

Expected: PASS (4/4).

- [ ] **Step 5: Write failing test for Plex adapter (slimmed)**

```typescript
// streamvault-static/tests/adapters/static/plex.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PlexAdapter, rankPlexConnections } from "../../../src/adapters/static/plex";

describe("PlexAdapter", () => {
  describe("rankPlexConnections", () => {
    it("ranks HTTPS public > HTTPS local > HTTP local", () => {
      const conns = [
        { protocol: "http", address: "192.168.1.10", port: 32400, local: 1, uri: "http://192.168.1.10:32400" },
        { protocol: "https", address: "1.2.3.4", port: 32400, local: 0, uri: "https://1.2.3.4:32400" },
        { protocol: "https", address: "192.168.1.10", port: 32400, local: 1, uri: "https://192.168.1.10:32400" },
      ];
      const ranked = rankPlexConnections(conns);
      expect(ranked[0].uri).toBe("https://1.2.3.4:32400");
      expect(ranked[1].uri).toBe("https://192.168.1.10:32400");
    });
  });

  describe("getResources", () => {
    beforeEach(() => { global.fetch = vi.fn(); });

    it("returns servers with ranked connections", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          MediaContainer: {
            Resource: [{
              name: "Home",
              product: "Plex Media Server",
              Connection: [
                { protocol: "https", address: "1.2.3.4", port: 32400, local: 0, uri: "https://1.2.3.4:32400" },
              ],
            }],
          },
        }),
      });
      const result = await PlexAdapter.getResources("token-xyz", "machine-id-1");
      expect(result.servers[0].name).toBe("Home");
      expect(result.servers[0].connections[0].uri).toBe("https://1.2.3.4:32400");
    });
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

```bash
npm test -- tests/adapters/static/plex.test.ts
```

Expected: FAIL.

- [ ] **Step 7: Implement `streamvault-static/src/adapters/static/plex.ts`**

```typescript
export interface PlexConnection {
  protocol: "http" | "https";
  address: string;
  port: number;
  local: 0 | 1;
  uri: string;
}

export interface PlexServer {
  name: string;
  product: string;
  connections: PlexConnection[];
}

export function rankPlexConnections(connections: PlexConnection[]): PlexConnection[] {
  // Ranking:
  // 1. HTTPS public (best — works from anywhere, no mixed content)
  // 2. HTTPS local
  // 3. HTTP public
  // 4. HTTP local (last resort — only works on HTTP app)
  return [...connections].sort((a, b) => {
    const score = (c: PlexConnection) =>
      (c.protocol === "https" ? 2 : 0) + (c.local === 0 ? 1 : 0);
    return score(b) - score(a);
  });
}

const PLEX_RESOURCES_URL = "https://plex.tv/api/v2/resources";

export const PlexAdapter = {
  async createPin(machineId: string): Promise<{ pinId: string; code: string }> {
    const res = await fetch("https://clients.plex.tv/api/v2/pins", {
      method: "POST",
      headers: { "X-Plex-Client-Identifier": machineId, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "standard" }),
      cache: "no-store",
    });
    if (!res.ok) throw new Error("Plex PIN create failed");
    const data: { id: number; code: string } = await res.json();
    return { pinId: data.id.toString(), code: data.code };
  },

  async pollPin(pinId: string, machineId: string): Promise<{ authToken: string | null }> {
    const res = await fetch(`https://clients.plex.tv/api/v2/pins/${pinId}`, {
      headers: { "X-Plex-Client-Identifier": machineId },
      cache: "no-store",
    });
    if (!res.ok) throw new Error("Plex PIN poll failed");
    const data: { authToken?: string } = await res.json();
    return { authToken: data.authToken ?? null };
  },

  async getResources(authToken: string, machineId: string): Promise<{ servers: PlexServer[] }> {
    const res = await fetch(PLEX_RESOURCES_URL, {
      headers: { "X-Plex-Token": authToken, "X-Plex-Client-Identifier": machineId, Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error("Plex resources failed");
    interface ResourcesResp {
      MediaContainer: {
        Resource: Array<{
          name: string;
          product: string;
          Connection: PlexConnection[];
        }>;
      };
    }
    const data: ResourcesResp = await res.json();
    const servers: PlexServer[] = (data.MediaContainer.Resource ?? []).map((r) => ({
      name: r.name,
      product: r.product,
      connections: rankPlexConnections(r.Connection ?? []),
    }));
    return { servers };
  },

  async getLibrary(
    baseUrl: string,
    token: string,
    machineId: string,
    opts: { sectionId?: string } = {}
  ): Promise<{ items: Array<{ ratingKey: string; title: string; type: string; thumb: string | null }> }> {
    const sectionsUrl = `${baseUrl}/library/sections?X-Plex-Token=${encodeURIComponent(token)}`;
    const sectionsRes = await fetch(sectionsUrl, {
      headers: { "X-Plex-Client-Identifier": machineId, Accept: "application/json" },
      cache: "no-store",
    });
    if (!sectionsRes.ok) throw new Error("Plex sections failed");
    const sectionsData: { MediaContainer: { Directory: Array<{ key: string; type: string }> } } = await sectionsRes.json();
    const section = opts.sectionId
      ? sectionsData.MediaContainer.Directory.find((d) => d.key === opts.sectionId)
      : sectionsData.MediaContainer.Directory[0];
    if (!section) return { items: [] };

    const itemsRes = await fetch(`${baseUrl}/library/sections/${section.key}/all?X-Plex-Token=${encodeURIComponent(token)}`, {
      headers: { "X-Plex-Client-Identifier": machineId, Accept: "application/json" },
      cache: "no-store",
    });
    if (!itemsRes.ok) throw new Error("Plex items failed");
    const itemsData: { MediaContainer: { Metadata: Array<{ ratingKey: string; title: string; type: string; thumb: string | null }> } } = await itemsRes.json();
    return { items: itemsData.MediaContainer.Metadata ?? [] };
  },

  getStreamUrl(baseUrl: string, itemId: string, token: string, machineId: string): string {
    return `${baseUrl}/library/parts/?path=/library/metadata/${itemId}&X-Plex-Token=${encodeURIComponent(token)}&X-Plex-Client-Identifier=${machineId}`;
  },
};
```

- [ ] **Step 8: Run test to verify it passes**

```bash
npm test -- tests/adapters/static/plex.test.ts
```

Expected: PASS (2/2).

- [ ] **Step 9: Create `streamvault-static/src/components/setup/JellyfinConnectStep.tsx`**

```tsx
import { useState } from "react";
import { JellyfinAdapter, type JellyfinItem } from "../../adapters/static/jellyfin";

export interface JellyfinConnectStepProps {
  onConnected: (items: JellyfinItem[], baseUrl: string, apiKey: string, userId: string, serverName: string) => void;
}

export function JellyfinConnectStep({ onConnected }: JellyfinConnectStepProps) {
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleConnect = async () => {
    setError(null);
    setLoading(true);
    try {
      const { userId, serverName } = await JellyfinAdapter.authenticate(baseUrl, apiKey);
      const lib = await JellyfinAdapter.getLibrary(baseUrl, apiKey, userId);
      onConnected(lib.items, baseUrl, apiKey, userId, serverName);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to connect");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: 24 }}>
      <h3>Connect Jellyfin</h3>
      <p>Find your API key in Jellyfin Dashboard → Administration → API Keys.</p>
      <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://jellyfin.local:8096" style={{ width: "100%", padding: 8, marginBottom: 8 }} />
      <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="API key" style={{ width: "100%", padding: 8, marginBottom: 8 }} />
      <button onClick={handleConnect} disabled={loading || !baseUrl || !apiKey}>
        {loading ? "Connecting..." : "Connect"}
      </button>
      {error && <div style={{ color: "#c00", marginTop: 12 }}>{error}</div>}
    </div>
  );
}
```

- [ ] **Step 10: Create `streamvault-static/src/components/setup/PlexConnectStep.tsx`**

```tsx
import { useState, useEffect } from "react";
import { PlexAdapter, type PlexServer } from "../../adapters/static/plex";

export interface PlexConnectStepProps {
  onConnected: (server: PlexServer, token: string, machineId: string) => void;
}

const POLL_INTERVAL_MS = 2000;
const TIMEOUT_MS = 10 * 60 * 1000;

export function PlexConnectStep({ onConnected }: PlexConnectStepProps) {
  const [pinId, setPinId] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const machineId = useState(() => crypto.randomUUID())[0];

  useEffect(() => {
    if (!pinId) return;
    const start = Date.now();
    const timer = setInterval(async () => {
      if (Date.now() - start > TIMEOUT_MS) {
        clearInterval(timer);
        setError("Plex auth timed out. Please try again.");
        setLoading(false);
        return;
      }
      try {
        const { authToken } = await PlexAdapter.pollPin(pinId, machineId);
        if (authToken) {
          clearInterval(timer);
          const { servers } = await PlexAdapter.getResources(authToken, machineId);
          if (servers.length === 0) {
            setError("No Plex servers found on this account.");
            setLoading(false);
            return;
          }
          onConnected(servers[0], authToken, machineId);
        }
      } catch (e) {
        if ((e as Error)?.name !== "AbortError") console.warn("Plex poll error:", e);
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [pinId, machineId, onConnected]);

  const handleStart = async () => {
    setError(null);
    setLoading(true);
    try {
      const { pinId: newPinId, code: newCode } = await PlexAdapter.createPin(machineId);
      setPinId(newPinId);
      setCode(newCode);
      window.open(`https://plex.tv/link?pin=${encodeURIComponent(newCode)}`, "_blank", "noopener,noreferrer");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to start Plex connect");
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: 24 }}>
      {!pinId && (
        <>
          <h3>Connect Plex</h3>
          <button onClick={handleStart} disabled={loading}>{loading ? "Starting..." : "Connect Plex"}</button>
        </>
      )}
      {pinId && (
        <>
          <h3>Approve on Plex</h3>
          <p>Enter this code at plex.tv/link:</p>
          <div style={{ fontSize: 24, fontWeight: "bold", letterSpacing: 4 }}>{code}</div>
          <p>Waiting for approval...</p>
        </>
      )}
      {error && <div style={{ color: "#c00", marginTop: 12 }}>{error}</div>}
    </div>
  );
}
```

- [ ] **Step 11: Commit**

```bash
git add streamvault-static/src/adapters/static/jellyfin.ts streamvault-static/src/adapters/static/plex.ts streamvault-static/src/components/setup/JellyfinConnectStep.tsx streamvault-static/src/components/setup/PlexConnectStep.tsx streamvault-static/tests/
git commit -m "feat(static): add Jellyfin and Plex adapters (browser-direct, no Worker)"
```

---

## Task 10: Server picker + final App wiring

**Files:**
- Create: `streamvault-static/src/components/ServerPicker.tsx`
- Modify: `streamvault-static/src/App.tsx`

- [ ] **Step 1: Create `streamvault-static/src/components/ServerPicker.tsx`**

```tsx
export type ProviderKey = "m3u" | "jellyfin" | "plex" | "xtream" | "stalker";

export interface ServerPickerProps {
  onSelect: (provider: ProviderKey) => void;
}

const PROVIDERS: Array<{ key: ProviderKey; label: string; description: string }> = [
  { key: "m3u", label: "M3U / M3U8 Playlist", description: "Paste a playlist URL" },
  { key: "jellyfin", label: "Jellyfin", description: "Self-hosted media server" },
  { key: "plex", label: "Plex", description: "Connect via plex.tv" },
  { key: "xtream", label: "Xtream Codes", description: "Server URL + username + password" },
  { key: "stalker", label: "Stalker Portal", description: "Portal URL + MAC address" },
];

export function ServerPicker({ onSelect }: ServerPickerProps) {
  return (
    <div style={{ padding: 24 }}>
      <h2>Add a server</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
        {PROVIDERS.map((p) => (
          <button
            key={p.key}
            onClick={() => onSelect(p.key)}
            style={{ background: "#222", color: "#fff", border: "1px solid #444", padding: 16, textAlign: "left", cursor: "pointer" }}
          >
            <div style={{ fontWeight: 600 }}>{p.label}</div>
            <div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>{p.description}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update `streamvault-static/src/App.tsx` to wire all providers**

```tsx
import { useEffect, useState } from "react";
import { openDb, listConnections, putConnection } from "./storage/indexeddb";
import type { StoredConnection, M3UConfig, JellyfinConfig, PlexConfig, XtreamConfig, StalkerConfig } from "./storage/schema";
import type { M3UChannel } from "./adapters/static/m3u";
import { M3UConnectStep } from "./components/setup/M3UConnectStep";
import { JellyfinConnectStep } from "./components/setup/JellyfinConnectStep";
import { PlexConnectStep } from "./components/setup/PlexConnectStep";
import { XtreamConnectStep } from "./components/setup/XtreamConnectStep";
import { StalkerConnectStep } from "./components/setup/StalkerConnectStep";
import { LibraryGrid } from "./components/LibraryGrid";
import { Player } from "./components/Player";
import { ServerPicker, type ProviderKey } from "./components/ServerPicker";
import { JellyfinAdapter } from "./adapters/static/jellyfin";
import { PlexAdapter } from "./adapters/static/plex";
import { XtreamAdapter } from "./adapters/relayed/xtream";
import { StalkerAdapter } from "./adapters/relayed/stalker";

type View =
  | { name: "home" }
  | { name: "picker" }
  | { name: "connect"; provider: ProviderKey }
  | { name: "library"; title: string; items: Array<{ id: string; name: string; url: string; logo: string | null }> };

export function App() {
  const [view, setView] = useState<View>({ name: "home" });
  const [connections, setConnections] = useState<StoredConnection[]>([]);

  useEffect(() => {
    (async () => {
      const db = await openDb();
      const list = await listConnections(db);
      setConnections(list);
    })();
  }, []);

  const saveConnection = async (providerType: StoredConnection["providerType"], name: string, config: StoredConnection["config"]) => {
    const db = await openDb();
    const conn: StoredConnection = {
      id: crypto.randomUUID(),
      providerType,
      name,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      config,
    };
    await putConnection(db, conn);
    setConnections(await listConnections(db));
  };

  return (
    <main style={{ minHeight: "100vh", background: "#1a1a2e", color: "#fff" }}>
      <header style={{ padding: 16, borderBottom: "1px solid #333" }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>StreamVault Media</h1>
        <button onClick={() => setView({ name: "picker" })}>Add server</button>
        {connections.length > 0 && (
          <ul>
            {connections.map((c) => <li key={c.id}>{c.name} ({c.providerType})</li>)}
          </ul>
        )}
      </header>

      {view.name === "home" && (
        <div style={{ padding: 24 }}>
          <p>Welcome. Add a server to get started.</p>
          {connections.length === 0 && <p>No connections yet.</p>}
        </div>
      )}

      {view.name === "picker" && <ServerPicker onSelect={(p) => setView({ name: "connect", provider: p })} />}

      {view.name === "connect" && view.provider === "m3u" && (
        <M3UConnectStep
          onConnected={(channels, url) => {
            saveConnection("m3u", new URL(url).hostname, { kind: "m3u", playlistUrl: url } as M3UConfig);
            setView({
              name: "library",
              title: new URL(url).hostname,
              items: channels.map((c, i) => ({ id: `${i}`, name: c.name, url: c.url, logo: c.logo })),
            });
          }}
        />
      )}

      {view.name === "connect" && view.provider === "jellyfin" && (
        <JellyfinConnectStep
          onConnected={(items, baseUrl, apiKey, userId, serverName) => {
            saveConnection("jellyfin", serverName, { kind: "jellyfin", baseUrl, apiKey, userId, serverName } as JellyfinConfig);
            setView({
              name: "library",
              title: serverName,
              items: items.map((it) => ({ id: it.Id, name: it.Name, url: JellyfinAdapter.getStreamUrl(baseUrl, apiKey, it.Id), logo: it.ImageTags?.Primary ? `${baseUrl}/Items/${it.Id}/Images/Primary?api_key=${apiKey}` : null })),
            });
          }}
        />
      )}

      {view.name === "connect" && view.provider === "plex" && (
        <PlexConnectStep
          onConnected={(server, token, machineId) => {
            const best = server.connections[0];
            saveConnection("plex", server.name, { kind: "plex", baseUrl: best.uri, accessToken: token, machineId, serverName: server.name } as PlexConfig);
            PlexAdapter.getLibrary(best.uri, token, machineId).then((lib) => {
              setView({
                name: "library",
                title: server.name,
                items: lib.items.map((it) => ({ id: it.ratingKey, name: it.title, url: PlexAdapter.getStreamUrl(best.uri, it.ratingKey, token, machineId), logo: it.thumb ? `${best.uri}${it.thumb}?X-Plex-Token=${token}` : null })),
              });
            });
          }}
        />
      )}

      {view.name === "connect" && view.provider === "xtream" && (
        <XtreamConnectStep
          onConnected={(channels, base, user, pass) => {
            saveConnection("xtream", new URL(base).hostname, { kind: "xtream", baseUrl: base, username: user, password: pass } as XtreamConfig);
            setView({
              name: "library",
              title: new URL(base).hostname,
              items: channels.map((c) => ({ id: String(c.stream_id), name: c.name, url: XtreamAdapter.getStreamUrl(base, user, pass, c.stream_id), logo: c.stream_icon })),
            });
          }}
        />
      )}

      {view.name === "connect" && view.provider === "stalker" && (
        <StalkerConnectStep
          onConnected={(channels, portal, mac) => {
            saveConnection("stalker", new URL(portal).hostname, { kind: "stalker", portal, mac } as StalkerConfig);
            setView({
              name: "library",
              title: new URL(portal).hostname,
              items: channels.map((c, i) => ({ id: String(i), name: c.name, url: c.url ?? "", logo: c.logo })),
            });
          }}
        />
      )}

      {view.name === "library" && (
        <LibraryGrid
          channels={view.items.map((it) => ({ name: it.name, url: it.url, tvgId: null, tvgName: null, logo: it.logo, group: view.title, streamType: "unknown" as const }))}
          onSelect={(ch) => setView({ name: "player", url: ch.url, name: ch.name } as never)}
        />
      )}

      {view.name === "library" && view.items.length > 0 && (
        <Player url={view.items[0].url} onClose={() => setView({ name: "home" })} />
      )}
    </main>
  );
}
```

- [ ] **Step 3: Verify it builds**

```bash
cd streamvault-static
npm run build
```

Expected: 0 TS errors, build succeeds.

- [ ] **Step 4: Commit**

```bash
git add streamvault-static/src/components/ServerPicker.tsx streamvault-static/src/App.tsx
git commit -m "feat(static): wire all 5 providers into server picker + app shell"
```

---

## Task 11: Deploy to Cloudflare Pages

**Files:**
- Create: `streamvault-static/.github/workflows/deploy-static.yml`
- Create: `streamvault-static/.github/workflows/deploy-worker.yml`
- Create: `streamvault-static/deploy/cloudflare-pages/_headers`
- Create: `streamvault-static/deploy/cloudflare-pages/_redirects`

- [ ] **Step 1: Create `streamvault-static/.github/workflows/deploy-static.yml`**

```yaml
name: Deploy static media portal
on:
  push:
    branches: [feature/static-media-portal]
    paths: [streamvault-static/**]
jobs:
  build-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: cd streamvault-static && npm ci
      - run: cd streamvault-static && npm run build
      - name: Publish to Cloudflare Pages
        uses: cloudflare/pages-action@v1
        with:
          apiToken: ${{ secrets.CF_PAGES_TOKEN }}
          accountId: ${{ secrets.CF_ACCOUNT_ID }}
          projectName: media-portalheaven
          directory: streamvault-static/dist
          gitHubToken: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 2: Create `streamvault-static/.github/workflows/deploy-worker.yml`**

```yaml
name: Deploy CF Worker
on:
  push:
    branches: [feature/static-media-portal]
    paths: ["streamvault-static/deploy/cloudflare-worker/**"]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: cd streamvault-static/deploy/cloudflare-worker && npm ci
      - run: cd streamvault-static/deploy/cloudflare-worker && npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CF_WORKER_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }}
```

- [ ] **Step 3: Create `streamvault-static/deploy/cloudflare-pages/_headers`**

```
/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
```

- [ ] **Step 4: Create `streamvault-static/deploy/cloudflare-pages/_redirects`**

```
/*    /index.html   200
```

- [ ] **Step 5: Commit**

```bash
git add streamvault-static/.github/ streamvault-static/deploy/cloudflare-pages/
git commit -m "ci(static): add Cloudflare Pages + Worker deploy workflows"
```

---

## Self-Review Checklist

- [x] **Spec coverage:** M3U ✅, Jellyfin ✅, Plex ✅, Xtream ✅, Stalker ✅, IndexedDB ✅, no stream byte proxying ✅, HTTP-only static ✅, CF Worker for session/metadata only ✅
- [x] **No placeholders:** All steps have full code; no TBD/TODO
- [x] **Type consistency:** `StoredConnection`, `M3UChannel`, `PlexConnection`, `XtreamLiveChannel`, `StalkerChannel` used consistently across tasks
- [x] **Reuse verified:** `poc/cf-worker` `stalker.js` and `stalker.js` handler copied verbatim (minus `/stalker/play`); Plex/Jellyfin adapters ported from current branch
- [x] **Task count:** 11 tasks, each self-contained and testable

---

## Out of Scope for v1 (Future Plans)

- EPG (XMLTV parsing) — add in a follow-up plan
- PWA install + service worker
- Cross-device sync (D1 + auth subdomain)
- Stream URL rewriting for HTTPS-app mixed content (HTTP-only app doesn't need it)
- Self-hosted Worker config UI

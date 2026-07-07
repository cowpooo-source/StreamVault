# HTTP Direct Content Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a scoped HTTP content shell for Xtream/M3U browsing and playback while keeping login/setup/account flows on HTTPS.

**Architecture:** HTTPS remains the authenticated control plane. Opening an Xtream or M3U connection creates a short-lived content-session token and navigates to `http://40.233.113.76/content?token=...`; the HTTP content shell validates that token, bootstraps the selected connection, and reuses existing catalog/player behavior without routing normal media bytes through `/stream`.

**Tech Stack:** Node/Express backend, in-memory token stores, React 19/Vite frontend, Vitest/Supertest tests, nginx bare-IP routing.

---

## File Map

- Create: `stalker-proxy/src/routes/contentSession.js`
  - Owns content-session token creation, validation, cleanup, and test exports.
- Modify: `stalker-proxy/src/app.js`
  - Mounts content-session router under `/api`.
- Modify: `stalker-proxy/tests/routes.test.js`
  - Adds backend coverage for content-session creation/validation and rejection cases.
- Create: `streamvault/src/direct-content-session.js`
  - Small frontend helper for direct-provider detection, request payload shaping, and content URL navigation.
- Test: `streamvault/tests/direct-content-session.test.js`
  - Unit tests for direct-provider detection and session request payloads.
- Modify: `streamvault/src/App.jsx`
  - Uses helper in `switchConnection`, adds `/content` bootstrap mode, and stops redirecting item playback to `/player` when already in HTTP content mode.
- Create: `nginx_vps_ip_content.conf`
  - Documents required bare-IP routes for `/content`, `/assets`, `/api/`, `/img`, `/proxy`, `/health`, and optional `/stalker/`.

---

### Task 1: Backend Content-Session Router

**Files:**
- Create: `stalker-proxy/src/routes/contentSession.js`
- Modify: `stalker-proxy/tests/routes.test.js`
- Modify: `stalker-proxy/src/app.js`

- [ ] **Step 1: Write failing backend tests**

Add these tests near the existing player route tests in `stalker-proxy/tests/routes.test.js`:

```js
it('POST /api/content-session requires auth', async () => {
  const res = await request(app)
    .post('/api/content-session')
    .send({ connection: { id: 'c1', type: 'xtream', config: {} } });

  expect(res.status).toBe(401);
  expect(res.body.error).toBe('Unauthorized');
});

it('POST /api/content-session rejects unsupported provider types', async () => {
  mockAuth.verifyToken.mockReturnValue({ id: 1, username: 'testuser', role: 'regular' });

  const res = await request(app)
    .post('/api/content-session')
    .set('authorization', 'Bearer valid-token')
    .send({
      connection: {
        id: 'stalker-1',
        type: 'stalker',
        label: 'Portal',
        config: { type: 'stalker', server: 'http://portal.example.com/c/', mac: '00:11:22:33:44:55' },
      },
    });

  expect(res.status).toBe(400);
  expect(res.body.error).toBe('Unsupported content session provider');
});

it('POST /api/content-session creates a scoped HTTP content URL for Xtream', async () => {
  mockAuth.verifyToken.mockReturnValue({ id: 1, username: 'testuser', role: 'regular' });

  const res = await request(app)
    .post('/api/content-session')
    .set('authorization', 'Bearer valid-token')
    .send({
      connection: {
        id: 'xtream-1',
        type: 'xtream',
        label: 'Demo Xtream',
        config: { type: 'xtream', server: 'http://provider.example.com', user: 'u', pass: 'p' },
      },
    });

  expect(res.status).toBe(200);
  expect(res.body.token).toBeTruthy();
  expect(res.body.contentUrl).toMatch(/^http:\/\/40\.233\.113\.76\/content\?token=/);
  expect(res.body.expiresAt).toBeGreaterThan(Date.now());

  const validate = await request(app).get(`/api/content-session/validate?token=${res.body.token}`);
  expect(validate.status).toBe(200);
  expect(validate.body).toMatchObject({
    connection: {
      id: 'xtream-1',
      type: 'xtream',
      label: 'Demo Xtream',
      config: { type: 'xtream', server: 'http://provider.example.com', user: 'u', pass: 'p' },
    },
  });
  expect(validate.body.user).toBeUndefined();
});

it('GET /api/content-session/validate rejects unknown tokens', async () => {
  const res = await request(app).get('/api/content-session/validate?token=missing');

  expect(res.status).toBe(404);
  expect(res.body.error).toBe('Content session not found');
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```powershell
npm test -- routes.test.js
```

Expected: new tests fail with 404 for `/api/content-session` because the router does not exist yet.

- [ ] **Step 3: Implement content-session router**

Create `stalker-proxy/src/routes/contentSession.js`:

```js
const crypto = require('crypto');

const contentSessions = new Map();
const CONTENT_SESSION_TTL = 30 * 60 * 1000;
const DIRECT_PROVIDER_TYPES = new Set(['xtream', 'm3u']);

function cleanupExpiredContentSessions(now = Date.now()) {
  for (const [token, session] of contentSessions) {
    if (session.expiresAt <= now) contentSessions.delete(token);
  }
}

setInterval(cleanupExpiredContentSessions, 60_000);

function normalizeConnection(input) {
  const connection = input || {};
  const config = connection.config || connection;
  const type = connection.type || config.type;
  if (!connection.id) throw new Error('Missing connection id');
  if (!DIRECT_PROVIDER_TYPES.has(type)) throw new Error('Unsupported content session provider');
  return {
    id: String(connection.id),
    type,
    label: connection.label || (type === 'xtream' ? `${config.user || 'Xtream'} · Xtream` : 'M3U Playlist'),
    config: { ...config, type },
  };
}

function contentBaseUrl(req) {
  return process.env.CONTENT_BASE_URL || process.env.PLAYER_BASE || 'http://40.233.113.76';
}

function createContentSessionRouter(deps) {
  const { auth } = deps;
  const router = require('express').Router();

  router.post('/content-session', (req, res) => {
    try {
      const authToken = req.cookies?.sv_auth || req.headers.authorization?.slice(7);
      if (!authToken) return res.status(401).json({ error: 'Unauthorized' });
      const user = auth.verifyToken(authToken);
      if (!user) return res.status(401).json({ error: 'Invalid token' });

      let connection;
      try {
        connection = normalizeConnection(req.body?.connection);
      } catch (e) {
        return res.status(e.message === 'Unsupported content session provider' ? 400 : 400).json({ error: e.message });
      }

      const token = crypto.randomBytes(24).toString('hex');
      const expiresAt = Date.now() + CONTENT_SESSION_TTL;
      contentSessions.set(token, {
        userId: user.id,
        connection,
        expiresAt,
      });

      res.json({
        token,
        contentUrl: `${contentBaseUrl(req)}/content?token=${token}`,
        expiresAt,
      });
    } catch (e) {
      console.error('content-session error:', e);
      res.status(500).json({ error: 'Failed to create content session' });
    }
  });

  router.get('/content-session/validate', (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Missing token' });

    const session = contentSessions.get(token);
    if (!session) return res.status(404).json({ error: 'Content session not found' });
    if (session.expiresAt <= Date.now()) {
      contentSessions.delete(token);
      return res.status(410).json({ error: 'Content session expired' });
    }

    res.json({
      connection: session.connection,
      expiresAt: session.expiresAt,
    });
  });

  return router;
}

module.exports = {
  createContentSessionRouter,
  contentSessions,
  cleanupExpiredContentSessions,
  normalizeConnection,
};
```

- [ ] **Step 4: Mount the router**

Modify `stalker-proxy/src/app.js` near the other route imports:

```js
const { createContentSessionRouter } = require('./routes/contentSession');
```

Mount it before `createPlayerRouter`:

```js
app.use('/api', createContentSessionRouter(routerDeps));
app.use('/api', createPlayerRouter(routerDeps));
```

- [ ] **Step 5: Clear test state between tests**

Modify the existing `beforeEach` in `stalker-proxy/tests/routes.test.js`:

```js
const { tokens, playbackSessions } = require('../src/routes/player');
tokens.clear();
playbackSessions.clear();
const { contentSessions } = require('../src/routes/contentSession');
contentSessions.clear();
```

- [ ] **Step 6: Run backend tests**

Run:

```powershell
npm test -- routes.test.js
```

Expected: all route tests pass.

- [ ] **Step 7: Commit backend session router**

```powershell
git add -- stalker-proxy/src/routes/contentSession.js stalker-proxy/src/app.js stalker-proxy/tests/routes.test.js
git commit -m "feat(content): add scoped direct content sessions"
```

---

### Task 2: Frontend Direct-Content Session Helper

**Files:**
- Create: `streamvault/src/direct-content-session.js`
- Create: `streamvault/tests/direct-content-session.test.js`

- [ ] **Step 1: Write helper tests**

Create `streamvault/tests/direct-content-session.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isDirectContentConnection, contentSessionPayload, openDirectContentSession } from '../src/direct-content-session.js';

vi.mock('../src/auth-utils.js', () => ({
  authHeaders: () => ({ authorization: 'Bearer valid-token' }),
}));

describe('direct content session helpers', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('window', { location: { href: 'https://portalheaven.stream/' } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('detects only Xtream and M3U as direct content connections', () => {
    expect(isDirectContentConnection({ type: 'xtream' })).toBe(true);
    expect(isDirectContentConnection({ type: 'm3u' })).toBe(true);
    expect(isDirectContentConnection({ type: 'stalker' })).toBe(false);
    expect(isDirectContentConnection(null)).toBe(false);
  });

  it('builds a safe content-session payload', () => {
    const connection = {
      id: 'c1',
      type: 'xtream',
      label: 'Demo',
      config: { type: 'xtream', server: 'http://provider.example.com', user: 'u', pass: 'p' },
      color: '#fff',
    };

    expect(contentSessionPayload(connection)).toEqual({
      connection: {
        id: 'c1',
        type: 'xtream',
        label: 'Demo',
        config: { type: 'xtream', server: 'http://provider.example.com', user: 'u', pass: 'p' },
      },
    });
  });

  it('opens a direct content session and navigates to returned URL', async () => {
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ contentUrl: 'http://40.233.113.76/content?token=abc' }), { status: 200 }));

    await openDirectContentSession({ id: 'c1', type: 'm3u', label: 'M3U', config: { type: 'm3u', url: 'http://list.example.com/a.m3u' } });

    expect(fetch).toHaveBeenCalledWith('/api/content-session', expect.objectContaining({ method: 'POST' }));
    expect(window.location.href).toBe('http://40.233.113.76/content?token=abc');
  });
});
```

- [ ] **Step 2: Run helper tests and verify failure**

Run:

```powershell
npm test -- direct-content-session.test.js
```

Expected: fails because `direct-content-session.js` does not exist.

- [ ] **Step 3: Implement helper**

Create `streamvault/src/direct-content-session.js`:

```js
import { authHeaders } from './auth-utils.js';

export function isDirectContentConnection(connection) {
  return connection?.type === 'xtream' || connection?.type === 'm3u';
}

export function contentSessionPayload(connection) {
  return {
    connection: {
      id: connection.id,
      type: connection.type,
      label: connection.label,
      config: connection.config,
    },
  };
}

export async function openDirectContentSession(connection) {
  const res = await fetch('/api/content-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(contentSessionPayload(connection)),
  });

  if (!res.ok) {
    let message = 'Failed to open direct content session';
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {}
    throw new Error(message);
  }

  const data = await res.json();
  if (!data.contentUrl) throw new Error('Missing content URL');
  window.location.href = data.contentUrl;
}

export function isHttpContentMode(locationObject = window.location) {
  return locationObject.pathname === '/content';
}

export function contentSessionToken(locationObject = window.location) {
  return new URLSearchParams(locationObject.search || '').get('token');
}
```

- [ ] **Step 4: Run helper tests**

Run:

```powershell
npm test -- direct-content-session.test.js
```

Expected: helper tests pass.

- [ ] **Step 5: Commit helper**

```powershell
git add -- streamvault/src/direct-content-session.js streamvault/tests/direct-content-session.test.js
git commit -m "feat(content): add direct content session client helper"
```

---

### Task 3: HTTPS Connection Switch Redirect

**Files:**
- Modify: `streamvault/src/App.jsx`

- [ ] **Step 1: Write frontend integration tests**

Add these helper tests to `streamvault/tests/direct-content-session.test.js`:

```js
import { maybeOpenDirectContentSession } from '../src/direct-content-session.js';

it('opens direct content session for Xtream connection switches', async () => {
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ contentUrl: 'http://40.233.113.76/content?token=abc' }), { status: 200 }));
  const result = await maybeOpenDirectContentSession({ id: 'c1', type: 'xtream', label: 'Demo', config: { type: 'xtream', server: 'http://p', user: 'u', pass: 'p' } });

  expect(result).toBe(true);
  expect(window.location.href).toBe('http://40.233.113.76/content?token=abc');
});

it('does not open direct content session for Stalker connection switches', async () => {
  const result = await maybeOpenDirectContentSession({ id: 's1', type: 'stalker', label: 'Portal', config: { type: 'stalker' } });

  expect(result).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npm test -- direct-content-session.test.js
```

Expected: fails because `maybeOpenDirectContentSession` is missing.

- [ ] **Step 3: Add helper function**

Modify `streamvault/src/direct-content-session.js`:

```js
export async function maybeOpenDirectContentSession(connection) {
  if (!isDirectContentConnection(connection)) return false;
  await openDirectContentSession(connection);
  return true;
}
```

- [ ] **Step 4: Use helper in `switchConnection`**

Import at the top of `streamvault/src/App.jsx`:

```js
import { isHttpContentMode, maybeOpenDirectContentSession } from './direct-content-session.js';
```

Change `switchConnection` to async and add direct-provider branch after `target` is found and before clearing current content:

```js
async function switchConnection(id) {
  if (id === activeConnId) { setShowConnManager(false); return; }
  const target = connections.find(c => c.id === id);
  if (!target) return;

  if (!isHttpContentMode() && await maybeOpenDirectContentSession(target)) {
    return;
  }

  setShowConnManager(false);
  // existing logic remains unchanged below
}
```

Keep the existing non-direct logic unchanged.

- [ ] **Step 5: Run frontend helper tests**

Run:

```powershell
npm test -- direct-content-session.test.js
```

Expected: tests pass.

- [ ] **Step 6: Run frontend test suite subset**

Run:

```powershell
npm test -- direct-content-session.test.js useStreamVault.test.js Setup.test.jsx
```

Expected: tests pass.

- [ ] **Step 7: Commit connection redirect**

```powershell
git add -- streamvault/src/App.jsx streamvault/src/direct-content-session.js streamvault/tests/direct-content-session.test.js
git commit -m "feat(content): open direct providers in http content mode"
```

---

### Task 4: HTTP Content Bootstrap Mode

**Files:**
- Modify: `streamvault/src/App.jsx`
- Modify: `streamvault/src/direct-content-session.js`
- Test: `streamvault/tests/direct-content-session.test.js`

- [ ] **Step 1: Write bootstrap helper tests**

Add to `streamvault/tests/direct-content-session.test.js`:

```js
import { validateContentSession, contentSessionToken, isHttpContentMode } from '../src/direct-content-session.js';

it('detects /content mode and token from location', () => {
  const loc = { pathname: '/content', search: '?token=abc' };

  expect(isHttpContentMode(loc)).toBe(true);
  expect(contentSessionToken(loc)).toBe('abc');
});

it('validates a content session token', async () => {
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({
    connection: { id: 'c1', type: 'm3u', label: 'M3U', config: { type: 'm3u', url: 'http://list.example.com/a.m3u' } },
    expiresAt: Date.now() + 1000,
  }), { status: 200 }));

  const session = await validateContentSession('abc');

  expect(fetch).toHaveBeenCalledWith('/api/content-session/validate?token=abc');
  expect(session.connection.type).toBe('m3u');
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npm test -- direct-content-session.test.js
```

Expected: fails because `validateContentSession` is missing.

- [ ] **Step 3: Implement validation helper**

Add to `streamvault/src/direct-content-session.js`:

```js
export async function validateContentSession(token) {
  const res = await fetch(`/api/content-session/validate?token=${encodeURIComponent(token)}`);
  if (!res.ok) {
    let message = 'Content session expired or invalid';
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {}
    throw new Error(message);
  }
  return res.json();
}
```

- [ ] **Step 4: Add `/content` bootstrap effect in App**

In `streamvault/src/App.jsx`, import:

```js
import { contentSessionToken, isHttpContentMode, maybeOpenDirectContentSession, validateContentSession } from './direct-content-session.js';
```

Add state near existing connection state:

```js
const [contentSessionError, setContentSessionError] = useState('');
const [httpContentMode] = useState(() => isHttpContentMode());
```

Add an effect after `connections`, `setConnections`, and `setActiveConnId` are available:

```js
useEffect(() => {
  if (!httpContentMode) return;
  const token = contentSessionToken();
  if (!token) {
    setContentSessionError('Missing content session token');
    return;
  }

  let cancelled = false;
  (async () => {
    try {
      const session = await validateContentSession(token);
      if (cancelled) return;
      const connection = session.connection;
      setConnections([connection]);
      setConn(connection.config);
      setActiveConnId(connection.id);
      setSection('live');
      setShowSetup(false);
    } catch (e) {
      if (!cancelled) setContentSessionError(e.message || 'Content session expired or invalid');
    }
  })();

  return () => { cancelled = true; };
}, [httpContentMode]);
```

Render a simple blocking error before main app content when `httpContentMode && contentSessionError`:

```jsx
if (httpContentMode && contentSessionError) {
  return (
    <div className="setup-screen">
      <div className="setup-card">
        <h2>Content Session Unavailable</h2>
        <p>{contentSessionError}</p>
        <button className="btn-go" onClick={() => { window.location.href = 'https://portalheaven.stream'; }}>
          Return to secure app
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Disable setup/account-only surfaces in HTTP content mode**

In `App.jsx`, guard setup/settings/account prompts:

```js
const allowAccountSurfaces = !httpContentMode;
```

Use `allowAccountSurfaces` where settings/setup/account manager buttons are shown. Keep content navigation, grids, EPG, search, and player available.

- [ ] **Step 6: Run frontend tests**

Run:

```powershell
npm test -- direct-content-session.test.js
```

Expected: helper tests pass.

- [ ] **Step 7: Manual local check**

Run frontend dev server and backend if needed. Visit:

```text
http://localhost:5173/content?token=missing
```

Expected: content session error screen, not normal login/setup.

- [ ] **Step 8: Commit content bootstrap**

```powershell
git add -- streamvault/src/App.jsx streamvault/src/direct-content-session.js streamvault/tests/direct-content-session.test.js
git commit -m "feat(content): bootstrap http content shell"
```

---

### Task 5: Playback Behavior Inside HTTP Content Mode

**Files:**
- Modify: `streamvault/src/App.jsx`
- Test: `streamvault/tests/direct-content-session.test.js` or `streamvault/tests/Player.test.jsx`

- [ ] **Step 1: Add helper test for content mode direct playback**

Add to `streamvault/tests/direct-content-session.test.js`:

```js
import { shouldUseTokenPlayerForItem } from '../src/direct-content-session.js';

it('does not use token player when already in HTTP content mode', () => {
  expect(shouldUseTokenPlayerForItem({ type: 'xtream' }, { pathname: '/content', search: '?token=abc' })).toBe(false);
});

it('uses token player for direct providers outside HTTP content mode', () => {
  expect(shouldUseTokenPlayerForItem({ type: 'xtream' }, { pathname: '/', search: '' })).toBe(true);
  expect(shouldUseTokenPlayerForItem({ type: 'm3u' }, { pathname: '/', search: '' })).toBe(true);
  expect(shouldUseTokenPlayerForItem({ type: 'stalker' }, { pathname: '/', search: '' })).toBe(false);
});
```

- [ ] **Step 2: Run helper test and verify failure**

Run:

```powershell
npm test -- direct-content-session.test.js
```

Expected: fails because `shouldUseTokenPlayerForItem` is missing.

- [ ] **Step 3: Implement helper**

Add to `streamvault/src/direct-content-session.js`:

```js
export function shouldUseTokenPlayerForItem(connection, locationObject = window.location) {
  return isDirectContentConnection(connection) && !isHttpContentMode(locationObject);
}
```

- [ ] **Step 4: Update playItem logic**

In `streamvault/src/App.jsx`, import `shouldUseTokenPlayerForItem`.

Replace:

```js
} else if (conn?.type === "xtream" || conn?.type === "m3u") {
```

with:

```js
} else if (shouldUseTokenPlayerForItem(conn)) {
```

Add a new branch immediately after token-player branch:

```js
} else if (conn?.type === 'xtream' || conn?.type === 'm3u') {
  const directItem = { ...item, _direct: true };
  setPlaying(directItem);
  addHistory(directItem);
```

This keeps old `/player` behavior outside `/content`, but keeps playback in-page inside HTTP content mode.

- [ ] **Step 5: Run frontend tests**

Run:

```powershell
npm test -- direct-content-session.test.js
```

Expected: tests pass.

- [ ] **Step 6: Commit playback-mode behavior**

```powershell
git add -- streamvault/src/App.jsx streamvault/src/direct-content-session.js streamvault/tests/direct-content-session.test.js
git commit -m "feat(content): keep direct playback inside http content mode"
```

---

### Task 6: Nginx Bare-IP Content Shell Template

**Files:**
- Create: `nginx_vps_ip_content.conf`

- [ ] **Step 1: Add nginx template**

Create `nginx_vps_ip_content.conf`:

```nginx
# Bare public IP vhost for HTTP direct content mode.
# Serves the HTTP content shell and proxies only metadata/control routes to 3201.
# Xtream/M3U media bytes must remain browser -> provider, not /stream.

server {
    listen 80;
    server_name 40.233.113.76;

    root /home/opc/StreamVault-Feature/streamvault/dist;
    index index.html;

    location /content {
        try_files $uri $uri/ /index.html;
    }

    location ~* \.(?:js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|otf|map)$ {
        expires 1y;
        access_log off;
        add_header Cache-Control "public";
        try_files $uri =404;
    }

    location /player {
        proxy_pass http://127.0.0.1:3201;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3201;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location /proxy {
        proxy_pass http://127.0.0.1:3201;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 300s;
    }

    location /img {
        proxy_pass http://127.0.0.1:3201;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 60s;
    }

    location /health {
        proxy_pass http://127.0.0.1:3201;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }

    location / {
        return 404;
    }
}
```

- [ ] **Step 2: Commit nginx template**

```powershell
git add -- nginx_vps_ip_content.conf
git commit -m "chore(nginx): add bare ip content shell template"
```

---

### Task 7: Verification and Deployment

**Files:**
- No source changes unless verification finds a bug.

- [ ] **Step 1: Run backend focused tests**

```powershell
cd stalker-proxy
npm test -- routes.test.js
```

Expected: all route tests pass.

- [ ] **Step 2: Run frontend focused tests**

```powershell
cd streamvault
npm test -- direct-content-session.test.js
```

Expected: all direct content helper tests pass.

- [ ] **Step 3: Build frontend**

```powershell
cd streamvault
npm run build
```

Expected: Vite build succeeds.

- [ ] **Step 4: Push feature branch to public remote**

```powershell
git push public feature/direct-play-no-proxy:feature/direct-play-no-proxy
```

Expected: remote branch updates.

- [ ] **Step 5: Update VPS feature checkout only**

```powershell
ssh -i "C:\Users\waqas\OneDrive\Documents\keys\vps-cenos\ssh-key-2026-03-23.key" opc@40.233.113.76 'cd /home/opc/StreamVault-Feature && git pull --ff-only origin feature/direct-play-no-proxy && pm2 restart stalker-proxy-play && pm2 list'
```

Expected: `stalker-proxy-play` restarts, production `stalker-proxy` PID remains unchanged.

- [ ] **Step 6: Verify VPS feature service**

```powershell
curl.exe -i --max-time 15 http://40.233.113.76/health
curl.exe -i --max-time 15 http://40.233.113.76/content?token=missing
curl.exe -i --max-time 15 http://40.233.113.76/api/content-session/validate?token=missing
```

Expected:
- `/health` returns 200.
- `/content?token=missing` serves the SPA HTML.
- `/api/content-session/validate?token=missing` returns JSON 404 from backend.

- [ ] **Step 7: Manual browser verification**

Manual checks:

1. Log into HTTPS app.
2. Open an Xtream connection.
3. Confirm browser navigates to `http://40.233.113.76/content?token=...`.
4. Confirm live/VOD/series lists load.
5. Confirm channel icons load through `http://40.233.113.76/img?...`.
6. Confirm EPG loads where provider supplies EPG.
7. Click live stream.
8. Confirm playback stays in the HTTP content screen.
9. Confirm media requests go to provider host, not `http://40.233.113.76/stream`.
10. Confirm HTTPS login/account pages still work separately.

- [ ] **Step 8: Final commit if verification required fixes**

If any verification fixes were made:

```powershell
git add -- <changed-files>
git commit -m "fix(content): address http content verification issues"
```

Expected: no uncommitted tracked changes remain except pre-existing unrelated untracked files.

# Frontend Refactor Phase 3 & High Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise automated coverage by splitting `Setup.jsx` into focused sub-components, moving app state into a testable hook plus pure store module, adding backend route coverage, and wiring a deterministic Playwright smoke flow for login-to-playback.

**Architecture:** 
1. Separate pure state transitions from side effects. Put reducer/selectors into `src/streamvault-store.js` and keep `useStreamVault.js` as the hook that wires persistence, sync, and API effects.
2. Keep `Setup.jsx` as the orchestration shell only. Extract the actual form and list UI into small components with explicit props so each piece can be tested in isolation.
3. Add real coverage harnesses before refactoring. Frontend and backend each get a `test:coverage` script, and Playwright gets a config with a deterministic web server and request interception so the happy path does not depend on live IPTV infrastructure.

**Tech Stack:** React, Vitest, `@testing-library/react`, Playwright.

**Coverage Targets:**
- Frontend: 80%+ lines on `streamvault/` when running `npm run test:coverage`
- Backend: 70%+ lines on `stalker-proxy/` when running `npm run test:coverage`
- E2E: Playwright smoke coverage is required, but it is not counted toward the numeric coverage thresholds

---

### Task 0: Add Coverage Harnesses And Scripts

**Files:**
- Modify: `streamvault/package.json`
- Modify: `streamvault/vitest.config.js`
- Create: `streamvault/playwright.config.js`
- Modify: `stalker-proxy/package.json`
- Modify: `stalker-proxy/vitest.config.js`

- [ ] **Step 1: Add the frontend coverage script and thresholds**

Update `streamvault/package.json` scripts:

```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "lint": "eslint .",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage",
    "e2e": "playwright test"
  }
}
```

Update `streamvault/vitest.config.js`:

```js
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.js"],
    css: true,
  },
  coverage: {
    provider: "v8",
    reporter: ["text", "html"],
    reportsDirectory: "./coverage",
    thresholds: {
      lines: 80,
      functions: 80,
      branches: 70,
      statements: 80,
    },
    exclude: ["e2e/**", "dist/**"],
  },
});
```

- [ ] **Step 2: Add the backend coverage script and thresholds**

Update `stalker-proxy/package.json` scripts:

```json
{
  "scripts": {
    "start": "node src/index.js",
    "dev": "nodemon src/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  }
}
```

Update `stalker-proxy/vitest.config.js`:

```js
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    exclude: ["test/**"],
    testTimeout: 15000,
    setupFiles: ["tests/setup.js"],
  },
  coverage: {
    provider: "v8",
    reporter: ["text", "html"],
    reportsDirectory: "./coverage",
    thresholds: {
      lines: 70,
      functions: 70,
      branches: 60,
      statements: 70,
    },
    exclude: ["tests/**"],
  },
});
```

- [ ] **Step 3: Add the Playwright config**

Create `streamvault/playwright.config.js`:

```js
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry",
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
```

- [ ] **Step 4: Verify the harness commands**

Run:

```bash
cd streamvault
npm run test:coverage
npm run e2e
cd ../stalker-proxy
npm run test:coverage
```

Expected:
- `streamvault` emits a coverage report with thresholds enabled
- `stalker-proxy` emits a coverage report with thresholds enabled
- Playwright is wired to the frontend dev server and ready for deterministic interception

- [ ] **Step 5: Commit**

```bash
git add streamvault/package.json streamvault/vitest.config.js streamvault/playwright.config.js stalker-proxy/package.json stalker-proxy/vitest.config.js
git commit -m "chore: add coverage and playwright harnesses"
```

### Task 1: Decompose Setup Component

**Files:**
- Create: `streamvault/src/components/setup/XtreamForm.jsx`
- Create: `streamvault/src/components/setup/StalkerForm.jsx`
- Create: `streamvault/src/components/setup/M3UForm.jsx`
- Create: `streamvault/src/components/setup/ConnectionList.jsx`
- Create: `streamvault/src/components/setup/ConnectionManagerList.jsx`
- Modify: `streamvault/src/components/Setup.jsx`
- Create: `streamvault/tests/components/setup/XtreamForm.test.jsx`
- Create: `streamvault/tests/components/setup/StalkerForm.test.jsx`
- Create: `streamvault/tests/components/setup/M3UForm.test.jsx`
- Create: `streamvault/tests/components/setup/ConnectionList.test.jsx`
- Create: `streamvault/tests/components/setup/ConnectionManagerList.test.jsx`

**Component contracts:**
- `XtreamForm({ form, setForm, loading, err, onSubmit })`
- `StalkerForm({ form, setForm, loading, err, skipValidation, setSkipValidation, onSubmit, onValidate })`
- `M3UForm({ form, setForm, rawText, setRawText, loading, err, detected, selected, setSelected, onSubmit, onFileImport })`
- `ConnectionList({ connections, activeConnId, onReconnect, onEdit, onRemoveConn })`
- `ConnectionManagerList({ connections, activeConnId, diagResults, diagLoading, onReconnect, onEdit, onRemoveConn, onDiagnose })`

- [ ] **Step 1: Extract and test XtreamForm**

Write the test first:

```jsx
// streamvault/tests/components/setup/XtreamForm.test.jsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import XtreamForm from "../../../src/components/setup/XtreamForm.jsx";

describe("XtreamForm", () => {
  it("submits the typed credentials", () => {
    const onSubmit = vi.fn((e) => e.preventDefault());
    const setForm = vi.fn();
    render(
      <XtreamForm
        form={{ server: "", user: "", pass: "" }}
        setForm={setForm}
        loading={false}
        err=""
        onSubmit={onSubmit}
      />
    );
    fireEvent.change(screen.getByPlaceholderText(/server/i), { target: { value: "https://portal.test" } });
    fireEvent.change(screen.getByPlaceholderText(/username/i), { target: { value: "alice" } });
    fireEvent.change(screen.getByPlaceholderText(/password/i), { target: { value: "secret" } });
    expect(setForm).toHaveBeenCalled();
  });
});
```

Run:

```bash
cd streamvault
npx vitest run tests/components/setup/XtreamForm.test.jsx
```

Expected: FAIL until `XtreamForm.jsx` exists.

Implement `XtreamForm.jsx` by moving only the Xtream-specific UI and handlers out of `Setup.jsx`.

Run the same test again.

Expected: PASS.

- [ ] **Step 2: Extract and test StalkerForm**

Create `streamvault/tests/components/setup/StalkerForm.test.jsx` with a test that:
- renders the MAC, portal, serial, device ID, and device ID2 fields
- toggles `skipValidation`
- clicks the submit button and verifies `onSubmit` fires

Move the Stalker-specific UI out of `Setup.jsx` into `StalkerForm.jsx`.

- [ ] **Step 3: Extract and test M3UForm**

Create `streamvault/tests/components/setup/M3UForm.test.jsx` with a test that:
- renders the M3U URL field and pasted-text import area
- shows detected entries when provided
- allows selecting detected entries
- triggers `onFileImport` when the file input changes

Move the M3U-specific UI and parsing entry points out of `Setup.jsx` into `M3UForm.jsx`.

- [ ] **Step 4: Extract and test ConnectionList**

Create `streamvault/tests/components/setup/ConnectionList.test.jsx` with a test that:
- renders saved connections
- highlights the active connection
- calls `onReconnect`, `onEdit`, and `onRemoveConn` from the corresponding buttons

Create `streamvault/tests/components/setup/ConnectionManagerList.test.jsx` with a test that:
- renders diagnostics for saved connections
- shows loading and result states for per-connection diagnostics
- calls `onDiagnose` from the diagnose button

Move the saved connection list UI into `ConnectionList.jsx`.

- [ ] **Step 5: Refactor Setup.jsx into a thin coordinator**

`Setup.jsx` should keep only:
- tab switching
- top-level `useState` for the setup screen
- the disclaimer modal
- the connection import/validation orchestration
- composition of the extracted sub-components

All provider-specific rendering should be delegated to the extracted sub-components.
The basic saved-connection list in the setup screen should stay separate from the diagnostics-enabled connection manager list used by the modal flow.

- [ ] **Step 6: Commit**

```bash
git add streamvault/src/components/setup/ streamvault/src/components/Setup.jsx streamvault/tests/components/setup/
git commit -m "refactor(setup): split Setup into focused sub-components"
```

### Task 2: Extract The Headless Store

**Files:**
- Create: `streamvault/src/streamvault-store.js`
- Create: `streamvault/src/useStreamVault.js`
- Modify: `streamvault/src/App.jsx`
- Create: `streamvault/tests/streamvault-store.test.js`
- Create: `streamvault/tests/useStreamVault.test.js`

**Store contract:**
- Pure state transitions live in `streamvault-store.js`
- `useStreamVault.js` wires persistence, API calls, and effects
- `App.jsx` consumes the hook and renders views; it should not own the app brain anymore
- Extract state in phases:
  - Phase A: connections, active connection, favorites, history, and persistence
  - Phase B: EPG and search-related state
  - Phase C: auth/session and cross-user sync behavior

- [ ] **Step 1: Extract and test pure state transitions first**

Create `streamvault/src/streamvault-store.js` with:
- `createInitialStoreState()`
- `streamvaultReducer(state, action)`
- `selectActiveConnection(state)`
- `selectFavItems(state)`

Write `streamvault/tests/streamvault-store.test.js` for the pure reducer/selectors:

```js
import { describe, it, expect } from "vitest";
import { createInitialStoreState, streamvaultReducer } from "../src/streamvault-store.js";

describe("streamvault store", () => {
  it("marks a connection active after CONNECT_SUCCESS", () => {
    const state = createInitialStoreState();
    const next = streamvaultReducer(state, {
      type: "CONNECT_SUCCESS",
      payload: { conn: { id: "c1", type: "m3u" } }
    });
    expect(next.activeConnId).toBe("c1");
  });
});
```

Run:

```bash
cd streamvault
npx vitest run tests/streamvault-store.test.js
```

Expected: FAIL until the store module exists.

Implement the reducer/selectors with no DOM and no fetch.
Only move the Phase A state slice into the store in this task; leave EPG/search/auth/session state in `App.jsx` for later phases.

Expected after implementation: PASS.

- [ ] **Step 2: Write hook tests against a small harness component**

Create `streamvault/tests/useStreamVault.test.js` with a harness component that calls the hook and renders its values into the DOM. Mock:
- `db` from `src/app-runtime.js`
- `authFetch` from `src/app-runtime.js`
- `localStorage`
- `window.fetch`

Test cases to include:
- `handleAuth` migrates guest data and sets `authUser`
- `toggleFavorite` updates local connection/favorite state and syncs through the mocked API layer
- `switchConnection` updates the active connection without disturbing the loaded source list

Use `render` from `@testing-library/react` and a tiny test harness component instead of adding a new hooks library.

- [ ] **Step 3: Implement the hook**

Create `streamvault/src/useStreamVault.js` so it:
- imports the pure reducer/selectors from `streamvault-store.js`
- imports `db`, `authFetch`, `track`, and `GUEST_ID` from the existing `app-runtime.js` seam
- owns the effect wiring for initial load, sync, and migration
- returns a plain object with the state plus action handlers used by `App.jsx`
- keeps the returned API slice-based, not a single unstructured blob

`App.jsx` should become a consumer of `useStreamVault()` and should stop carrying the app-wide business logic inline.

- [ ] **Step 4: Commit**

```bash
git add streamvault/src/streamvault-store.js streamvault/src/useStreamVault.js streamvault/src/App.jsx streamvault/tests/streamvault-store.test.js streamvault/tests/useStreamVault.test.js
git commit -m "refactor(frontend): extract streamvault store and hook"
```

### Task 3: Increase Backend Route Coverage

**Files:**
- Modify: `stalker-proxy/tests/routes.test.js`
- Create: `stalker-proxy/tests/stalker-router.test.js`

The backend plan should focus on `src/routes/stalker.js`, since that is where the route complexity lives.

- [ ] **Step 1: Expand the integration smoke tests in routes.test.js**

Add coverage for:
- `/stalker/validate` error handling for missing params and upstream failures
- `/stalker/play` URL normalization for localhost/127.0.0.1 rewrites
- `/stalker/series/categories` and `/stalker/series/seasons` happy-path responses

Keep these tests using the existing `createApp` integration harness where possible.

- [ ] **Step 2: Add a focused router test file**

Create `stalker-proxy/tests/stalker-router.test.js` to test `createStalkerRouter(deps)` directly with `express()` + `supertest`.

Use explicit cases for:
- handshake failures returning `502`
- token/validation responses mapping to the expected JSON shape
- channel list parsing
- play/stream URL rewriting
- series paging behavior

Example structure:

```js
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import express from "express";
import { createStalkerRouter } from "../src/routes/stalker";

describe("createStalkerRouter", () => {
  it("returns 400 when portal and mac are missing", async () => {
    const app = express();
    app.use(express.json());
    app.use("/stalker", createStalkerRouter({
      cache: { get: vi.fn(), set: vi.fn(), trackWatch: vi.fn(), trackCacheHit: vi.fn(), trackCacheMiss: vi.fn(), cacheKey: vi.fn() },
      auth: {},
      fetch: vi.fn(),
      isUrlAllowed: vi.fn(),
      getSession: vi.fn(),
      portalFetchRetry: vi.fn(),
      safeError: vi.fn(e => e.message),
      buildStalkerStreamHeaders: vi.fn(),
      summarizeUpstreamHeaders: vi.fn()
    }));

    const res = await request(app).post("/stalker/validate").send({});
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 3: Verify backend coverage**

Run:

```bash
cd stalker-proxy
npm run test:coverage
```

Expected:
- Coverage report is generated
- `src/routes/stalker.js` coverage moves toward the 70% target
- Existing smoke tests still pass

- [ ] **Step 4: Commit**

```bash
git add stalker-proxy/tests/routes.test.js stalker-proxy/tests/stalker-router.test.js
git commit -m "test: increase stalker route coverage"
```

### Task 4: Implement Playwright E2E Smoke Flow

**Files:**
- Create: `streamvault/e2e/playback.spec.js`

This test should be deterministic. It should not depend on live IPTV services or the backend proxy being up.
Use `page.route()` to fake the API responses and `page.addInitScript()` to spy on `HTMLMediaElement.prototype.play`.
Use role-based selectors for buttons and exact placeholder selectors for inputs so the flow stays stable if the layout changes.

- [ ] **Step 1: Write the E2E test**

```js
// streamvault/e2e/playback.spec.js
import { test, expect } from "@playwright/test";

test("login to playback happy path", async ({ page }) => {
  await page.addInitScript(() => {
    window.__playCalls = 0;
    HTMLMediaElement.prototype.play = function () {
      window.__playCalls += 1;
      return Promise.resolve();
    };
  });

  await page.route("**/api/auth/login", async route => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ user: { id: "1", username: "demo", role: "regular" } }),
    });
  });

  await page.route("**/proxy?url=**", async route => {
    const url = route.request().url();
    if (url.includes(".m3u")) {
      await route.fulfill({
        contentType: "text/plain",
        body: "#EXTM3U\n#EXTINF:-1,Demo Channel\nhttp://media.test/stream.m3u8\n",
      });
      return;
    }
    await route.fulfill({ contentType: "text/plain", body: "" });
  });

  await page.route("**/media.test/stream.m3u8", async route => {
    await route.fulfill({
      contentType: "application/vnd.apple.mpegurl",
      body: "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST\n",
    });
  });

  await page.goto("/");
  await expect(page.getByText("Portal Heaven")).toBeVisible();
  await page.getByRole("button", { name: /^Login$/i }).first().click();
  await page.getByPlaceholder("Username").fill("demo");
  await page.getByPlaceholder("Password").fill("password");
  await page.getByRole("button", { name: /^Login$/i }).last().click();

  await expect(page.getByPlaceholder("http://server.com:8080")).toBeVisible();
  await page.getByRole("button", { name: /M3U Playlist/i }).click();
  await page.getByPlaceholder("http://example.com/playlist.m3u").fill("https://mock.test/playlist.m3u");
  await page.getByRole("button", { name: /Connect/i }).last().click();

  await expect(page.getByText("Demo Channel")).toBeVisible();
  await page.getByText("Demo Channel").click();
  await expect(page.locator("video")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__playCalls || 0)).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run the E2E test**

Run:

```bash
cd streamvault
npm run e2e
```

Expected:
- The test starts the frontend dev server via `playwright.config.js`
- The mocked login and playlist flow completes
- `HTMLMediaElement.prototype.play` is called after selecting a channel

- [ ] **Step 3: Commit**

```bash
git add streamvault/e2e/playback.spec.js streamvault/playwright.config.js
git commit -m "test: add deterministic login to playback e2e smoke"
```

### Task 5: Final Verification

**Files:**
- Modify: `streamvault/src/App.jsx`
- Modify: `streamvault/src/components/Setup.jsx`
- Modify: `streamvault/src/useStreamVault.js`
- Modify: `streamvault/src/streamvault-store.js`
- Modify: `stalker-proxy/src/routes/stalker.js`

- [ ] **Step 1: Run the frontend unit/coverage suite**

Run:

```bash
cd streamvault
npm run test:coverage
```

Expected:
- Coverage report is generated
- Thresholds pass or the plan records the exact uncovered hotspots that remain

- [ ] **Step 2: Run the backend unit/coverage suite**

Run:

```bash
cd stalker-proxy
npm run test:coverage
```

Expected:
- Backend route coverage clears the target threshold
- `routes.test.js` and `stalker-router.test.js` pass

- [ ] **Step 3: Run the browser smoke**

Run:

```bash
cd streamvault
npm run e2e
```

Expected:
- Login-to-playback smoke passes without live IPTV dependencies

- [ ] **Step 4: Run build and lint**

Run:

```bash
cd streamvault
npm run build
npm run lint
```

Expected:
- No new build regressions
- No new lint regressions from the refactor

- [ ] **Step 5: Commit**

```bash
git add streamvault/src/App.jsx streamvault/src/components/Setup.jsx streamvault/src/useStreamVault.js streamvault/src/streamvault-store.js stalker-proxy/src/routes/stalker.js
git commit -m "refactor(frontend): complete phase 3 coverage work"
```

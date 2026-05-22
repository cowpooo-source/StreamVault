# Frontend Refactor Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the remaining large views (`SettingsView`, `DirectHLSView`, `DiscoverView`, and `Setup`) from the monolithic `App.jsx` into dedicated component files, while first moving their App-local helper dependencies into shared modules so the extraction is actually runnable.

**Architecture:** Following the pattern established in Phase 1 (where `Player`, `AuthScreen`, and `TimelineGrid` were extracted), we will first promote the App-only helper functions used by multiple views into a small shared runtime module, then move each view into `src/components/` with explicit imports instead of hidden globals. Tests will cover the helper module and each extracted view with behavior-oriented assertions, not just static renders. The rule for this phase is simple: nothing new may depend on `App.jsx` internals that are not either passed in as props or exported from a shared module.

**Tech Stack:** React, Vitest, `@testing-library/react`, jsdom

**Shared dependency map:**
- `SettingsView` imports `db` and `API`
- `DirectHLSView` only needs `Player`
- `DiscoverView` imports `safeJsonFetch`, `API`, `imgSrc`, and `normalizeTitle`
- `Setup` imports `proxyFetch`, `makeXtreamAPI`, `track`, `GUEST_ID`, `API`, `parseM3U`, and `trackAnalytics`
- `App.jsx` must keep owning screen state, routing, and top-level feature flags, but no longer own the helper implementations that these views consume

---

### Task 0: Extract Shared App Helpers

**Files:**
- Create: `streamvault/src/app-runtime.js`
- Create: `streamvault/tests/app-runtime.test.js`
- Modify: `streamvault/src/App.jsx`

- [ ] **Step 1: Write the failing test**

```jsx
// streamvault/tests/app-runtime.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { safeJsonFetch, proxyFetch, makeXtreamAPI } from "../src/app-runtime.js";

describe("app-runtime helpers", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should proxy external URLs through the backend proxy", async () => {
    fetch.mockResolvedValueOnce(new Response("", { status: 200 }));
    await proxyFetch("https://example.com/live.m3u8");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toContain("/proxy?url=");
  });

  it("should parse JSON responses with safeJsonFetch", async () => {
    await expect(safeJsonFetch(new Response(JSON.stringify({ ok: true }), { status: 200 }))).resolves.toEqual({ ok: true });
  });

  it("should create an Xtream API wrapper that uses the proxy helper", () => {
    const api = makeXtreamAPI("https://portal.test", "u", "p");
    expect(api.auth).toBeTypeOf("function");
    expect(api.getLive).toBeTypeOf("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `cd streamvault && npx vitest run tests/app-runtime.test.js`
Expected: FAIL - module does not exist yet.

- [ ] **Step 3: Move the App-only helper implementations into `src/app-runtime.js`**
Create `streamvault/src/app-runtime.js` and move these definitions out of `App.jsx`:
`GUEST_ID`, `authHeaders`, `authFetch`, `track`, `db`, `proxyFetch`, `safeJsonFetch`, and `makeXtreamAPI`.
Import `API` from `./utils.js` inside the new module, and keep `App.jsx` as the consumer of the exported helpers.

- [ ] **Step 4: Update App.jsx to import the shared helpers**
Remove the moved helper bodies from `App.jsx` and import the shared exports from `./app-runtime.js`.
Keep `setEncKeySource(GUEST_ID)` in `App.jsx`, but source `GUEST_ID` from the shared module instead of creating it inline.

- [ ] **Step 5: Run test to verify it passes**
Run: `cd streamvault && npx vitest run tests/app-runtime.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add streamvault/src/app-runtime.js streamvault/tests/app-runtime.test.js streamvault/src/App.jsx
git commit -m "refactor(frontend): extract shared app runtime helpers"
```

### Task 1: Extract SettingsView Component

**Files:**
- Create: `streamvault/src/components/SettingsView.jsx`
- Create: `streamvault/tests/SettingsView.test.jsx`
- Modify: `streamvault/src/App.jsx`

- [ ] **Step 1: Write the failing test**

```jsx
// streamvault/tests/SettingsView.test.jsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import SettingsView from "../src/components/SettingsView.jsx";
import { db } from "../src/app-runtime.js";

vi.mock("../src/app-runtime.js", () => ({
  db: { get: vi.fn(async (_key, fallback) => fallback) }
}));

describe("SettingsView", () => {
  const defaultProps = {
    connections: [],
    authUser: null,
    activeConnId: null,
    onAuth: vi.fn(),
    onImportFull: vi.fn(),
    autoLoadMore: false,
    setAutoLoadMore: vi.fn()
  };

  it("should render General tab by default", () => {
    render(<SettingsView {...defaultProps} />);
    expect(screen.getByText("Playback & Content")).toBeInTheDocument();
  });

  it("should switch to Account tab", () => {
    render(<SettingsView {...defaultProps} />);
    fireEvent.click(screen.getByText("Account"));
    expect(screen.getByText("Profile")).toBeInTheDocument();
  });

  it("should switch to Data tab", () => {
    render(<SettingsView {...defaultProps} />);
    fireEvent.click(screen.getByText("Data"));
    expect(screen.getByText("Export Data")).toBeInTheDocument();
  });

  it("should read export data from the db prop", () => {
    render(<SettingsView {...defaultProps} />);
    fireEvent.click(screen.getByText("Data"));
    fireEvent.click(screen.getByText("Download Backup (.json)"));
    expect(db.get).toHaveBeenCalledWith("sv-connections", []);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `cd streamvault && npx vitest run tests/SettingsView.test.jsx`
Expected: FAIL - component still depends on App-local helpers until extraction is completed.

- [ ] **Step 3: Extract SettingsView to src/components/SettingsView.jsx**
Move the `SettingsView` function (approx lines 5095-5291) from `App.jsx` into `streamvault/src/components/SettingsView.jsx`.
Import `useState` and `useRef` from React, `API` from `../utils.js`, and `db` from `../app-runtime.js`.
Do not use `window.db` or `window.API`.
The component signature should become `SettingsView({ connections, authUser, activeConnId, onAuth, onImportFull, autoLoadMore, setAutoLoadMore })`.

- [ ] **Step 4: Update App.jsx and verify tests pass**
In `App.jsx`, remove the `SettingsView` function and add `import SettingsView from "./components/SettingsView.jsx";`.
Run: `cd streamvault && npx vitest run tests/SettingsView.test.jsx`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add streamvault/src/components/SettingsView.jsx streamvault/tests/SettingsView.test.jsx streamvault/src/App.jsx
git commit -m "refactor(frontend): extract SettingsView component"
```

### Task 2: Extract DirectHLSView Component

**Files:**
- Create: `streamvault/src/components/DirectHLSView.jsx`
- Create: `streamvault/tests/DirectHLSView.test.jsx`
- Modify: `streamvault/src/App.jsx`

- [ ] **Step 1: Write the failing test**

```jsx
// streamvault/tests/DirectHLSView.test.jsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import DirectHLSView from "../src/components/DirectHLSView.jsx";

// Mock Player
vi.mock("../src/components/Player.jsx", () => ({
  default: () => <div data-testid="mock-player">Player</div>
}));

describe("DirectHLSView", () => {
  it("should render input and examples", () => {
    render(<DirectHLSView />);
    expect(screen.getByPlaceholderText(/https:\/\/your-stream.com/i)).toBeInTheDocument();
    expect(screen.getByText("Public test streams")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `cd streamvault && npx vitest run tests/DirectHLSView.test.jsx`

- [ ] **Step 3: Extract DirectHLSView to src/components/DirectHLSView.jsx**
Move `DirectHLSView` (approx lines 5292-5332) from `App.jsx` to the new file.
```jsx
import React, { useState, memo } from 'react';
import Player from './Player.jsx';
// ... paste DirectHLSView code ...
export default DirectHLSView;
```

- [ ] **Step 4: Update App.jsx and verify tests pass**
In `App.jsx`, remove `DirectHLSView` and add the import.
Run: `cd streamvault && npx vitest run tests/DirectHLSView.test.jsx`

- [ ] **Step 5: Commit**
```bash
git add streamvault/src/components/DirectHLSView.jsx streamvault/tests/DirectHLSView.test.jsx streamvault/src/App.jsx
git commit -m "refactor(frontend): extract DirectHLSView component"
```

### Task 3: Extract DiscoverView Component

**Files:**
- Create: `streamvault/src/components/DiscoverView.jsx`
- Create: `streamvault/tests/DiscoverView.test.jsx`
- Modify: `streamvault/src/App.jsx`

- [ ] **Step 1: Write the failing test**

```jsx
// streamvault/tests/DiscoverView.test.jsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import DiscoverView from "../src/components/DiscoverView.jsx";
vi.mock("../src/utils.js", () => ({
  imgSrc: vi.fn(u => u),
  API: "http://localhost"
}));

describe("DiscoverView", () => {
  it("should render API key prompt if no key", () => {
    render(<DiscoverView tmdbKey="" setTmdbKey={vi.fn()} vod={[]} series={[]} onPlay={vi.fn()} />);
    expect(screen.getByText("Discover Trending Content")).toBeInTheDocument();
  });

  it("should accept the shared helper imports without App globals", () => {
    expect(DiscoverView).toBeTypeOf("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `cd streamvault && npx vitest run tests/DiscoverView.test.jsx`

- [ ] **Step 3: Extract DiscoverView to src/components/DiscoverView.jsx**
Move `normalizeTitle` and `DiscoverView` (approx lines 5333-end) from `App.jsx` to the new file.
Include imports for `React, { useState, useEffect, useCallback, memo }`, `imgSrc` and `API` from `../utils.js`, and `safeJsonFetch` from `../app-runtime.js`.
Keep `normalizeTitle` in the component file unless it is moved to a shared pure helper module with tests.

- [ ] **Step 4: Update App.jsx and verify tests pass**
In `App.jsx`, remove `DiscoverView` and `normalizeTitle`, and add the import.
Run: `cd streamvault && npx vitest run tests/DiscoverView.test.jsx`

- [ ] **Step 5: Commit**
```bash
git add streamvault/src/components/DiscoverView.jsx streamvault/tests/DiscoverView.test.jsx streamvault/src/App.jsx
git commit -m "refactor(frontend): extract DiscoverView component"
```

### Task 4: Extract Setup Component

**Files:**
- Create: `streamvault/src/components/Setup.jsx`
- Create: `streamvault/tests/Setup.test.jsx`
- Modify: `streamvault/src/App.jsx`

- [ ] **Step 1: Write the failing test**

```jsx
// streamvault/tests/Setup.test.jsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import Setup from "../src/components/Setup.jsx";

describe("Setup", () => {
  const defaultProps = {
    onConnect: vi.fn(), onImportMultiple: vi.fn(), onImportFull: vi.fn(),
    connections: [], onReconnect: vi.fn(), onRemoveConn: vi.fn(),
    onEdit: vi.fn(), authUser: null, isGuest: true, onLogout: vi.fn(),
    t: k => k
  };

  it("should render setup tabs", () => {
    render(<Setup {...defaultProps} />);
    expect(screen.getByText("Xtream Codes")).toBeInTheDocument();
    expect(screen.getByText("M3U Playlist")).toBeInTheDocument();
    expect(screen.getByText("Stalker Portal")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `cd streamvault && npx vitest run tests/Setup.test.jsx`

- [ ] **Step 3: Extract Setup to src/components/Setup.jsx**
Move the `Setup` component (approx lines 1235-1952) to the new file.
Import `API` and `parseM3U` from `../utils.js`, and `proxyFetch`, `makeXtreamAPI`, `track`, and `GUEST_ID` from `../app-runtime.js`.
Do not keep any provider/network helper logic in `App.jsx` after the move.
The component signature should become `Setup({ onConnect, onImportMultiple, onImportFull, connections = [], onReconnect, onRemoveConn, onEdit, authUser, isGuest, onLogout, t: st })`.

- [ ] **Step 4: Update App.jsx and verify tests pass**
In `App.jsx`, remove `Setup` and add the import.
Run: `cd streamvault && npx vitest run tests/Setup.test.jsx`

- [ ] **Step 5: Commit**
```bash
git add streamvault/src/components/Setup.jsx streamvault/tests/Setup.test.jsx streamvault/src/App.jsx
git commit -m "refactor(frontend): extract Setup component"
```

### Task 5: Final Integration Verification

**Files:**
- Modify: `streamvault/src/App.jsx`
- Modify: `streamvault/src/components/SettingsView.jsx`
- Modify: `streamvault/src/components/DirectHLSView.jsx`
- Modify: `streamvault/src/components/DiscoverView.jsx`
- Modify: `streamvault/src/components/Setup.jsx`

- [ ] **Step 1: Run the full frontend test suite**
Run: `cd streamvault && npm run test`
Expected:
- All existing frontend tests pass
- The new runtime-helper and extraction tests pass

- [ ] **Step 2: Run a production build**
Run: `cd streamvault && npm run build`
Expected:
- The build completes successfully
- `dist/index.html` and `dist/landing.html` still build correctly after the component split
- No missing import or tree-shaking failures appear

- [ ] **Step 3: Run lint on the touched frontend files**
Run: `cd streamvault && npm run lint`
Expected:
- No new lint errors are introduced by the refactor
- If pre-existing repo-wide lint debt remains, the worker records the exact files that were newly changed and confirms they are clean

- [ ] **Step 4: Commit**
```bash
git add streamvault/src/App.jsx streamvault/src/app-runtime.js streamvault/src/components/SettingsView.jsx streamvault/src/components/DirectHLSView.jsx streamvault/src/components/DiscoverView.jsx streamvault/src/components/Setup.jsx streamvault/tests/app-runtime.test.js streamvault/tests/SettingsView.test.jsx streamvault/tests/DirectHLSView.test.jsx streamvault/tests/DiscoverView.test.jsx streamvault/tests/Setup.test.jsx
git commit -m "refactor(frontend): complete phase 2 view extraction"
```

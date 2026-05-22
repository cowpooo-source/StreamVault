# Frontend Refactor Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the remaining large views (`SettingsView`, `DirectHLSView`, `DiscoverView`, and `Setup`) from the monolithic `App.jsx` into dedicated component files to further reduce its size and improve maintainability.

**Architecture:** Following the pattern established in Phase 1 (where `Player`, `AuthScreen`, and `TimelineGrid` were extracted), we will move each view function into `src/components/`. We will also write shallow rendering tests using `@testing-library/react` and Vitest to ensure they don't break during extraction. Shared global dependencies (like `API` and `db`) will either be passed as props, or we will assume they are globally available/mocked in tests.

**Tech Stack:** React, Vitest, `@testing-library/react`, jsdom

---

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

// Mock the global db object if used
global.db = { get: vi.fn(), set: vi.fn() };
global.API = "http://localhost";

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
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `cd streamvault && npx vitest run tests/SettingsView.test.jsx`
Expected: FAIL - Cannot find module.

- [ ] **Step 3: Extract SettingsView to src/components/SettingsView.jsx**
Move the `SettingsView` function (approx lines 5095-5291) from `App.jsx` into `streamvault/src/components/SettingsView.jsx`. Add `import React, { useState, useRef } from 'react';` at the top and `export default SettingsView;` at the bottom. Make sure `window.API` or `window.db` are handled if not imported. You can add `import { API } from '../utils.js';` and pass `db` as a prop if preferred, but for now assuming global/mocked.

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

global.API = "http://localhost";
vi.mock("../src/utils.js", () => ({
  imgSrc: vi.fn(u => u),
  API: "http://localhost"
}));

describe("DiscoverView", () => {
  it("should render API key prompt if no key", () => {
    render(<DiscoverView tmdbKey="" setTmdbKey={vi.fn()} vod={[]} series={[]} onPlay={vi.fn()} />);
    expect(screen.getByText("Discover Trending Content")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `cd streamvault && npx vitest run tests/DiscoverView.test.jsx`

- [ ] **Step 3: Extract DiscoverView to src/components/DiscoverView.jsx**
Move `normalizeTitle` and `DiscoverView` (approx lines 5333-end) from `App.jsx` to the new file.
Include imports for `React, { useState, useEffect, useCallback, memo }` and `imgSrc`, `API` from `../utils.js`.

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

global.API = "http://localhost";

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
Move the `Setup` component (approx lines 1235-1952) to the new file. This is a very large component. Make sure all necessary React hooks (`useState`) are imported, along with `API` from `../utils.js`.

- [ ] **Step 4: Update App.jsx and verify tests pass**
In `App.jsx`, remove `Setup` and add the import.
Run: `cd streamvault && npx vitest run tests/Setup.test.jsx`

- [ ] **Step 5: Commit**
```bash
git add streamvault/src/components/Setup.jsx streamvault/tests/Setup.test.jsx streamvault/src/App.jsx
git commit -m "refactor(frontend): extract Setup component"
```
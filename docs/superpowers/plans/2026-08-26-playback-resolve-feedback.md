# Playback Resolve Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep users informed and in control while a provider prepares a stream, without allowing an unresolved request to block the application indefinitely.

**Architecture:** Introduce a small, framework-independent coordinator that owns one active preparation request, enforces a 90-second deadline, and rejects stale completions. `App.jsx` will use it for Stalker item, catch-up, and series-episode resolution, while the shared overlay receives a cancel action and a fullscreen/local presentation mode. The Player's existing initial-media timeout remains responsible for media buffering after a URL has been resolved.

**Tech Stack:** React 19, Vitest, Playwright, native `AbortController` and `AbortSignal`.

**Spec:** User-approved findings `PBL-01`, `PBL-02`, and `PBL-03` from the playback-loading review on 2026-08-26.

## Global Constraints

- Preserve direct-first playback and existing Stalker refresh/relay behavior.
- Do not change provider API contracts or make the VPS relay mandatory.
- Keep a slow but valid provider request usable for up to 90 seconds.
- Cancellation and timeout must never show a generic connection error or start stale playback.
- Do not change unrelated working-tree files.
- Implement test-first; do not deploy or commit until all verification commands pass.

---

## File Structure

- Create: `streamvault/src/playback-resolve.js` - owns one cancellable, deadline-bound resolve operation and exposes stable error codes.
- Create: `streamvault/tests/playback-resolve.test.js` - unit coverage for cancellation, timeout, and stale completion behavior.
- Modify: `streamvault/src/App.jsx` - wires the coordinator into Stalker item, catch-up, and series-episode resolution and clears it during app teardown/navigation.
- Modify: `streamvault/src/components/PlaybackLoadingOverlay.jsx` - adds a cancel action and supports fullscreen versus player-local positioning.
- Modify: `streamvault/src/components/Player.jsx` - keeps the media-buffering overlay local to the player, so the close controls remain reachable.
- Modify: `streamvault/e2e/fixtures/provider-mocks.js` - permits a long delayed `/stalker/play` response without changing existing defaults.
- Modify: `streamvault/e2e/stalker-playback.spec.js` - covers pending, cancel, failure, catch-up, and series-episode feedback flows.

### Task 1: Resolve Coordinator

**Files:**
- Create: `streamvault/src/playback-resolve.js`
- Create: `streamvault/tests/playback-resolve.test.js`

**Interfaces:**
- Produces `PLAYBACK_RESOLVE_TIMEOUT_MS` set to `90_000`.
- Produces `createPlaybackResolveCoordinator(options?)` with `run(operation)` and `cancel()`.
- `operation` receives `{ signal }` and may return any value or promise.
- `run()` rejects with `error.code === "playback_resolve_cancelled"` after manual cancellation and `error.code === "playback_resolve_timeout"` after the deadline.

- [ ] **Step 1: Write failing unit tests for cancellation and timeout.**

```js
import { describe, expect, it, vi } from "vitest";
import { createPlaybackResolveCoordinator } from "../src/playback-resolve.js";

it("rejects immediately when the active resolve is cancelled", async () => {
  const coordinator = createPlaybackResolveCoordinator({ timeoutMs: 90_000 });
  const pending = coordinator.run(({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));

  coordinator.cancel();
  await expect(pending).rejects.toMatchObject({ code: "playback_resolve_cancelled" });
});

it("rejects when the resolve deadline expires even if the operation ignores abort", async () => {
  vi.useFakeTimers();
  const coordinator = createPlaybackResolveCoordinator({ timeoutMs: 90_000 });
  const pending = coordinator.run(() => new Promise(() => {}));

  await vi.advanceTimersByTimeAsync(90_000);
  await expect(pending).rejects.toMatchObject({ code: "playback_resolve_timeout" });
  vi.useRealTimers();
});
```

- [ ] **Step 2: Run the unit test to verify it fails.**

Run: `npm test -- playback-resolve.test.js`

Expected: FAIL because `playback-resolve.js` does not exist.

- [ ] **Step 3: Add stale-completion test before implementation.**

```js
it("does not let a superseded operation produce a playback result", async () => {
  let firstResolve;
  const coordinator = createPlaybackResolveCoordinator();
  const first = coordinator.run(() => new Promise(resolve => { firstResolve = resolve; }));
  const second = coordinator.run(async () => "fresh-url");

  firstResolve("stale-url");
  await expect(first).rejects.toMatchObject({ code: "playback_resolve_cancelled" });
  await expect(second).resolves.toBe("fresh-url");
});
```

- [ ] **Step 4: Implement the minimal coordinator.**

```js
export const PLAYBACK_RESOLVE_TIMEOUT_MS = 90_000;

function resolveError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function createPlaybackResolveCoordinator({ timeoutMs = PLAYBACK_RESOLVE_TIMEOUT_MS } = {}) {
  let active = null;

  function cancel() {
    if (!active) return false;
    const request = active;
    active = null;
    request.controller.abort(resolveError("playback_resolve_cancelled", "Stream loading was cancelled."));
    request.rejectAbort(request.controller.signal.reason);
    return true;
  }

  async function run(operation) {
    cancel();
    const controller = new AbortController();
    let rejectAbort;
    const abortResult = new Promise((_, reject) => { rejectAbort = reject; });
    const request = { controller, rejectAbort };
    active = request;
    const timeout = window.setTimeout(() => {
      if (active !== request) return;
      const error = resolveError("playback_resolve_timeout", "The provider took too long to prepare this stream.");
      active = null;
      controller.abort(error);
      rejectAbort(error);
    }, timeoutMs);

    try {
      return await Promise.race([operation({ signal: controller.signal }), abortResult]);
    } finally {
      window.clearTimeout(timeout);
      if (active === request) active = null;
    }
  }

  return { run, cancel };
}
```

Use `globalThis.setTimeout` and `globalThis.clearTimeout` instead of `window` if the existing Vitest environment does not provide `window`. Preserve the error code supplied by `AbortController` rather than replacing it in a catch block.

- [ ] **Step 5: Run the coordinator tests and full unit suite.**

Run: `npm test -- playback-resolve.test.js`

Expected: PASS.

Run: `npm test`

Expected: all existing test files pass.

- [ ] **Step 6: Commit the isolated coordinator.**

```bash
git add streamvault/src/playback-resolve.js streamvault/tests/playback-resolve.test.js
git commit -m "feat: bound cancellable playback resolution"
```

### Task 2: Overlay Controls and Player-Local Layout

**Files:**
- Modify: `streamvault/src/components/PlaybackLoadingOverlay.jsx:3-46`
- Modify: `streamvault/src/components/Player.jsx:1189-1195`
- Test: `streamvault/e2e/playback-hls.spec.js`

**Interfaces:**
- `PlaybackLoadingOverlay` accepts `onCancel?: () => void` and `fullScreen?: boolean`.
- `fullScreen` defaults to `true`; `false` renders `position: "absolute"` with `zIndex: 3`.
- The cancel button has visible text `Cancel loading` and calls `onCancel` once.

- [ ] **Step 1: Write a failing Player E2E assertion that the close button remains usable while media is loading.**

Add to the existing HLS loading test:

```js
await expect(appPage.getByTestId("player-loading")).toBeVisible();
await expect(appPage.getByRole("button", { name: /close/i })).toBeVisible();
```

Run: `npx playwright test --config=playwright.config.js e2e/playback-hls.spec.js --grep "successful playing event"`

Expected: FAIL because the fixed overlay sits above the player close control.

- [ ] **Step 2: Add the overlay props and cancel button.**

```jsx
export default function PlaybackLoadingOverlay({
  testId = "playback-loading",
  message = "Connecting to stream...",
  detail = "Waiting for the provider response",
  fullScreen = true,
  onCancel,
}) {
  // Existing elapsed timer remains unchanged.
  return (
    <div
      data-testid={testId}
      role="status"
      aria-live="polite"
      style={{
        position: fullScreen ? "fixed" : "absolute",
        inset: 0,
        zIndex: fullScreen ? 10000 : 3,
        // Existing visual styles remain.
      }}
    >
      {/* Existing spinner and status text. */}
      {onCancel && <button className="btn-secondary" onClick={onCancel}>Cancel loading</button>}
    </div>
  );
}
```

Pass `fullScreen={false}` from `Player.jsx`:

```jsx
<PlaybackLoadingOverlay
  testId="player-loading"
  fullScreen={false}
  message="Loading stream..."
  detail="Waiting for playable media"
/>
```

- [ ] **Step 3: Run the focused Player test.**

Run: `npx playwright test --config=playwright.config.js e2e/playback-hls.spec.js --grep "successful playing event"`

Expected: PASS; loading overlay is visible and the Player close button remains visible.

- [ ] **Step 4: Commit the visual-control boundary.**

```bash
git add streamvault/src/components/PlaybackLoadingOverlay.jsx streamvault/src/components/Player.jsx streamvault/e2e/playback-hls.spec.js
git commit -m "fix: keep player controls accessible during media load"
```

### Task 3: Use the Coordinator for Every Stalker Playback Resolve

**Files:**
- Modify: `streamvault/src/App.jsx:1948-1950`
- Modify: `streamvault/src/App.jsx:3171-3272`
- Modify: `streamvault/src/App.jsx:3458-3530`
- Modify: `streamvault/src/App.jsx:3533-3589`
- Modify: `streamvault/src/App.jsx:3629-3675`
- Modify: `streamvault/src/App.jsx:1844-1865`
- Modify: `streamvault/src/App.jsx:3740-3765`
- Modify: `streamvault/src/App.jsx:3885-3900`

**Interfaces:**
- `runPlaybackResolve({ name, operation })` receives a display name and an operation accepting `{ signal }`.
- `cancelPlaybackResolve()` aborts the current operation, hides the overlay, and never changes `playing`.
- `resolveStalkerStream` must receive the coordinator signal through its existing `options.signal` parameter.
- Timeout maps to `The provider took too long to prepare this stream. Try again later.`
- Manual cancellation is silent: no `connError`, no history entry, no Player mount.

- [ ] **Step 1: Write failing Stalker E2E tests for cancellation and provider failure.**

```js
test("cancels a slow Stalker resolution without opening Player", async ({ appPage }) => {
  await setupStalkerTest(appPage, { playDelayMs: 120_000 });
  await connectAndOpenStalkerLive(appPage);
  await appPage.getByText("Stalker News").click();
  await expect(appPage.getByTestId("playback-loading")).toBeVisible();
  await appPage.getByRole("button", { name: "Cancel loading" }).click();
  await expect(appPage.getByTestId("playback-loading")).toBeHidden();
  await expect(appPage.locator(".player-ov")).toHaveCount(0);
  await expect(appPage.getByText("Stalker News")).toBeVisible();
});

test("removes pending feedback and reports a failed Stalker resolution", async ({ appPage }) => {
  await setupStalkerTest(appPage, { createLink: "failure" });
  await connectAndOpenStalkerLive(appPage);
  await appPage.getByText("Stalker News").click();
  await expect(appPage.getByTestId("playback-loading")).toBeHidden();
  await expect(appPage.getByText(/stream not available/i)).toBeVisible();
  await expect(appPage.locator(".player-ov")).toHaveCount(0);
});
```

Implement `connectAndOpenStalkerLive` in `stalker-playback.spec.js` only if the repeated setup is already present in at least three tests. Otherwise keep setup inline to avoid unrelated fixture refactoring.

- [ ] **Step 2: Run the new E2E tests to verify they fail.**

Run: `npx playwright test --config=playwright.config.js e2e/stalker-playback.spec.js --grep "cancels a slow|removes pending"`

Expected: FAIL because the overlay has no cancel control and resolve failure/cancellation are not centrally handled.

- [ ] **Step 3: Add App-level coordinator ownership.**

Add imports and refs near existing playback state:

```jsx
import { createPlaybackResolveCoordinator } from "./playback-resolve.js";

const playbackResolveCoordinatorRef = useRef(null);
const playbackResolveGenerationRef = useRef(0);
if (!playbackResolveCoordinatorRef.current) {
  playbackResolveCoordinatorRef.current = createPlaybackResolveCoordinator();
}
```

Add helpers inside `App`:

```jsx
function cancelPlaybackResolve() {
  playbackResolveGenerationRef.current += 1;
  playbackResolveCoordinatorRef.current?.cancel();
  setPlaybackLoading(null);
}

async function runPlaybackResolve({ name, operation }) {
  const generation = ++playbackResolveGenerationRef.current;
  setPlaybackLoading({ name });
  try {
    return await playbackResolveCoordinatorRef.current.run(operation);
  } finally {
    if (generation === playbackResolveGenerationRef.current) setPlaybackLoading(null);
  }
}

function isResolveCancellation(error) {
  return error?.code === "playback_resolve_cancelled" || error?.name === "AbortError";
}
```

Use `runPlaybackResolve` only for Stalker resolution:

```jsx
const resolved = await runPlaybackResolve({
  name: item.name || "Selected content",
  operation: ({ signal }) => resolveStalkerStream(item, item.type || "live", { signal }),
});
```

In each catch block, return silently for `isResolveCancellation(error)`. For timeout, call `setConnError("The provider took too long to prepare this stream. Try again later.")`; retain the existing provider error message for all other errors.

Pass cancellation to the App overlay:

```jsx
<PlaybackLoadingOverlay
  message={`Connecting to ${playbackLoading.name || "stream"}...`}
  onCancel={cancelPlaybackResolve}
/>
```

- [ ] **Step 4: Apply the helper to catch-up and series episodes.**

Replace each direct Stalker `resolveStalkerStream(...)` call with `runPlaybackResolve(...)` and preserve its existing resolve options:

```jsx
const resolved = await runPlaybackResolve({
  name: `${channel.name} - ${program.title}`,
  operation: ({ signal }) => resolveStalkerStream(
    { id: channel.id, _stalkerCmd: program.cmd || channel._stalkerCmd, type: "live" },
    "live",
    { signal, start: startUTC, end: endUTC, duration: Math.max(1, endUTC - startUTC), programId: program.id || program.programId },
  ),
});
```

For series use the existing `episode` and `episodeMeta` values unchanged, adding only `signal` to the third argument. Keep `setEpisodeLoading(episodeNum)` and its existing `finally` behavior.

- [ ] **Step 5: Cancel pending resolution when application context changes.**

Call `cancelPlaybackResolve()` before state reset in each existing transition that invalidates the selected connection:

```jsx
// handleLogout
cancelPlaybackResolve();
setPlaying(null);

// switchConnection and disconnect/new-connection flows
cancelPlaybackResolve();
setPlaying(null);

// terminal content-session invalidation path
cancelPlaybackResolve();
setPlaying(null);
```

Do not call it from Player `onClose`: Player is mounted only after resolve succeeds, so there is no active pre-playback resolve to cancel.

- [ ] **Step 6: Run focused tests and full Stalker playback tests.**

Run: `npx playwright test --config=playwright.config.js e2e/stalker-playback.spec.js`

Expected: all Stalker playback tests pass, including direct HLS, TS, VOD, cancellation, and failure.

- [ ] **Step 7: Commit the shared Stalker resolve behavior.**

```bash
git add streamvault/src/App.jsx streamvault/e2e/stalker-playback.spec.js
git commit -m "fix: make Stalker playback resolution cancellable"
```

### Task 4: Cover Catch-Up and Series-Episode Feedback

**Files:**
- Modify: `streamvault/e2e/fixtures/provider-mocks.js:217-305`
- Modify: `streamvault/e2e/stalker-playback.spec.js`

**Interfaces:**
- Existing `playDelayMs` delays every Stalker `/play` resolve response.
- Catch-up and series tests use real UI actions and assert `playback-loading`; they must not invoke component internals.

- [ ] **Step 1: Write failing catch-up and series tests.**

Add a mock EPG program marked as past and catch-up capable, then test:

```js
test("shows cancellable feedback while Stalker catch-up resolves", async ({ appPage }) => {
  await setupStalkerTest(appPage, { playDelayMs: 1_000, epg: "past-catchup" });
  await connectAndOpenStalkerLive(appPage);
  await openPastCatchupProgram(appPage);
  await expect(appPage.getByTestId("playback-loading")).toContainText("Stalker News");
  await expect(appPage.getByTestId("playback-loading")).toBeHidden({ timeout: 5_000 });
});

test("shows cancellable feedback while a Stalker episode resolves", async ({ appPage }) => {
  await setupStalkerTest(appPage, { playDelayMs: 1_000, series: "one-episode" });
  await connectAndOpenStalkerSeries(appPage);
  await appPage.getByRole("button", { name: /episode 1/i }).click();
  await expect(appPage.getByTestId("playback-loading")).toContainText(/episode 1/i);
  await expect(appPage.getByTestId("playback-loading")).toBeHidden({ timeout: 5_000 });
});
```

Use the actual accessible names produced by the existing series-detail modal instead of adding test-only labels.

- [ ] **Step 2: Run tests to verify they fail before the App wiring is complete.**

Run: `npx playwright test --config=playwright.config.js e2e/stalker-playback.spec.js --grep "catch-up resolves|episode resolves"`

Expected: FAIL because these resolution paths do not set `playbackLoading`.

- [ ] **Step 3: Extend only the mock data needed by the real UI flows.**

Add fixture options that return one catch-up program and one series episode through the same request routes used in production. Do not mock `playSeriesEpisode` or `playCatchup` directly.

- [ ] **Step 4: Run the two new E2E tests.**

Run: `npx playwright test --config=playwright.config.js e2e/stalker-playback.spec.js --grep "catch-up resolves|episode resolves"`

Expected: PASS.

- [ ] **Step 5: Commit the regression coverage.**

```bash
git add streamvault/e2e/fixtures/provider-mocks.js streamvault/e2e/stalker-playback.spec.js
git commit -m "test: cover Stalker playback preparation feedback"
```

### Task 5: Full Verification and Self-Review

**Files:**
- Review only: all files modified in Tasks 1-4.

- [ ] **Step 1: Verify the acceptance criteria against the implementation.**

| Acceptance criterion | Evidence required |
| --- | --- |
| Normal Stalker item shows immediate feedback | delayed `/stalker/play` Playwright test |
| User can cancel a pending resolve | cancel test leaves no Player and no connection error |
| A hung request releases at 90 seconds | fake-timer unit test with an operation that ignores abort |
| Stale completion cannot open an old stream | coordinator supersession unit test |
| Provider failure clears feedback | failed resolve Playwright test |
| Catch-up and episode clicks show feedback | their dedicated Playwright tests |
| Player close remains usable while media buffers | Player-local overlay test |
| Existing direct playback/recovery remains intact | complete `stalker-playback.spec.js` and `playback-recovery.spec.js` |

- [ ] **Step 2: Run unit tests.**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 3: Run relevant Playwright suites.**

Run: `npx playwright test --config=playwright.config.js e2e/stalker-playback.spec.js e2e/playback-hls.spec.js e2e/playback-recovery.spec.js`

Expected: all selected tests pass.

- [ ] **Step 4: Run lint and production build.**

Run: `npm run lint`

Expected: zero errors; report pre-existing warnings separately.

Run: `$env:VITE_SECURE_APP_BASE_URL='https://media.portalheaven.stream'; npm run build`

Expected: build succeeds.

- [ ] **Step 5: Inspect the final diff.**

Run: `git diff --check`

Expected: no whitespace errors.

Run: `git diff -- streamvault/src/playback-resolve.js streamvault/tests/playback-resolve.test.js streamvault/src/App.jsx streamvault/src/components/PlaybackLoadingOverlay.jsx streamvault/src/components/Player.jsx streamvault/e2e/fixtures/provider-mocks.js streamvault/e2e/stalker-playback.spec.js streamvault/e2e/playback-hls.spec.js`

Expected: changes are limited to cancellation, timeout, shared resolve use, and targeted tests.

- [ ] **Step 6: Commit only after all checks pass.**

```bash
git add streamvault/src/playback-resolve.js streamvault/tests/playback-resolve.test.js streamvault/src/App.jsx streamvault/src/components/PlaybackLoadingOverlay.jsx streamvault/src/components/Player.jsx streamvault/e2e/fixtures/provider-mocks.js streamvault/e2e/stalker-playback.spec.js streamvault/e2e/playback-hls.spec.js
git commit -m "fix: make slow playback loading cancellable"
```

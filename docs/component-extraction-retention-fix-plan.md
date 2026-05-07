# Component Extraction Retention Review and Fix Plan

Date: 2026-05-04

Reviewed branch: `feature/component-extraction-tests`

Baseline branch: `vps/self-hosted`

Primary goal: make the component extraction and test work retain all existing runtime behavior from `vps/self-hosted`, then add tests that prove the retained behavior continues to work.

## Sources Reviewed

- `docs/extractoin-and-testing-design-plans.md`
- `docs/superpowers/plans/2026-05-03-component-extraction-and-testing.md`
- `docs/superpowers/specs/2026-05-03-component-extraction-and-testing-design.md`
- Current branch source files under `streamvault/src`
- Current branch tests under `streamvault/tests`
- Baseline implementation from `vps/self-hosted:streamvault/src/App.jsx`

## Verification Snapshot

- `npm run build`: passed.
- `npx vitest run`: passed, 7 test files and 71 tests.
- `npm run lint`: failed with 82 reported problems.

The build and tests passing is not enough to prove retained functionality. Several behavior regressions are present but are not covered by the current tests.

## Executive Summary

The extraction plan was partially implemented, but the current branch does not fully preserve the behavior from `vps/self-hosted`.

The highest risk regressions are:

1. External stream proxying is broken when `VITE_API_URL` is empty, which is the self-hosted/default shape.
2. M3U parsing lost metadata used by channel grouping, EPG matching, logos, channel numbers, VOD, and series detection.
3. The extracted `Player` does not accept `onPlayCatchup`, even though it still calls it.
4. `AuthScreen` sends the Turnstile token under a different JSON field name than the baseline.
5. VAST tracker collection became async, but callers use it synchronously, so ad tracking can be dropped.
6. Current tests are too shallow around retained behavior, so these regressions pass unnoticed.

## Plan Conformity Review

### Auth Utilities

Plan intent:

- Move encryption helpers out of `App.jsx`.
- Add focused unit tests.
- Preserve local storage behavior and compatibility.

Current state:

- `streamvault/src/auth-utils.js` exists.
- The implementation extracts encryption helpers, but compatibility and migration behavior need deeper review.
- `_encKeySource` defaults to `null`, and `deriveKey` falls back to `"default"`.
- Tests do not yet prove that saved connections from the baseline still decrypt and behave correctly.

Required fixes:

- Add round-trip tests for M3U, Xtream, and Stalker saved connection objects.
- Add a migration compatibility test using a representative saved object from the old shape.
- Confirm whether stripped `pass` values must be restored after decrypting `_encPass`.

### AuthScreen Extraction

Plan intent:

- Extract login, register, forgot password, and guest mode into `AuthScreen`.
- Preserve API requests, Turnstile behavior, and error handling.

Current state:

- `streamvault/src/components/AuthScreen.jsx` exists.
- The component accepts `onAuth`, `onGuest`, and `api`.
- Request body field names changed from the baseline.

Baseline behavior:

- `App.jsx` sent `cf_turnstile_response` in login, register, and guest request JSON bodies.

Current behavior:

- `AuthScreen.jsx` sends `"cf-turnstile-response"`.

Risk:

- If the backend expects `cf_turnstile_response`, login, registration, or guest access can fail when Turnstile is enabled.

Required fixes:

- Restore the baseline field name: `cf_turnstile_response`.
- Add tests that assert the exact request body for login, register, guest, and forgot password.
- Add tests for Turnstile required and Turnstile disabled paths.

### TimelineGrid Extraction

Plan intent:

- Extract timeline rendering from `App.jsx`.
- Move reusable EPG helpers/constants.
- Preserve rendering, time-line behavior, catch-up indicators, and click behavior.

Current state:

- `streamvault/src/components/TimelineGrid.jsx` exists.
- Some text/icon characters appear corrupted after extraction.
- `useState(Date.now())` triggers React hook purity lint.

Observed regression:

- Baseline displayed a proper time range separator and catch-up icon.
- Current source shows replacement/corrupted characters in the timeline title and catch-up marker.

Required fixes:

- Restore the intended display characters, or use stable ASCII alternatives if the project wants ASCII-only source.
- Replace `useState(Date.now())` with a lazy initializer or an effect-safe value to satisfy lint.
- Add tests for:
  - live program rendering
  - time range title formatting
  - catch-up marker
  - now-line behavior
  - item click behavior
  - empty EPG fallback

### Player Extraction and Tests

Plan intent:

- Player was already extracted.
- Expand tests for HLS, audio tracks, subtitle tracks, VAST, and edge cases.

Current state:

- `streamvault/src/components/Player.jsx` imports several unused utilities.
- Top-level code references `current`, which only exists inside the component.
- The component uses `onPlayCatchup` but does not receive it as a prop.
- Stream proxy behavior changed by importing `streamProxy` from `utils.js`.

Required fixes:

- Add `onPlayCatchup` to the `Player` prop list.
- Remove top-level `current` dependent code from `Player.jsx`.
- Remove unused imports and duplicate logic.
- Restore the baseline proxy decision behavior.
- Add tests for:
  - HLS setup and cleanup
  - native playback fallback
  - subtitle track discovery and selection
  - audio track menu rendering
  - VAST empty response fallback to content
  - VAST media response playback before content
  - catch-up menu click calls `onPlayCatchup`
  - quick channel switching

## Critical Issues

### P0: Stream Proxy Is Broken In Self-Hosted Default Mode

File:

- `streamvault/src/utils.js`

Current implementation:

```js
export const streamProxy = (u) => (u?.startsWith('/') || u?.startsWith(API))
  ? u
  : `${API}/stream?url=${encodeURIComponent(u)}`;
```

Problem:

- `API` defaults to an empty string.
- In JavaScript, every string starts with `""`.
- Therefore, external URLs are treated as already local and are not proxied.

Baseline behavior:

```js
const origin = API || location.origin;
const streamProxy = (u) => (u?.startsWith('/') || u?.startsWith(origin))
  ? u
  : `${API}/stream?url=${encodeURIComponent(u)}`;
```

Impact:

- External IPTV streams can stop playing due to CORS, mixed content, provider restrictions, or missing backend proxy handling.
- This directly affects retained playback behavior.

Fix:

- Use `const origin = API || location.origin`.
- Compare against `origin`, not raw `API`.
- Preserve direct stream bypass behavior with `current?._direct`.
- Add unit tests for empty API, non-empty API, local path, same-origin URL, external URL, and direct streams.

### P0: M3U Parser Lost Required Metadata

File:

- `streamvault/src/utils.js`

Current behavior:

- Returns only `{ name, url }`.

Baseline behavior preserved:

- `logo`
- `group`
- `epgId`
- `num`
- `type`
- `id`
- playlist-level `epgUrl`

Impact:

- Logos disappear.
- Categories and groups break or collapse.
- EPG matching breaks.
- Channel number sorting can change.
- VOD and series classification from M3U URLs breaks.
- Auto EPG URL discovery breaks.

Fix:

- Restore the full baseline parser behavior.
- Add tests for:
  - `url-tvg` and `x-tvg-url`
  - `tvg-logo`
  - `group-title`
  - `tvg-id`
  - `tvg-chno`
  - live, movie, and series URL classification
  - default group and default name behavior

### P0: Player Catch-Up Callback Is Not Wired

File:

- `streamvault/src/components/Player.jsx`

Problem:

- `App.jsx` passes `onPlayCatchup={playCatchup}`.
- `Player.jsx` does not destructure `onPlayCatchup`.
- `Player.jsx` still calls `onPlayCatchup(...)`.

Impact:

- Clicking catch-up entries in the player can throw a runtime `ReferenceError`.
- Catch-up playback from the player menu is not retained.

Fix:

- Add `onPlayCatchup` to the Player props.
- Add a regression test that opens catch-up choices and verifies the callback receives the selected item.

### P1: AuthScreen Turnstile Field Name Changed

File:

- `streamvault/src/components/AuthScreen.jsx`

Problem:

- Baseline used `cf_turnstile_response`.
- Current branch uses `"cf-turnstile-response"`.

Impact:

- Auth can fail when the backend validates Turnstile under the original field name.

Fix:

- Restore `cf_turnstile_response`.
- Add request body tests.

### P1: VAST Trackers Can Be Dropped

File:

- `streamvault/src/vast.js`

Problem:

- `collectVastTrackers` is declared `async`.
- `parseVastDocument` calls it without `await`.
- Tracker merging receives a Promise instead of the tracker object.

Impact:

- Impression, start, quartile, complete, click, error, and skip trackers can be missed.
- Ads may appear to load, but reporting to the ad network is incorrect.

Fix:

- Make `collectVastTrackers` synchronous if it does not perform async work.
- Or update all callers to `await` it.
- Add tests for inline ads, wrapper inheritance, no-ad VAST, and tracker merge behavior.

### P1: Player Contains Invalid Top-Level Runtime Logic

File:

- `streamvault/src/components/Player.jsx`

Problem:

- Top-level code references `current`, which is component-local state.
- Lint reports `current` as undefined.
- There are duplicate proxy helper declarations.

Impact:

- The source is fragile and currently only passes build because the top-level helper is not exercised in a way that crashes immediately.
- It blocks lint and increases risk in future edits.

Fix:

- Remove the top-level helper block.
- Keep proxy decisions inside the component or move them into a tested utility that receives all required values explicitly.

### P1: Encoding Corruption In Extracted UI

Files:

- `streamvault/src/components/TimelineGrid.jsx`
- `streamvault/tests/Player.test.jsx`

Problem:

- Extracted source/tests contain garbled strings such as replacement characters for UI symbols.

Impact:

- UI quality regresses.
- Tests can begin asserting corrupted output instead of intended output.

Fix:

- Restore intended characters using valid UTF-8, or replace with ASCII-safe strings/icons.
- Update tests to assert intended user-visible text, not corrupted text.

### P2: Test Script Is Missing

File:

- `streamvault/package.json`

Problem:

- Vitest is configured and tests pass through `npx vitest run`, but there is no project `test` script.

Fix:

- Add:

```json
"test": "vitest run"
```

Optional:

```json
"test:watch": "vitest"
```

### P2: Lint Failures Hide Real Regressions

Files:

- `streamvault/src/App.jsx`
- `streamvault/src/components/Player.jsx`
- `streamvault/src/components/AuthScreen.jsx`
- `streamvault/src/components/TimelineGrid.jsx`
- test files

Problem:

- There are 82 lint problems.
- Some are style issues, but several are real behavior risks.

Fix:

- Prioritize extraction-related lint failures first.
- Then decide separately whether to clean pre-existing broad App lint debt.

## Retained Functionality Checklist

Use this checklist before merging the extraction branch.

### Auth and Account Flows

- Login still works.
- Registration still works.
- Forgot password still works.
- Guest login still works.
- Guest ID is still persisted and reused.
- Turnstile required path still works.
- Turnstile disabled path still works.
- Auth errors display the same kind of user-facing feedback.
- Token/session behavior remains unchanged.

### Connection Management

- M3U connection creation still works.
- Xtream connection creation still works.
- Stalker connection creation still works.
- Saved connections still load.
- Encrypted saved connection passwords still decrypt.
- Existing saved data from before extraction remains compatible.
- Sync still uploads and downloads connection state.

### M3U Behavior

- `#EXTM3U url-tvg` and `x-tvg-url` are still detected.
- Channel name parsing still works.
- `tvg-logo` still populates channel logos.
- `group-title` still populates categories.
- `tvg-id` still supports EPG matching.
- `tvg-chno` still supports channel numbering.
- Live, VOD, and series detection still works.

### Xtream Behavior

- Live categories still load.
- VOD categories still load.
- Series categories still load.
- Live streams still play.
- VOD streams still play.
- Series episodes still play.
- Direct or proxied URL handling remains unchanged from baseline.

### Stalker Behavior

- Portal validation still works.
- Live channel loading still works.
- VOD loading still works.
- Series loading still works.
- Catch-up discovery still works.
- Catch-up playback still works.

### Player Behavior

- HLS playback still works.
- Native playback fallback still works.
- Stream proxying still matches baseline behavior.
- Direct stream bypass still works.
- VAST empty response falls back to content playback.
- VAST filled response plays ad before content.
- VAST tracking pings still fire.
- Subtitle tracks appear when available.
- Multi-language audio tracks appear when available.
- Favorite toggle still works.
- Quick channel navigation still works.
- Picture-in-picture still works where supported.
- Playback stats/debug behavior remains unchanged.
- Player close behavior remains unchanged.

### EPG and Timeline

- EPG XML loading still works.
- EPG matching still works by channel ID/name fallback.
- Current program display still works.
- Timeline grid still renders programs.
- Timeline now-line still updates.
- Timeline catch-up markers still display.
- Timeline item clicks still play the expected content.

### App-Level Features

- Search still works.
- Category filtering still works.
- Favorites still work.
- Continue watching/history still works.
- Theme selection still works.
- Language/i18n selection still works.
- Analytics tracking still works.

## Fix Sequence

### Phase 1: Restore Runtime Parity

1. Restore `streamProxy` parity with baseline behavior.
2. Restore full `parseM3U` metadata parsing.
3. Add `onPlayCatchup` to `Player` props.
4. Restore `cf_turnstile_response` in `AuthScreen`.
5. Fix VAST tracker collection to be synchronous or fully awaited.
6. Remove invalid top-level Player proxy logic and unused imports introduced by extraction.
7. Restore corrupted UI strings/icons in extracted components and tests.

Exit criteria:

- Existing build still passes.
- A targeted regression test fails before each fix and passes after it.

### Phase 2: Complete Extraction Cleanup

1. Ensure `App.jsx` imports only utilities and components it actually uses.
2. Keep API base URL ownership consistent, preferably through one `API` export.
3. Ensure extracted components do not duplicate old inline logic unless necessary.
4. Move EPG/timeline helper constants into `epg.js` only if they are reused and tested.
5. Confirm no generated `dist` files or local DB artifacts are part of the source change unless intentionally required.

Exit criteria:

- Extraction-related lint failures are resolved.
- Component boundaries match the approved design.

### Phase 3: Strengthen Tests

Add or update tests in these areas:

- `streamvault/tests/utils.test.js`
  - full M3U metadata
  - stream proxy behavior with empty and non-empty API
  - same-origin and external URLs

- `streamvault/tests/AuthScreen.test.jsx`
  - login request body
  - register request body
  - guest request body
  - forgot password request body
  - Turnstile enabled and disabled paths
  - error rendering

- `streamvault/tests/Player.test.jsx`
  - `onPlayCatchup` callback
  - VAST no-fill fallback
  - VAST filled ad playback
  - tracker pinging
  - subtitle menu rendering
  - audio track menu rendering
  - HLS cleanup

- `streamvault/tests/TimelineGrid.test.jsx`
  - program rendering
  - catch-up marker
  - click behavior
  - empty state
  - now-line behavior with fake timers

- `streamvault/tests/vast.test.js`
  - inline trackers
  - wrapper tracker inheritance
  - empty VAST
  - media file selection

Exit criteria:

- `npm run test` exists and passes.
- Tests cover the regressions identified in this review.

### Phase 4: Verification

Run:

```bash
npm run build
npm run test
npm run lint
```

Manual smoke tests:

- Login, register, forgot password, guest.
- M3U playlist with logo, group, EPG ID, channel number, VOD, and series entries.
- Xtream live, VOD, and series playback.
- Stalker live and catch-up playback.
- HLS playback with subtitles and multiple audio tracks.
- VAST empty response and filled ad response.
- EPG timeline rendering and item click.
- Favorites, history, search, category filtering, theme, and language selection.

Exit criteria:

- Build passes.
- Tests pass.
- Lint passes or only documented pre-existing warnings remain.
- Manual smoke confirms retained behavior from `vps/self-hosted`.

## Possible Improvements After Parity

These should be done after retained functionality is restored, not before.

1. Add Playwright smoke coverage for guest login, stream selection, subtitle menu, and timeline click.
2. Add a small fixture library for M3U, VAST, EPG XML, Xtream, and Stalker responses.
3. Split large Player behavior into smaller hooks only after current behavior is pinned by tests.
4. Centralize URL/proxy decisions in one tested module.
5. Add CI steps for build, unit tests, and lint.
6. Consider TypeScript or JSDoc types for channel, program, connection, and VAST structures.
7. Keep generated `dist` output out of normal feature branches unless deployment requires it.

## Merge Readiness Gate

Do not merge the extraction branch until these are true:

- `parseM3U` preserves all baseline metadata.
- `streamProxy` behaves correctly when `API` is empty.
- Player catch-up callback is wired and tested.
- Auth Turnstile field name matches backend expectations.
- VAST tracker merging is fixed and tested.
- Extraction-related lint failures are resolved.
- The retained functionality checklist has been manually smoke tested.

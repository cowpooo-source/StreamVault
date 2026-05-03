# Component Extraction and Testing Design

**Date:** 2026-05-03
**Status:** Approved
**Scope:** Extract AuthScreen and TimelineGrid from App.jsx, create auth-utils.js, expand test coverage

## Overview

The StreamVault frontend has a monolithic `App.jsx` (5000+ lines). Player.jsx was already extracted. This design covers extracting the remaining two major components (AuthScreen, TimelineGrid), moving encryption utilities to a dedicated module, and writing shallow integration tests for all three components.

## Section 1: AuthScreen Extraction

Extract `AuthScreen` (App.jsx lines 127-333) into `src/components/AuthScreen.jsx`.

**Props:**
- `onAuth(user)` — called on successful login/register
- `onGuest()` — called when user continues as guest

**Internal State (unchanged):**
- `mode` — "login", "register", or "forgot"
- `username`, `password`, `showPassword`, `emailInput`
- `loading`, `err`, `msg`, `forceLogin`

**Internal Refs:**
- `formRef` — form element reference
- `turnstileContainerRef` — Cloudflare Turnstile widget container

**Dependencies:**
- Uses global `API` variable (defined in App.jsx)
- `import.meta.env.VITE_TURNSTILE_SITE_KEY` for Turnstile site key
- `window.turnstile` for CAPTCHA rendering

**Files:**
- Created: `src/components/AuthScreen.jsx`
- Modified: `src/App.jsx` — remove lines 127-333, add import

## Section 2: auth-utils.js

Create `src/auth-utils.js` with encryption functions from App.jsx lines 335-374.

**Exports:**
- `setEncKeySource(id)` — updates the encryption key source (called from App.jsx on login)
- `deriveKey()` — returns CryptoKey from SHA-256 hash of key source + ":sv-enc-key"
- `encryptData(plaintext)` — AES-GCM encrypt, returns "iv.base64.data.base64"
- `decryptData(ciphertext)` — AES-GCM decrypt, returns plaintext or original if invalid
- `encryptConnections(conns)` — strips credentials, encrypts connection list
- `decryptConnections(data)` — decrypts back to connection list

**Internal:**
- `ENC_ALGO = "AES-GCM"`
- `_encKeySource` — module-level variable, default `GUEST_ID`

**Files:**
- Created: `src/auth-utils.js`
- Modified: `src/App.jsx` — remove lines 335-374, import from auth-utils.js

## Section 3: TimelineGrid Extraction

Extract `TimelineGrid` (App.jsx lines 2311-2415) into `src/components/TimelineGrid.jsx`.

**Props (unchanged):**
- `channels` — array of channel objects
- `epgData` — EPG data keyed by channel epgId
- `onPlay(channel)` — called when channel is clicked
- `onPlayCatchup(channel, program)` — called when past program is clicked
- `ref` — forwarded ref via `memo(React.forwardRef(...))`

**Move to `src/epg.js`:**
- Constants: `P_X_PER_MIN`, `TOTAL_HOURS`, `TOTAL_MS`, `TOTAL_PX`, `CH_COL_W`, `ROW_H`
- Helpers: `msToPx(ms, windowStart)`, `fmtT(ms)`

**Keep in TimelineGrid.jsx:**
- State: `nowMs`, timer effect (updates every 60s)
- `timeLabels` memo (time label generation every 30 min)
- `windowStart`, `windowEnd` memos
- All JSX: time header, channel column, program area, now-line

**Imports:**
- React: `useMemo`, `useState`, `useEffect`, `memo`, `forwardRef`
- `imgSrc` from `utils.js`
- `epgLookup` from `epg.js`
- Constants/helpers from `epg.js`

**Files:**
- Created: `src/components/TimelineGrid.jsx`
- Modified: `src/App.jsx` — remove lines 2311-2415, add import
- Modified: `src/epg.js` — add constants and helpers

## Section 4: Testing

### Test Configuration

**Turnstile Test Keys:**
- `VITE_TURNSTILE_SITE_KEY=1x00000000000000000000AA`
- `TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA`

These keys always pass in test mode.

**Test Infrastructure (existing):**
- `vitest.config.js` — jsdom environment, globals: true, setupFiles: `./tests/setup.js`
- `tests/setup.js` — mocks fetch, localStorage, crypto.randomUUID

### AuthScreen.test.jsx

**Mocks:**
- `window.turnstile = { render: vi.fn(), reset: vi.fn() }`
- `fetch` (global mock in setup.js, overridden per test)

**Tests:**
1. Renders login form by default
2. Switches to register tab, shows email field
3. Switches to forgot password, shows email form
4. Shows/hides password on button click
5. Login success calls `onAuth` with user data
6. Login failure shows error message
7. Register flow sends email in body
8. Forgot password sends email, shows message
9. Guest login calls `onGuest`
10. Force login checkbox toggles, shows confirm dialog on max logins
11. Turnstile re-renders on mode change

### TimelineGrid.test.jsx

**Mocks:**
- `imgSrc` from `utils.js` → returns URL string
- `epgLookup` from `epg.js` → returns sample program array

**Tests:**
1. Renders with empty channels (no rows)
2. Renders with sample channels (shows channel names/logos)
3. Renders with EPG data (shows program blocks)
4. Clicking channel calls `onPlay`
5. Clicking past program calls `onPlayCatchup`
6. Time labels render at 30-min intervals
7. Now-line appears at correct position

### Player.test.jsx (Expand)

**Mocks:**
- `window.Hls = { isSupported: vi.fn(() => false) }`
- `window.mpegts = { isSupported: vi.fn(() => false), createPlayer: vi.fn(), Events: {} }`
- `video.play`, `video.pause`, `video.requestFullscreen`, `document.exitPictureInPicture`
- `fetchVastAd`, `parseVastDocument` from `vast.js`
- `getEPGNow` from `epg.js`

**Tests (keep existing + add):**
1. Renders without crashing (existing)
2. Shows OSD with channel name and logo
3. Escape key calls `onClose`
4. Space key toggles play/pause
5. 'S' key toggles stats overlay
6. 'F' key toggles fullscreen
7. Audio track menu opens/closes, track selection
8. Subtitle track menu opens/closes, track selection
9. Catchup menu renders with past programs
10. Channel navigation (prev/next) when channelList provided

## Section 5: File Change Summary

**Created:**
1. `src/components/AuthScreen.jsx`
2. `tests/AuthScreen.test.jsx`
3. `src/auth-utils.js`
4. `src/components/TimelineGrid.jsx`
5. `tests/TimelineGrid.test.jsx`
6. Update `tests/Player.test.jsx`

**Modified:**
1. `src/App.jsx` — remove AuthScreen (lines 127-333), remove encryption functions (lines 335-374), remove TimelineGrid (lines 2311-2415), add imports
2. `src/epg.js` — add TimelineGrid constants and helpers

## Success Criteria

1. All existing tests pass (28 utility/VAST tests + 82 backend tests)
2. New tests: ~28 AuthScreen + ~7 TimelineGrid + ~10 expanded Player = ~45 new tests
3. Build succeeds with no regressions (`npm run build`)
4. Extracted components behave identically to inline versions
5. No functionality lost in App.jsx after removals

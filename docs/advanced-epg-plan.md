# Advanced EPG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Track progress with checkbox (`- [ ]`) steps.

**Goal:** Keep EPG sources available across connection switches, prevent duplicate/overlapping programs when merging guides, and add small usability improvements without regressing TV Guide performance.

**Architecture:** Treat EPG sources as session-scoped data with metadata so the UI can distinguish XMLTV sources from portal-derived sources and merge them safely. Keep channel filtering and guide rendering inside the existing React flow, but make the search input deferred and the merged EPG output deterministic. Add the time-left label in the player overlay first, then optionally mirror the same calculation in the guide UI where there is enough space.

**Tech Stack:** React, existing `App.jsx` state, `TimelineGrid.jsx`, `Player.jsx`, `useDeferredValue`, current EPG parsing helpers in `epg.js`.

---

### Task 1: Preserve EPG sources across connection switches

**Files:**
- Modify: `streamvault/src/App.jsx:2416-2450`
- Modify: `streamvault/src/App.jsx:3366-3375`

- [ ] **Step 1: Update the state reset rules**

Remove the unconditional `setEpgSources([])` from the `useEffect([activeConnId])` block. Keep the token invalidation so in-flight loads cannot overwrite newer data.

```jsx
useEffect(() => {
  epgLoadToken.current++; // invalidate stale loads
  setActiveEpgSource("all");
}, [activeConnId]);
```

- [ ] **Step 2: Update manual connection switching**

Stop clearing EPG sources in `switchConnection(id)`. Continue clearing live content, VOD, series, and Stalker category caches because those are connection-specific, but preserve EPG sources for the current session.

```jsx
function switchConnection(id) {
  if (id === activeConnId) { setShowConnManager(false); return; }
  const target = connections.find(c => c.id === id);
  if (!target) return;
  setShowConnManager(false);
  epgLoadToken.current++;
  setChannels([]);
  setVod([]);
  setSeries([]);
  setActiveEpgSource("all");
  setStalkerVodCats([]);
  setStalkerSeriesCats([]);

  fetchingCatRef.current.clear();
  setPrefetchProgress(null);
  setPlaying(null);
  setCat("All");
  setConn(target.config);
  setActiveConnId(id);
  db.set("sv-activeConn", id);
}
```

- [ ] **Step 3: Keep invalidation behavior on reconnect**

Verify that reconnect paths still increment `epgLoadToken.current` before any new EPG fetch starts, so old responses do not append stale sources.

- [ ] **Step 4: Validate session persistence**

Confirm the TV Guide still shows XMLTV sources loaded earlier in the session after switching between Xtream and Stalker connections.

---

### Task 2: Make merged EPG output deterministic and deduplicated

**Files:**
- Modify: `streamvault/src/App.jsx:2423-2437`
- Modify: `streamvault/src/epg.js:28-35`

- [ ] **Step 1: Define a stable source shape**

Add metadata to each source object so merge logic can reason about provenance.

```jsx
const newSource = {
  id,
  label: label || new URL(url).hostname,
  kind: "xmltv",
  sourceKey: id,
  connectionId: activeConnId,
  data,
};
```

For Stalker loads:

```jsx
const newSource = {
  id,
  label,
  kind: "stalker",
  sourceKey: id,
  connectionId: activeConnId,
  data: data.programs,
};
```

- [ ] **Step 2: Replace first-source-wins merging**

The current `All` path only keeps the first channel entry it sees. Replace it with deterministic merge logic that:

1. Groups by channel key.
2. Sorts each channel’s programs by `start`.
3. Removes exact duplicates.
4. Removes overlapping duplicates only when title and time window are effectively the same.
5. Preserves legitimately different overlapping blocks when the provider data differs.

```jsx
function mergeProgramsByChannel(sources) {
  const merged = {};

  for (const source of sources) {
    if (!source?.data) continue;
    for (const [chId, progs] of Object.entries(source.data)) {
      if (!merged[chId]) merged[chId] = [];
      merged[chId].push(...progs);
    }
  }

  for (const [chId, progs] of Object.entries(merged)) {
    const sorted = [...progs].sort((a, b) => a.start - b.start || a.stop - b.stop || a.title.localeCompare(b.title));
    const deduped = [];

    for (const p of sorted) {
      const last = deduped[deduped.length - 1];
      if (
        last &&
        Math.abs(last.start - p.start) < 60000 &&
        Math.abs(last.stop - p.stop) < 60000 &&
        (last.title || "").trim().toLowerCase() === (p.title || "").trim().toLowerCase()
      ) {
        continue;
      }
      deduped.push(p);
    }

    merged[chId] = deduped;
  }

  return merged;
}
```

- [ ] **Step 3: Keep non-overlapping channels fast**

Do not normalize every source on every render if the source list has not changed. Keep the `useMemo`, but make its output deterministic so the guide does not flicker or render duplicated blocks.

- [ ] **Step 4: Validate guide rendering**

Verify that `TimelineGrid.jsx` receives one program list per channel and no longer renders stacked duplicates when `All` is selected.

---

### Task 3: Optimize TV Guide search with deferred input

**Files:**
- Modify: `streamvault/src/App.jsx:4700-4788`

- [ ] **Step 1: Use deferred search text**

The search input already filters channels, so this task is not wiring it up from scratch. Update the filter to use a deferred value so large channel lists do not lag while the user types.

```jsx
const deferredSearch = useDeferredValue(search);

const filteredChannels = useMemo(() => {
  let chs = channels;
  const q = deferredSearch.trim().toLowerCase();
  if (q) {
    chs = chs.filter(ch => ch.name?.toLowerCase().includes(q));
  }
  return chs.slice(0, MAX_CHANNELS);
}, [channels, deferredSearch]);
```

- [ ] **Step 2: Keep analytics unchanged**

Leave the existing EPG interaction analytics in place. The optimization should not change event names or event cadence.

- [ ] **Step 3: Validate typing performance**

Confirm the guide stays responsive when filtering a large channel list and that clearing the search restores the full visible set.

---

### Task 4: Add a time-left indicator for current programs

**Files:**
- Modify: `streamvault/src/components/Player.jsx:671-690`
- Modify: `streamvault/src/components/TimelineGrid.jsx:74-90`

- [ ] **Step 1: Add the calculation in the player overlay**

Use the current EPG block returned by `getEPGNow` and show remaining minutes for the active program.

```jsx
const minutesLeft = epgNow
  ? Math.max(0, Math.ceil((epgNow.stop - Date.now()) / 60000))
  : null;
```

Render it near the existing program title in the OSD.

```jsx
{epgNow && (
  <div className="osd-epg">
    ▶ {epgNow.title}
    {minutesLeft !== null && <span className="osd-epg-left"> · {minutesLeft} min left</span>}
  </div>
)}
```

- [ ] **Step 2: Surface the same data in the guide where space exists**

In `TimelineGrid.jsx`, add the label only for blocks that are currently live and wide enough to fit it.

```jsx
const minutesLeft = isNow ? Math.max(0, Math.ceil((p.stop - nowMs) / 60000)) : null;

{widthPx > 140 && minutesLeft !== null && (
  <div className="epg-prog-l">{minutesLeft} min left</div>
)}
```

- [ ] **Step 3: Verify catch-up behavior is unchanged**

Past programs should still use the existing catch-up click path and should not display a remaining-time label.

---

### Task 5: Verify current EPG routes still load correctly

**Files:**
- Review: `stalker-proxy/src/routes/stalker.js:189-205`
- Review: `streamvault-worker/src/handlers/stalker.js:300-321`

- [ ] **Step 1: Confirm Stalker EPG responses stay compatible**

Check that the worker and proxy still return `programs` in the same shape consumed by `loadStalkerEPG()`.

- [ ] **Step 2: Confirm XMLTV parsing still produces channel-keyed arrays**

`parseXMLTV()` should continue returning `{ [channelId]: [{ title, start, stop }] }` so the merge logic can work without a format migration.

- [ ] **Step 3: Run manual verification**

Test these flows:

```bash
npm run build
```

Expected: build succeeds.

Then manually verify:

1. Load XMLTV EPG.
2. Switch from Live TV to Movies and back.
3. Open TV Guide and switch `Source` between `All` and a specific source.
4. Type in the guide search box and confirm the UI stays responsive.
5. Open the player and confirm the live program shows remaining minutes.

---

## Acceptance Criteria

- EPG sources loaded earlier in the session remain available after switching connections.
- `All` no longer produces overlapping duplicate blocks for the same channel and time window.
- TV Guide search uses deferred input and stays responsive on large channel lists.
- The player shows a clear remaining-time indicator for the current live program.
- Stalker and XMLTV EPG data still load through the existing code paths.

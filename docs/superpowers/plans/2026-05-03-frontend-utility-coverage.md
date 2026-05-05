# Enhance Frontend Utility Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Increase test coverage for `streamvault/src/vast.js` and `streamvault/src/epg.js` to over 80%.

**Architecture:** Use Vitest for unit testing. Mock global DOM and fetch where necessary. Follow TDD for adding missing coverage.

**Tech Stack:** Vitest, jsdom.

---

### Task 1: Test `epg.js` Utility Functions

**Files:**
- Modify: `streamvault/tests/epg-timeline.test.js`

- [ ] **Step 1: Write failing tests for `getEPGNow`, `epgLookup`, and `parseEPGDate`**

```javascript
import { getEPGNow, epgLookup, parseEPGDate } from "../src/epg.js";

describe("getEPGNow", () => {
  it("should return correct program for current time", () => {
    const now = Date.now();
    const programs = {
      "ch1": [
        { start: now - 1000, stop: now + 1000, title: "Current" },
        { start: now + 1000, stop: now + 2000, title: "Next" }
      ]
    };
    expect(getEPGNow(programs, "ch1")).toEqual(programs.ch1[0]);
  });

  it("should handle normalized epgId", () => {
    const now = Date.now();
    const programs = {
      "ch1": [{ start: now - 1000, stop: now + 1000, title: "Current" }]
    };
    expect(getEPGNow(programs, "  CH1  ")).toEqual(programs.ch1[0]);
  });

  it("should return null if no program found", () => {
    const now = Date.now();
    const programs = {
      "ch1": [{ start: now + 1000, stop: now + 2000, title: "Next" }]
    };
    expect(getEPGNow(programs, "ch1")).toBeNull();
  });
});

describe("epgLookup", () => {
  const epgData = { "ch.123": [{ title: "Program" }] };
  it("should find by normalized epgId", () => {
    expect(epgLookup(epgData, { epgId: "  CH.123  " })).toBe(epgData["ch.123"]);
  });
  it("should find by raw epgId", () => {
    expect(epgLookup(epgData, { epgId: "ch.123" })).toBe(epgData["ch.123"]);
  });
  it("should find by id", () => {
    const data = { "123": [{ title: "Prog" }] };
    expect(epgLookup(data, { id: "123" })).toBe(data["123"]);
  });
});

describe("parseEPGDate", () => {
  it("should parse ISO date", () => {
    const s = "2026-05-03T14:30:00Z";
    expect(parseEPGDate(s)).toBe(new Date(s).getTime());
  });
  it("should parse XMLTV date format YYYYMMDDHHmmss", () => {
    const s = "20260503143000";
    const expected = new Date(2026, 4, 3, 14, 30, 0).getTime();
    expect(parseEPGDate(s)).toBe(expected);
  });
  it("should return 0 for invalid date", () => {
    expect(parseEPGDate("invalid")).toBe(0);
    expect(parseEPGDate(null)).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail/pass**

Run: `npx vitest run tests/epg-timeline.test.js`
Expected: PASS (Wait, these should pass because the implementation exists. We are just adding coverage).

- [ ] **Step 3: Commit coverage for epg.js**

```bash
git add streamvault/tests/epg-timeline.test.js
git commit -m "test: add coverage for epg.js utilities"
```

---

### Task 2: Test `vast.js` `parseVastDocument` with InLine Ad

**Files:**
- Modify: `streamvault/tests/vast.test.js`

- [ ] **Step 1: Add comprehensive test for InLine ad parsing**

```javascript
import { parseVastTime } from "../src/utils.js";

describe("parseVastTime", () => {
  it("should parse HH:MM:SS format", () => {
    expect(parseVastTime("00:00:10")).toBe(10);
    expect(parseVastTime("01:02:03")).toBe(3600 + 120 + 3);
  });
  it("should parse MM:SS format", () => {
    expect(parseVastTime("02:03")).toBe(123);
  });
  it("should parse seconds as number", () => {
    expect(parseVastTime("15")).toBe(15);
  });
  it("should return 0 for invalid", () => {
    expect(parseVastTime(null)).toBe(0);
    expect(parseVastTime("abc")).toBe(0);
  });
});

describe("parseVastDocument InLine", () => {
  it("should parse a basic InLine ad", () => {
    const xml = `
      <VAST version="3.0">
        <Ad>
          <InLine>
            <AdTitle>Test Ad</AdTitle>
            <Impression>http://example.com/imp</Impression>
            <Creatives>
              <Creative>
                <Linear skipoffset="00:00:05">
                  <Duration>00:00:30</Duration>
                  <VideoClicks>
                    <ClickThrough>http://example.com/click</ClickThrough>
                  </VideoClicks>
                  <MediaFiles>
                    <MediaFile type="video/mp4">http://example.com/video.mp4</MediaFile>
                  </MediaFiles>
                </Linear>
              </Creative>
            </Creatives>
          </InLine>
        </Ad>
      </VAST>
    `;
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const result = parseVastDocument(doc, "http://base.com/vast.xml", null, 0, {});
    
    expect(result.title).toBe("Test Ad");
    expect(result.mediaUrl).toBe("http://example.com/video.mp4");
    expect(result.duration).toBe(30);
    expect(result.skipOffset).toBe(5);
    expect(result.trackers.impression).toContain("http://example.com/imp");
  });

  it("should return null if no media files", () => {
     const xml = `<VAST><Ad><InLine><Linear><MediaFiles></MediaFiles></Linear></InLine></Ad></VAST>`;
     const doc = new DOMParser().parseFromString(xml, "application/xml");
     expect(parseVastDocument(doc, "url", null, 0, {})).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/vast.test.js`
Expected: PASS

---

### Task 3: Test `vast.js` `fetchVastAd` and Wrapper logic

**Files:**
- Modify: `streamvault/tests/vast.test.js`

- [ ] **Step 1: Mock fetch and test Wrapper traversal**

```javascript
import { vi } from "vitest";
import * as utils from "../src/utils.js";

describe("fetchVastAd and Wrapper", () => {
  it("should follow Wrappers", async () => {
    const wrapperXml = `
      <VAST>
        <Ad>
          <Wrapper>
            <VASTAdTagURI>http://example.com/inline.xml</VASTAdTagURI>
          </Wrapper>
        </Ad>
      </VAST>
    `;
    const inlineXml = `
      <VAST>
        <Ad>
          <InLine>
            <Linear>
              <MediaFiles><MediaFile>http://example.com/video.mp4</MediaFile></MediaFiles>
            </Linear>
          </InLine>
        </Ad>
      </VAST>
    `;

    vi.spyOn(utils, "fetchTextWithTimeout").mockImplementation(async (url) => {
      if (url.includes("wrapper")) return wrapperXml;
      if (url.includes("inline")) return inlineXml;
      return null;
    });

    const result = await fetchVastAd("http://example.com/wrapper.xml", null);
    expect(result.mediaUrl).toBe("http://example.com/video.mp4");
  });
});
```

- [ ] **Step 2: Run tests and check final coverage**

Run: `npx vitest run --coverage`
Expected: `epg.js` and `vast.js` > 80%

---

### Task 4: Cleanup

- [ ] **Step 1: Remove any temporary files and verify all tests pass**

Run: `npx vitest run`
Expected: All 76+ tests pass.

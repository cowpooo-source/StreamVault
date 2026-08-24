import { describeStalkerCatalogLoading, loadInitialStalkerCatalog, shouldUseGlobalCatalogLoader } from "../src/stalker-catalog-loading.js";

describe("loadInitialStalkerCatalog", () => {
  it("loads channels, VOD, and series in order", async () => {
    const calls = [];

    await loadInitialStalkerCatalog({
      loadChannels: async () => calls.push("channels"),
      loadVod: async () => calls.push("vod"),
      loadSeries: async () => calls.push("series"),
    });

    expect(calls).toEqual(["channels", "vod", "series"]);
  });

  it("stops before the next catalog when the connection is cancelled", async () => {
    const calls = [];
    let cancelled = false;

    await loadInitialStalkerCatalog({
      loadChannels: async () => {
        calls.push("channels");
        cancelled = true;
      },
      loadVod: async () => calls.push("vod"),
      loadSeries: async () => calls.push("series"),
      isCancelled: () => cancelled,
    });

    expect(calls).toEqual(["channels"]);
  });
});

describe("describeStalkerCatalogLoading", () => {
  it("labels shared live snapshot preparation distinctly", () => {
    expect(describeStalkerCatalogLoading({
      kind: "live",
      capabilities: { mode: "bounded_live_snapshot" },
    })).toBe("Preparing live catalog for this provider");
  });
});

describe("shouldUseGlobalCatalogLoader", () => {
  it("keeps the category rail mounted while lazy VOD or series items load", () => {
    expect(shouldUseGlobalCatalogLoader({ lazyCatalogEnabled: true, kind: "vod" })).toBe(false);
    expect(shouldUseGlobalCatalogLoader({ lazyCatalogEnabled: true, kind: "series" })).toBe(false);
  });

  it("preserves the global loader for non-lazy catalog flows", () => {
    expect(shouldUseGlobalCatalogLoader({ lazyCatalogEnabled: false, kind: "vod" })).toBe(true);
    expect(shouldUseGlobalCatalogLoader({ lazyCatalogEnabled: true, kind: "live" })).toBe(true);
  });
});

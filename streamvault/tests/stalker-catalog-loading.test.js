import { describeStalkerCatalogLoading, loadInitialStalkerCatalog, shouldUseGlobalCatalogLoader } from "../src/stalker-catalog-loading.js";

describe("loadInitialStalkerCatalog", () => {
  it("does not load VOD or Series item pages during connection activation", async () => {
    const calls = [];

    await loadInitialStalkerCatalog({
      loadLive: async () => calls.push("live-items"),
      loadVodCategories: async () => calls.push("vod-categories"),
      loadSeriesCategories: async () => calls.push("series-categories"),
    });

    expect(calls).toEqual(["live-items", "vod-categories", "series-categories"]);
  });

  it("stops before the next catalog when the connection is cancelled", async () => {
    const calls = [];
    let cancelled = false;

    await loadInitialStalkerCatalog({
      loadLive: async () => {
        calls.push("live-items");
        cancelled = true;
      },
      loadVodCategories: async () => calls.push("vod-categories"),
      loadSeriesCategories: async () => calls.push("series-categories"),
      isCancelled: () => cancelled,
    });

    expect(calls).toEqual(["live-items"]);
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
    expect(shouldUseGlobalCatalogLoader({ lazyCatalogEnabled: true, kind: "live" })).toBe(false);
  });
});

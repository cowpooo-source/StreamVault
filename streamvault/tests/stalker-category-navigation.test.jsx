import { describe, expect, it } from "vitest";
import {
  createStalkerCatalogPageRequest,
  setSelectedStalkerCategory,
} from "../src/stalker-category-navigation.js";

describe("Stalker lazy category navigation", () => {
  it("keeps duplicate category titles distinct by ID", () => {
    const selected = setSelectedStalkerCategory(
      { live: null, vod: null, series: null },
      "vod",
      { id: "20", title: "Movies" },
    );

    const request = createStalkerCatalogPageRequest({
      kind: "vod",
      selected: selected.vod,
      page: 2,
      pageSize: 100,
      contentToken: "content-token",
    });

    expect(request).toMatchObject({
      kind: "vod",
      category: "20",
      page: 2,
      pageSize: 100,
    });
  });

  it("does not create a pagination request without a selected category", () => {
    expect(createStalkerCatalogPageRequest({
      kind: "series",
      selected: null,
      page: 2,
      pageSize: 100,
      contentToken: "content-token",
    })).toBeNull();
  });
});

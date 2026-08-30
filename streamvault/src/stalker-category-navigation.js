const CATEGORY_KINDS = new Set(["live", "vod", "series"]);

export function setSelectedStalkerCategory(selection, kind, category) {
  if (!CATEGORY_KINDS.has(kind)) return selection;

  const id = String(category?.id ?? "").trim();
  if (!id) return selection;

  return {
    ...selection,
    [kind]: {
      id,
      title: String(category?.title ?? category?.name ?? "Other").trim() || "Other",
    },
  };
}

export function createStalkerCatalogPageRequest({
  kind,
  selected,
  page,
  pageSize,
  contentToken,
} = {}) {
  const category = String(selected?.id ?? "").trim();
  if (!CATEGORY_KINDS.has(kind) || !category) return null;

  return {
    kind,
    category,
    page,
    pageSize,
    contentToken,
  };
}

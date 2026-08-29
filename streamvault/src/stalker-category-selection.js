export function normalizeStalkerCategory(category = {}) {
  const rawId = String(category.id ?? category.category_id ?? '').trim();
  const title = String(category.title ?? category.name ?? 'Other').trim();
  const aggregate = rawId === '*' || rawId.toLowerCase() === 'all' || title.toLowerCase() === 'all';
  const rawCount = category.count;
  const numericCount = rawCount === null || rawCount === undefined || rawCount === ''
    ? null
    : Number(rawCount);

  return {
    id: aggregate ? 'all' : rawId,
    title: aggregate ? 'All' : title,
    count: Number.isFinite(numericCount) ? numericCount : null,
    aggregate,
  };
}

export function firstBrowsableCategory(categories, { allowAggregate = false } = {}) {
  const normalized = (Array.isArray(categories) ? categories : []).map(normalizeStalkerCategory);
  return normalized.find(category => !category.aggregate)
    || (allowAggregate ? normalized.find(category => category.aggregate) : null)
    || null;
}

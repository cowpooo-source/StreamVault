export function findExactCatalogItem(items, original) {
  const originalId = original?.id;
  if (originalId !== null && originalId !== undefined && String(originalId) !== '') {
    return (items || []).find(item => String(item?.id) === String(originalId)) || null;
  }
  return (items || []).find(item =>
    item?.name === original?.name && item?.type === original?.type
  ) || null;
}

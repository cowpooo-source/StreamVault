function stableSeed(value) {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// Keep discovery bounded while still changing the sampled categories by day.
export function selectDiscoveryCategories(categories, { seed = '', max = 4 } = {}) {
  const normalized = (Array.isArray(categories) ? categories : [])
    .filter(category => category && category.id != null && String(category.id) !== '')
    .filter((category, index, list) => list.findIndex(item => String(item.id) === String(category.id)) === index);
  const limit = Math.max(0, Number(max) || 0);
  if (normalized.length <= limit) return normalized;
  if (limit === 0) return [];

  const selected = [normalized[0]];
  const candidates = normalized.slice(1);
  const start = stableSeed(seed) % candidates.length;
  for (let offset = 0; selected.length < limit && offset < candidates.length; offset += 1) {
    const index = (start + Math.floor((offset * candidates.length) / Math.max(1, limit - 1))) % candidates.length;
    const candidate = candidates[index];
    if (!selected.some(item => String(item.id) === String(candidate.id))) selected.push(candidate);
  }
  return selected;
}

export function discoverySeed(connectionScope, now = Date.now()) {
  const day = Math.floor(Number(now) / 86_400_000);
  return `${connectionScope || ''}:${day}`;
}

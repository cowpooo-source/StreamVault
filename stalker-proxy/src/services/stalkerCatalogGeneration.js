function createCatalogGenerations() {
  const generations = new Map();
  const current = key => {
    const normalized = String(key);
    if (!generations.has(normalized)) generations.set(normalized, 0);
    return generations.get(normalized) || 0;
  };
  const bump = key => {
    const normalized = String(key);
    const next = current(normalized) + 1;
    generations.set(normalized, next);
    return next;
  };
  const bumpMatching = prefix => {
    for (const key of generations.keys()) {
      if (key.startsWith(String(prefix))) bump(key);
    }
  };
  return {
    current,
    bump,
    bumpMatching,
    isCurrent: (key, generation) => current(key) === generation,
  };
}

module.exports = { createCatalogGenerations };

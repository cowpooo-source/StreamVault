function createCatalogPageHistory({ maxSignatures = 32 } = {}) {
  const scopes = new Map();

  function observe(scopeKey, generation, signature) {
    const key = String(scopeKey);
    let state = scopes.get(key);
    if (!state || state.generation !== generation) {
      state = { generation, signatures: [] };
      scopes.set(key, state);
    }

    const repeated = state.signatures.includes(signature);
    if (!repeated) {
      state.signatures.push(signature);
      if (state.signatures.length > maxSignatures) state.signatures.shift();
    }
    return repeated;
  }

  function clear(prefix = '') {
    const normalized = String(prefix);
    for (const key of scopes.keys()) {
      if (key.startsWith(normalized)) scopes.delete(key);
    }
  }

  return { observe, clear, size: () => scopes.size };
}

module.exports = { createCatalogPageHistory };

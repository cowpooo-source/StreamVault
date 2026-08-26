const encoder = new TextEncoder();

function fallbackCatalogFingerprint(value) {
  // HTTP player origins do not expose Web Crypto. Keep cache keys opaque there
  // without blocking catalog loading for those direct-play pages.
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function normalizeStalkerCatalogConnection(connection = {}) {
  return {
    type: 'stalker',
    server: String(connection.server || connection.portal || '').trim().replace(/\/+$/, '').toLowerCase(),
    mac: String(connection.mac || '').trim().toUpperCase(),
    serial: String(connection.serial || '').trim(),
    deviceId: String(connection.deviceId || '').trim(),
    deviceId2: String(connection.deviceId2 || '').trim(),
  };
}

export async function stalkerCatalogConnectionFingerprint(connection = {}, webCrypto = globalThis.crypto) {
  const serialized = JSON.stringify(normalizeStalkerCatalogConnection(connection));
  if (!webCrypto?.subtle) return fallbackCatalogFingerprint(serialized);

  const bytes = encoder.encode(serialized);
  const digest = await webCrypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

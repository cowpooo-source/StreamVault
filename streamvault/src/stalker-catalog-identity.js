const encoder = new TextEncoder();

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

export async function stalkerCatalogConnectionFingerprint(connection = {}) {
  const bytes = encoder.encode(JSON.stringify(normalizeStalkerCatalogConnection(connection)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

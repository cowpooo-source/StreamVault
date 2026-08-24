const crypto = require('crypto');

function catalogIdentity({ portal, mac, serial, deviceId, deviceId2 } = {}) {
  return {
    portal: String(portal || '').trim().replace(/\/+$/, '').toLowerCase(),
    mac: String(mac || '').trim().toUpperCase(),
    serial: String(serial || '').trim(),
    deviceId: String(deviceId || '').trim(),
    deviceId2: String(deviceId2 || '').trim(),
  };
}

function catalogIdentityHash(connection) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(catalogIdentity(connection)))
    .digest('hex');
}

module.exports = { catalogIdentity, catalogIdentityHash };

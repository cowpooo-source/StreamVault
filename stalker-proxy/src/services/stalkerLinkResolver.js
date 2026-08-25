const crypto = require('crypto');
const { isSupportedBrowserProtocol } = require('./stalkerSecurity');

function createGeneration(url) {
  return crypto.createHash('sha256').update(`${url}|${Date.now()}|${crypto.randomBytes(8).toString('hex')}`).digest('hex').slice(0, 24);
}

function directCapability(normalized, warnings = []) {
  if (!normalized?.url) return 'invalid_response';
  if (!isSupportedBrowserProtocol(normalized.url)) return 'unsupported_protocol';
  if (normalized.headersRequired) return 'headers_required';
  if (warnings.includes('ip_bound_suspected')) return 'ip_bound_suspected';
  if (warnings.includes('cors_risk')) return 'cors_risk';
  return 'browser_candidate';
}

function buildResolveContract({ normalized, url, direct, refreshUrl, relayAvailable = false, relayUrl = null, warnings = [] }) {
  const safeWarnings = [...new Set(warnings.filter(Boolean))];
  const resolved = { ...normalized, url: url || normalized?.url };
  return {
    url: resolved.url || null,
    streamKind: resolved.streamKind || 'unknown',
    direct: direct == null ? Boolean(resolved.url && isSupportedBrowserProtocol(resolved.url)) : Boolean(direct),
    directCapability: directCapability(resolved, safeWarnings),
    expiresAt: resolved.expiresAt || null,
    refreshable: Boolean(refreshUrl),
    refreshUrl: refreshUrl || null,
    generation: createGeneration(resolved.url || 'invalid'),
    relayAvailable: Boolean(relayAvailable),
    relayUrl: relayAvailable ? relayUrl : null,
    warnings: safeWarnings,
  };
}

module.exports = { buildResolveContract, createGeneration, directCapability };

const CATALOG_MODE_HEADER = 'x-streamvault-catalog-mode';
const LAZY_CATALOG_MODE = 'lazy-v1';

function invalidModeError(value) {
  return Object.assign(new Error(`Unsupported Stalker catalog mode: ${value}`), {
    code: 'invalid_catalog_mode',
    status: 400,
  });
}

function getCatalogMode(request = {}) {
  const headers = request.headers || {};
  const raw = typeof request.get === 'function'
    ? request.get(CATALOG_MODE_HEADER)
    : headers[CATALOG_MODE_HEADER] ?? headers[CATALOG_MODE_HEADER.toLowerCase()];
  if (raw == null || String(raw).trim() === '') return null;
  const mode = String(raw).trim().toLowerCase();
  if (mode !== LAZY_CATALOG_MODE) throw invalidModeError(mode);
  return mode;
}

function isLazyCatalogRequest(request) {
  return getCatalogMode(request) === LAZY_CATALOG_MODE;
}

module.exports = { CATALOG_MODE_HEADER, LAZY_CATALOG_MODE, getCatalogMode, isLazyCatalogRequest };

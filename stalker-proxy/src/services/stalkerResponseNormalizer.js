const path = require('path');
const { isSupportedBrowserProtocol } = require('./stalkerSecurity');

const FILE_EXTENSIONS = new Set(['mp4', 'mkv', 'mpg', 'mpeg', 'avi', 'mov', 'webm', 'mp3', 'aac']);

function stripCommandPrefix(value) {
  return String(value || '').trim().replace(/^(?:ffmpeg|ffrt)\s+/i, '').trim();
}

function classifyStreamKind(value, contentType = 'live') {
  const clean = stripCommandPrefix(value);
  let parsed;
  try { parsed = new URL(clean); } catch { parsed = null; }
  const pathname = parsed?.pathname?.toLowerCase() || clean.split('?')[0].toLowerCase();
  const extension = path.extname(pathname).replace('.', '');
  if (pathname.endsWith('.m3u8')) return 'hls';
  if (pathname.endsWith('.ts') || parsed?.searchParams.get('extension') === 'ts') return 'ts';
  if (FILE_EXTENSIONS.has(extension) || parsed?.searchParams.get('extension') === 'mp4') return 'file';
  if (contentType === 'live' || pathname.includes('/live/')) return 'ts';
  if (contentType === 'vod' || contentType === 'series' || contentType === 'file') return 'file';
  return 'unknown';
}

function normalizeUrl(value, portal) {
  const clean = stripCommandPrefix(value);
  if (!clean) return null;
  if (clean.startsWith('//')) {
    try { return `${new URL(portal).protocol}${clean}`; } catch { return `http:${clean}`; }
  }
  if (clean.startsWith('/') && portal) {
    try { return new URL(clean, portal).toString(); } catch {}
  }
  if (clean.includes('localhost') || clean.includes('127.0.0.1')) {
    try {
      const host = new URL(portal).host;
      return clean.replace(/localhost(?::\d+)?/gi, host).replace(/127\.0\.0\.1(?::\d+)?/g, host);
    } catch {}
  }
  return clean;
}

function buildTokenizedMovieUrl(payload, context) {
  const streamId = String(payload?.id || payload?.stream || '').trim();
  const playToken = String(payload?.play_token || payload?.playToken || '').trim();
  if (!streamId || !playToken || !context?.portal) return null;
  try {
    const portal = new URL(context.portal);
    const basePath = portal.pathname.includes('/stalker_portal')
      ? portal.pathname.slice(0, portal.pathname.indexOf('/stalker_portal'))
      : portal.pathname.includes('/c/')
        ? portal.pathname.slice(0, portal.pathname.indexOf('/c/'))
        : '';
    const base = `${portal.protocol}//${portal.host}${basePath}`;
    const params = new URLSearchParams({
      mac: context.mac || '',
      stream: streamId,
      play_token: playToken,
      type: context.contentType === 'series' ? 'series' : 'movie',
    });
    return `${base}/play/movie.php?${params}`;
  } catch { return null; }
}

function normalizeCreateLinkResponse(payload, context = {}) {
  const js = payload?.js || {};
  const candidates = [
    ['cmd', js.cmd],
    ['url', js.url],
    ['stream', js.stream],
  ];
  for (const [sourceShape, candidate] of candidates) {
    const url = normalizeUrl(candidate, context.portal);
    if (!url) continue;
    if (!isSupportedBrowserProtocol(url)) {
      return {
        url,
        streamKind: 'unknown',
        commandKind: sourceShape,
        expiresAt: null,
        tokenized: false,
        headersRequired: false,
        sourceShape,
        unsupportedProtocol: true,
      };
    }
    return {
      url,
      streamKind: classifyStreamKind(url, context.contentType),
      commandKind: sourceShape,
      expiresAt: extractExpiry(url),
      tokenized: /(?:[?&])(play_token|token|st)=/i.test(url),
      headersRequired: false,
      sourceShape,
    };
  }

  const constructed = buildTokenizedMovieUrl(js, context);
  if (constructed) {
    return {
      url: constructed,
      streamKind: 'file',
      commandKind: 'generated_movie_url',
      expiresAt: extractExpiry(constructed),
      tokenized: true,
      headersRequired: false,
      sourceShape: 'id_play_token',
    };
  }
  return null;
}

function extractExpiry(value) {
  try {
    const parsed = new URL(value);
    const raw = parsed.searchParams.get('e') || parsed.searchParams.get('expires') || parsed.searchParams.get('expires_at');
    if (!raw) return null;
    const seconds = Number(raw);
    return Number.isFinite(seconds) ? (seconds < 10_000_000_000 ? seconds * 1000 : seconds) : null;
  } catch { return null; }
}

module.exports = {
  classifyStreamKind,
  normalizeCreateLinkResponse,
  normalizeUrl,
  stripCommandPrefix,
};

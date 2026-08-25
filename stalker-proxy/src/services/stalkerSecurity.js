const SENSITIVE_QUERY_KEYS = new Set([
  'authorization', 'device_id', 'deviceid', 'deviceid2', 'mac', 'pass',
  'password', 'play_token', 'serial', 'sn', 'st', 'token', 'username', 'user',
]);

function sanitizeStalkerUrl(value) {
  if (!value) return value;
  try {
    const parsed = new URL(String(value));
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) parsed.searchParams.set(key, '[REDACTED]');
    }
    parsed.username = parsed.username ? '[REDACTED]' : '';
    parsed.password = parsed.password ? '[REDACTED]' : '';
    return parsed.toString();
  } catch {
    return String(value)
      .replace(/(00(?::|%3A)[0-9a-f]{2}(?:(?::|%3A)[0-9a-f]{2}){4})/ig, '[REDACTED_MAC]')
      .replace(/([?&](?:authorization|device_id2?|mac|pass(?:word)?|play_token|serial|sn|st|token|user(?:name)?)=)[^&\s]*/ig, '$1[REDACTED]');
  }
}

function stripStalkerPlaybackTokens(value) {
  const command = String(value || '');
  const prefix = command.match(/^(?:ffmpeg|ffrt)\s+/i)?.[0] || '';
  const raw = prefix ? command.slice(prefix.length) : command;
  try {
    const parsed = new URL(raw);
    for (const key of ['play_token', 'token', 'st', 'expires', 'expires_at', 'e']) parsed.searchParams.delete(key);
    return prefix + parsed.toString();
  } catch {
    return command.replace(/([?&](?:play_token|token|st|expires|expires_at|e)=)[^&\s]*/ig, '$1');
  }
}
function isSupportedBrowserProtocol(value) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); }
  catch { return false; }
}

module.exports = { isSupportedBrowserProtocol, sanitizeStalkerUrl, stripStalkerPlaybackTokens };

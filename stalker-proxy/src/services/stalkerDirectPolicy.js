function playbackMode() {
  const mode = String(process.env.STALKER_PLAYBACK_MODE || 'direct_only').toLowerCase();
  return ['direct_only', 'direct_preferred', 'relay_allowed'].includes(mode) ? mode : 'direct_only';
}

function directPlayEnabled() {
  return process.env.STALKER_DIRECT_PLAY_ENABLED !== 'false';
}

function mediaRelayEnabled() {
  return process.env.STALKER_MEDIA_RELAY_ENABLED === 'true' && playbackMode() !== 'direct_only';
}

function redirectProbeMode() {
  const mode = String(process.env.STALKER_REDIRECT_RESOLUTION || 'head').toLowerCase();
  if (mode === 'range') {
    const explicitlyAllowed = process.env.STALKER_ALLOW_RANGE_REDIRECT_PROBE === 'true';
    return explicitlyAllowed && playbackMode() === 'direct_preferred' ? 'range' : 'head';
  }
  return ['head', 'off'].includes(mode) ? mode : 'head';
}

module.exports = { directPlayEnabled, mediaRelayEnabled, playbackMode, redirectProbeMode };

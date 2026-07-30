/**
 * Pure recovery decision functions for the Player state machine.
 *
 * These functions answer "should we recover?" and "what action should we try?"
 * without any side effects.  The Player component calls them and then executes
 * the chosen action using React state and DOM refs.
 */

/** Maximum stalker URL refreshes allowed in a 60-second window. */
const STALKER_REFRESH_WINDOW_MS = 60_000;
const STALKER_MAX_REFRESHES = 3;

/** Maximum stall recovery attempts before terminal error. */
const MAX_STALL_RECOVERIES = 3;

/**
 * Check whether a Stalker refresh is currently allowed.
 *
 * @param {{ stalkerRefreshInFlight?: boolean, stalkerRefreshTimes?: number[] }} recovery
 * @param {{ _direct?: boolean, type?: string }} current
 * @returns {{ allowed: boolean, reason?: string }}
 */
function canStalkerRefresh(recovery, current) {
  if (!current._direct) return { allowed: false, reason: 'not_direct' };
  if (recovery.stalkerRefreshInFlight) return { allowed: false, reason: 'already_in_flight' };
  const now = Date.now();
  const recent = (recovery.stalkerRefreshTimes || []).filter(t => t > now - STALKER_REFRESH_WINDOW_MS);
  if (recent.length >= STALKER_MAX_REFRESHES) return { allowed: false, reason: 'rate_limited' };
  return { allowed: true };
}

/**
 * Check whether stall recovery is currently allowed.
 *
 * @param {{ recoveryInFlight?: boolean, stall?: number }} recovery
 * @param {boolean} videoEnded
 * @param {boolean} videoPaused
 * @param {string} playbackPhase
 * @returns {{ allowed: boolean, reason?: string }}
 */
function canStallRecover(recovery, videoEnded, videoPaused, playbackPhase) {
  if (recovery.recoveryInFlight) return { allowed: false, reason: 'already_in_flight' };
  if (videoEnded) return { allowed: false, reason: 'video_ended' };
  if (videoPaused) return { allowed: false, reason: 'video_paused' };
  if (playbackPhase !== 'content') return { allowed: false, reason: 'not_content_phase' };
  if ((recovery.stall || 0) >= MAX_STALL_RECOVERIES) return { allowed: false, reason: 'max_stalls_reached' };
  return { allowed: true };
}

/**
 * Choose the next stall recovery action based on engine state.
 *
 * Returns one of:
 *   "hls_reload"       — call hls.startLoad(-1)
 *   "mpegts_reload"    — call mpegts.unload() + load() + play()
 *   "stalker_refresh"  — call onRefreshStream
 *   "native_rebuild"   — increment streamRevision to rebuild <video>
 *
 * @param {number} stallCount      — recovery.stall (1-indexed)
 * @param {boolean} hasHls
 * @param {boolean} hasMpegts
 * @param {boolean} isDirect       — current._direct
 * @returns {string}
 */
function chooseStallAction(stallCount, hasHls, hasMpegts, isDirect) {
  // First stall: try engine-level reload.
  if (stallCount === 1) {
    if (hasHls) return 'hls_reload';
    if (hasMpegts) return 'mpegts_reload';
  }

  // Second stall: try fresh URL for direct Stalker.
  if (isDirect) return 'stalker_refresh';

  // Engine re-reload.
  if (hasHls) return 'hls_reload';
  if (hasMpegts) return 'mpegts_reload';

  // No engine available — rebuild the native video element.
  return 'native_rebuild';
}

/**
 * Determine whether a stall should trigger progressive recovery or
 * immediate terminal error, based on HTTP status of prior responses.
 *
 * @param {boolean} hasTerminalHttpError  — true if the last resolve returned 401/403/404/410
 * @param {number} stallCount
 * @returns {{ terminal: boolean, action?: string }}
 */
function classifyRecoveryPath(hasTerminalHttpError, stallCount) {
  // A terminal HTTP error should skip engine recovery and go straight to
  // a single fresh URL, then terminal.
  if (hasTerminalHttpError) {
    if (stallCount === 0) return { terminal: false, action: 'refresh_url' };
    return { terminal: true, action: 'show_terminal_error' };
  }
  return { terminal: false };
}

export {
  canStalkerRefresh,
  canStallRecover,
  chooseStallAction,
  classifyRecoveryPath,
};

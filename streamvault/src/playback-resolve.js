export const PLAYBACK_RESOLVE_TIMEOUT_MS = 90_000;

function playbackResolveError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function createPlaybackResolveCoordinator({
  timeoutMs = PLAYBACK_RESOLVE_TIMEOUT_MS,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
} = {}) {
  let active = null;

  function cancel() {
    if (!active) return false;

    const request = active;
    active = null;
    const error = playbackResolveError(
      "playback_resolve_cancelled",
      "Stream loading was cancelled.",
    );
    request.controller.abort(error);
    request.rejectAbort(error);
    return true;
  }

  function run(operation) {
    cancel();

    if (typeof operation !== "function") {
      return Promise.reject(new TypeError("Playback resolve operation must be a function"));
    }

    const controller = new AbortController();
    let rejectAbort;
    const abortResult = new Promise((_, reject) => {
      rejectAbort = reject;
    });
    const request = { controller, rejectAbort };
    active = request;

    const timeout = setTimeoutFn(() => {
      if (active !== request) return;

      active = null;
      const error = playbackResolveError(
        "playback_resolve_timeout",
        "The provider took too long to prepare this stream.",
      );
      controller.abort(error);
      rejectAbort(error);
    }, Math.max(0, Number(timeoutMs) || 0));

    const operationResult = Promise.resolve().then(() => operation({ signal: controller.signal }));
    return Promise.race([operationResult, abortResult]).finally(() => {
      clearTimeoutFn(timeout);
      if (active === request) active = null;
    });
  }

  return { run, cancel };
}

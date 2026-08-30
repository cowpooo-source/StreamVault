function createProviderMetadataCoordinator({ maxActive = 1, maxQueued = 2, safetyMs = 60_000, backgroundDelayMs = 250 } = {}) {
  const states = new Map();
  const abortError = () => Object.assign(new Error('Metadata request aborted'), { code: 'ABORT_ERR', status: 499 });
  const timeoutError = () => Object.assign(new Error('Metadata operation timed out'), { code: 'ETIMEDOUT', status: 504 });

  function stateFor(providerKey) {
    if (!states.has(providerKey)) states.set(providerKey, { active: 0, queue: [], inFlight: new Map(), backgroundTimer: null });
    return states.get(providerKey);
  }

  function cleanup(state, providerKey, requestKey) {
    state.inFlight.delete(requestKey);
    if (!state.active && !state.queue.length && !state.inFlight.size && !state.backgroundTimer) states.delete(providerKey);
  }

  function clearBackgroundTimer(state) {
    if (!state.backgroundTimer) return;
    clearTimeout(state.backgroundTimer);
    state.backgroundTimer = null;
  }

  function releaseWaiter(entry) {
    entry.waiters = Math.max(0, entry.waiters - 1);
    if (entry.waiters || entry.settled) return;
    if (entry.started) {
      entry.controller?.abort();
      return;
    }
    const index = entry.state.queue.indexOf(entry.job);
    if (index >= 0) entry.state.queue.splice(index, 1);
    entry.job.settled = true;
    entry.settled = true;
    entry.reject(abortError());
    cleanup(entry.state, entry.providerKey, entry.requestKey);
  }

  function waitForEntry(entry, signal) {
    entry.waiters += 1;
    if (!signal) return entry.promise.finally(() => releaseWaiter(entry));
    if (signal.aborted) {
      releaseWaiter(entry);
      return Promise.reject(abortError());
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => finish(reject, abortError());
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        releaseWaiter(entry);
        fn(value);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(value => finish(resolve, value), error => finish(reject, error));
    });
  }

  function runProviderMetadata({ providerKey, requestKey, signal, operation, priority = 'foreground' }) {
    const state = stateFor(providerKey);
    const existing = state.inFlight.get(requestKey);
    if (existing) return waitForEntry(existing, signal);
    if (signal?.aborted) return Promise.reject(abortError());
    if (state.active >= maxActive && state.queue.length >= maxQueued) {
      const error = new Error('Provider metadata queue is busy');
      error.code = 'PROVIDER_METADATA_BUSY';
      error.status = 429;
      error.retryAfterMs = 5000;
      return Promise.reject(error);
    }

    const entry = {
      requestKey,
      state,
      providerKey,
      operation,
      priority: priority === 'background' ? 'background' : 'foreground',
      waiters: 0,
      started: false,
      settled: false,
      controller: null,
      job: null,
      resolve: null,
      reject: null,
      promise: null,
    };
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    entry.job = { entry, started: false, settled: false };
    state.inFlight.set(requestKey, entry);

    const startNext = () => {
      if (state.active >= maxActive) return;
      const foregroundIndex = state.queue.findIndex(job => job.entry.priority !== 'background');
      const nextIndex = foregroundIndex >= 0 ? foregroundIndex : 0;
      const next = state.queue[nextIndex];
      if (!next) {
        cleanup(state, providerKey, requestKey);
        return;
      }
      if (next.entry.priority === 'background') {
        if (state.backgroundTimer) return;
        state.backgroundTimer = setTimeout(() => {
          state.backgroundTimer = null;
          const index = state.queue.indexOf(next);
          if (index >= 0) {
            state.queue.splice(index, 1);
            start(next);
          } else {
            startNext();
          }
        }, backgroundDelayMs);
        state.backgroundTimer.unref?.();
        return;
      }
      state.queue.splice(nextIndex, 1);
      start(next);
    };
    const start = job => {
      const current = job.entry;
      if (current.settled) {
        startNext();
        return;
      }
      current.started = true;
      job.started = true;
      current.controller = new AbortController();
      state.active += 1;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        current.controller.abort();
        if (!current.settled) {
          current.settled = true;
          job.settled = true;
          current.reject(timeoutError());
        }
      }, safetyMs);

      Promise.resolve()
        .then(() => current.operation(current.controller.signal))
        .then(value => {
          if (!timedOut && !current.settled) {
            current.settled = true;
            job.settled = true;
            current.resolve(value);
          }
        }, error => {
          if (!timedOut && !current.settled) {
            current.settled = true;
            job.settled = true;
            current.reject(error);
          }
        })
        .finally(() => {
          clearTimeout(timer);
          state.active -= 1;
          cleanup(state, providerKey, current.requestKey);
          startNext();
        });
    };

    if (entry.priority !== 'background' && state.backgroundTimer) clearBackgroundTimer(state);
    if (state.active < maxActive && entry.priority !== 'background') {
      start(entry.job);
    } else {
      const backgroundIndex = state.queue.findIndex(job => job.entry.priority === 'background');
      if (entry.priority === 'background' || backgroundIndex < 0) state.queue.push(entry.job);
      else state.queue.splice(backgroundIndex, 0, entry.job);
      if (state.active < maxActive) startNext();
    }
    return waitForEntry(entry, signal);
  }

  return { runProviderMetadata, size: () => states.size };
}

module.exports = { createProviderMetadataCoordinator };

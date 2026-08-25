function createProviderMetadataCoordinator({ maxActive = 1, maxQueued = 2, safetyMs = 60_000 } = {}) {
  const states = new Map();
  const abortError = () => Object.assign(new Error('Metadata request aborted'), { code: 'ABORT_ERR', status: 499 });
  const timeoutError = () => Object.assign(new Error('Metadata operation timed out'), { code: 'ETIMEDOUT', status: 504 });

  function stateFor(providerKey) {
    if (!states.has(providerKey)) states.set(providerKey, { active: 0, queue: [], inFlight: new Map() });
    return states.get(providerKey);
  }

  function cleanup(state, providerKey, requestKey) {
    state.inFlight.delete(requestKey);
    if (!state.active && !state.queue.length && !state.inFlight.size) states.delete(providerKey);
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

  function runProviderMetadata({ providerKey, requestKey, signal, operation }) {
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
      const next = state.queue.shift();
      if (next) start(next);
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

    if (state.active < maxActive) start(entry.job);
    else state.queue.push(entry.job);
    return waitForEntry(entry, signal);
  }

  return { runProviderMetadata, size: () => states.size };
}

module.exports = { createProviderMetadataCoordinator };

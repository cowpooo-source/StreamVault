function normalizeProviderUrl(value) {
  const raw = String(value || "").trim();
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host.toLowerCase()}${path}`.toLowerCase();
  } catch {
    return raw.replace(/\/+$/, "").toLowerCase();
  }
}

export function providerKeyForImport(item = {}) {
  const type = String(item.type || "unknown").toLowerCase();
  const endpoint = item.server || item.url || "";
  return `${type}:${normalizeProviderUrl(endpoint)}`;
}

function isRateLimited(result) {
  const code = String(result?.code || "").toLowerCase();
  return result?.rateLimited === true
    || Number(result?.status) === 429
    || code === "provider_cooldown"
    || code === "provider_rate_limited"
    || code === "rate_limited";
}

export async function validateImports(items, validateItem, {
  maxConcurrent = 1,
  signal,
  onProgress,
} = {}) {
  const list = Array.from(items || []);
  const results = new Array(list.length);
  const states = new Array(list.length).fill("pending");
  const activeProviders = new Set();
  const blockedProviders = new Map();
  const concurrency = Math.max(1, Number.parseInt(maxConcurrent, 10) || 1);

  return new Promise(resolve => {
    let active = 0;
    let completed = 0;
    let settled = false;

    const report = (index, result) => {
      try {
        onProgress?.({
          completed,
          total: list.length,
          index,
          item: list[index],
          result,
        });
      } catch {
        // Progress reporting must never interrupt validation.
      }
    };

    const finishIfReady = () => {
      if (settled || completed !== list.length || active !== 0) return;
      settled = true;
      signal?.removeEventListener("abort", abortPending);
      resolve(results);
    };

    const markComplete = (index, result) => {
      if (states[index] === "done") return;
      states[index] = "done";
      results[index] = result;
      completed += 1;
      report(index, result);
    };

    const abortPending = () => {
      for (let index = 0; index < list.length; index += 1) {
        if (states[index] !== "pending") continue;
        markComplete(index, {
          valid: false,
          code: "ABORT_ERR",
          skipped: true,
          reason: "Import validation was cancelled.",
        });
      }
      finishIfReady();
    };

    const retryAfterSecondsFor = result => {
      const seconds = Number(result?.retryAfterSeconds);
      if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
      const milliseconds = Number(result?.retryAfterMs);
      if (Number.isFinite(milliseconds) && milliseconds > 0) return Math.ceil(milliseconds / 1000);
      return undefined;
    };

    const pump = () => {
      if (signal?.aborted) {
        abortPending();
        return;
      }

      while (active < concurrency) {
        const index = list.findIndex((item, candidate) => (
          states[candidate] === "pending" && !activeProviders.has(providerKeyForImport(item))
        ));
        if (index < 0) break;

        const item = list[index];
        const providerKey = providerKeyForImport(item);
        const blocked = blockedProviders.get(providerKey);
        if (blocked) {
          const retryAfterSeconds = blocked.retryAfterSeconds;
          markComplete(index, {
            valid: false,
            rateLimited: true,
            code: "provider_cooldown",
            skipped: true,
            ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
            reason: retryAfterSeconds
              ? `Provider cooldown is active. Please wait ${retryAfterSeconds} seconds before importing another connection from it.`
              : "Provider cooldown is active. Please wait before importing another connection from it.",
          });
          continue;
        }

        states[index] = "running";
        active += 1;
        activeProviders.add(providerKey);
        Promise.resolve()
          .then(() => validateItem(item, { signal }))
          .catch(error => ({ valid: false, reason: error?.message || "Validation failed" }))
          .then(result => {
            const normalized = result && typeof result === "object" ? result : { valid: Boolean(result) };
            if (isRateLimited(normalized)) {
              blockedProviders.set(providerKey, {
                retryAfterSeconds: retryAfterSecondsFor(normalized),
              });
            }
            markComplete(index, normalized);
          })
          .finally(() => {
            active -= 1;
            activeProviders.delete(providerKey);
            pump();
          });
      }

      finishIfReady();
    };

    signal?.addEventListener("abort", abortPending, { once: true });
    pump();
  });
}

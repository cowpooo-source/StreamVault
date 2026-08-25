function createRelaySlotManager() {
  const active = new Map();

  function acquire(key, { limit, timeoutMs, onTimeout } = {}) {
    const boundedLimit = Math.max(1, Number(limit) || 1);
    const boundedTimeoutMs = Math.max(1, Number(timeoutMs) || 60_000);
    const current = active.get(key) || 0;
    if (current >= boundedLimit) return null;

    active.set(key, current + 1);
    let released = false;
    const timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // Lease cleanup must not turn a defensive timeout into an uncaught error.
      } finally {
        release();
      }
    }, boundedTimeoutMs);

    function release() {
      if (released) return false;
      released = true;
      clearTimeout(timer);
      const remaining = (active.get(key) || 1) - 1;
      if (remaining > 0) active.set(key, remaining);
      else active.delete(key);
      return true;
    }

    return { release };
  }

  return {
    acquire,
    activeCount: key => active.get(key) || 0,
  };
}

module.exports = { createRelaySlotManager };

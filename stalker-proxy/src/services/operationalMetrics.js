function createOperationalMetrics({ now = Date.now, windowMs = 60_000 } = {}) {
  const buckets = new Map();
  let activeRequests = 0;

  function cleanup(timestamp = now()) {
    const oldestSecond = Math.floor((timestamp - windowMs) / 1000);
    for (const second of buckets.keys()) {
      if (second <= oldestSecond) buckets.delete(second);
    }
  }

  function begin() {
    activeRequests += 1;
  }

  function finish(type = 'other', status = 200, duration = 0, route = null) {
    activeRequests = Math.max(0, activeRequests - 1);
    const timestamp = now();
    cleanup(timestamp);
    const second = Math.floor(timestamp / 1000);
    const bucket = buckets.get(second) || { total: 0, errors: 0, latency: 0, byType: {}, byStatus: {}, byRouteStatus: {} };
    bucket.total += 1;
    bucket.errors += Number(status) >= 400 ? 1 : 0;
    bucket.latency += Math.max(0, Number(duration) || 0);
    bucket.byType[type] = (bucket.byType[type] || 0) + 1;
    const statusCode = String(Number(status) || 0);
    bucket.byStatus[statusCode] = (bucket.byStatus[statusCode] || 0) + 1;
    if (route) {
      bucket.byRouteStatus[route] ||= {};
      bucket.byRouteStatus[route][statusCode] = (bucket.byRouteStatus[route][statusCode] || 0) + 1;
    }
    buckets.set(second, bucket);
  }

  function snapshot() {
    cleanup();
    const summary = { total: 0, errors: 0, latency: 0, byType: {}, byStatus: {}, byRouteStatus: {} };
    for (const bucket of buckets.values()) {
      summary.total += bucket.total;
      summary.errors += bucket.errors;
      summary.latency += bucket.latency;
      for (const [type, count] of Object.entries(bucket.byType)) {
        summary.byType[type] = (summary.byType[type] || 0) + count;
      }
      for (const [status, count] of Object.entries(bucket.byStatus || {})) {
        summary.byStatus[status] = (summary.byStatus[status] || 0) + count;
      }
      for (const [route, statuses] of Object.entries(bucket.byRouteStatus || {})) {
        summary.byRouteStatus[route] ||= {};
        for (const [status, count] of Object.entries(statuses)) {
          summary.byRouteStatus[route][status] = (summary.byRouteStatus[route][status] || 0) + count;
        }
      }
    }
    return {
      active: activeRequests,
      requestsLastMinute: summary.total,
      errorsLastMinute: summary.errors,
      errorRate: summary.total ? Math.round((summary.errors / summary.total) * 1000) / 10 : 0,
      averageLatencyMs: summary.total ? Math.round(summary.latency / summary.total) : 0,
      byType: summary.byType,
      byStatus: summary.byStatus,
      byRouteStatus: summary.byRouteStatus,
    };
  }

  return { begin, finish, snapshot };
}

module.exports = { createOperationalMetrics };

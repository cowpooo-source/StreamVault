import { describe, expect, it } from 'vitest';
import { createOperationalMetrics } from '../src/services/operationalMetrics';

describe('operational metrics', () => {
  it('tracks active requests, rates, errors, latency, and request types', () => {
    let timestamp = 1_000_000;
    const metrics = createOperationalMetrics({ now: () => timestamp });
    metrics.begin();
    expect(metrics.snapshot().active).toBe(1);
    metrics.finish('stalker', 200, 40);
    metrics.begin();
    metrics.finish('proxy', 502, 60);

    expect(metrics.snapshot()).toEqual({
      active: 0,
      requestsLastMinute: 2,
      errorsLastMinute: 1,
      errorRate: 50,
      averageLatencyMs: 50,
      byType: { stalker: 1, proxy: 1 },
      byStatus: { '200': 1, '502': 1 },
    });

    timestamp += 60_001;
    expect(metrics.snapshot().requestsLastMinute).toBe(0);
  });
});

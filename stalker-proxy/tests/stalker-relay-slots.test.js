import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRelaySlotManager } from "../src/services/stalkerRelaySlots.js";

describe("createRelaySlotManager", () => {
  beforeEach(() => vi.useRealTimers());

  it("enforces limits and permits reacquisition after release", () => {
    const slots = createRelaySlotManager();
    const lease = slots.acquire("provider", { limit: 1, timeoutMs: 60_000 });

    expect(lease).not.toBeNull();
    expect(slots.activeCount("provider")).toBe(1);
    expect(slots.acquire("provider", { limit: 1, timeoutMs: 60_000 })).toBeNull();
    expect(lease.release()).toBe(true);
    expect(lease.release()).toBe(false);
    expect(slots.activeCount("provider")).toBe(0);

    const nextLease = slots.acquire("provider", { limit: 1, timeoutMs: 60_000 });
    expect(nextLease).not.toBeNull();
    nextLease.release();
  });

  it("aborts and releases a timed-out lease", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const slots = createRelaySlotManager();
    slots.acquire("provider", { limit: 1, timeoutMs: 1000, onTimeout });

    vi.advanceTimersByTime(1000);

    expect(onTimeout).toHaveBeenCalledOnce();
    expect(slots.activeCount("provider")).toBe(0);
  });

  it("releases the lease even when the timeout callback throws", () => {
    vi.useFakeTimers();
    const slots = createRelaySlotManager();
    slots.acquire("provider", {
      limit: 1,
      timeoutMs: 1000,
      onTimeout: () => { throw new Error("abort failed"); },
    });

    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(slots.activeCount("provider")).toBe(0);
    expect(slots.acquire("provider", { limit: 1, timeoutMs: 1000 })).not.toBeNull();
  });
});

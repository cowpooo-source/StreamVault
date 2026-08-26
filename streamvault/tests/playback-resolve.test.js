import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlaybackResolveCoordinator } from "../src/playback-resolve.js";

describe("playback resolve coordinator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects immediately when the active resolve is cancelled", async () => {
    const coordinator = createPlaybackResolveCoordinator({ timeoutMs: 90_000 });
    const pending = coordinator.run(({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const assertion = expect(pending).rejects.toMatchObject({ code: "playback_resolve_cancelled" });

    expect(coordinator.cancel()).toBe(true);
    await assertion;
    expect(coordinator.cancel()).toBe(false);
  });

  it("rejects when the deadline expires even if the operation ignores abort", async () => {
    vi.useFakeTimers();
    const coordinator = createPlaybackResolveCoordinator({ timeoutMs: 90_000 });
    const pending = coordinator.run(() => new Promise(() => {}));
    const assertion = expect(pending).rejects.toMatchObject({ code: "playback_resolve_timeout" });

    await vi.advanceTimersByTimeAsync(90_000);
    await assertion;
  });

  it("does not let a superseded operation produce a stale result", async () => {
    let firstResolve;
    const coordinator = createPlaybackResolveCoordinator();
    const first = coordinator.run(() => new Promise(resolve => { firstResolve = resolve; }));
    await Promise.resolve();
    const firstAssertion = expect(first).rejects.toMatchObject({ code: "playback_resolve_cancelled" });
    const second = coordinator.run(async () => "fresh-url");

    firstResolve("stale-url");
    await firstAssertion;
    await expect(second).resolves.toBe("fresh-url");
  });
});

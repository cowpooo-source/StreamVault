import { describe, expect, it, vi } from "vitest";
import { providerKeyForImport, validateImports } from "../src/stalker-import-validation.js";

describe("Stalker import validation", () => {
  it("normalizes provider identity so equivalent portal entries share a gate", () => {
    expect(providerKeyForImport({ type: "stalker", server: "HTTP://Portal.test/c/", mac: "00:11" }))
      .toBe("stalker:http://portal.test/c");
    expect(providerKeyForImport({ type: "xtream", server: "http://X.test/", user: "a" }))
      .toBe("xtream:http://x.test");
  });

  it("validates imports sequentially and stops a provider after rate limiting", async () => {
    const active = new Map();
    const maxActive = new Map();
    const validate = vi.fn(async item => {
      const key = providerKeyForImport(item);
      const count = (active.get(key) || 0) + 1;
      active.set(key, count);
      maxActive.set(key, Math.max(maxActive.get(key) || 0, count));
      await new Promise(resolve => setTimeout(resolve, 0));
      active.set(key, count - 1);
      if (item.user === "limited") return { valid: false, reason: "Provider cooldown", rateLimited: true };
      return { valid: true };
    });
    const items = [
      { type: "xtream", server: "http://provider.test", user: "limited", pass: "1" },
      { type: "xtream", server: "http://provider.test/", user: "second", pass: "2" },
      { type: "stalker", server: "http://other.test/c", mac: "00:11" },
    ];

    const results = await validateImports(items, validate);

    expect(results).toHaveLength(3);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(results[1]).toMatchObject({ valid: false, rateLimited: true, code: "provider_cooldown", skipped: true });
    expect(results[1].reason).toMatch(/wait|cooldown/i);
    expect(maxActive.get("xtream:http://provider.test")).toBe(1);
    expect(maxActive.get("stalker:http://other.test/c")).toBe(1);
  });

  it("honors concurrency, reports progress, and passes the abort signal", async () => {
    const pending = new Map();
    const progress = [];
    const controller = new AbortController();
    const validate = vi.fn((item, { signal }) => new Promise(resolve => {
      pending.set(item.id, resolve);
      expect(signal).toBe(controller.signal);
    }));
    const items = [
      { id: "a", type: "xtream", server: "http://a.test" },
      { id: "b", type: "xtream", server: "http://b.test" },
      { id: "c", type: "xtream", server: "http://a.test" },
    ];

    const resultPromise = validateImports(items, validate, {
      maxConcurrent: 2,
      signal: controller.signal,
      onProgress: update => progress.push(update),
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(validate).toHaveBeenCalledTimes(2);
    pending.get("a")({ valid: true });
    pending.get("b")({ valid: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(validate).toHaveBeenCalledTimes(3);
    pending.get("c")({ valid: true });

    await expect(resultPromise).resolves.toEqual([
      { valid: true },
      { valid: true },
      { valid: true },
    ]);
    expect(progress.map(update => update.completed)).toEqual([1, 2, 3]);
  });

  it("marks pending validations as skipped when the caller aborts", async () => {
    const controller = new AbortController();
    let release;
    const validate = vi.fn((item, { signal }) => new Promise(resolve => {
      release = resolve;
      signal.addEventListener("abort", () => resolve({ valid: false, code: "ABORT_ERR" }), { once: true });
    }));
    const resultPromise = validateImports([
      { id: "first", type: "xtream", server: "http://a.test" },
      { id: "second", type: "xtream", server: "http://b.test" },
    ], validate, { signal: controller.signal });

    await new Promise(resolve => setTimeout(resolve, 0));
    controller.abort();
    release({ valid: false, code: "ABORT_ERR" });

    await expect(resultPromise).resolves.toMatchObject([
      { valid: false, code: "ABORT_ERR" },
      { valid: false, code: "ABORT_ERR", skipped: true },
    ]);
    expect(validate).toHaveBeenCalledTimes(1);
  });
});

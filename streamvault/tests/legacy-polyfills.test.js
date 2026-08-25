import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("legacy polyfills", () => {
  it("installs TextEncoder, TextDecoder, and ResizeObserver when native globals are missing", async () => {
    vi.stubGlobal("TextEncoder", undefined);
    vi.stubGlobal("TextDecoder", undefined);
    vi.stubGlobal("ResizeObserver", undefined);

    await import("../src/legacy-polyfills.js");

    expect(globalThis.TextEncoder).toBeTypeOf("function");
    expect(globalThis.TextDecoder).toBeTypeOf("function");
    expect(globalThis.ResizeObserver).toBeTypeOf("function");
  });
});

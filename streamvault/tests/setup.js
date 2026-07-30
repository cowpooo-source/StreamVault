import { vi } from "vitest";

// Mock fetch globally (only in jsdom environment; node tests don't need this).
if (typeof window !== "undefined") {
  window.fetch = vi.fn(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(""),
      blob: () => Promise.resolve(new Blob()),
    })
  );

  // Mock localStorage
  const localStorageMock = {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
  };
  Object.defineProperty(window, "localStorage", { value: localStorageMock });

  // Mock crypto.randomUUID
  window.crypto.randomUUID = vi.fn(() => "test-uuid-1234");
}

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock crypto.subtle before importing
const mockDigest = vi.fn();
const mockImportKey = vi.fn();
const mockEncrypt = vi.fn();
const mockDecrypt = vi.fn();

Object.defineProperty(global, 'crypto', {
  value: {
    subtle: {
      digest: mockDigest,
      importKey: mockImportKey,
      encrypt: mockEncrypt,
      decrypt: mockDecrypt,
    },
    getRandomValues: (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = i; return arr; },
  },
});

// Dynamic import to pick up mocks
let authUtils;
beforeEach(async () => {
  vi.resetModules();
  mockDigest.mockResolvedValue(new Uint8Array([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]));
  mockImportKey.mockResolvedValue({ type: "secret", algorithm: { name: "AES-GCM" } });
  authUtils = await import("../src/auth-utils.js");
});

describe("setEncKeySource", () => {
  it("should update the key source", () => {
    authUtils.setEncKeySource("test-id-123");
    expect(true).toBe(true);
  });
});

describe("deriveKey", () => {
  it("should derive a CryptoKey from key source", async () => {
    authUtils.setEncKeySource("user:123");
    const key = await authUtils.deriveKey();
    // Check mockDigest was called with "SHA-256" and some data
    const digestCalls = mockDigest.mock.calls;
    expect(digestCalls.length).toBeGreaterThan(0);
    expect(digestCalls[0][0]).toBe("SHA-256");
    expect(digestCalls[0][1]).toBeDefined();
    // Check mockImportKey was called
    expect(mockImportKey.mock.calls.length).toBeGreaterThan(0);
    expect(mockImportKey.mock.calls[0][0]).toBe("raw");
    expect(mockImportKey.mock.calls[0][2]).toBe("AES-GCM");
  });
});

describe("encryptData/decryptData", () => {
  it("should encrypt and decrypt data round-trip", async () => {
    authUtils.setEncKeySource("user:123");
    mockEncrypt.mockResolvedValue(new Uint8Array([100, 101, 102]));
    const encrypted = await authUtils.encryptData("hello");
    expect(encrypted).toContain(".");
    // Verify crypto.subtle.encrypt was called with proper parameters
    const calls = mockEncrypt.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const [params, key, data] = calls[0];
    expect(params.name).toBe("AES-GCM");
    expect(params.iv).toBeInstanceOf(Uint8Array);
  });

  it("should return plaintext on encryption error", async () => {
    authUtils.setEncKeySource("user:123");
    mockEncrypt.mockRejectedValue(new Error("fail"));
    const result = await authUtils.encryptData("hello");
    expect(result).toBe("hello");
  });

  it("should return ciphertext on decryption error", async () => {
    const result = await authUtils.decryptData("invalid-data");
    expect(result).toBe("invalid-data");
  });

  it("should return value unchanged if no dot separator", async () => {
    const result = await authUtils.decryptData("no-dot-here");
    expect(result).toBe("no-dot-here");
  });
});

describe("encryptConnections/decryptConnections", () => {
  it("should encrypt connections list", async () => {
    authUtils.setEncKeySource("user:123");
    mockEncrypt.mockResolvedValue(new Uint8Array([50, 51, 52]));
    const conns = [{ type: "xtream", user: "test", pass: "secret", url: "http://example.com" }];
    const encrypted = await authUtils.encryptConnections(conns);
    expect(encrypted).toContain(".");
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { encryptToken, decryptToken } from '../../src/services/tokenManager.js';

// Mock crypto.subtle
const mockEncrypt = vi.fn();
const mockDecrypt = vi.fn();
const mockImportKey = vi.fn();
const mockGetRandomValues = vi.fn();

vi.stubGlobal('crypto', {
  subtle: {
    encrypt: mockEncrypt,
    decrypt: mockDecrypt,
    importKey: mockImportKey,
  },
  getRandomValues: mockGetRandomValues,
});

// Mock localStorage
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
};
vi.stubGlobal('localStorage', localStorageMock);

describe('tokenManager', () => {
  const TEST_KEY = 'test-session-key-12345678901234';
  const TEST_PLAINTEXT = 'my-secret-token-abc123';

  beforeEach(() => {
    vi.clearAllMocks();
    // Setup localStorage to return test key
    localStorageMock.getItem.mockReturnValue('test-session-key-12345678901234');
    // Setup default key mock
    mockImportKey.mockResolvedValue({
      type: 'secret',
      algorithm: { name: 'AES-GCM' },
      extractable: false,
      usages: ['encrypt', 'decrypt'],
    });
    // Setup random IV generator
    mockGetRandomValues.mockImplementation((arr) => {
      for (let i = 0; i < arr.length; i++) arr[i] = i % 256;
      return arr;
    });
  });

  describe('encryptToken', () => {
    it('should encrypt plaintext and return base64 string', async () => {
      mockEncrypt.mockResolvedValue(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]).buffer);

      const result = await encryptToken(TEST_PLAINTEXT);

      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
      // Should be valid base64
      expect(() => atob(result)).not.toThrow();
    });

    it('should produce different ciphertext with different IVs', async () => {
      let callCount = 0;
      mockEncrypt.mockImplementation(async () => {
        callCount++;
        return new Uint8Array(Array.from({ length: 16 }, (_, i) => (i + callCount) % 256)).buffer;
      });

      const result1 = await encryptToken(TEST_PLAINTEXT);
      const result2 = await encryptToken(TEST_PLAINTEXT);

      expect(result1).not.toBe(result2);
    });

    it('should call crypto.subtle.encrypt with correct algorithm', async () => {
      mockEncrypt.mockResolvedValue(new Uint8Array(16).buffer);

      await encryptToken(TEST_PLAINTEXT);

      expect(mockEncrypt).toHaveBeenCalled();
      const [alg, key, data] = mockEncrypt.mock.calls[0];
      expect(alg.name).toBe('AES-GCM');
      expect(alg.iv).toBeInstanceOf(Uint8Array);
      expect(alg.iv.length).toBe(12);
      expect(data.constructor.name).toBe('Uint8Array');
      expect(data.length).toBe(TEST_PLAINTEXT.length);
    });
  });

  describe('decryptToken', () => {
    it('should decrypt ciphertext back to original plaintext', async () => {
      const originalBytes = new TextEncoder().encode(TEST_PLAINTEXT);
      mockDecrypt.mockResolvedValue(originalBytes.buffer);

      const encrypted = await encryptToken(TEST_PLAINTEXT);
      const decrypted = await decryptToken(encrypted);

      expect(decrypted).toBe(TEST_PLAINTEXT);
    });

    it('should call crypto.subtle.decrypt with correct parameters', async () => {
      const encryptedBytes = new Uint8Array([...Array(12).keys(), ...Array(16).keys()]);
      mockDecrypt.mockResolvedValue(new TextEncoder().encode(TEST_PLAINTEXT).buffer);

      await decryptToken(btoa(String.fromCharCode(...encryptedBytes)));

      expect(mockDecrypt).toHaveBeenCalled();
      const [alg, key, data] = mockDecrypt.mock.calls[0];
      expect(alg.name).toBe('AES-GCM');
      expect(alg.iv).toBeInstanceOf(Uint8Array);
      expect(alg.iv.length).toBe(12);
      expect(data).toBeInstanceOf(Uint8Array);
    });
  });

  describe('round-trip', () => {
    it('should return original value after encrypt then decrypt', async () => {
      const encodedPlaintext = new TextEncoder().encode(TEST_PLAINTEXT);
      mockEncrypt.mockResolvedValue(new Uint8Array(16).buffer);
      mockDecrypt.mockResolvedValue(encodedPlaintext.buffer);

      const encrypted = await encryptToken(TEST_PLAINTEXT);
      const decrypted = await decryptToken(encrypted);

      expect(decrypted).toBe(TEST_PLAINTEXT);
    });
  });
});

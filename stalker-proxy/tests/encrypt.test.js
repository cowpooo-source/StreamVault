import { describe, it, expect, beforeEach } from 'vitest';
import { encryptToken, decryptToken, encryptField, decryptField } from '../src/middleware/encrypt.js';

describe('encrypt middleware', () => {
  const TEST_PLAINTEXT = 'my-secret-token-abc123';

  describe('encryptToken', () => {
    it('should return colon-separated base64 string (iv:tag:ciphertext)', () => {
      const result = encryptToken(TEST_PLAINTEXT);

      expect(typeof result).toBe('string');
      const parts = result.split(':');
      expect(parts).toHaveLength(3);
      // Each part should be valid base64
      expect(() => Buffer.from(parts[0], 'base64')).not.toThrow();
      expect(() => Buffer.from(parts[1], 'base64')).not.toThrow();
      expect(() => Buffer.from(parts[2], 'base64')).not.toThrow();
    });

    it('should produce different ciphertext with different IVs', () => {
      const result1 = encryptToken(TEST_PLAINTEXT);
      const result2 = encryptToken(TEST_PLAINTEXT);

      expect(result1).not.toBe(result2);
    });
  });

  describe('decryptToken', () => {
    it('should correctly reverse encryptToken', () => {
      const encrypted = encryptToken(TEST_PLAINTEXT);
      const decrypted = decryptToken(encrypted);

      expect(decrypted).toBe(TEST_PLAINTEXT);
    });
  });

  describe('round-trip', () => {
    it('should return original value after encrypt then decrypt', () => {
      const encrypted = encryptToken(TEST_PLAINTEXT);
      const decrypted = decryptToken(encrypted);

      expect(decrypted).toBe(TEST_PLAINTEXT);
    });
  });

  describe('encryptField', () => {
    it('should encrypt specified fields and add _enc suffix', () => {
      const obj = { username: 'john', apiKey: 'secret-key-123' };
      const result = encryptField(obj, 'apiKey');

      expect(result.username).toBe('john');
      expect(result.apiKey).toBe('secret-key-123');
      expect(result.apiKey_enc).toBeDefined();
      expect(result.apiKey_enc).not.toBe('secret-key-123');
    });

    it('should not encrypt fields that do not exist', () => {
      const obj = { username: 'john' };
      const result = encryptField(obj, 'apiKey');

      expect(result.username).toBe('john');
      expect(result.apiKey_enc).toBeUndefined();
    });

    it('should handle multiple fields', () => {
      const obj = { token1: 'abc', token2: 'def' };
      const result = encryptField(obj, 'token1', 'token2');

      expect(result.token1).toBe('abc');
      expect(result.token2).toBe('def');
      expect(result.token1_enc).toBeDefined();
      expect(result.token2_enc).toBeDefined();
    });
  });

  describe('decryptField', () => {
    it('should decrypt _enc fields back to original', () => {
      const obj = { apiKey: 'secret-key-123' };
      const encrypted = encryptField(obj, 'apiKey');
      const result = decryptField(encrypted, 'apiKey');

      expect(result.apiKey).toBe('secret-key-123');
    });

    it('should not decrypt fields that do not have _enc suffix', () => {
      const obj = { username: 'john', apiKey: 'secret-key-123' };
      const encrypted = encryptField(obj, 'apiKey');
      const result = decryptField(encrypted, 'apiKey');

      expect(result.username).toBe('john');
      expect(result.apiKey).toBe('secret-key-123');
    });

    it('should handle multiple fields', () => {
      const obj = { token1: 'abc', token2: 'def' };
      const encrypted = encryptField(obj, 'token1', 'token2');
      const result = decryptField(encrypted, 'token1', 'token2');

      expect(result.token1).toBe('abc');
      expect(result.token2).toBe('def');
    });
  });
});

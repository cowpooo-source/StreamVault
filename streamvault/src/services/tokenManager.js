// Uses Web Crypto API (AES-GCM) for browser-side token encryption
// Master key is derived from localStorage/sessionStorage

const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;

let _cachedKey; // Uint8Array, cached after first derivation

async function getKey() {
  if (_cachedKey) return _cachedKey;
  // Key comes from localStorage/sessionStorage
  const raw = localStorage.getItem('sv_key_seed') || sessionStorage.getItem('sv_session_key');
  if (!raw) throw new Error('No session key available');
  const enc = new TextEncoder();
  const keyData = enc.encode(raw.padEnd(32, '0').slice(0, 32));
  _cachedKey = await crypto.subtle.importKey('raw', keyData, ALGORITHM, false, ['encrypt', 'decrypt']);
  return _cachedKey;
}

export async function encryptToken(plaintext) {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, key, encoded);
  // Return iv + ciphertext as base64
  const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.byteLength);
  return btoa(String.fromCharCode(...combined));
}

export async function decryptToken(encrypted) {
  const key = await getKey();
  const raw = atob(encrypted);
  const combined = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) combined[i] = raw.charCodeAt(i);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, ciphertext);
  return new TextDecoder().decode(decrypted);
}

const ENC_ALGO = "AES-GCM";
const KEY_SALT = ":sv-enc-key";
let _encKeySource = null; // Set by App.jsx on login/guest

export function setEncKeySource(id) {
  _encKeySource = id;
}

export async function deriveKey() {
  if (!_encKeySource) {
    console.warn("⚠️ deriveKey called with no _encKeySource set, using default");
  }
  const raw = new TextEncoder().encode((_encKeySource || "default") + KEY_SALT);
  const hash = await crypto.subtle.digest("SHA-256", raw);
  return crypto.subtle.importKey("raw", hash, ENC_ALGO, false, ["encrypt", "decrypt"]);
}

export async function encryptData(plaintext) {
  try {
    const key = await deriveKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = await crypto.subtle.encrypt({ name: ENC_ALGO, iv }, key, new TextEncoder().encode(plaintext));
    return btoa(String.fromCharCode(...iv)) + "." + btoa(String.fromCharCode(...new Uint8Array(enc)));
  } catch (err) {
    console.warn("Encryption failed:", err.message);
    return plaintext;
  }
}

export async function decryptData(ciphertext) {
  try {
    if (!ciphertext || !ciphertext.includes(".")) return ciphertext;
    const [ivB64, dataB64] = ciphertext.split(".");
    const iv = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0));
    const data = Uint8Array.from(atob(dataB64), c => c.charCodeAt(0));
    const key = await deriveKey();
    const dec = await crypto.subtle.decrypt({ name: ENC_ALGO, iv }, key, data);
    return new TextDecoder().decode(dec);
  } catch (err) {
    console.warn("Decryption failed:", err.message);
    return ciphertext;
  }
}

export async function encryptConnections(conns) {
  const stripped = conns.map(c => {
    const safe = { ...c };
    if (safe.type === "xtream" && safe.pass) { safe._encPass = true; delete safe.pass; }
    if (safe.type === "stalker" && safe.mac) { safe._encMac = true; }
    return safe;
  });
  return await encryptData(JSON.stringify(stripped));
}

export async function decryptConnections(data) {
  try {
    const json = await decryptData(data);
    return JSON.parse(json);
  } catch (err) {
    console.warn("Failed to decrypt connections:", err.message);
    return [];
  }
}

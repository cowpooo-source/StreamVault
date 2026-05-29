import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function getMasterKey() {
  const key = process.env.TOKEN_MASTER_KEY;
  if (!key) throw new Error('TOKEN_MASTER_KEY env var not set');
  return Buffer.from(key, 'hex');
}

export function encryptToken(plaintext) {
  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

export function decryptToken(encrypted) {
  const key = getMasterKey();
  const [ivB64, tagB64, cipherB64] = encrypted.split(':');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const cipher = Buffer.from(cipherB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(cipher), decipher.final()]).toString('utf8');
}

export function encryptField(obj, ...fields) {
  const out = { ...obj };
  for (const f of fields) {
    if (obj[f]) out[f + '_enc'] = encryptToken(obj[f]);
  }
  return out;
}

export function decryptField(obj, ...fields) {
  const out = { ...obj };
  for (const f of fields) {
    if (obj[f + '_enc']) out[f] = decryptToken(obj[f + '_enc']);
  }
  return out;
}

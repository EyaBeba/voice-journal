// On-device encryption for journal entries (Web Crypto: PBKDF2 → AES-GCM 256).
// The key is derived from your PIN and only ever lives in memory while the app is unlocked.
const ITERATIONS = 310_000;
const enc = new TextEncoder();
const dec = new TextDecoder();
const CHECK_TEXT = 'voice-journal';

export async function deriveKey(pin, salt, iterations = ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptBytes(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return { iv, data };
}

export const decryptBytes = (key, box) => crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.iv }, key, box.data);

/** Everything needed to set up encryption for a PIN: a fresh salt and a check value. */
export async function newEncryptionRecord(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(pin, salt);
  return { key, record: { salt, iterations: ITERATIONS, check: await encryptBytes(key, enc.encode(CHECK_TEXT)) } };
}

/** The key for a PIN, or null if the PIN doesn't open this journal. */
export async function unlockKey(pin, record) {
  const key = await deriveKey(pin, record.salt, record.iterations);
  try {
    return dec.decode(await decryptBytes(key, record.check)) === CHECK_TEXT ? key : null;
  } catch {
    return null;
  }
}

/** Encrypt an entry for storage. id and createdAt stay readable so the list can be sorted and counted. */
export async function sealEntry(key, entry) {
  const { id, createdAt, audio, photos, ...rest } = entry;
  return {
    id,
    createdAt,
    sealed: true,
    meta: await encryptBytes(key, enc.encode(JSON.stringify(rest))),
    audio: audio ? await encryptBytes(key, audio) : null,
    photos: await Promise.all((photos || []).map(async (p) => ({ type: p.type, ...(await encryptBytes(key, p.data)) }))),
  };
}

export async function openEntry(key, stored) {
  if (!stored.sealed) return stored;
  const rest = JSON.parse(dec.decode(await decryptBytes(key, stored.meta)));
  return {
    id: stored.id,
    createdAt: stored.createdAt,
    ...rest,
    audio: stored.audio ? await decryptBytes(key, stored.audio) : new ArrayBuffer(0),
    photos: await Promise.all((stored.photos || []).map(async (p) => ({ type: p.type, data: await decryptBytes(key, p) }))),
  };
}

// Secure folder encryption (Web Crypto, runs on the device only).
//
//   password ──PBKDF2-SHA256 (salt, 310k iterations)──▶ AES-GCM 256 key (kept in memory, never stored)
//
// The vault row stores the salt and `check_value` = the encrypted text CHECK, which tells us
// whether a typed password is right. Each secure note stores its private fields as
// "v1.<keyId>.<iv>.<ciphertext>" ({title, content, items, tags} inside). keyId (derived from the salt) shows which password encrypted it.
//
// Email recovery: the same key is also stored wrapped ("recovery_wrap", AES-GCM) with a random
// recovery key. The server only hands that recovery key out to a session that has just verified
// an email code (see notesgo.get_vault_recovery in schema.sql), so "Forgot password?" can unlock
// the folder and set a new password without losing notes.

const Vault = (() => {
  const CHECK = 'notesgo-vault-ok';
  const ITERATIONS = 310000;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  let key = null; // CryptoKey while unlocked
  let keyId = null;

  const toB64 = (buf) => {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function derive(password, saltB64, iterations) {
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(saltB64), iterations },
      base,
      { name: 'AES-GCM', length: 256 },
      true, // exportable so it can be wrapped for email recovery (it still only lives in memory)
      ['encrypt', 'decrypt'],
    );
  }

  async function idFor(saltB64) {
    const h = await crypto.subtle.digest('SHA-256', fromB64(saltB64));
    return toB64(h).replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
  }

  async function seal(k, kid, text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, enc.encode(text));
    return `v1.${kid}.${toB64(iv)}.${toB64(ct)}`;
  }

  async function open(k, kid, sealed) {
    const [v, id, iv, ct] = String(sealed).split('.');
    if (v !== 'v1' || id !== kid) throw new Error('wrong-key');
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, k, fromB64(ct));
    return dec.decode(pt);
  }

  /** Make a new vault record for `password`. Returns { record, key, keyId } (not yet active). */
  async function create(password) {
    const salt = toB64(crypto.getRandomValues(new Uint8Array(16)));
    const k = await derive(password, salt, ITERATIONS);
    const kid = await idFor(salt);
    return { record: { salt, iterations: ITERATIONS, check_value: await seal(k, kid, CHECK) }, key: k, keyId: kid };
  }

  /** Unlock with `password` against `record`. Returns true if the password was right. */
  async function unlock(record, password) {
    const k = await derive(password, record.salt, record.iterations);
    const kid = await idFor(record.salt);
    try {
      if ((await open(k, kid, record.check_value)) !== CHECK) return false;
    } catch {
      return false;
    }
    key = k;
    keyId = kid;
    return true;
  }

  const importAes = (raw) => crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);

  /** Wrap the current key for email recovery. Returns { rkey, wrap } (rkey goes to the server's locked table). */
  async function makeRecovery(k = key, kid = keyId) {
    if (!k) throw new Error('locked');
    const r = crypto.getRandomValues(new Uint8Array(32));
    const rk = await importAes(r);
    const raw = await crypto.subtle.exportKey('raw', k);
    return { rkey: toB64(r), wrap: await seal(rk, kid, toB64(raw)) };
  }

  /** The key id a recovery wrap belongs to ('' if none). */
  const recoveryKid = (wrap) => (wrap ? String(wrap).split('.')[1] || '' : '');

  /** Unlock with the recovery key from the server. Returns true if it opened the vault. */
  async function unlockWithRecovery(record, rkeyB64) {
    try {
      const kid = await idFor(record.salt);
      const raw = fromB64(await open(await importAes(fromB64(rkeyB64)), kid, record.recovery_wrap));
      const k = await importAes(raw);
      if ((await open(k, kid, record.check_value)) !== CHECK) return false;
      key = k;
      keyId = kid;
      return true;
    } catch {
      return false;
    }
  }

  function activate(k, kid) {
    key = k;
    keyId = kid;
  }

  function lock() {
    key = null;
    keyId = null;
  }

  /** Encrypt a note's private fields. */
  async function encryptNote({ title, content, items, tags }, k = key, kid = keyId) {
    if (!k) throw new Error('locked');
    return seal(k, kid, JSON.stringify({ title, content, items: items || [], tags }));
  }

  /** Decrypt a note's private fields, or null if it can't be read with the current key. */
  async function decryptNote(cipher) {
    if (!key || !cipher) return null;
    try {
      const o = JSON.parse(await open(key, keyId, cipher));
      return {
        title: o.title || '',
        content: o.content || '',
        items: Array.isArray(o.items) ? o.items : [],
        tags: Array.isArray(o.tags) ? o.tags : [],
      };
    } catch {
      return null;
    }
  }

  return {
    create,
    unlock,
    activate,
    lock,
    makeRecovery,
    recoveryKid,
    unlockWithRecovery,
    encryptNote,
    decryptNote,
    idFor,
    get unlocked() {
      return Boolean(key);
    },
    get keyId() {
      return keyId;
    },
  };
})();

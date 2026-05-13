// auth.js — Encrypted user profile system using Web Crypto API
// Keys are NEVER stored in plaintext. Password is NEVER stored at all.
// Encryption: PBKDF2 (310k iterations, SHA-256) → AES-256-GCM

const Auth = (() => {

  // ── Session (in-memory only, cleared on tab close) ──
  let session = null; // { username, keys: {gemini,groq,openrouter,ollama_host,ollama_model,sheet_id,google_client_id} }

  const PBKDF2_ITERATIONS = 310000;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // ── Derive AES key from password + salt ──
  async function deriveKey(password, salt) {
    const keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  // ── Encrypt plaintext with derived key ──
  async function encrypt(key, plaintext) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      enc.encode(JSON.stringify(plaintext))
    );
    return {
      iv: bufToBase64(iv),
      data: bufToBase64(new Uint8Array(ciphertext)),
    };
  }

  // ── Decrypt ciphertext ──
  async function decrypt(key, iv64, data64) {
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBuf(iv64) },
      key,
      base64ToBuf(data64)
    );
    return JSON.parse(dec.decode(plainBuf));
  }

  function bufToBase64(buf) {
    return btoa(String.fromCharCode(...buf));
  }

  function base64ToBuf(b64) {
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  }

  // ── Register new user ──
  async function register(username, password, keys = {}) {
    const existing = await DB.get('profiles', username.toLowerCase()).catch(() => null);
    if (existing) throw new Error('Username already taken');

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const aesKey = await deriveKey(password, salt);
    const encrypted = await encrypt(aesKey, keys);

    const profile = {
      username: username.toLowerCase(),
      displayName: username,
      salt: bufToBase64(salt),
      iv: encrypted.iv,
      data: encrypted.data,
      created: new Date().toISOString(),
      lastLogin: new Date().toISOString(),
    };

    await DB.put('profiles', profile);
    session = { username: username.toLowerCase(), displayName: username, keys: { ...keys } };
    localStorage.setItem('sage_last_user', username.toLowerCase());
    return session;
  }

  // ── Login ──
  async function login(username, password) {
    const profile = await DB.get('profiles', username.toLowerCase()).catch(() => null);
    if (!profile) throw new Error('User not found');

    let decrypted;
    try {
      const salt = base64ToBuf(profile.salt);
      const aesKey = await deriveKey(password, salt);
      decrypted = await decrypt(aesKey, profile.iv, profile.data);
    } catch {
      throw new Error('Incorrect password');
    }

    // Update lastLogin
    await DB.put('profiles', { ...profile, lastLogin: new Date().toISOString() });
    session = { username: username.toLowerCase(), displayName: profile.displayName, keys: { ...decrypted } };
    localStorage.setItem('sage_last_user', username.toLowerCase());
    return session;
  }

  // ── Save updated keys (re-encrypts with same password) ──
  async function saveKeys(password, keys) {
    if (!session) throw new Error('Not logged in');
    const profile = await DB.get('profiles', session.username);
    const salt = base64ToBuf(profile.salt);
    const aesKey = await deriveKey(password, salt);

    // Verify password is correct before saving
    try { await decrypt(aesKey, profile.iv, profile.data); }
    catch { throw new Error('Incorrect password — keys not saved'); }

    const encrypted = await encrypt(aesKey, keys);
    await DB.put('profiles', { ...profile, iv: encrypted.iv, data: encrypted.data });
    session.keys = { ...keys };
  }

  // ── Change password (re-encrypts data with new password) ──
  async function changePassword(oldPassword, newPassword) {
    if (!session) throw new Error('Not logged in');
    const profile = await DB.get('profiles', session.username);
    const oldSalt = base64ToBuf(profile.salt);
    const oldKey = await deriveKey(oldPassword, oldSalt);

    let plaintext;
    try { plaintext = await decrypt(oldKey, profile.iv, profile.data); }
    catch { throw new Error('Incorrect current password'); }

    const newSalt = crypto.getRandomValues(new Uint8Array(16));
    const newKey = await deriveKey(newPassword, newSalt);
    const encrypted = await encrypt(newKey, plaintext);
    await DB.put('profiles', { ...profile, salt: bufToBase64(newSalt), iv: encrypted.iv, data: encrypted.data });
  }

  // ── Export encrypted profile + scoped app data backup ──
  async function exportProfile() {
    if (!session) throw new Error('Not logged in');
    const profile = await DB.get('profiles', session.username);
    const appData = await DB.exportScopedData(session.username);
    const payload = { version: 2, profile, appData, exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `sage-profile-${session.username}.json`; a.click();
    URL.revokeObjectURL(url);
  }

  // ── Import encrypted profile + optional scoped app data ──
  async function importProfile(jsonText) {
    const bundle = JSON.parse(jsonText);
    const profile = bundle.profile || bundle;
    if (!profile.username || !profile.salt || !profile.iv || !profile.data)
      throw new Error('Invalid profile file');
    const existing = await DB.get('profiles', profile.username).catch(() => null);
    if (existing) throw new Error(`Profile "${profile.username}" already exists on this device`);
    await DB.put('profiles', profile);
    if (bundle.appData) await DB.importScopedData(profile.username, bundle.appData, { replace: true });
    return profile.username;
  }

  // ── List profiles on this device ──
  async function listProfiles() {
    return (await DB.getAll('profiles')).map(p => ({
      username: p.username,
      displayName: p.displayName,
      created: p.created,
      lastLogin: p.lastLogin,
    }));
  }

  // ── Delete profile ──
  async function deleteProfile(password) {
    if (!session) throw new Error('Not logged in');
    const profile = await DB.get('profiles', session.username);
    const salt = base64ToBuf(profile.salt);
    const key = await deriveKey(password, salt);
    try { await decrypt(key, profile.iv, profile.data); }
    catch { throw new Error('Incorrect password'); }
    await DB.delete('profiles', session.username);
    session = null;
    localStorage.removeItem('sage_last_user');
  }

  // ── Logout ──
  function logout() {
    session = null;
    // Don't clear last_user — helpful for login form pre-fill
  }

  // ── Getters ──
  function isLoggedIn() { return session !== null; }
  function getSession() { return session; }
  function getKeys() { return session?.keys || {}; }
  function getLastUser() { return localStorage.getItem('sage_last_user') || ''; }

  return {
    register, login, saveKeys, changePassword,
    exportProfile, importProfile, listProfiles, deleteProfile, logout,
    isLoggedIn, getSession, getKeys, getLastUser,
  };
})();

// ── Extend DB to support profiles store ──
// (profiles store is added to the DB upgrade path in db.js)

// profile.js — Profile management: API keys, Google Sheets OAuth, export/import

const Profile = (() => {

  // ── Render the profile modal content ──
  function renderProfileModal() {
    const keys = Auth.getKeys();
    const s = Auth.getSession();
    return `
      <div class="profile-header">
        <div class="profile-avatar">${(s?.displayName || 'U')[0].toUpperCase()}</div>
        <div>
          <div class="profile-name">${s?.displayName || 'User'}</div>
          <div class="profile-sub">@${s?.username || ''}</div>
        </div>
        <button class="btn-sm" style="margin-left:auto" onclick="Profile.logout()">🚪 Logout</button>
      </div>
      <hr class="profile-divider">

      <div class="profile-section">
        <h3>🔑 API Keys <span class="profile-hint">(encrypted with your password — never sent anywhere)</span></h3>
        <div class="keys-grid">
          <div class="key-row">
            <label>✨ Google Gemini <a href="https://aistudio.google.com/apikey" target="_blank" class="get-key-link">Get free key →</a></label>
            <div class="key-input-row">
              <input type="password" id="key-gemini" value="${keys.gemini || ''}" placeholder="AIza..." autocomplete="off">
              <button class="btn-sm test-btn" onclick="Profile.testKey('gemini')">Test</button>
            </div>
            <div id="test-result-gemini" class="test-result"></div>
          </div>
          <div class="key-row">
            <label>⚡ Groq <a href="https://console.groq.com/keys" target="_blank" class="get-key-link">Get free key →</a></label>
            <div class="key-input-row">
              <input type="password" id="key-groq" value="${keys.groq || ''}" placeholder="gsk_..." autocomplete="off">
              <button class="btn-sm test-btn" onclick="Profile.testKey('groq')">Test</button>
            </div>
            <div id="test-result-groq" class="test-result"></div>
          </div>
          <div class="key-row">
            <label>🌐 OpenRouter <a href="https://openrouter.ai/keys" target="_blank" class="get-key-link">Get free key →</a></label>
            <div class="key-input-row">
              <input type="password" id="key-openrouter" value="${keys.openrouter || ''}" placeholder="sk-or-..." autocomplete="off">
              <button class="btn-sm test-btn" onclick="Profile.testKey('openrouter')">Test</button>
            </div>
            <div id="test-result-openrouter" class="test-result"></div>
          </div>
          <div class="key-row">
            <label>💰 The Odds API <a href="https://the-odds-api.com" target="_blank" class="get-key-link">Get free key (500 req/mo) →</a></label>
            <div class="key-input-row">
              <input type="password" id="key-odds-api" value="${keys.odds_api_key || ''}" placeholder="Your Odds API key" autocomplete="off">
              <button class="btn-sm test-btn" onclick="Profile.testOddsKey()">Test</button>
            </div>
            <div id="test-result-odds" class="test-result"></div>
          </div>
          <div class="key-row">
            <label>🏦 FRED API (economic data) <a href="https://fred.stlouisfed.org/docs/api/api_key.html" target="_blank" class="get-key-link">Get free key →</a></label>
            <input type="password" id="key-fred" value="${keys.fred_key || ''}" placeholder="Your FRED API key" autocomplete="off">
          </div>
          <div class="key-row">
            <label>🖥️ Ollama Model</label>
            <input type="text" id="key-ollama-model" value="${keys.ollama_model || 'llama3.3'}" placeholder="llama3.3">
          </div>
        </div>
        <div class="key-row" style="margin-top:8px">
          <label>Confirm current password to save keys</label>
          <div class="key-input-row">
            <input type="password" id="save-password" placeholder="Your password" autocomplete="current-password">
            <button class="btn-primary" onclick="Profile.saveKeys()">💾 Save Keys</button>
          </div>
        </div>
      </div>

      <hr class="profile-divider">

      <div class="profile-section">
        <h3>📊 Google Sheets Sync <span class="profile-hint">(cross-device — logs all picks automatically)</span></h3>
        <div style="background:rgba(6,182,212,0.07);border:1px solid rgba(6,182,212,0.2);border-radius:8px;padding:12px;margin-bottom:14px;font-size:12px;color:var(--text-secondary);line-height:1.7">
          <strong style="color:var(--accent-cyan)">How to set up (2 minutes):</strong><br>
          1. Open or create a Google Sheet → <strong>Extensions → Apps Script</strong><br>
          2. Paste the contents of <strong>SAGE_AppScript.gs</strong> (included in your download) → Save<br>
          3. Click <strong>Run → setupSAGE</strong> (creates all tabs)<br>
          4. Click <strong>Deploy → New deployment → Web app → Anyone → Deploy</strong><br>
          5. Copy the Web App URL and paste it below
        </div>
        <div class="key-row">
          <label>Your Google Sheet ID <span style="font-weight:400;color:var(--text-muted)">(from the sheet URL)</span></label>
          <input type="text" id="key-sheet-id" value="${keys.sheet_id || getPersistedField('sheet_id') || ''}" placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms">
        </div>
        <div class="key-row" style="margin-top:10px">
          <label>Apps Script Web App URL</label>
          <div class="key-input-row">
            <input type="text" id="key-apps-script-url"
              value="${keys.apps_script_url || getPersistedField('apps_script_url') || ''}"
              placeholder="https://script.google.com/macros/s/AKfy.../exec">
            <button class="btn-sm test-btn" onclick="Profile.testAppsScript()">Test</button>
          </div>
          <div id="apps-script-status" class="test-result" style="margin-top:4px"></div>
        </div>
      </div>

      <hr class="profile-divider">

      <div class="profile-section">
        <h3>🔐 Account</h3>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn-sm" onclick="Profile.exportProfile()">📤 Export Encrypted Profile</button>
          <button class="btn-sm" onclick="Profile.showImport()">📥 Import Profile</button>
          <button class="btn-sm" onclick="Profile.showChangePassword()">🔑 Change Password</button>
          <button class="btn-sm" style="color:var(--accent-red);border-color:rgba(239,68,68,0.3)" onclick="Profile.showDeleteAccount()">🗑️ Delete Account</button>
        </div>
        <div id="profile-sub-form" style="margin-top:12px"></div>
      </div>`;
  }

  // ── Save keys ──
  async function saveKeys() {
    const password = document.getElementById('save-password')?.value;
    if (!password) { UI.showToast('Enter your password to save', 'warning'); return; }
    const keys = {
      gemini:           document.getElementById('key-gemini')?.value.trim() || '',
      groq:             document.getElementById('key-groq')?.value.trim() || '',
      openrouter:       document.getElementById('key-openrouter')?.value.trim() || '',
      odds_api_key:     document.getElementById('key-odds-api')?.value.trim() || '',
      fred_key:         document.getElementById('key-fred')?.value.trim() || '',
      ollama_host:      document.getElementById('key-ollama-host')?.value.trim() || 'http://localhost:11434',
      ollama_model:     document.getElementById('key-ollama-model')?.value.trim() || 'llama3.3',
      sheet_id:         document.getElementById('key-sheet-id')?.value.trim() || '',
      apps_script_url:  document.getElementById('key-apps-script-url')?.value.trim() || '',
    };
    try {
      await Auth.saveKeys(password, keys);
      persistProfileField('sheet_id', keys.sheet_id);
      persistProfileField('apps_script_url', keys.apps_script_url);
      localStorage.setItem('sage_sheet_id', keys.sheet_id || '');
      if (keys.apps_script_url) globalThis.SheetsClient?.setAppsScriptUrl?.(keys.apps_script_url);
      UI.showToast('Keys saved and encrypted ✅', 'success');
      document.getElementById('save-password').value = '';
      const prov = document.getElementById('status-provider'); if (prov) prov.value = LLM.getProviderMode();
      await globalThis.SAGE?.updateSheetsStatus?.().catch(() => {});
    } catch (err) {
      UI.showToast(err.message, 'error');
    }
  }

  // ── Test a key ──
  async function testKey(provider) {
    const keyEl = document.getElementById(`key-${provider}`);
    const resultEl = document.getElementById(`test-result-${provider}`);
    if (!keyEl || !resultEl) return;
    const apiKey = keyEl.value.trim();
    if (!apiKey) { resultEl.textContent = '⚠️ Enter a key first'; resultEl.className = 'test-result warn'; return; }
    resultEl.textContent = '⏳ Testing...'; resultEl.className = 'test-result';
    const result = await LLM.testKey(provider, apiKey, { ignoreCooldown: true });
    if (result.success) {
      resultEl.textContent = `✅ Working — model: ${result.model}`;
      resultEl.className = 'test-result ok';
    } else {
      resultEl.textContent = `❌ ${result.error}`;
      resultEl.className = 'test-result err';
    }
  }

  // ── Test Odds API key ──
  async function testOddsKey() {
    const keyEl = document.getElementById('key-odds-api');
    const resultEl = document.getElementById('test-result-odds');
    if (!keyEl || !resultEl) return;
    const apiKey = keyEl.value.trim();
    if (!apiKey) { resultEl.textContent = '⚠️ Enter a key first'; resultEl.className = 'test-result warn'; return; }
    resultEl.textContent = '⏳ Testing...'; resultEl.className = 'test-result';
    try {
      const res = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${apiKey}`);
      if (res.ok) {
        const data = await res.json();
        resultEl.textContent = `✅ Working — ${data.length} sports available. Remaining requests: ${res.headers.get('x-requests-remaining') || '?'}`;
        resultEl.className = 'test-result ok';
      } else {
        resultEl.textContent = `❌ Invalid key (HTTP ${res.status})`;
        resultEl.className = 'test-result err';
      }
    } catch (e) {
      resultEl.textContent = `❌ ${e.message}`;
      resultEl.className = 'test-result err';
    }
  }
  function sheetsTokenKey() {
    const username = Auth.getSession?.()?.username || Auth.getLastUser() || 'global';
    return `sage_sheets_token:${String(username).toLowerCase()}`;
  }

  async function authorizeSheets() {
    const username = (Auth.getSession?.()?.username || Auth.getLastUser() || 'global').toLowerCase();
    const clientId = Auth.getKeys().google_client_id || localStorage.getItem(`sage_profile_${username}_google_client_id`) || localStorage.getItem('sage_google_client_id');
    const sheetId = document.getElementById('key-sheet-id')?.value.trim() || Auth.getKeys().sheet_id || localStorage.getItem(`sage_profile_${username}_sheet_id`) || localStorage.getItem('sage_sheet_id');
    if (clientId) {
      localStorage.setItem(`sage_profile_${username}_google_client_id`, clientId);
      localStorage.setItem('sage_google_client_id', clientId);
    }
    if (sheetId) {
      localStorage.setItem(`sage_profile_${username}_sheet_id`, sheetId);
      localStorage.setItem('sage_sheet_id', sheetId);
    }
    if (!clientId) {
      UI.showToast('Enter your Google OAuth Client ID first', 'warning');
      return;
    }
    const redirectUri = window.location.origin + window.location.pathname;
    const scope = 'https://www.googleapis.com/auth/spreadsheets';
    const state = encodeURIComponent((Auth.getSession?.()?.username || Auth.getLastUser() || 'global').toLowerCase());
    const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${encodeURIComponent(scope)}&state=${state}&prompt=select_account`;
    const popup = window.open(url, 'google-auth', 'width=500,height=600');
    UI.showToast('Complete authorization in the popup window', 'info');

    const timer = setInterval(() => {
      const token = getSheetsToken();
      if (token) {
        clearInterval(timer);
        const el = document.getElementById('sheets-auth-status');
        if (el) { el.textContent = '✅ Connected'; el.style.color = 'var(--accent-green)'; }
        UI.showToast('Google Sheets connected ✅', 'success');
        if (popup && !popup.closed) popup.close();
      }
      if (popup && popup.closed && !token) clearInterval(timer);
    }, 1000);
  }

  async function testAppsScript() {
    const urlEl = document.getElementById('key-apps-script-url');
    const statusEl = document.getElementById('apps-script-status');
    const url = urlEl?.value.trim();

    if (!url) {
      if (statusEl) { statusEl.textContent = '⚠️ Enter your Apps Script URL first'; statusEl.className = 'test-result warn'; }
      return;
    }
    if (!url.startsWith('https://script.google.com/macros/s/')) {
      if (statusEl) { statusEl.textContent = '⚠️ URL should start with https://script.google.com/macros/s/…'; statusEl.className = 'test-result warn'; }
      return;
    }

    if (statusEl) { statusEl.textContent = '⏳ Testing connection…'; statusEl.className = 'test-result'; }

    // Apps Script GET with ?action=status — must follow redirects (Google auth redirects to the web app)
    const testUrl = url.split('?')[0] + '?action=status';

    // Use a timeout via Promise.race since AbortSignal.timeout has limited browser support
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);

    try {
      const res = await fetch(testUrl, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        if (statusEl) {
          statusEl.textContent = res.status === 403
            ? '❌ 403 Forbidden — make sure "Who has access" is set to Anyone (not Just Me)'
            : '❌ HTTP ' + res.status + ' — check deployment settings';
          statusEl.className = 'test-result err';
        }
        return;
      }

      // Try to parse JSON
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* not JSON */ }

      if (data?.success) {
        if (statusEl) { statusEl.textContent = '✅ Connected — tabs: ' + (data.tabs || []).join(', '); statusEl.className = 'test-result ok'; }
        globalThis.SheetsClient?.setAppsScriptUrl?.(url);
        const user = (Auth.getSession?.()?.username || Auth.getLastUser?.() || 'global').toLowerCase();
        localStorage.setItem('sage_apps_script_url', url);
        localStorage.setItem('sage_profile_' + user + '_apps_script_url', url);
        UI.showToast('Sheets connected ✅', 'success');
        await globalThis.SAGE?.updateSheetsStatus?.().catch(() => {});
      } else if (text.includes('script.google.com') || text.includes('<!DOCTYPE')) {
        if (statusEl) {
          statusEl.textContent = '⚠️ Got HTML instead of JSON — deployment may need "Execute as: Me" and "Who has access: Anyone"';
          statusEl.className = 'test-result warn';
        }
      } else {
        if (statusEl) { statusEl.textContent = '⚠️ Unexpected response — re-deploy the script and try again'; statusEl.className = 'test-result warn'; }
      }
    } catch (err) {
      clearTimeout(timer);
      const msg = err.name === 'AbortError'
        ? 'Timed out — check the URL is correct and the script is deployed'
        : (err.message || 'Connection failed');
      if (statusEl) { statusEl.textContent = '❌ ' + msg; statusEl.className = 'test-result err'; }
    }
  }


  // ── Check for OAuth token in URL hash (callback) ──
  async function checkOAuthCallback() {
    const hash = window.location.hash;
    if (!hash.includes('access_token')) return;
    const params = new URLSearchParams(hash.substring(1));
    const token = params.get('access_token');
    const state = (params.get('state') || Auth.getSession?.()?.username || Auth.getLastUser() || 'global').toLowerCase();
    if (token) {
      localStorage.setItem(`sage_sheets_token:${state}`, token);
      localStorage.setItem('sage_sheets_token', token);
      sessionStorage.setItem('sage_sheets_token', token);
      localStorage.setItem('sage_sheets_token_user', state);
      try { window.opener?.postMessage({ type: 'sage-sheets-token', token, username: state }, window.location.origin); } catch {}
      window.history.replaceState({}, document.title, window.location.pathname);
      const el = document.getElementById('sheets-auth-status');
      if (el) { el.textContent = '✅ Connected'; el.style.color = 'var(--accent-green)'; }
      UI.showToast('Google Sheets connected ✅', 'success');
      await globalThis.SAGE?.updateSheetsStatus?.().catch(() => {});
    }
  }

  function getSheetsToken() {
    const scoped = localStorage.getItem(sheetsTokenKey());
    const lastUserScoped = localStorage.getItem(`sage_sheets_token:${(Auth.getLastUser() || 'global').toLowerCase()}`);
    const popupUser = localStorage.getItem('sage_sheets_token_user');
    return scoped || lastUserScoped || (popupUser ? localStorage.getItem(`sage_sheets_token:${popupUser}`) : null) || localStorage.getItem('sage_sheets_token') || sessionStorage.getItem('sage_sheets_token');
  }


  function scopedUserKey(suffix) {
    const username = (Auth.getSession?.()?.username || Auth.getLastUser() || 'global').toLowerCase();
    return `sage_profile_${username}_${suffix}`;
  }

  function getPersistedField(field, fallback = '') {
    return localStorage.getItem(scopedUserKey(field)) || fallback;
  }

  function persistProfileField(field, value) {
    if (value == null) return;
    localStorage.setItem(scopedUserKey(field), String(value));
  }

  // ── Export profile ──
  function exportProfile() {
    Auth.exportProfile().catch(err => UI.showToast(err.message, 'error'));
  }

  // ── Import profile ──
  function showImport() {
    document.getElementById('profile-sub-form').innerHTML = `
      <div class="sub-form">
        <p style="font-size:12px;color:var(--text-muted);margin-bottom:8px">Import a previously exported SAGE profile JSON file.</p>
        <input type="file" id="import-file" accept=".json" style="font-size:12px">
        <button class="btn-sm" style="margin-top:8px" onclick="Profile.doImport()">Import</button>
      </div>`;
  }

  async function doImport() {
    const file = document.getElementById('import-file')?.files?.[0];
    if (!file) return;
    const text = await file.text();
    try {
      const username = await Auth.importProfile(text);
      UI.showToast(`Profile "${username}" imported. You can now log in with it.`, 'success');
    } catch (err) {
      UI.showToast(err.message, 'error');
    }
  }

  // ── Change password ──
  function showChangePassword() {
    document.getElementById('profile-sub-form').innerHTML = `
      <div class="sub-form">
        <input type="password" id="cp-old" placeholder="Current password" style="margin-bottom:6px">
        <input type="password" id="cp-new" placeholder="New password (8+ chars)" style="margin-bottom:6px">
        <input type="password" id="cp-confirm" placeholder="Confirm new password">
        <button class="btn-primary" style="margin-top:8px" onclick="Profile.doChangePassword()">Update Password</button>
      </div>`;
  }

  async function doChangePassword() {
    const oldPw = document.getElementById('cp-old')?.value;
    const newPw = document.getElementById('cp-new')?.value;
    const confirm = document.getElementById('cp-confirm')?.value;
    if (!oldPw || !newPw) { UI.showToast('Fill all fields', 'warning'); return; }
    if (newPw !== confirm) { UI.showToast('Passwords do not match', 'error'); return; }
    if (newPw.length < 8) { UI.showToast('Password must be 8+ characters', 'warning'); return; }
    try {
      await Auth.changePassword(oldPw, newPw);
      UI.showToast('Password changed ✅', 'success');
      document.getElementById('profile-sub-form').innerHTML = '';
    } catch (err) { UI.showToast(err.message, 'error'); }
  }

  // ── Delete account ──
  function showDeleteAccount() {
    document.getElementById('profile-sub-form').innerHTML = `
      <div class="sub-form" style="border-color:rgba(239,68,68,0.3)">
        <p style="color:var(--accent-red);font-size:13px;margin-bottom:8px">⚠️ This permanently deletes your profile and all encrypted keys from this device.</p>
        <input type="password" id="del-password" placeholder="Confirm your password">
        <button class="btn-sm" style="margin-top:8px;color:var(--accent-red);border-color:rgba(239,68,68,0.4)" onclick="Profile.doDeleteAccount()">Permanently Delete</button>
      </div>`;
  }

  async function doDeleteAccount() {
    const pw = document.getElementById('del-password')?.value;
    if (!pw) return;
    try {
      await Auth.deleteProfile(pw);
      document.getElementById('profile-modal').classList.remove('open');
      showAuthScreen();
      UI.showToast('Account deleted', 'info');
    } catch (err) { UI.showToast(err.message, 'error'); }
  }

  // ── Logout ──
  function logout() {
    const username = Auth.getSession?.()?.username || Auth.getLastUser();
    Auth.logout();
    if (username) localStorage.removeItem(`sage_sheets_token:${String(username).toLowerCase()}`);
    sessionStorage.removeItem('sage_sheets_token');
    localStorage.removeItem('sage_sheets_token');
    document.getElementById('profile-modal').classList.remove('open');
    showAuthScreen();
    UI.showToast('Logged out', 'info');
  }

  // ── Show / hide auth screen ──
  function showAuthScreen() {
    document.getElementById('auth-screen').style.display = 'flex';
    document.getElementById('app-shell').style.display = 'none';
  }

  function showApp() {
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('app-shell').style.display = 'grid';
  }

  // ── Auth screen login/register actions ──
  async function doLogin() {
    const username = document.getElementById('auth-username')?.value.trim();
    const password = document.getElementById('auth-password')?.value;
    const errEl    = document.getElementById('auth-error');
    if (errEl) errEl.textContent = '';
    if (!username || !password) { if (errEl) errEl.textContent = 'Enter username and password'; return; }

    const btn = document.getElementById('auth-submit');
    if (btn) { btn.disabled = true; btn.textContent = 'Verifying...'; }

    // Show loading overlay immediately so user sees feedback right away
    const overlay = document.getElementById('loading-overlay');
    const loadTxt = document.getElementById('loading-text') || overlay?.querySelector('.loading-text');
    if (overlay) overlay.style.display = 'flex';
    if (loadTxt) loadTxt.textContent = 'Verifying password…';

    // Yield to browser so overlay paints before crypto starts
    await new Promise(r => setTimeout(r, 30));

    try {
      await Auth.login(username, password);
      if (loadTxt) loadTxt.textContent = 'Loading SAGE2…';
      showApp();
      await SAGE.init();
    } catch (err) {
      if (overlay) overlay.style.display = 'none';
      if (errEl) errEl.textContent = err.message;
      if (btn) { btn.disabled = false; btn.textContent = 'Login'; }
    }
  }

  async function doRegister() {
    const username = document.getElementById('auth-username')?.value.trim();
    const password = document.getElementById('auth-password')?.value;
    const confirm  = document.getElementById('auth-confirm')?.value;
    const errEl = document.getElementById('auth-error');
    if (!username || !password) { if (errEl) errEl.textContent = 'Enter username and password'; return; }
    if (password !== confirm) { if (errEl) errEl.textContent = 'Passwords do not match'; return; }
    if (password.length < 8) { if (errEl) errEl.textContent = 'Password must be at least 8 characters'; return; }
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) { if (errEl) errEl.textContent = 'Username: 3-20 chars, letters/numbers/underscore only'; return; }
    try {
      const btn = document.getElementById('auth-submit');
      if (btn) { btn.disabled = true; btn.textContent = 'Creating account...'; }
      const _overlay = document.getElementById('loading-overlay');
      const _loadTxt = document.getElementById('loading-text') || _overlay?.querySelector('.loading-text');
      if (_overlay) _overlay.style.display = 'flex';
      if (_loadTxt) _loadTxt.textContent = 'Setting up account…';
      await new Promise(r => setTimeout(r, 30));
      await Auth.register(username, password);
      if (_loadTxt) _loadTxt.textContent = 'Loading SAGE2…';
      showApp();
      await SAGE.init();
      UI.showToast(`Welcome, ${username}! Add your API keys in Profile → API Keys.`, 'success');
    } catch (err) {
      if (errEl) errEl.textContent = err.message;
      const btn = document.getElementById('auth-submit');
      if (btn) { btn.disabled = false; btn.textContent = 'Create Account'; }
    }
  }

  function openProfileModal() {
    const body = document.getElementById('profile-modal-body');
    if (body) body.innerHTML = renderProfileModal();
    document.getElementById('profile-modal').classList.add('open');
    checkOAuthCallback();
    // Check sheets status
    const token = getSheetsToken();
    const el = document.getElementById('sheets-auth-status');
    if (el && token) { el.textContent = '✅ Connected'; el.style.color = 'var(--accent-green)'; }
  }

  if (typeof window !== 'undefined' && !window.__sageSheetsMessageListenerAdded) {
    window.__sageSheetsMessageListenerAdded = true;
    window.addEventListener('message', (event) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data || {};
      if (data.type !== 'sage-sheets-token' || !data.token) return;
      const user = String(data.username || Auth.getSession?.()?.username || Auth.getLastUser() || 'global').toLowerCase();
      localStorage.setItem(`sage_sheets_token:${user}`, data.token);
      localStorage.setItem('sage_sheets_token', data.token);
      localStorage.setItem('sage_sheets_token_user', user);
      const el = document.getElementById('sheets-auth-status');
      if (el) { el.textContent = '✅ Connected'; el.style.color = 'var(--accent-green)'; }
    });
  }

  return {
    saveKeys, testKey, testOddsKey, authorizeSheets, checkOAuthCallback, getSheetsToken,
    exportProfile, showImport, doImport,
    showChangePassword, doChangePassword, showDeleteAccount, doDeleteAccount,
    logout, showAuthScreen, showApp, doLogin, doRegister, openProfileModal,
  };
})();

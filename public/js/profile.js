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
        <h3>📊 Google Sheets <span class="profile-hint">(optional — logs all picks, agents, equity curve to your sheet)</span></h3>

        <div class="apps-script-box">
          <div class="apps-script-title">⚡ Recommended: Apps Script (no OAuth needed, works on any device)</div>
          <div class="apps-script-steps">
            <div class="step"><span class="step-num">1</span> Open <a href="https://script.google.com" target="_blank" style="color:var(--accent-blue)">script.google.com</a> → New project → delete all code → paste <code>sage-appscript.gs</code> from your repo</div>
            <div class="step"><span class="step-num">2</span> Deploy → New deployment → Web app → Execute as: <strong>Me</strong> → Access: <strong>Anyone</strong></div>
            <div class="step"><span class="step-num">3</span> Copy the web app URL and paste it below</div>
          </div>
          <div class="key-row" style="margin-top:10px">
            <label>Apps Script Web App URL</label>
            <div class="key-input-row">
              <input type="text" id="key-apps-script" value="${keys.apps_script_url || ''}" placeholder="https://script.google.com/macros/s/.../exec">
              <button class="btn-sm test-btn" onclick="Profile.testAppsScript()">Test</button>
            </div>
            <div id="test-result-apps-script" class="test-result"></div>
          </div>
        </div>

        <div class="key-row" style="margin-top:12px">
          <label>Your Google Sheet ID <span class="profile-hint">(from URL: docs.google.com/spreadsheets/d/<strong>THIS_PART</strong>/edit)</span></label>
          <input type="text" id="key-sheet-id" value="${keys.sheet_id || ''}" placeholder="e.g. 1ZkrcVO7Ev7pv8hRltL4_TMasMYPI7hGFtrhD6x3-bgo">
        </div>

        <details style="margin-top:12px">
          <summary style="font-size:12px;color:var(--text-muted);cursor:pointer">Advanced: OAuth fallback (for self-hosted only)</summary>
          <div style="margin-top:8px">
            <div class="key-row">
              <label>Google OAuth Client ID <a href="https://console.cloud.google.com" target="_blank" class="get-key-link">Get one →</a></label>
              <input type="text" id="key-google-client-id" value="${keys.google_client_id || ''}" placeholder="xxxx.apps.googleusercontent.com">
            </div>
            <button class="btn-sm" style="margin-top:8px" onclick="Profile.authorizeSheets()">🔗 Authorize My Google Account</button>
            <span id="sheets-auth-status" style="font-size:12px;margin-left:10px;color:var(--text-muted)">
              ${Profile.getSheetsToken() ? '✅ Connected' : 'Not connected'}
            </span>
          </div>
        </details>
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
      gemini:            document.getElementById('key-gemini')?.value.trim() || '',
      groq:              document.getElementById('key-groq')?.value.trim() || '',
      openrouter:        document.getElementById('key-openrouter')?.value.trim() || '',
      odds_api_key:      document.getElementById('key-odds-api')?.value.trim() || '',
      fred_key:          document.getElementById('key-fred')?.value.trim() || '',
      apps_script_url:   document.getElementById('key-apps-script')?.value.trim() || '',
      sheet_id:          document.getElementById('key-sheet-id')?.value.trim() || '',
      google_client_id:  document.getElementById('key-google-client-id')?.value.trim() || '',
      ollama_host:       document.getElementById('key-ollama-host')?.value.trim() || 'http://localhost:11434',
      ollama_model:      document.getElementById('key-ollama-model')?.value.trim() || 'llama3.3',
    };
    try {
      await Auth.saveKeys(password, keys);
      // Hide odds nudge if key is now set
      const nudge = document.getElementById('odds-key-nudge');
      if (nudge) nudge.style.display = keys.odds_api_key ? 'none' : 'flex';
      UI.showToast('Keys saved and encrypted ✅', 'success');
      document.getElementById('save-password').value = '';
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
    const result = await LLM.testKey(provider, apiKey);
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
  async function authorizeSheets() {
    const clientId = document.getElementById('key-google-client-id')?.value.trim() || Auth.getKeys().google_client_id;
    if (!clientId) {
      UI.showToast('Enter your Google OAuth Client ID first', 'warning');
      return;
    }
    const redirectUri = window.location.origin + window.location.pathname;
    const scope = 'https://www.googleapis.com/auth/spreadsheets';
    const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${encodeURIComponent(scope)}&prompt=select_account`;
    window.open(url, 'google-auth', 'width=500,height=600');
    UI.showToast('Complete authorization in the popup window', 'info');
  }

  // ── Check for OAuth token in URL hash (callback) ──
  function checkOAuthCallback() {
    const hash = window.location.hash;
    if (!hash.includes('access_token')) return;
    const params = new URLSearchParams(hash.substring(1));
    const token = params.get('access_token');
    if (token) {
      sessionStorage.setItem('sage_sheets_token', token);
      window.history.replaceState({}, document.title, window.location.pathname);
      const el = document.getElementById('sheets-auth-status');
      if (el) { el.textContent = '✅ Connected'; el.style.color = 'var(--accent-green)'; }
      UI.showToast('Google Sheets connected ✅', 'success');
    }
  }

  function getSheetsToken() {
    return sessionStorage.getItem('sage_sheets_token');
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
    Auth.logout();
    sessionStorage.removeItem('sage_sheets_token');
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
    const errEl = document.getElementById('auth-error');
    if (!username || !password) { if (errEl) errEl.textContent = 'Enter username and password'; return; }
    try {
      const btn = document.getElementById('auth-submit');
      if (btn) { btn.disabled = true; btn.textContent = 'Logging in...'; }
      await Auth.login(username, password);
      showApp();
      SAGE.init();
    } catch (err) {
      if (errEl) errEl.textContent = err.message;
      const btn = document.getElementById('auth-submit');
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
      await Auth.register(username, password);
      showApp();
      SAGE.init();
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

  // ── Test Apps Script URL ──
  async function testAppsScript() {
    const urlEl = document.getElementById('key-apps-script');
    const resultEl = document.getElementById('test-result-apps-script');
    if (!urlEl || !resultEl) return;
    const url = urlEl.value.trim();
    if (!url) { resultEl.textContent = '⚠️ Enter the Apps Script URL first'; resultEl.className = 'test-result warn'; return; }
    resultEl.textContent = '⏳ Testing connection...'; resultEl.className = 'test-result';
    const result = await SheetsClient.testScriptUrl(url);
    if (result.success) {
      resultEl.textContent = `✅ Connected — ${result.status || 'Apps Script running'}`;
      resultEl.className = 'test-result ok';
    } else {
      resultEl.textContent = `❌ ${result.error}. Make sure you deployed as "Anyone" can access.`;
      resultEl.className = 'test-result err';
    }
  }

  return {
    saveKeys, testKey, testOddsKey, testAppsScript,
    authorizeSheets, checkOAuthCallback, getSheetsToken,
    exportProfile, showImport, doImport,
    showChangePassword, doChangePassword, showDeleteAccount, doDeleteAccount,
    logout, showAuthScreen, showApp, doLogin, doRegister, openProfileModal,
  };
})();

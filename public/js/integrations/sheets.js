// integrations/sheets.js — Google Sheets logging + Apps Script webhook support
// Dual mode: localhost (server proxy) | GitHub Pages (direct Sheets API + Apps Script)

var SheetsClient = globalThis.SheetsClient = (() => {

  function isLocal() {
    return typeof LLM !== 'undefined' && LLM.IS_LOCAL;
  }

  function currentUsername() {
    try { return String(Auth?.getSession?.()?.username || Auth?.getLastUser?.() || 'global').toLowerCase(); }
    catch { return 'global'; }
  }

  function getToken() {
    try {
      return Profile?.getSheetsToken?.()
        || localStorage.getItem(`sage_sheets_token:${currentUsername()}`)
        || localStorage.getItem('sage_sheets_token')
        || sessionStorage.getItem('sage_sheets_token');
    } catch {
      return localStorage.getItem(`sage_sheets_token:${currentUsername()}`)
        || localStorage.getItem('sage_sheets_token')
        || sessionStorage.getItem('sage_sheets_token');
    }
  }

  function getSheetId() {
    const keys = (typeof Auth !== 'undefined') ? Auth.getKeys() : {};
    const user = currentUsername();
    return keys.sheet_id
      || localStorage.getItem(`sage_profile_${user}_sheet_id`)
      || localStorage.getItem('sage_sheet_id')
      || '1ZkrcVO7Ev7pv8hRltL4_TMasMYPI7hGFtrhD6x3-bgo';
  }

  // ── Apps Script webhook URL (for cross-device sync without OAuth) ──
  function getAppsScriptUrl() {
    const keys = (typeof Auth !== 'undefined') ? Auth.getKeys() : {};
    const user = currentUsername();
    return keys.apps_script_url
      || localStorage.getItem(`sage_profile_${user}_apps_script_url`)
      || localStorage.getItem('sage_apps_script_url')
      || '';
  }

  function setAppsScriptUrl(url) {
    const user = currentUsername();
    localStorage.setItem(`sage_profile_${user}_apps_script_url`, url);
    localStorage.setItem('sage_apps_script_url', url);
  }

  // ── Check status ──
  async function checkStatus() {
    if (isLocal()) {
      try {
        const res = await fetch('/api/health');
        return res.json();
      } catch { return { authorized: false, configured: false }; }
    }
    const token = getToken();
    const keys = (typeof Auth !== 'undefined') ? Auth.getKeys() : {};
    const appsScriptUrl = getAppsScriptUrl();
    return {
      authorized: !!token || !!appsScriptUrl,
      configured: !!keys.google_client_id || !!appsScriptUrl,
      sheetsAuthorized: !!token,
      appsScriptConfigured: !!appsScriptUrl,
    };
  }

  // ── Authorize ──
  async function authorize() {
    if (isLocal()) {
      window.open('/auth/google', '_blank', 'width=500,height=600');
      return new Promise(resolve => {
        const interval = setInterval(async () => {
          try {
            const s = await fetch('/auth/status').then(r => r.json());
            if (s.authorized) { clearInterval(interval); resolve(true); }
          } catch { /* keep polling */ }
        }, 2000);
        setTimeout(() => { clearInterval(interval); resolve(false); }, 120000);
      });
    }
    if (typeof Profile !== 'undefined') Profile.authorizeSheets();
    return false;
  }

  // ── Core append: routes to server, direct API, or Apps Script ──
  async function appendRows(tab, rows) {
    if (!rows?.length) return;
    try {
      if (isLocal()) {
        await fetch('/api/sheets/append', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tab, rows }),
        });
        return;
      }
      // Try Apps Script webhook first (no OAuth needed, cross-device)
      const scriptUrl = getAppsScriptUrl();
      if (scriptUrl) {
        await appendViaAppsScript(scriptUrl, tab, rows, { username: currentUsername() });
        return;
      }
      // Fallback to direct API with OAuth token
      await appendRowsDirect(tab, rows);
    } catch (err) {
      console.warn('[Sheets] append failed:', err.message);
    }
  }

  // ── Apps Script webhook append ──
  async function appendViaAppsScript(scriptUrl, tab, rows, extra = {}) {
    const payload = { action: 'append', tab, rows, username: currentUsername(), ...extra };
    // Apps Script requires no-cors or JSONP; use fetch with mode no-cors
    // and send data via URL params for GETs or form POST
    await fetch(scriptUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload),
    });
    // no-cors means we can't read the response, but data goes through
  }

  // ── Apps Script read (for cross-device sync) ──
  async function readViaAppsScript(scriptUrl, tab, limit = 100) {
    try {
      const url = `${scriptUrl}?action=read&tab=${encodeURIComponent(tab)}&limit=${limit}`;
      const res = await fetch(url); // GET — needs to be published as web app with JSONP or CORS
      if (!res.ok) throw new Error(`Apps Script read ${res.status}`);
      return await res.json();
    } catch (err) {
      console.warn('[Sheets] Apps Script read failed:', err.message);
      return null;
    }
  }

  // ── Direct Google Sheets API (OAuth) ──
  async function appendRowsDirect(tab, rows) {
    const token = getToken();
    if (!token) return;
    const sheetId = getSheetId();
    const range = encodeURIComponent(`'${tab}'!A1`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: rows }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 401) {
        sessionStorage.removeItem('sage_sheets_token');
        localStorage.removeItem('sage_sheets_token');
        console.warn('[Sheets] Token expired. Re-authorize in Profile → Google Sheets.');
      }
      throw new Error(err.error?.message || `Sheets API ${res.status}`);
    }
  }

  // ── Upsert agent performance row ──
  async function upsertAgent(row) {
    try {
      if (isLocal()) {
        await fetch('/api/sheets/upsert-agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ row }),
        });
        return;
      }
      const scriptUrl = getAppsScriptUrl();
      if (scriptUrl) {
        await appendViaAppsScript(scriptUrl, 'Agent Performance', [row], { username: currentUsername(), action: 'upsert_agent' });
        return;
      }
      await upsertAgentDirect(row);
    } catch (err) {
      console.warn('[Sheets] upsert agent failed:', err.message);
    }
  }

  // ── Load picks from sheet for cross-device sync ──
  async function loadSportsPicks(limit = 50) {
    try {
      const scriptUrl = getAppsScriptUrl();
      if (scriptUrl) {
        return await readViaAppsScript(scriptUrl, 'Sports Picks', limit);
      }
      if (isLocal()) {
        const res = await fetch(`/api/sheets/read?tab=Sports Picks&limit=${limit}`);
        if (res.ok) return res.json();
      }
      const token = getToken();
      if (token) return await readRowsDirect('Sports Picks', token, limit);
    } catch (err) {
      console.warn('[Sheets] loadSportsPicks failed:', err.message);
    }
    return null;
  }

  async function loadTradingPicks(limit = 50) {
    try {
      const scriptUrl = getAppsScriptUrl();
      if (scriptUrl) {
        return await readViaAppsScript(scriptUrl, 'Trading Picks', limit);
      }
      if (isLocal()) {
        const res = await fetch(`/api/sheets/read?tab=Trading Picks&limit=${limit}`);
        if (res.ok) return res.json();
      }
      const token = getToken();
      if (token) return await readRowsDirect('Trading Picks', token, limit);
    } catch (err) {
      console.warn('[Sheets] loadTradingPicks failed:', err.message);
    }
    return null;
  }

  async function readRowsDirect(tab, token, limit = 100) {
    const sheetId = getSheetId();
    const range = encodeURIComponent(`'${tab}'!A1:S${limit + 1}`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Sheets read ${res.status}`);
    const data = await res.json();
    const rows = data.values || [];
    if (rows.length < 2) return [];
    const headers = rows[0];
    return rows.slice(1).map(row =>
      Object.fromEntries(headers.map((h, i) => [h, row[i] || '']))
    );
  }


  async function upsertAgentDirect(row) {
    const token = getToken();
    const sheetId = getSheetId();
    if (!token || !sheetId) throw new Error('Missing Sheets token or sheet ID');
    const range = encodeURIComponent(`'Agent Performance'!A:A`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Sheets read ${res.status}`);
    const data = await res.json();
    const rows = data.values || [];
    const idx = rows.findIndex((r, i) => i > 0 && r[0] === row[0]);
    if (idx >= 1) {
      const rowRange = encodeURIComponent(`'Agent Performance'!A${idx + 1}`);
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${rowRange}?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [row] }),
      });
      return;
    }
    await appendRowsDirect('Agent Performance', [row]);
  }

  async function overwriteRowsDirect(tab, rows) {
    const token = getToken();
    const sheetId = getSheetId();
    if (!token || !sheetId) throw new Error('Missing Sheets token or sheet ID');
    const clearRange = encodeURIComponent(`'${tab}'!A2:Z`);
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${clearRange}:clear`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    }).catch(() => {});
    if (!rows?.length) return;
    const range = encodeURIComponent(`'${tab}'!A2`);
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: rows }),
    });
  }

  async function markSportsOutcome({ sessionId, identifier, outcome, pnl, runningRoi, agentWeight }) {
    try {
      const payload = {
        action: 'mark_outcome',
        tab: 'Sports Picks',
        sessionId,
        identifier,
        outcome,
        pnl,
        runningRoi,
        agentWeight,
        username: currentUsername(),
      };
      const scriptUrl = getAppsScriptUrl();
      if (scriptUrl) {
        await fetch(scriptUrl, {
          method: 'POST',
          mode: 'no-cors',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify(payload),
        });
        return true;
      }
      if (isLocal()) {
        await fetch('/api/sheets/mark-outcome', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        return true;
      }
      await markSportsOutcomeDirect(payload);
      return true;
    } catch (err) {
      console.warn('[Sheets] markSportsOutcome failed:', err.message);
      return false;
    }
  }

  async function markSportsOutcomeDirect(payload) {
    const token = getToken();
    const sheetId = getSheetId();
    if (!token || !sheetId) throw new Error('Missing Sheets token or sheet ID');
    const range = encodeURIComponent(`'Sports Picks'!A:S`);
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`,
      { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Sheets read ${res.status}`);
    const data = await res.json();
    const rows = data.values || [];
    if (rows.length < 2) return false;
    const headers = rows[0].map(h => String(h || ''));
    const sessionCol = headers.findIndex(h => h.toLowerCase().includes('session'));
    const gameCol = headers.findIndex(h => h.toLowerCase() === 'game');
    const pickCol = headers.findIndex(h => h.toLowerCase() === 'pick');
    const outcomeCol = headers.findIndex(h => h.toLowerCase() === 'outcome');
    const pnlCol = headers.findIndex(h => h.toLowerCase().includes('p&l'));
    const roiCol = headers.findIndex(h => h.toLowerCase().includes('running roi'));
    const weightCol = headers.findIndex(h => h.toLowerCase().includes('agent weight'));
    const targetIdentifier = String(payload.identifier || '').toLowerCase();
    let matched = -1;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const rowSession = String(row[sessionCol] || '');
      const rowGame = String(row[gameCol] || '').toLowerCase();
      const rowPick = String(row[pickCol] || '').toLowerCase();
      const matchSession = !payload.sessionId || rowSession === String(payload.sessionId);
      const matchIdentifier = !targetIdentifier || `${rowGame}||${rowPick}`.includes(targetIdentifier) || targetIdentifier.includes(`${rowGame}||${rowPick}`);
      if (matchSession && matchIdentifier) { matched = i; break; }
    }
    if (matched < 0) return false;
    const updateRow = rows[matched].slice();
    if (outcomeCol >= 0) updateRow[outcomeCol] = payload.outcome === 'win' ? 'WIN ✅' : 'LOSS ❌';
    if (pnlCol >= 0 && payload.pnl !== undefined) updateRow[pnlCol] = payload.pnl;
    if (roiCol >= 0 && payload.runningRoi !== undefined) updateRow[roiCol] = payload.runningRoi;
    if (weightCol >= 0 && payload.agentWeight !== undefined) updateRow[weightCol] = payload.agentWeight;
    const rowRange = encodeURIComponent(`'Sports Picks'!A${matched + 1}:S${matched + 1}`);
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${rowRange}?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [updateRow] }),
    });
    return true;
  }

  // ════════════════════════════════════════
  // PUBLIC LOGGING FUNCTIONS
  // ════════════════════════════════════════

  async function logTradingSession(sessionResult, agentWeights) {
    if (!sessionResult?.finalPicks?.length) return;
    const date = new Date().toLocaleDateString();
    const session = sessionResult.sessionId;
    const rows = sessionResult.finalPicks.map(pick => [
      date, session,
      pick.primary_agent_source || 'CIO', 'Decision',
      pick.ticker || '', pick.action || '',
      pick.entry || '', pick.target || '', pick.stop || '',
      pick.confidence || '',
      agentWeights?.[pick.primary_agent_source || 't_cio'] || 1.0,
      pick.one_line_thesis || '',
      '', '', '', '',   // timeframe, outcome, return%, sharpe (filled later)
      sessionResult.regime || '', sessionResult.posture || '',
    ]);
    await appendRows('Trading Picks', rows);
  }

  async function logSportsSession(sessionResult) {
    if (!sessionResult?.finalPicks?.length) return;
    const date = new Date().toLocaleDateString();
    const session = sessionResult.sessionId;
    const rows = sessionResult.finalPicks.map(pick => {
      const odds = pick.odds || 0;
      const implied = odds < 0
        ? (Math.abs(odds) / (Math.abs(odds) + 100) * 100).toFixed(1)
        : odds > 0 ? (100 / (odds + 100) * 100).toFixed(1) : '';
      const agreementCell =
        pick.agreement_breakdown
        || (Array.isArray(pick.agreement_sources) ? pick.agreement_sources.join(' | ') : '')
        || (Array.isArray(pick.agreement_llms) && Array.isArray(pick.agreement_agent_ids)
          ? pick.agreement_llms.map((llm, i) => `${llm}: ${pick.agreement_agent_ids?.[i] || ''}`).filter(Boolean).join(' | ')
          : '')
        || (pick.agents_in_agreement || []).join(', ');
      return [
        date, session,
        pick.source_agent || pick.source_agent_name || 'Sports CIO',
        pick.sport || '', pick.game || '',
        pick.event_date || '',          // event date (NEW)
        pick.game_time || '',           // game time (NEW)
        pick.bet_type || '', pick.pick || '',
        odds, implied,
        pick.confidence || '',
        pick.units ?? pick.stake_units ?? 1,
        '', '', '', (pick.source_weight ?? pick.agent_weight ?? pick.primary_agent_weight ?? ''),
        pick.full_reasoning || pick.reasoning || '',
        agreementCell,
      ];
    });
    await appendRows('Sports Picks', rows);
  }


  async function logFreshOddsSnapshot({ sportKey, sportName, fetchedAt, rows, range }) {
    try {
      const tab = 'Fresh Odds';
      const rowPayloads = (rows || []).map(r => [
        fetchedAt,
        sportName || sportKey || '',
        r.away || '',
        r.home || '',
        r.commenceTime || '',
        r.awayML || '',
        r.homeML || '',
        r.spread || '',
        r.total ?? '',
        r.book || '',
        range?.from || '',
        range?.to || '',
      ]);
      await overwriteRows(tab, rowPayloads);
    } catch (err) {
      console.warn('[Sheets] log fresh odds failed:', err.message);
    }
  }

  async function syncAgentPerformance(agents) {
    for (const agent of agents) {
      const acc = agent.stats?.predictions > 0
        ? ((agent.stats.correct / agent.stats.predictions) * 100).toFixed(1) : '0.0';
      const delta = calcDelta(agent);
      const row = [
        agent.id, agent.name, agent.domain,
        agent.layerName || agent.layer,
        agent.weight?.toFixed(3),
        agent.stats?.predictions || 0,
        agent.stats?.correct || 0,
        acc,
        agent.stats?.sharpe?.toFixed(3) || '0.000',
        agent.stats?.roi?.toFixed(2) || '0.00',
        agent.rewrites || 0,
        agent.promptHistory?.slice(-1)[0]?.date || '',
        delta,
        (agent.blindSpots || []).length,
        agent.shadowMode ? 'shadow_mode' : (agent.active ? 'active' : 'inactive'),
        new Date().toLocaleDateString(),  // sync date (NEW)
      ];
      await upsertAgent(row);
    }
  }

  async function logEquityPoint(data) {
    const row = [
      new Date().toLocaleDateString(),
      data.session, data.domain,
      data.portfolioValue ?? data.units ?? '',
      data.dailyReturn ?? '',
      data.drawdown ?? '',
      data.regime || '',
      data.topAgent || '',
      data.notes || '',
    ];
    await appendRows('Equity Curve', [row]);
  }

  function calcDelta(agent) {
    const h = agent.promptHistory || [];
    if (h.length < 2) return 'N/A';
    const latest = h[h.length - 1]?.reason || '';
    const m = latest.match(/([+-]?\d+\.\d+)\s*→\s*([+-]?\d+\.\d+)/);
    return m ? (parseFloat(m[2]) - parseFloat(m[1])).toFixed(3) : 'N/A';
  }

  const api = {
    checkStatus, authorize,
    logTradingSession, logSportsSession,
    logFreshOddsSnapshot, syncAgentPerformance, logEquityPoint,
    overwriteRows, markSportsOutcome,
    loadSportsPicks, loadTradingPicks,
    getAppsScriptUrl, setAppsScriptUrl,
    appendViaAppsScript,
  };
  Object.defineProperty(api, '__isRealSheetsClient', { value: true, enumerable: false });
  return api;
})();

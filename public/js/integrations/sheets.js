// integrations/sheets.js — Google Sheets via Apps Script (primary) or OAuth (fallback)
// Apps Script = zero OAuth, zero CORS issues, works on any device forever

const SheetsClient = (() => {

  function getScriptUrl() {
    const keys = (typeof Auth !== 'undefined') ? Auth.getKeys() : {};
    return keys.apps_script_url || '';
  }

  function getSheetId() {
    const keys = (typeof Auth !== 'undefined') ? Auth.getKeys() : {};
    return keys.sheet_id || '';
  }

  function isLocal() {
    return typeof LLM !== 'undefined' && LLM.IS_LOCAL;
  }

  function getOAuthToken() {
    return sessionStorage.getItem('sage_sheets_token') || '';
  }

  // ── Core request via Apps Script ──
  async function scriptRequest(action, payload = {}) {
    const url = getScriptUrl();
    if (!url) return { success: false, error: 'No Apps Script URL configured' };
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' }, // Apps Script requires text/plain for CORS
        body: JSON.stringify({
          action,
          sheetId: getSheetId(),
          ...payload,
        }),
      });
      return res.json();
    } catch (err) {
      console.warn('[Sheets]', action, 'failed:', err.message);
      return { success: false, error: err.message };
    }
  }

  // ── Fallback: direct Sheets REST API with OAuth token ──
  async function restRequest(method, range, body) {
    const token = getOAuthToken();
    if (!token) return null;
    const sheetId = getSheetId();
    if (!sheetId) return null;
    try {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: body }),
      });
      if (res.status === 401) { sessionStorage.removeItem('sage_sheets_token'); return null; }
      return res.json();
    } catch { return null; }
  }

  // ── Decide which method to use ──
  function hasScriptUrl() { return !!getScriptUrl(); }
  function hasOAuth() { return !!getOAuthToken(); }
  function hasServerProxy() { return isLocal(); }

  async function send(action, payload, tab, rows) {
    // Priority: Apps Script → Server proxy → OAuth REST
    if (hasScriptUrl()) {
      return scriptRequest(action, payload);
    }
    if (hasServerProxy()) {
      try {
        await fetch('/api/sheets/append', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tab, rows }),
        });
        return { success: true };
      } catch { return { success: false }; }
    }
    if (hasOAuth() && rows) {
      await restRequest('POST', `'${tab}'!A1`, rows);
      return { success: true };
    }
    return { success: false, error: 'No Sheets method configured' };
  }

  // ── Status check ──
  async function checkStatus() {
    return {
      hasScriptUrl: hasScriptUrl(),
      hasOAuth: hasOAuth(),
      hasServer: hasServerProxy(),
      sheetId: getSheetId(),
      ready: hasScriptUrl() || hasOAuth() || hasServerProxy(),
    };
  }

  // ── Test the Apps Script connection ──
  async function testScriptUrl(url) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'health', sheetId: getSheetId() }),
      });
      const data = await res.json();
      return { success: true, status: data.status };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // ════════════════════════════════════
  // PUBLIC LOGGING FUNCTIONS
  // ════════════════════════════════════

  async function logTradingSession(sessionResult, agentWeights) {
    if (!sessionResult?.finalPicks?.length) return;
    const date = new Date().toLocaleDateString();
    const session = sessionResult.sessionId;
    const rows = sessionResult.finalPicks.map(pick => [
      date,
      session,
      pick.primary_agent_source || 'CIO',
      'Decision',
      pick.ticker || '',
      pick.action || '',
      pick.entry_price || pick.entry || '',
      pick.target_price || pick.target || '',
      pick.stop_price || pick.stop || '',
      pick.confidence || '',
      agentWeights?.[pick.primary_agent_source || 't_cio'] || 1.0,
      pick.one_line_thesis || pick.thesis || '',
      pick.timeframe || '',
      (pick.catalysts || []).join(', '),
      '', '', // outcome, return% — filled when user marks
      sessionResult.regime || '',
      '',
    ]);
    return send('append_trading', { rows }, 'Trading Picks', rows);
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
      return [
        date,
        session,
        pick.source_agent || 'Sports CIO',
        pick.sport || '',
        pick.game || '',
        pick.event_date || '',
        pick.event_time || '',
        pick.bet_type || '',
        pick.pick || '',
        odds,
        implied,
        pick.confidence || '',
        pick.stake_units || pick.units || 1,
        (pick.key_factors || []).join(', '),
        pick.line_movement || '',
        '', '', '', // outcome, P&L, ROI — filled later
        '',
        pick.reasoning || pick.full_reasoning || '',
      ];
    });
    return send('append_sports', { rows }, 'Sports Picks', rows);
  }

  async function syncAgentPerformance(agents) {
    if (!agents?.length) return;
    const agentRows = agents.map(agent => {
      const acc = agent.stats?.predictions > 0
        ? ((agent.stats.correct / agent.stats.predictions) * 100).toFixed(1) : '0.0';
      return [
        agent.id,
        agent.name,
        agent.domain,
        agent.layerName || agent.layer,
        agent.weight?.toFixed(3),
        agent.stats?.predictions || 0,
        agent.stats?.correct || 0,
        acc,
        agent.stats?.sharpe?.toFixed(3) || '0.000',
        agent.stats?.roi?.toFixed(2) || '0.00',
        agent.rewrites || 0,
        agent.promptHistory?.slice(-1)[0]?.date || '',
        calcDelta(agent),
        (agent.blindSpots || []).length,
        agent.shadowMode ? 'shadow_mode' : (agent.active ? 'active' : 'inactive'),
        new Date().toLocaleString(),
      ];
    });

    if (hasScriptUrl()) {
      return scriptRequest('sync_all_agents', { agents: agentRows });
    }
    // Fallback: upsert one by one
    for (const row of agentRows) {
      if (hasServerProxy()) {
        await fetch('/api/sheets/upsert-agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ row }),
        }).catch(() => {});
      }
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
    return send('append_equity', { rows: [row] }, 'Equity Curve', [row]);
  }

  async function logImprovement(agentId, agentName, domain, oldScore, newScore, kept, reason) {
    const row = [
      new Date().toLocaleString(),
      agentId, agentName, domain,
      '', '', // prompt hashes
      oldScore?.toFixed(3) || '—',
      newScore?.toFixed(3) || '—',
      newScore && oldScore ? (newScore - oldScore).toFixed(3) : '—',
      kept ? 'KEPT' : 'REVERTED',
      reason || '',
    ];
    return send('log_improvement', { rows: [row] }, 'Improvement Log', [row]);
  }

  async function markOutcomeInSheet(domain, sessionId, identifier, outcome, value) {
    const action = domain === 'trading' ? 'update_outcome_trading' : 'update_outcome_sports';
    return scriptRequest(action, { sessionId, ticker: identifier, pick: identifier, outcome, returnPct: value, pnl: value });
  }

  function calcDelta(agent) {
    const h = agent.promptHistory || [];
    if (h.length < 2) return 'N/A';
    const latest = h[h.length - 1]?.reason || '';
    const m = latest.match(/([+-]?\d+\.\d+)\s*→\s*([+-]?\d+\.\d+)/);
    return m ? (parseFloat(m[2]) - parseFloat(m[1])).toFixed(3) : 'N/A';
  }

  return {
    checkStatus, testScriptUrl, hasScriptUrl, hasOAuth,
    logTradingSession, logSportsSession, syncAgentPerformance,
    logEquityPoint, logImprovement, markOutcomeInSheet,
  };
})();

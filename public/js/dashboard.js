// ui/dashboard.js — All UI rendering and event handling for SAGE

const UI = (() => {

  // ════════════════════════════════════════
  // CORE RENDER ROUTER
  // ════════════════════════════════════════
  function renderAll() {
    renderNav();
    renderAgents();
    renderRegimePanel();
  }

  function renderNav() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
  }

  function switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    document.querySelector(`[data-tab="${tab}"]`)?.classList.add('active');
    document.getElementById(`tab-${tab}`)?.classList.add('active');
    if (typeof SAGE !== 'undefined' && SAGE.setActiveTab) SAGE.setActiveTab(tab);
    if (window._sageState) window._sageState.activeTab = tab;
  }

  // ════════════════════════════════════════
  // AGENT CARDS
  // ════════════════════════════════════════
  async function renderAgents() {
    const container = document.getElementById('agents-container') || document.getElementById('agents-grid');
    if (!container) return;
    const agents = await AgentManager.getAllAgents();
    if (!agents.length) { container.innerHTML = '<div class="empty-agents">No agents initialized yet. Run a session first.</div>'; return; }

    // Compute live stats from DB picks (so they show up even before manual outcome marking)
    const allPicks = await DB.getAllPicks();
    const liveStats = {};
    for (const pick of allPicks) {
      const aid = pick.agentId;
      if (!aid) continue;
      if (!liveStats[aid]) liveStats[aid] = { predictions: 0, correct: 0, totalReturn: 0, wins: 0, losses: 0 };
      liveStats[aid].predictions++;
      if (pick.outcomeDate) {
        if (pick.correct) { liveStats[aid].correct++; liveStats[aid].wins++; }
        else { liveStats[aid].losses++; }
        liveStats[aid].totalReturn += (pick.returnPct || 0);
      }
    }

    agents.forEach(a => {
      const live = liveStats[a.id];
      if (!live) return;
      const stored = a.stats || {};
      // Use whichever is higher (live pick count vs stored)
      if (live.predictions > (stored.predictions || 0)) {
        a.stats = {
          predictions: live.predictions,
          correct: live.correct,
          roi: live.predictions > 0 ? (live.totalReturn / live.predictions) * 100 : 0,
          sharpe: stored.sharpe || 0,
          totalReturn: live.totalReturn,
        };
      }
    });

    const tradingAgents = agents.filter(a => a.domain === 'trading').sort((a, b) => b.weight - a.weight);
    const sportsAgents  = agents.filter(a => a.domain === 'sports').sort((a, b) => b.weight - a.weight);

    container.innerHTML = `
      <div class="agents-header">
        <h2>🧠 Agent Performance</h2>
        <div class="agent-header-actions">
          <button class="btn-sm" onclick="UI.renderAgents()">🔄 Refresh Stats</button>
          <button class="btn-sm" onclick="SAGE.runBlindSpotDetection('all')">🔍 Blind Spot Scan</button>
          <button class="btn-sm" onclick="SAGE.runFixWeakestAgent('all')">🛠️ Fix Weakest Agent</button>
        </div>
      </div>
      ${renderDomainAgentTable('Trading', tradingAgents, liveStats)}
      ${renderDomainAgentTable('Sports', sportsAgents, liveStats)}
    `;
  }

  function renderDomainAgentTable(label, agents, liveStats) {
    if (!agents.length) return '';
    return `
      <div class="agent-domain-section">
        <h3 class="domain-label">${label === 'Trading' ? '📈' : '🏆'} ${label} Agents (${agents.length})</h3>
        <div class="agent-table-wrap">
          <table class="agent-table">
            <thead><tr>
              <th>Agent</th><th>Layer</th><th>Weight</th>
              <th>Picks</th><th>W/L</th><th>Accuracy</th>
              <th>${label === 'Trading' ? 'Sharpe' : 'ROI %'}</th>
              <th>Rewrites</th><th>Status</th>
            </tr></thead>
            <tbody>
              ${agents.map(a => {
                const live = liveStats[a.id] || {};
                const picks = Math.max(a.stats?.predictions || 0, live.predictions || 0);
                const wins  = live.wins ?? a.stats?.correct ?? 0;
                const losses = live.losses ?? 0;
                const acc   = picks > 0 ? ((wins / picks) * 100).toFixed(0) + '%' : '—';
                const metric = label === 'Trading'
                  ? (a.stats?.sharpe?.toFixed(3) || '—')
                  : (picks > 0 ? (a.stats?.roi?.toFixed(1) || '0.0') + '%' : '—');
                const wc = a.weight >= 1.5 ? '#22c55e' : a.weight <= 0.5 ? '#ef4444' : '#f59e0b';
                const wBar = Math.min(100, (a.weight / 2.5) * 100);
                const status = a.shadowMode ? '🔬 Shadow' : (a.active ? '✅ Active' : '⏸ Paused');
                return `<tr class="agent-row" onclick="UI.showAgentDetail('${a.id}')">
                  <td>
                    <div class="agent-name-cell">
                      <span class="agent-name-text">${a.name}</span>
                      ${a.blindSpots?.length ? '<span class="badge-mini warn">⚠️</span>' : ''}
                    </div>
                  </td>
                  <td><span class="layer-badge">${a.layerName || 'L' + a.layer}</span></td>
                  <td>
                    <div class="weight-cell">
                      <span style="color:${wc};font-weight:700">${a.weight.toFixed(2)}×</span>
                      <div class="weight-bar-mini"><div style="width:${wBar}%;background:${wc}"></div></div>
                    </div>
                  </td>
                  <td>${picks}</td>
                  <td>${picks > 0 ? wins + 'W / ' + losses + 'L' : '—'}</td>
                  <td>${acc}</td>
                  <td>${metric}</td>
                  <td>${a.rewrites || 0}</td>
                  <td>${status}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }



  function renderAgentCard(agent) {
    const pct = agent.stats?.predictions > 0
      ? ((agent.stats.correct / agent.stats.predictions) * 100).toFixed(0) : '—';
    const metric = agent.domain === 'trading'
      ? `Sharpe: ${agent.stats?.sharpe?.toFixed(2) || '—'}`
      : `ROI: ${agent.stats?.roi?.toFixed(1) || '—'}%`;
    const weightBar = Math.min(100, (agent.weight / 2.5) * 100);
    const weightColor = agent.weight >= 1.5 ? '#22c55e' : agent.weight <= 0.5 ? '#ef4444' : '#f59e0b';
    const shadowBadge = agent.shadowMode ? '<span class="badge badge-shadow">🔬 shadow</span>' : '';
    const spawnedBadge = agent.spawned ? '<span class="badge badge-spawned">⚡ spawned</span>' : '';
    const blindSpotCount = (agent.blindSpots || []).length;

    return `
      <div class="agent-card" id="agent-${agent.id}" onclick="UI.showAgentDetail('${agent.id}')">
        <div class="agent-header">
          <span class="agent-name">${agent.name}</span>
          <span class="agent-weight" style="color:${weightColor}">${agent.weight.toFixed(2)}×</span>
        </div>
        <div class="weight-bar"><div class="weight-fill" style="width:${weightBar}%;background:${weightColor}"></div></div>
        <div class="agent-stats">
          <span>${pct !== '—' ? pct + '% acc' : 'No data'}</span>
          <span>${metric}</span>
          <span>${agent.stats?.predictions || 0} picks</span>
        </div>
        <div class="agent-badges">${shadowBadge}${spawnedBadge}${blindSpotCount > 0 ? `<span class="badge badge-warn">⚠️ ${blindSpotCount} blind spot${blindSpotCount > 1 ? 's' : ''}</span>` : ''}</div>
        <div class="agent-rewrites">Rewrites: ${agent.rewrites || 0} | Prompts: ${(agent.promptHistory || []).length}</div>
      </div>`;
  }

  async function showAgentDetail(agentId) {
    const agent = await AgentManager.getAgent(agentId);
    if (!agent) return;
    const picks = await DB.getPicksByAgent(agentId);
    const modal = document.getElementById('agent-modal');
    const body = document.getElementById('agent-modal-body');

    body.innerHTML = `
      <div class="modal-agent-header">
        <h2>${agent.name}</h2>
        <div class="modal-meta">
          <span class="badge">${agent.domain}</span>
          <span class="badge">Layer ${agent.layer}: ${agent.layerName}</span>
          <span class="badge ${agent.shadowMode ? 'badge-shadow' : ''}">Weight: ${agent.weight.toFixed(3)}×</span>
          ${agent.spawned ? '<span class="badge badge-spawned">Auto-Spawned</span>' : ''}
        </div>
      </div>
      <div class="modal-grid">
        <div>
          <h3>📊 Performance</h3>
          <table class="stats-table">
            <tr><td>Predictions</td><td>${agent.stats?.predictions || 0}</td></tr>
            <tr><td>Correct</td><td>${agent.stats?.correct || 0}</td></tr>
            <tr><td>Accuracy</td><td>${agent.stats?.predictions > 0 ? ((agent.stats.correct / agent.stats.predictions)*100).toFixed(1)+'%' : '—'}</td></tr>
            <tr><td>${agent.domain === 'trading' ? 'Sharpe Ratio' : 'ROI %'}</td><td>${agent.domain === 'trading' ? (agent.stats?.sharpe?.toFixed(3) || '—') : (agent.stats?.roi?.toFixed(2)+'%' || '—')}</td></tr>
            <tr><td>Prompt Rewrites</td><td>${agent.rewrites || 0}</td></tr>
          </table>
        </div>
        <div>
          <h3>🔬 Prompt Evolution (${(agent.promptHistory||[]).length} versions)</h3>
          <div class="prompt-history">
            ${(agent.promptHistory || []).slice(-5).reverse().map((h, i) => `
              <div class="prompt-version ${i === 0 ? 'current' : ''}">
                <div class="prompt-ver-header">${i === 0 ? '✅ Current' : `v${(agent.promptHistory.length - i)}`} — ${new Date(h.date).toLocaleDateString()}</div>
                <div class="prompt-reason">${h.reason}</div>
                <pre class="prompt-preview">${h.prompt.slice(0, 300)}${h.prompt.length > 300 ? '...' : ''}</pre>
              </div>`).join('')}
          </div>
        </div>
      </div>
      ${(agent.blindSpots || []).length > 0 ? `
        <h3>⚠️ Detected Blind Spots</h3>
        <ul class="blind-spots-list">${agent.blindSpots.map(s => `<li>${s}</li>`).join('')}</ul>` : ''}
      ${agent.shadowMode ? `
        <div class="shadow-alert">
          🔬 <strong>Shadow Mode Active</strong> — New prompt running alongside old. ${agent.shadowMode.sessionCount}/5 sessions complete.
          <br>Started: ${new Date(agent.shadowMode.startDate).toLocaleDateString()}
        </div>` : ''}
      <h3>📋 Recent Picks (${picks.length} total)</h3>
      <div class="picks-list">
        ${picks.slice(-10).reverse().map(p => `
          <div class="pick-item ${p.correct === true ? 'win' : p.correct === false ? 'loss' : ''}">
            <span>${new Date(p.timestamp).toLocaleDateString()}</span>
            <span>${p.ticker || p.pick || '—'}</span>
            <span>${formatConfidence(p.confidence)}</span>
            <span>${p.correct === true ? '✅ Win' : p.correct === false ? '❌ Loss' : '⏳ Open'}</span>
          </div>`).join('')}
      </div>`;

    modal.classList.add('open');
  }

  // ════════════════════════════════════════
  // TRADING RESULTS
  // ════════════════════════════════════════
  function renderTradingResults(result) {
    const container = document.getElementById('trading-results');
    if (!container) return;

    const allResults = Object.values(result.layers || {}).flat();
    const errors = allResults.filter(r => r.error);
    const errorBanner = errors.length
      ? `<div class="error-banner">⚠️ ${errors.length} agent(s) failed: ${[...new Set(errors.map(e => e.errorMessage?.slice(0,60)))].join(' | ')}</div>`
      : '';

    if (!result.finalPicks?.length) {
      container.innerHTML = `
        ${errorBanner}
        <div class="empty-results">
          <div style="font-size:36px;margin-bottom:12px">🤔</div>
          <div style="font-size:15px;font-weight:600;margin-bottom:8px">No final picks this session</div>
          <div style="color:var(--text-secondary);font-size:13px;max-width:420px;text-align:center;line-height:1.6">
            ${errors.length
              ? `${errors.length} agent(s) hit errors (likely Groq rate limits). Try again in 60 seconds.`
              : 'The CIO agent did not produce picks. Try adding more specific market context and run again.'}
          </div>
          ${renderRawDebugQuick(result.layers)}
        </div>`;
      return;
    }

    container.innerHTML = `
      ${errorBanner}
      <div class="session-header">
        <div class="session-meta">
          <span class="regime-badge ${result.regime}">${RegimeEngine.TRADING_REGIMES[result.regime]?.icon || '📊'} ${RegimeEngine.TRADING_REGIMES[result.regime]?.label || result.regime || 'Unknown Regime'}</span>
          <span class="posture-badge">${result.posture || ''}</span>
          <span class="session-id">Session #${result.sessionId}</span>
          ${errors.length ? `<span class="badge badge-warn">⚠️ ${errors.length} agent errors</span>` : ''}
        </div>
        <p class="session-summary">${result.summary || ''}</p>
      </div>
      <div class="picks-grid">
        ${result.finalPicks.map((pick, i) => {
          const conf = normalizeConfidenceValue(pick.confidence);
          const confColor = conf >= 75 ? '#22c55e' : conf >= 60 ? '#f59e0b' : '#ef4444';
          const action = (pick.action || '').toLowerCase();
          return `
          <div class="pick-card trading">
            <div class="pick-card-header">
              <div class="pick-rank">#${pick.rank || i+1}</div>
              <div class="pick-ticker">${pick.ticker || '—'}</div>
              <div class="pick-action-badge ${action}">${(pick.action||'').toUpperCase()}</div>
            </div>
            <div class="pick-levels">
              <div class="level-item"><span class="level-label">Entry</span><strong>${pick.entry ? '$'+pick.entry : '—'}</strong></div>
              <div class="level-item"><span class="level-label">Target</span><strong class="target-val">${pick.target ? '$'+pick.target : '—'}</strong></div>
              <div class="level-item"><span class="level-label">Stop</span><strong class="stop-val">${pick.stop ? '$'+pick.stop : '—'}</strong></div>
              <div class="level-item"><span class="level-label">Size</span><strong>${pick.size_pct ? pick.size_pct+'%' : '—'}</strong></div>
            </div>
            <div class="pick-thesis">${pick.one_line_thesis || ''}</div>
            <div class="conf-row">
              <span class="conf-label">Confidence</span>
              <div class="conf-bar-wrap"><div class="conf-bar-fill" style="width:${conf}%;background:${confColor}"></div></div>
              <span class="conf-val" style="color:${confColor}">${conf}/100</span>
            </div>
            <div class="pick-footer">
              <span class="agent-source">📊 ${pick.primary_agent_source || 'CIO'}</span>
            </div>
            <div class="pick-actions">
              <button class="btn-sm win-btn" onclick="UI.markOutcome(${result.sessionId}, '${pick.ticker}', true, 5)">✅ Win</button>
              <button class="btn-sm loss-btn" onclick="UI.markOutcome(${result.sessionId}, '${pick.ticker}', false, -3)">❌ Loss</button>
            </div>
          </div>`;
        }).join('')}
      </div>
      <div class="layer-debug">
        <details>
          <summary>🔍 Full Debate Log (${Object.keys(result.layers||{}).length} layers, ${allResults.length} agents)</summary>
          ${renderDebateLog(result.layers)}
        </details>
      </div>`;
  }

  // ════════════════════════════════════════
  // SPORTS RESULTS
  // ════════════════════════════════════════
  function renderSportsResults(result) {
    const container = document.getElementById('sports-results');
    if (!container) return;

    const allResults = Object.values(result.layers || {}).flat();
    const errors = allResults.filter(r => r.error);
    const errorBanner = errors.length
      ? `<div class="error-banner">⚠️ ${errors.length} agent(s) failed: ${[...new Set(errors.map(e => e.errorMessage?.slice(0,60)))].join(' | ')}</div>`
      : '';

    if (!result.finalPicks?.length) {
      container.innerHTML = `
        ${errorBanner}
        <div class="empty-results">
          <div style="font-size:36px;margin-bottom:12px">🎰</div>
          <div style="font-size:15px;font-weight:600;margin-bottom:8px">No qualifying sports picks found</div>
          <div style="color:var(--text-secondary);font-size:13px;max-width:500px;text-align:center;line-height:1.7">
            ${errors.length
              ? `${errors.length} agent(s) hit errors. Wait 60 seconds and try again.`
              : `No matching games found or agents returned malformed output.<br><br>
                 <strong>Paste today's specific games with odds labeled by sport (NFL:, NBA:, etc.)</strong>`}
          </div>
          ${!errors.length ? `
          <div class="how-to-box">
            <strong>Example input format:</strong>
            <pre>NBA: Boston Celtics vs Brooklyn Nets (7:30 PM ET, May 12)
Celtics ML: -165  |  Nets ML: +140
Celtics -4.5 (-110)  |  Total: 224.5

MLB: NY Yankees @ Boston Red Sox (7:10 PM ET, May 12)
SP: Gerrit Cole vs Nick Pivetta
Yankees ML: -135  |  Red Sox ML: +115

NHL: Colorado Avalanche @ Dallas Stars (8:00 PM ET, May 12)
Avalanche ML: -130  |  Stars ML: +110</pre>
          </div>` : ''}
          ${renderRawDebugQuick(result.layers)}
        </div>`;
      return;
    }

    // Group picks by sport for display
    const bySport = {};
    for (const pick of result.finalPicks) {
      const s = (pick.sport || 'OTHER').toUpperCase();
      if (!bySport[s]) bySport[s] = [];
      bySport[s].push(pick);
    }

    container.innerHTML = `
      ${errorBanner}
      <div class="session-header">
        <div class="session-meta">
          <span class="session-id">Session #${result.sessionId}</span>
          <span class="picks-count">✅ ${result.finalPicks.length} final pick${result.finalPicks.length !== 1 ? 's' : ''}</span>
          <span class="sports-covered">${Object.keys(bySport).map(s => sportIcon(s)+' '+s).join(' · ')}</span>
          ${errors.length ? `<span class="badge badge-warn">⚠️ ${errors.length} agent errors</span>` : ''}
        </div>
        <p class="session-summary">${result.summary || ''}</p>
      </div>
      <div class="picks-grid">
        ${result.finalPicks.map(pick => renderSportsPickCard(pick, result.sessionId)).join('')}
      </div>
      <div class="layer-debug">
        <details>
          <summary>🔍 Full Debate Log (${allResults.length} agents across ${Object.keys(result.layers||{}).length} layers)</summary>
          ${renderDebateLog(result.layers)}
        </details>
      </div>`;
  }

  function renderSportsPickCard(pick, sessionId) {
    const odds = Number(pick.odds ?? 0);
    const impliedProb = Number.isFinite(odds) && odds !== 0
      ? (odds < 0
        ? (Math.abs(odds) / (Math.abs(odds) + 100) * 100)
        : (100 / (odds + 100) * 100)).toFixed(1)
      : null;

    // Odds color: positive = green, -100 to -200 = gradient yellow→orange
    let oddsColor = '#22c55e';
    if (odds < 0) {
      const abs = Math.abs(odds);
      if (abs <= 110) oddsColor = '#a3e635';
      else if (abs <= 140) oddsColor = '#facc15';
      else if (abs <= 170) oddsColor = '#fb923c';
      else oddsColor = '#f87171';
    }

    const conf = normalizeConfidenceValue(pick.confidence);
    const confColor = conf >= 75 ? '#22c55e' : conf >= 60 ? '#f59e0b' : '#ef4444';
    const units = pick.units ?? pick.stake_units ?? 1;
    const sport = (pick.sport || '').toUpperCase();
    const agents = pick.agents_in_agreement || [];

    // Format date/time display
    const eventDate = pick.event_date || '';
    const gameTime  = pick.game_time || '';
    let dateDisplay = '';
    if (eventDate) {
      try {
        const d = new Date(eventDate + 'T12:00:00');
        dateDisplay = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      } catch { dateDisplay = eventDate; }
    }
    const timeDisplay = gameTime || '';
    const dateTimeDisplay = [dateDisplay, timeDisplay].filter(Boolean).join(' · ');

    // Format odds display
    const oddsDisplay = odds > 0 ? `+${odds}` : `${odds}`;
    const reasoning = (pick.full_reasoning || pick.reasoning || '').trim();
    const reasoningShort = reasoning.length > 220 ? reasoning.slice(0, 220) + '…' : reasoning;

    const safeGame = (pick.game || '').replace(/'/g, "\'");
    const safePick = (pick.pick || '').replace(/'/g, "\'");

    return `
    <div class="pick-card sports sport-${sport.toLowerCase()}">
      <div class="sports-card-header">
        <div class="sport-pill">${sportIcon(sport)} ${sport}</div>
        ${dateTimeDisplay ? `<div class="event-datetime">📅 ${dateTimeDisplay}</div>` : ''}
      </div>
      <div class="pick-game-name">${pick.game || '—'}</div>
      <div class="bet-meta-row">
        <span class="bet-type-pill">${pick.bet_type || 'Moneyline'}</span>
      </div>
      <div class="pick-selection">${pick.pick || '—'}</div>
      <div class="odds-block">
        <div class="odds-main">
          <span class="odds-number" style="color:${oddsColor}">${oddsDisplay}</span>
          <span class="odds-label">American</span>
        </div>
        <div class="odds-secondary">
          ${impliedProb ? `<span class="implied-prob-badge">${impliedProb}% implied</span>` : ''}
          <span class="units-badge">🎯 ${units}u</span>
        </div>
      </div>
      <div class="conf-row">
        <span class="conf-label">Confidence</span>
        <div class="conf-bar-wrap"><div class="conf-bar-fill" style="width:${conf}%;background:${confColor}"></div></div>
        <span class="conf-val" style="color:${confColor}">${conf}/100</span>
      </div>
      ${reasoning ? `<div class="pick-reasoning">${reasoningShort}</div>` : ''}
      ${(pick.agreement_count || agents.length) > 1 ? `<div class="agents-agree agree-strong">🤝 ${pick.agreement_breakdown || agents.slice(0,3).join(', ')}${agents.length > 3 ? ` +${agents.length-3}` : ''}</div>` : (agents.length > 0 ? `<div class="agents-agree">🤝 ${agents.slice(0,3).join(', ')}${agents.length > 3 ? ` +${agents.length-3}` : ''}</div>` : '')}
      <div class="pick-actions">
        <button class="btn-sm win-btn" onclick="UI.markSportsOutcome('${safeGame}','${safePick}',true)">✅ Win</button>
        <button class="btn-sm loss-btn" onclick="UI.markSportsOutcome('${safeGame}','${safePick}',false)">❌ Loss</button>
      </div>
    </div>`;
  }

  // ── Quick debug: show first non-empty raw response ──
  function renderRawDebugQuick(layers) {
    if (!layers) return '';
    const allResults = Object.values(layers).flat();
    const sample = allResults.find(r => r.raw && r.raw.length > 20 && !r.error);
    if (!sample) return '';
    return `
      <details style="margin-top:16px;max-width:600px;text-align:left">
        <summary style="cursor:pointer;font-size:12px;color:var(--text-muted)">🔍 Show raw agent output (debug)</summary>
        <div style="background:var(--bg-2);border:1px solid var(--border);border-radius:6px;padding:10px;margin-top:8px">
          <div style="font-size:11px;color:var(--accent-cyan);margin-bottom:4px">${sample.agentName}</div>
          <pre style="font-size:11px;color:var(--text-secondary);white-space:pre-wrap;max-height:200px;overflow-y:auto">${sample.raw.slice(0,600)}</pre>
        </div>
      </details>`;
  }

  function normalizeConfidenceValue(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 50;
    return n <= 10 ? Math.round(n * 10) : Math.max(0, Math.min(100, Math.round(n)));
  }

  function formatConfidence(value, showDash = false) {
    const n = normalizeConfidenceValue(value);
    return `${n}/100`;
  }

  function sportIcon(sport) {
    const icons = { NFL: '🏈', NBA: '🏀', MMA: '🥊', MLB: '⚾', NHL: '🏒', UFC: '🥊' };
    return icons[(sport||'').toUpperCase()] || '🎰';
  }

    function renderDebateLog(layers) {
    if (!layers) return '';
    return Object.entries(layers).map(([layerName, results]) => {
      const arr = Array.isArray(results) ? results : [];
      return `
        <div class="layer-log">
          <h4>${layerName.toUpperCase()} (${arr.length} agents)</h4>
          ${arr.map(r => `
            <div class="agent-log ${r.error ? 'error' : ''}">
              <div class="agent-log-header">
                <span>${r.agentName}</span>
                <span>weight: ${r.weight?.toFixed(2)}</span>
                ${r.error ? '<span class="error-badge">ERROR</span>' : ''}
              </div>
              <pre class="agent-log-raw">${JSON.stringify(r.parsed, null, 2).slice(0, 800)}</pre>
            </div>`).join('')}
        </div>`;
    }).join('');
  }

  // ════════════════════════════════════════
  // PERFORMANCE DASHBOARD
  // ════════════════════════════════════════
  async function renderPerformance() {
    const container = document.getElementById('performance-content');
    if (!container) return;
    const agents = await AgentManager.getAllAgents();
    const allPicks = await DB.getAllPicks();

    const tradingAgents = agents.filter(a => a.domain === 'trading').sort((a, b) => b.weight - a.weight);
    const sportsAgents = agents.filter(a => a.domain === 'sports').sort((a, b) => b.weight - a.weight);

    container.innerHTML = `
      <div class="perf-grid">
        <div class="perf-section">
          <h3>📈 Trading Agent Leaderboard</h3>
          ${renderLeaderboard(tradingAgents, 'trading')}
        </div>
        <div class="perf-section">
          <h3>🎰 Sports Agent Leaderboard</h3>
          ${renderLeaderboard(sportsAgents, 'sports')}
        </div>
      </div>
      <div class="equity-section">
        <h3>📉 Equity Curve</h3>
        <canvas id="equity-chart" height="200"></canvas>
      </div>
      <div class="weight-evolution">
        <h3>⚖️ Agent Weight Evolution</h3>
        <div id="weight-chart-container"></div>
      </div>`;

    renderEquityChart(allPicks);
  }

  function renderLeaderboard(agents, domain) {
    if (!agents.length) return '<div class="empty-state">No agents yet.</div>';
    return `
      <div class="table-scroll"><table class="leaderboard-table">
        <thead>
          <tr>
            <th>Agent</th><th>Layer</th><th>Weight</th><th>Picks</th><th>Acc%</th>
            <th>${domain === 'trading' ? 'Sharpe' : 'ROI%'}</th><th>Rewrites</th><th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${agents.map((a, i) => {
            const acc = a.stats?.predictions > 0 ? ((a.stats.correct/a.stats.predictions)*100).toFixed(1) : '—';
            const metric = domain === 'trading'
              ? (a.stats?.sharpe?.toFixed(2) || '—')
              : (a.stats?.roi?.toFixed(1) || '—');
            const weightColor = a.weight >= 1.5 ? '#22c55e' : a.weight <= 0.5 ? '#ef4444' : '#f59e0b';
            return `<tr class="${i < 3 ? 'top-agent' : i >= agents.length - 3 ? 'bot-agent' : ''}">
              <td class="agent-name-cell" onclick="UI.showAgentDetail('${a.id}')" style="cursor:pointer">${a.name}</td>
              <td>${a.layerName}</td>
              <td style="color:${weightColor};font-weight:bold">${a.weight.toFixed(2)}×</td>
              <td>${a.stats?.predictions || 0}</td>
              <td>${acc}${acc !== '—' ? '%' : ''}</td>
              <td>${metric}</td>
              <td>${a.rewrites || 0}</td>
              <td>${a.shadowMode ? '🔬' : a.active ? '✅' : '⏸️'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>`;
  }

  function renderEquityChart(picks) {
    const canvas = document.getElementById('equity-chart');
    if (!canvas) return;
    const resolved = picks.filter(p => p.correct !== undefined && p.domain === 'trading').slice(-50);
    if (resolved.length < 2) {
      canvas.parentElement.innerHTML = '<div class="empty-state">Run sessions and record outcomes to see equity curve.</div>';
      return;
    }
    let capital = 100000;
    const points = [{ x: 0, y: capital }];
    resolved.forEach((p, i) => {
      capital *= (1 + (p.returnPct || (p.correct ? 0.04 : -0.02)));
      points.push({ x: i + 1, y: capital });
    });
    const ctx = canvas.getContext('2d');
    const w = canvas.offsetWidth || 600;
    const h = 200;
    canvas.width = w; canvas.height = h;
    const minY = Math.min(...points.map(p => p.y)) * 0.98;
    const maxY = Math.max(...points.map(p => p.y)) * 1.02;
    const scaleX = (x) => (x / points.length) * w;
    const scaleY = (y) => h - ((y - minY) / (maxY - minY)) * h;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = '#1a2035'; ctx.fillStyle = '#1a2035';
    ctx.fillRect(0, 0, w, h);
    // Draw zero line
    const zeroY = scaleY(100000);
    ctx.strokeStyle = '#334155'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(0, zeroY); ctx.lineTo(w, zeroY); ctx.stroke();
    ctx.setLineDash([]);
    // Draw equity curve
    const endY = points[points.length - 1].y;
    ctx.strokeStyle = endY >= 100000 ? '#22c55e' : '#ef4444';
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((p, i) => { i === 0 ? ctx.moveTo(scaleX(i), scaleY(p.y)) : ctx.lineTo(scaleX(i), scaleY(p.y)); });
    ctx.stroke();
    // Fill
    ctx.fillStyle = endY >= 100000 ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)';
    ctx.lineTo(scaleX(points.length - 1), h); ctx.lineTo(0, h); ctx.fill();
  }

  // ════════════════════════════════════════
  // REGIME PANEL
  // ════════════════════════════════════════
  async function renderRegimePanel() {
    const container = document.getElementById('regime-panel');
    if (!container) return;
    const regime = RegimeEngine.currentRegime();
    const tradingInfo = RegimeEngine.TRADING_REGIMES[regime.trading];
    const sportsInfo = RegimeEngine.SPORTS_REGIMES[regime.sports];

    container.innerHTML = `
      <div class="regime-grid">
        <div class="regime-card">
          <div class="regime-icon">${tradingInfo?.icon || '📊'}</div>
          <div class="regime-label">Market Regime</div>
          <div class="regime-name" style="color:${tradingInfo?.color}">${tradingInfo?.label || regime.trading}</div>
          <div class="regime-desc">${tradingInfo?.description || ''}</div>
          <div class="regime-cohort">${RegimeEngine.TRADING_COHORTS[regime.trading]?.description || ''}</div>
          <select class="regime-select" onchange="RegimeEngine.setRegime('trading', this.value).then(()=>UI.renderRegimePanel())">
            ${Object.entries(RegimeEngine.TRADING_REGIMES).map(([k, v]) => `<option value="${k}" ${k === regime.trading ? 'selected' : ''}>${v.label}</option>`).join('')}
          </select>
        </div>
        <div class="regime-card">
          <div class="regime-icon">${sportsInfo?.icon || '🏆'}</div>
          <div class="regime-label">Sports Season</div>
          <div class="regime-name" style="color:${sportsInfo?.color}">${sportsInfo?.label || regime.sports}</div>
          <div class="regime-desc">${sportsInfo?.description || ''}</div>
          <div class="regime-cohort">${RegimeEngine.SPORTS_COHORTS[regime.sports]?.description || ''}</div>
          <select class="regime-select" onchange="RegimeEngine.setRegime('sports', this.value).then(()=>UI.renderRegimePanel())">
            ${Object.entries(RegimeEngine.SPORTS_REGIMES).map(([k, v]) => `<option value="${k}" ${k === regime.sports ? 'selected' : ''}>${v.label}</option>`).join('')}
          </select>
        </div>
      </div>`;
  }

  // ════════════════════════════════════════
  // BACKTEST UI
  // ════════════════════════════════════════
  function renderBacktestResults(results) {
    const container = document.getElementById('backtest-results');
    if (!container) return;
    const s = results.summary;

    container.innerHTML = `
      <div class="backtest-summary">
        <h3>📊 Backtest Results — ${results.domain.toUpperCase()} (${results.sessions.length} sessions)</h3>
        <div class="summary-grid">
          ${results.domain === 'trading' ? `
            <div class="summary-card"><div class="s-label">Total Return</div><div class="s-value ${s.totalReturn >= 0 ? 'positive' : 'negative'}">${s.totalReturn?.toFixed(1)}%</div></div>
            <div class="summary-card"><div class="s-label">Sharpe Ratio</div><div class="s-value">${s.sharpe?.toFixed(2)}</div></div>
            <div class="summary-card"><div class="s-label">Max Drawdown</div><div class="s-value negative">-${s.maxDrawdown?.toFixed(1)}%</div></div>
          ` : `
            <div class="summary-card"><div class="s-label">Total Units</div><div class="s-value ${s.totalUnits >= 0 ? 'positive' : 'negative'}">${s.totalUnits?.toFixed(2)}</div></div>
            <div class="summary-card"><div class="s-label">ROI</div><div class="s-value">${s.roi?.toFixed(1)}%</div></div>
          `}
          <div class="summary-card"><div class="s-label">Sessions</div><div class="s-value">${s.sessions}</div></div>
        </div>
        <h4>Agent Weights After Evolution</h4>
        <div class="weight-bars">
          ${(results.finalAgentWeights || []).sort((a,b) => b.weight - a.weight).map(a => {
            const w = Math.min(100, (a.weight / 2.5) * 100);
            const c = a.weight >= 1.5 ? '#22c55e' : a.weight <= 0.5 ? '#ef4444' : '#f59e0b';
            return `<div class="wbar-row"><span class="wbar-name">${a.name}</span><div class="wbar-track"><div class="wbar-fill" style="width:${w}%;background:${c}"></div></div><span style="color:${c}">${a.weight.toFixed(2)}×</span></div>`;
          }).join('')}
        </div>
        <h4>Equity Curve</h4>
        <canvas id="bt-equity-chart" height="200"></canvas>
      </div>`;

    renderBTChart(results);
  }

  function renderBTChart(results) {
    const canvas = document.getElementById('bt-equity-chart');
    if (!canvas) return;
    const points = results.equityCurve || [];
    if (points.length < 2) return;
    const values = points.map(p => p.capital || (p.units * 100 + 100000));
    const w = canvas.offsetWidth || 600; const h = 200;
    canvas.width = w; canvas.height = h;
    const minV = Math.min(...values) * 0.98, maxV = Math.max(...values) * 1.02;
    const sx = (i) => (i / (points.length - 1)) * w;
    const sy = (v) => h - ((v - minV) / (maxV - minV)) * h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1a2035'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = values[values.length-1] >= values[0] ? '#22c55e' : '#ef4444';
    ctx.lineWidth = 2;
    ctx.beginPath();
    values.forEach((v, i) => { i === 0 ? ctx.moveTo(sx(i), sy(v)) : ctx.lineTo(sx(i), sy(v)); });
    ctx.stroke();
  }

  function updateBacktestProgress(p) {
    const bar = document.getElementById('bt-progress-bar');
    const label = document.getElementById('bt-progress-label');
    if (bar) bar.style.width = `${Math.round((p.session / p.total) * 100)}%`;
    if (label) label.textContent = p.message;
  }

  // ════════════════════════════════════════
  // STATUS BAR & UTILITIES
  // ════════════════════════════════════════
  function updateStatus(state) {
    const el = document.getElementById('status-bar');
    if (!el) return;

    const sheetsOk = state.sheetsStatus?.authorized
      || !!Profile?.getSheetsToken?.()
      || !!globalThis.SheetsClient?.getAppsScriptUrl?.();

    const hyperOn = LLM.isHyperMode?.();
    const hyperBtn = document.getElementById('hyper-toggle-btn');
    if (hyperBtn) hyperBtn.classList.toggle('hyper-on', !!hyperOn);

    el.innerHTML = `
      <span class="status-item ok">${LLM.activeProviderLabel()}</span>
      <span class="status-item ${sheetsOk ? 'ok' : 'warn'}" style="cursor:pointer" onclick="Profile.openProfileModal?.()" title="${sheetsOk ? 'Sheets connected' : 'Click to set up Sheets'}">
        ${sheetsOk ? '✅' : '⚠️'} Sheets
      </span>
      <span class="status-item">
        📊 <strong>${RegimeEngine.TRADING_REGIMES[state.regimes?.trading]?.label || state.regimes?.trading || 'Bull'}</strong>
      </span>
      <span class="status-item">
        🏆 <strong>${RegimeEngine.SPORTS_REGIMES[state.regimes?.sports]?.label || state.regimes?.sports || 'Mid Season'}</strong>
      </span>`;
  }

  // ── Show what data was auto-fetched ──
  function showFetchSummary(domain, feedResult) {
    const container = document.getElementById(`${domain}-results`);
    if (!container) return;
    if (!feedResult?.sources?.length) return;
    container.innerHTML = `
      <div class="fetch-summary">
        <div class="fetch-summary-title">📡 Live data fetched</div>
        <div class="fetch-summary-sources">${feedResult.sources.map(s => `<span class="source-chip">${s}</span>`).join('')}</div>
        <details class="fetch-raw-details">
          <summary>View raw context fed to agents</summary>
          <pre class="fetch-raw">${feedResult.context.slice(0, 2000)}${feedResult.context.length > 2000 ? '\n…(truncated)' : ''}</pre>
        </details>
        <div style="margin-top:10px;color:var(--text-muted);font-size:12px">⏳ Agents are now debating this data…</div>
      </div>`;
  }

  function showLoading(msg) {
    const el = document.getElementById('loading-overlay');
    if (el) { el.querySelector('.loading-text').textContent = msg; el.style.display = 'flex'; }
  }

  function hideLoading() {
    const el = document.getElementById('loading-overlay');
    if (el) el.style.display = 'none';
  }

  function setRunning(running, domain) {
    const btn = document.getElementById(`run-${domain}-btn`);
    if (btn) {
      btn.disabled = running;
      btn.textContent = running
        ? '⏳ Running agents...'
        : `▶ Run ${domain === 'trading' ? 'Trading' : 'Sports'} Session`;
    }
    const progress = document.getElementById(`${domain}-progress`);
    if (progress) progress.style.display = running ? 'block' : 'none';

    // Wire rate-limit handler to show live status
    if (running) {
      DebateEngine.setRateLimitHandler((agentName, waitMs, attempt) => {
        updateProgress({
          message: `⏳ Rate limit hit on "${agentName}" — waiting ${waitMs/1000}s (attempt ${attempt}/3)...`,
          stage: 'waiting',
          domain,
        });
      });
    } else {
      DebateEngine.setRateLimitHandler(null);
    }
  }

  function updateProgress(progress) {
    // Update whichever progress label/bar is visible
    ['trading', 'sports'].forEach(domain => {
      const container = document.getElementById(`${domain}-progress`);
      if (!container || container.style.display === 'none') return;
      const label = container.querySelector('.progress-label');
      const bar = container.querySelector('.progress-bar-inner');
      if (label) label.textContent = progress.message || '';
      if (bar) {
        const stages = {
          fetch: 8, layer1: 20, layer1_done: 35, layer2: 50,
          layer2_done: 65, layer3: 80, layer3_done: 88, layer4: 94,
          complete: 100, waiting: null,
        };
        const pct = stages[progress.stage];
        if (pct !== null && pct !== undefined) bar.style.width = `${pct}%`;
      }
    });
  }

  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container') || (() => {
      const d = document.createElement('div'); d.id = 'toast-container'; document.body.appendChild(d); return d;
    })();
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 4000);
  }

  function markOutcome(sessionId, ticker, correct, returnPct) {
    DB.getAllPicks().then(picks => {
      const pick = picks.find(p => p.sessionId === sessionId && p.ticker === ticker);
      if (pick) SAGE.recordPickOutcome(pick.id, correct, returnPct / 100);
    });
  }

  function markSportsOutcome(game, pick, correct) {
    DB.getAllPicks().then(picks => {
      const found = picks.find(p => p.game === game && p.pick === pick && !p.outcomeDate);
      if (found) SAGE.recordPickOutcome(found.id, correct, correct ? 0.5 : -1);
    });
  }

  return {
    renderAll, renderNav, switchTab, renderAgents, showAgentDetail,
    renderTradingResults, renderSportsResults, renderPerformance, renderRegimePanel,
    renderBacktestResults, updateBacktestProgress, updateStatus,
    showLoading, hideLoading, setRunning, updateProgress, showToast,
    showFetchSummary,
    markOutcome, markSportsOutcome,
  };
})();

// app.js — SAGE main application controller

const SAGE = (() => {

  let state = {
    initialized: false,
    activeTab: 'trading',
    lastTradingSession: null,
    lastSportsSession: null,
    runningSession: false,
    sheetsStatus: { authorized: false },
    regimes: { trading: 'bull', sports: 'mid_season' },
  };

  function isForeground() {
    try {
      return document.visibilityState === 'visible' && document.hasFocus();
    } catch {
      return true;
    }
  }

  function requireForeground(actionLabel = 'This action') {
    if (isForeground()) return true;
    UI.showToast(`${actionLabel} is paused while this tab is in the background.`, 'warning');
    return false;
  }

  function setActiveTab(tab) {
    state.activeTab = tab;
    window._sageState = state;
  }


  function hasSheetsSyncAccess() {
    try {
      return !!(state.sheetsStatus?.authorized
        || state.sheetsStatus?.sheetsAuthorized
        || state.sheetsStatus?.appsScriptConfigured
        || Profile?.getSheetsToken?.()
        || globalThis.SheetsClient?.getAppsScriptUrl?.());
    } catch {
      return false;
    }
  }

  async function refreshSheetsStatus() {
    try {
      if (LLM.IS_LOCAL) {
        state.sheetsStatus = await fetch('/api/health').then(r => r.json()).catch(() => ({}));
      } else {
        const appsScriptUrl = globalThis.SheetsClient?.getAppsScriptUrl?.() || '';
        const token = Profile?.getSheetsToken?.();
        state.sheetsStatus = {
          authorized: !!token || !!appsScriptUrl,
          sheetsAuthorized: !!token,
          appsScriptConfigured: !!appsScriptUrl,
        };
      }
    } catch {
      state.sheetsStatus = {
        authorized: !!Profile?.getSheetsToken?.() || !!globalThis.SheetsClient?.getAppsScriptUrl?.(),
        sheetsAuthorized: !!Profile?.getSheetsToken?.(),
        appsScriptConfigured: !!globalThis.SheetsClient?.getAppsScriptUrl?.(),
      };
    }
    UI.updateStatus(state);
    window._sageState = state;
    return state.sheetsStatus;
  }

  function mapSportToLeague(sport = '') {
    const s = String(sport).toUpperCase();
    if (s.includes('NFL')) return { sport: 'football', league: 'nfl' };
    if (s.includes('NBA')) return { sport: 'basketball', league: 'nba' };
    if (s.includes('MLB')) return { sport: 'baseball', league: 'mlb' };
    if (s.includes('NHL')) return { sport: 'hockey', league: 'nhl' };
    return null;
  }

  function cleanOutcomeText(v) {
    return String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function parseAmericanPnl(odds, units = 1) {
    const o = Number(odds);
    const u = Number(units) || 1;
    if (!Number.isFinite(o) || o === 0) return 0;
    return o < 0 ? (100 / Math.abs(o)) * u : (o / 100) * u;
  }

  function determineSportsOutcome(pick, game) {
    const pickText = cleanOutcomeText(pick.pick);
    const betType = cleanOutcomeText(pick.bet_type || pick.betType || pick.market);
    const odds = Number(pick.odds || 0);
    const awayTeam = String(game.awayTeam || '').toLowerCase();
    const homeTeam = String(game.homeTeam || '').toLowerCase();
    const awayScore = Number(game.awayScore ?? game.awayScoreFinal ?? 0);
    const homeScore = Number(game.homeScore ?? game.homeScoreFinal ?? 0);
    const total = awayScore + homeScore;
    const totalMatch = `${pickText} ${betType}`.match(/\b(over|under)\s*([0-9]+(?:\.[0-9]+)?)\b/i);
    const spreadMatch = `${pickText} ${betType}`.match(/([+\-]\d+(?:\.\d+)?)/);
    const line = Number(pick.line || pick.spread || (totalMatch ? totalMatch[2] : '') || (spreadMatch ? spreadMatch[1] : 0)) || 0;

    if (/over/i.test(betType) || /over/i.test(pickText)) {
      if (!line) return { correct: false, pnl: 0 };
      return { correct: total > line, pnl: total > line ? parseAmericanPnl(odds, pick.units || 1) : -(pick.units || 1) };
    }
    if (/under/i.test(betType) || /under/i.test(pickText)) {
      if (!line) return { correct: false, pnl: 0 };
      return { correct: total < line, pnl: total < line ? parseAmericanPnl(odds, pick.units || 1) : -(pick.units || 1) };
    }

    const winner = awayScore > homeScore ? awayTeam : homeTeam;
    const pickTeam = pickText.replace(/[^a-z\s]/g, ' ');
    const isAway = awayTeam && pickTeam.includes(awayTeam);
    const isHome = homeTeam && pickTeam.includes(homeTeam);
    const guessedTeam = isAway ? awayTeam : isHome ? homeTeam : pickText;
    const won = winner === guessedTeam || pickText.includes(winner);
    return { correct: won, pnl: won ? parseAmericanPnl(odds, pick.units || 1) : -(pick.units || 1) };
  }

  async function reconcileCompletedSportsOutcomes({ sessionResult = state.lastSportsSession } = {}) {
    const picks = await DB.getPicksByDomain('sports').catch(() => []);
    const unresolved = (picks || []).filter(p => !p.outcomeDate && !/live|tbd|tba/i.test(String(p.game_time || p.game || '')));
    if (!unresolved.length) return 0;

    const grouped = new Map();
    for (const pick of unresolved) {
      const meta = mapSportToLeague(pick.sport);
      if (!meta) continue;
      const eventDate = String(pick.eventDate || pick.event_date || '').slice(0, 10);
      const key = `${meta.sport}:${meta.league}:${eventDate}`;
      if (!grouped.has(key)) grouped.set(key, { ...meta, eventDate, picks: [] });
      grouped.get(key).picks.push(pick);
    }

    let updated = 0;
    for (const group of grouped.values()) {
      const board = await DataFeeds.getESPNGames(group.sport, group.league, group.eventDate).catch(() => []);
      for (const pick of group.picks) {
        const game = board.find(g => {
          const tgt = String(pick.game || '').toLowerCase();
          const teams = `${String(g.awayTeam || '').toLowerCase()} @ ${String(g.homeTeam || '').toLowerCase()}`;
          const rev = `${String(g.homeTeam || '').toLowerCase()} @ ${String(g.awayTeam || '').toLowerCase()}`;
          return tgt.includes(teams) || tgt.includes(rev) || teams.includes(tgt) || rev.includes(tgt);
        });
        if (!game || String(game.statusState || '').toLowerCase() === 'pre' || game.isLive) continue;
        const outcome = determineSportsOutcome(pick, game);
        const resultLabel = outcome.correct ? 'win' : 'loss';
        await DB.put(DB.STORES.picks, { ...pick, correct: outcome.correct, returnPct: outcome.pnl, pnl: outcome.pnl, outcomeDate: new Date().toISOString(), outcome: resultLabel });
        if (Array.isArray(sessionResult?.finalPicks)) {
          const livePick = sessionResult.finalPicks.find(p => String(p.sessionId || sessionResult.sessionId) === String(sessionResult.sessionId)
            && String(p.game || '').toLowerCase() === String(pick.game || '').toLowerCase()
            && String(pick.pick || '').toLowerCase() === String(p.pick || '').toLowerCase());
          if (livePick) Object.assign(livePick, { correct: outcome.correct, pnl: outcome.pnl, outcomeDate: new Date().toISOString(), outcome: resultLabel });
        }
        const agreedAgentIds = [
          pick.agentId,
          ...(Array.isArray(pick.agreement_agent_ids) ? pick.agreement_agent_ids : []),
          ...(Array.isArray(pick.agents_in_agreement) ? pick.agents_in_agreement.filter(v => /^([st]_[a-z0-9_]+)$/i.test(String(v).trim())) : []),
        ].map(v => String(v).trim()).filter(Boolean);
        for (const agentId of [...new Set(agreedAgentIds)]) {
          await AgentManager.recordOutcome(agentId, 'sports', outcome.correct, outcome.pnl);
        }
        if (hasSheetsSyncAccess()) {
          await globalThis.SheetsClient?.markSportsOutcome?.({
            sessionId: pick.sessionId,
            game: pick.game,
            pick: pick.pick,
            betType: pick.betType || pick.bet_type,
            eventDate: pick.eventDate || pick.event_date,
            outcome: resultLabel,
            pnl: outcome.pnl,
            agentWeight: pick.agentWeight || pick.source_weight || 1,
          }).catch(() => {});
        }
        updated += 1;
      }
    }

    if (updated) {
      await AgentManager.applyDarwinianUpdate('sports').catch(() => {});
      const agents = await AgentManager.getAllAgents().catch(() => []);
      if (hasSheetsSyncAccess()) {
        await globalThis.SheetsClient?.syncAgentPerformance?.(agents.filter(a => a.domain === 'sports')).catch(() => {});
      }
      if (state.lastSportsSession?.finalPicks?.length) UI.renderSportsResults(state.lastSportsSession);
      UI.renderAgents();
    }
    return updated;
  }

  // ── Boot (called after successful login) ──
  async function init() {
    console.log('🧠 SAGE initializing...');
    UI.showLoading('Initializing SAGE...');

    // Wire header user info
    const session = Auth.getSession();
    if (session) {
      const avatar = document.getElementById('header-avatar');
      const name = document.getElementById('header-username');
      if (avatar) avatar.textContent = session.displayName[0].toUpperCase();
      if (name) name.textContent = session.displayName;
    }

    // Update provider selector in header
    const provEl = document.getElementById('status-provider');
    if (provEl) provEl.value = LLM.getProviderMode();

    // Show/hide odds key nudge
    const oddsNudge = document.getElementById('odds-key-nudge');
    if (oddsNudge) {
      oddsNudge.style.display = Auth.getKeys().odds_api_key ? 'none' : 'flex';
    }

    const _setLoadMsg = (msg) => {
      const el = document.getElementById('loading-text') ||
                 document.querySelector('#loading-overlay .loading-text') ||
                 document.querySelector('.loading-text');
      if (el) el.textContent = msg;
    };

    _setLoadMsg('Loading agents…');
    await AgentManager.init();

    _setLoadMsg('Detecting market regime…');
    await RegimeEngine.loadRegime();
    state.regimes = RegimeEngine.currentRegime();

    // Check sheets status
    if (Profile.hydrateSheetsToken) {
      await Profile.hydrateSheetsToken().catch(() => {});
    }
    _setLoadMsg('Checking Sheets…');
    await refreshSheetsStatus();

    _setLoadMsg('Building dashboard…');
    UI.renderAll();
    UI.updateStatus(state);
    // refresh sheets status asynchronously in case auth/url state just changed
    try { await SAGE.updateSheetsStatus?.(); } catch {}

    // Initialize sports date controls
    const sportsDate = document.getElementById('sports-date-filter');
    if (sportsDate && !sportsDate.value) {
      const today = new Date();
      const local = new Date(today.getTime() - today.getTimezoneOffset() * 60000);
      sportsDate.value = local.toISOString().slice(0, 10);
    }
    state.initialized = true;

    if (!window.__sageOutcomeTimer) {
      window.__sageOutcomeTimer = setInterval(() => {
        if (!state.runningSession && isForeground()) {
          reconcileCompletedSportsOutcomes().catch(() => {});
        }
      }, 15 * 60 * 1000);
    }

    if (!window.__sageFocusListenersAdded) {
      window.__sageFocusListenersAdded = true;
      document.addEventListener('visibilitychange', () => UI.updateStatus(window._sageState || state));
      window.addEventListener('focus', () => UI.updateStatus(window._sageState || state));
      window.addEventListener('blur', () => UI.updateStatus(window._sageState || state));
    }

    window._sageState = state;
    console.log('✅ SAGE2 ready |', LLM.activeProviderLabel(), '| Hyper:', LLM.isHyperMode?.());
    UI.hideLoading();
  }

  // ── Run a trading session (auto-fetches market data first) ──
  async function runTradingSession(userNotes) {
    if (state.runningSession) return;
    if (!requireForeground('Trading session')) return;
    state.runningSession = true;
    UI.setRunning(true, 'trading');

    try {
      // Step 1: Auto-fetch live market data
      UI.updateProgress({ stage: 'fetch', message: '🔍 Fetching live market data (Reddit, RSS, indices)...' });
      const keys = Auth.getKeys();
      const feedResult = await DataFeeds.buildTradingContext(keys, userNotes);

      UI.updateProgress({
        stage: 'layer1',
        message: `✅ Fetched: ${feedResult.sources.join(', ') || 'general knowledge'} — starting debate...`,
      });
      UI.showFetchSummary?.('trading', feedResult);

      // Step 2: Run the debate with auto-fetched context
      const result = await DebateEngine.runTradingDebate(
        { marketContext: feedResult.context },
        (progress) => UI.updateProgress(progress)
      );
      state.lastTradingSession = result;

      await DB.saveSession({ ...result, domain: 'trading' });
      for (const pick of result.finalPicks || []) {
        await DB.savePick({
          domain: 'trading', sessionId: result.sessionId,
          agentId: pick.primary_agent_source || 't_cio',
          ticker: pick.ticker, action: pick.action, entry: pick.entry,
          target: pick.target, stop: pick.stop, confidence: pick.confidence,
          thesis: pick.one_line_thesis, regime: result.regime,
          timestamp: new Date().toISOString(),
        });
      }

      if (result.regime) await RegimeEngine.setRegime('trading', result.regime);
      await AgentManager.applyDarwinianUpdate('trading');

      if (hasSheetsSyncAccess()) {
        const agents = await AgentManager.getAllAgents();
        await globalThis.SheetsClient?.logTradingSession?.(result, agents.reduce((acc, a) => { acc[a.id] = a.weight; return acc; }, {}));
        await globalThis.SheetsClient?.syncAgentPerformance?.(agents.filter(a => a.domain === 'trading'));
      }

      UI.renderTradingResults(result);
      UI.showToast(`Trading session complete — ${result.finalPicks?.length || 0} picks`, 'success');

    } catch (err) {
      console.error('[SAGE] Trading session error:', err);
      UI.renderTradingResults({ error: err.message, layers: {}, finalPicks: [] });
      UI.showToast('Session error: ' + err.message, 'error');
    }

    state.runningSession = false;
    UI.setRunning(false, 'trading');
  }

  // ── Run a sports session (auto-fetches schedule + odds + injuries first) ──
  async function runSportsSession(userNotes) {
    if (state.runningSession) return;
    if (!requireForeground('Sports session')) return;
    state.runningSession = true;
    UI.setRunning(true, 'sports');

    try {
      // Step 1: Auto-fetch live sports data
      UI.updateProgress({ stage: 'fetch', message: '🔍 Fetching schedules, odds, and injury reports...' });
      const keys = Auth.getKeys();
      const sportsDate = document.getElementById('sports-date-filter')?.value || new Date().toISOString().slice(0,10);
      const feedResult = await DataFeeds.buildSportsContext(keys, userNotes, { date: sportsDate, activeScreen: isForeground() });

      if (!feedResult.hasOdds) {
        UI.showToast('⚠️ No Odds API key — add one free in Profile for real moneylines', 'warning');
      }

      UI.updateProgress({
        stage: 'layer1',
        message: `✅ Fetched: ${feedResult.sources.join(', ') || 'ESPN schedules'} — starting debate...`,
      });
      UI.showFetchSummary?.('sports', feedResult);

      // Step 2: Run the debate
      const result = await DebateEngine.runSportsDebate(
        { gamesContext: feedResult.context, scheduleData: feedResult.scheduleData || {} },
        (progress) => UI.updateProgress(progress)
      );
      state.lastSportsSession = result;

      await DB.saveSession({ ...result, domain: 'sports' });
      for (const pick of result.finalPicks || []) {
        await DB.savePick({
          domain: 'sports', sessionId: result.sessionId,
          agentId: pick.source_agent || 's_cio',
          sport: pick.sport, game: pick.game, eventDate: pick.event_date || pick.eventDate || sportsDate, game_time: pick.game_time || '',
          betType: pick.bet_type,
          pick: pick.pick, odds: pick.odds, units: pick.units,
          confidence: pick.confidence, reasoning: pick.full_reasoning,
          agents_in_agreement: pick.agents_in_agreement || [],
          agreement_agent_ids: pick.agreement_agent_ids || [],
          agreement_llms: pick.agreement_llms || [],
          agreement_breakdown: pick.agreement_breakdown || '',
          timestamp: new Date().toISOString(),
        });
      }

      await AgentManager.applyDarwinianUpdate('sports');

      if (hasSheetsSyncAccess()) {
        await globalThis.SheetsClient?.logSportsSession?.(result);
        const agents = await AgentManager.getAllAgents();
        await globalThis.SheetsClient?.syncAgentPerformance?.(agents.filter(a => a.domain === 'sports'));
      }

      UI.renderSportsResults(result);
      window._sageState = state;
    UI.showToast(`Sports session complete — ${result.finalPicks?.length || 0} picks (≥ -200)`, 'success');

    } catch (err) {
      console.error('[SAGE] Sports session error:', err);
      UI.renderSportsResults({ error: err.message, layers: {}, finalPicks: [] });
      UI.showToast('Session error: ' + err.message, 'error');
    }

    state.runningSession = false;
    UI.setRunning(false, 'sports');
  }


  // ── Update sports date mode label/value ──
  function updateSportsDateMode(mode) {
    const label = document.getElementById('sports-date-label');
    if (label) label.textContent = 'Game start date';
    const dateInput = document.getElementById('sports-date-filter');
    if (dateInput && !dateInput.value) {
      const today = new Date();
      const local = new Date(today.getTime() - today.getTimezoneOffset() * 60000);
      dateInput.value = local.toISOString().slice(0, 10);
    }
    return 'day';
  }

  // ── Run autoresearch on weakest agent ──
  async function runAutoresearch(domain) {
    if (!requireForeground('Autoresearch')) return;
    const targets = domain === 'all' ? ['trading', 'sports'] : [domain];
    UI.showToast('Starting autoresearch...', 'info');
    let started = 0;
    for (const target of targets) {
      const result = await AgentManager.triggerAutoresearch(target);
      if (result.success) started++;
    }
    if (started > 0) {
      UI.showToast(`Autoresearch completed for ${started} domain(s)`, 'success');
      UI.renderAgents();
    } else {
      UI.showToast('Autoresearch found no agent worth rewriting.', 'warning');
    }
  }

  async function runFixWeakestAgent(domain) {
    return runAutoresearch(domain);
  }

  // ── Detect blind spots ──
  async function runBlindSpotDetection(domain) {
    if (!requireForeground('Blind spot scan')) return;
    const targets = domain === 'all' ? ['trading', 'sports'] : [domain];
    UI.showToast('Scanning for blind spots...', 'info');
    let found = 0;
    for (const target of targets) {
      const spots = await AgentManager.detectBlindSpots(target);
      found += spots.length;
      const spawnCheck = await AgentManager.checkSpawnCondition(target);

      if (spawnCheck?.shouldSpawn) {
        const confirmed = window.confirm(`SAGE detected a repeated blind spot pattern in ${target}:

"${spawnCheck.suggestion}"

Spawn a new specialist agent?`);
        if (confirmed) {
          const newAgent = await AgentManager.spawnAgent(target, spawnCheck.suggestion, 'blind spot detection');
          if (newAgent) UI.showToast(`New agent spawned: ${newAgent.name}`, 'success');
        }
      }
    }
    if (found > 0) {
      UI.showToast(`Found ${found} blind spot(s). Check agent cards.`, 'warning');
    } else {
      UI.showToast('No new blind spots detected.', 'info');
    }
    UI.renderAgents();
  }

  // ── Record outcome for a pick ──
  async function recordPickOutcome(pickId, correct, returnPct) {
    const pick = await DB.get(DB.STORES.picks, pickId);
    if (!pick) return;
    await DB.put(DB.STORES.picks, { ...pick, correct, returnPct, outcomeDate: new Date().toISOString() });

    const agreedAgentIds = [
      pick.agentId,
      ...(Array.isArray(pick.agreement_agent_ids) ? pick.agreement_agent_ids : []),
      ...(Array.isArray(pick.agents_in_agreement)
        ? pick.agents_in_agreement.filter(v => /^([st]_[a-z0-9_]+)$/i.test(String(v).trim()))
        : []),
    ].map(v => String(v).trim()).filter(Boolean);
    const uniqueAgentIds = [...new Set(agreedAgentIds)];

    for (const agentId of uniqueAgentIds) {
      await AgentManager.recordOutcome(agentId, pick.domain, correct, returnPct);
    }

    await AgentManager.applyDarwinianUpdate(pick.domain);
    const agents = await AgentManager.getAllAgents();
    if (hasSheetsSyncAccess()) {
      await globalThis.SheetsClient?.syncAgentPerformance?.(agents);
    }
    UI.renderPerformance();
    UI.renderAgents();
    UI.showToast('Outcome recorded ✅', 'success');
  }

  // ── Run backtest ──
  async function runBacktest(config) {
    if (!requireForeground('Backtest')) return;
    UI.showToast('Starting backtest...', 'info');
    try {
      const results = await BacktestEngine.run(config, (p) => {
        UI.updateBacktestProgress(p);
      });
      UI.renderBacktestResults(results);
      UI.showToast(`Backtest complete: ${results.summary.totalReturn?.toFixed(1) || results.summary.totalUnits?.toFixed(2)} ${config.domain === 'trading' ? '% return' : ' units'}`, 'success');
    } catch (err) {
      UI.showToast('Backtest error: ' + err.message, 'error');
    }
  }

  return {
    init,
    runTradingSession,
    runSportsSession,
    runAutoresearch,
    runFixWeakestAgent,
    runBlindSpotDetection,
    recordPickOutcome,
    runBacktest,
    updateSportsDateMode,
    setActiveTab,
    isForeground,
    getState: () => state,
    updateSheetsStatus: async () => {
      await refreshSheetsStatus();
      UI.updateStatus(state);
    },
  };
})();

// ── App boots only after successful login (called from profile.js) ──
// See: Profile.doLogin() and Profile.doRegister() in profile.js

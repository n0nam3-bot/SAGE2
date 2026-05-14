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

  const SPORTS_LEAGUE_MAP = {
    NFL: { sport: 'football', league: 'nfl' },
    NBA: { sport: 'basketball', league: 'nba' },
    MLB: { sport: 'baseball', league: 'mlb' },
    NHL: { sport: 'hockey', league: 'nhl' },
  };

  function normalizeOutcomeLabel(value) {
    return String(value || '').toLowerCase().trim();
  }

  function normalizePickText(value) {
    return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function parsePickTeamFromText(pickText, gameText) {
    const pick = normalizePickText(pickText);
    const game = normalizePickText(gameText);
    if (!pick || !game) return '';
    const candidates = game.split(/\s*@\s*|\s+vs\.?\s+/i).map(s => s.trim()).filter(Boolean);
    for (const team of candidates) {
      if (pick.includes(team)) return team;
    }
    return '';
  }

  function parseTotalLine(pickText) {
    const text = normalizePickText(pickText);
    const m = text.match(/(over|under)\s+([0-9]+(?:\.[0-9]+)?)/i) || text.match(/\b([0-9]+(?:\.[0-9]+)?)\s*(over|under)\b/i);
    if (!m) return null;
    const side = String(m[1]).toLowerCase() === 'over' || String(m[2]).toLowerCase() === 'over' ? 'over' : 'under';
    const line = Number(m[2] || m[1]);
    return Number.isFinite(line) ? { side, line } : null;
  }

  function computeSportsPnl({ correct, odds, units }) {
    const stake = Number(units) || 1;
    if (!correct) return -Math.abs(stake);
    const o = Number(odds);
    if (!Number.isFinite(o) || o === 0) return Math.max(0.5, stake * 0.5);
    return o > 0 ? stake * (o / 100) : stake * (100 / Math.abs(o));
  }

  function computeRunningRoi(picks) {
    const resolved = picks.filter(p => p.domain === 'sports' && p.outcomeDate && Number.isFinite(Number(p.profitLoss ?? p.returnPct)));
    const totalStake = resolved.reduce((sum, p) => sum + Math.max(0, Number(p.units) || 0), 0);
    const totalPnL = resolved.reduce((sum, p) => sum + (Number(p.profitLoss ?? p.returnPct) || 0), 0);
    if (!totalStake) return 0;
    return Math.round((totalPnL / totalStake) * 1000) / 10;
  }

  async function determineSportsOutcome(pick) {
    const sportKey = String(pick.sport || '').toUpperCase();
    const leagueInfo = SPORTS_LEAGUE_MAP[sportKey];
    if (!leagueInfo || !pick.event_date) return null;
    const games = await DataFeeds.getESPNGames(leagueInfo.sport, leagueInfo.league, pick.event_date);
    const game = games.find(g => {
      const gameName = normalizePickText(`${g.awayTeam} @ ${g.homeTeam}`);
      const pickGame = normalizePickText(pick.game);
      return gameName === pickGame || gameName.includes(pickGame) || pickGame.includes(gameName);
    });
    if (!game || game.statusState !== 'post') return null;

    const awayScore = Number(game.awayScore);
    const homeScore = Number(game.homeScore);
    if (!Number.isFinite(awayScore) || !Number.isFinite(homeScore)) return null;
    const totalScore = awayScore + homeScore;
    const gameText = normalizePickText(pick.game);
    const pickText = normalizePickText(pick.pick);
    const betType = normalizeOutcomeLabel(pick.betType || pick.bet_type);

    let correct = null;
    if (/total|over|under|ou/.test(betType) || /\b(over|under)\b/.test(pickText)) {
      const parsed = parseTotalLine(pick.pick || pickText);
      if (parsed) {
        correct = parsed.side === 'over' ? totalScore > parsed.line : totalScore < parsed.line;
      }
    } else if (/spread|runline|puckline/.test(betType)) {
      // Best-effort spread support when the line is embedded in the pick label.
      const parsed = (pickText.match(/([+-]\d+(?:\.\d+)?)/) || [])[1];
      const line = parsed ? Number(parsed) : NaN;
      const team = parsePickTeamFromText(pick.pick, pick.game);
      if (Number.isFinite(line) && team) {
        const awayTeam = normalizePickText(game.awayTeam);
        const homeTeam = normalizePickText(game.homeTeam);
        const margin = awayScore - homeScore;
        const pickedAway = normalizePickText(team) === awayTeam;
        const pickedHome = normalizePickText(team) === homeTeam;
        if (pickedAway) correct = (margin + line) > 0;
        if (pickedHome) correct = (-margin + line) > 0;
      }
    } else {
      const team = parsePickTeamFromText(pick.pick, pick.game);
      const winner = awayScore > homeScore ? normalizePickText(game.awayTeam) : normalizePickText(game.homeTeam);
      if (team) correct = normalizePickText(team) === winner;
      else if (/away|road/.test(pickText) || pickText === normalizePickText(game.awayTeam)) correct = normalizePickText(game.awayTeam) === winner;
      else if (/home/.test(pickText) || pickText === normalizePickText(game.homeTeam)) correct = normalizePickText(game.homeTeam) === winner;
    }

    if (correct == null) return null;
    const pnl = computeSportsPnl({ correct, odds: pick.odds, units: pick.units });
    return { correct, pnl, game, totalScore };
  }

  async function syncResolvedSportsPicks() {
    if (!state.initialized || !isForeground()) return;
    if (!state.sheetsStatus?.authorized && !Profile.getSheetsToken?.()) return;
    const picks = await DB.getAllPicks();
    const unresolved = picks.filter(p => p.domain === 'sports' && !p.outcomeDate && p.event_date && p.game && p.pick);
    if (!unresolved.length) return;
    let updated = 0;
    for (const pick of unresolved) {
      try {
        const result = await determineSportsOutcome(pick);
        if (!result) continue;
        const pnl = result.pnl;
        const correct = !!result.correct;
        await SAGE.recordPickOutcome(pick.id, correct, pnl);
        const allPicks = await DB.getAllPicks();
        const runningRoi = computeRunningRoi(allPicks);
        await globalThis.SheetsClient?.markSportsOutcome?.({
          sessionId: pick.sessionId,
          identifier: `${pick.game}||${pick.pick}`,
          outcome: correct ? 'win' : 'loss',
          pnl: Number(pnl.toFixed ? pnl.toFixed(2) : pnl),
          runningRoi,
          agentWeight: pick.agentWeight ?? pick.source_weight ?? '',
        });
        updated++;
      } catch (err) {
        console.warn('[SAGE] Sports outcome sync failed for', pick.game, err.message);
      }
    }
    if (updated > 0) {
      UI.renderPerformance();
      UI.renderAgents();
      if (state.sheetsStatus?.authorized) {
        const agents = await AgentManager.getAllAgents();
        await globalThis.SheetsClient?.syncAgentPerformance?.(agents.filter(a => a.domain === 'sports'));
      }
    }
  }

  function scheduleOutcomeSync() {
    if (window.__sageOutcomeSyncInterval) return;
    window.__sageOutcomeSyncInterval = setInterval(() => {
      if (state.runningSession || !isForeground()) return;
      syncResolvedSportsPicks().catch(() => {});
    }, 15 * 60 * 1000);
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
    if (LLM.IS_LOCAL) {
      _setLoadMsg('Connecting to server…');
      state.sheetsStatus = await fetch('/api/health').then(r => r.json()).catch(() => ({}));
    } else {
      const appsScriptUrl = globalThis.SheetsClient?.getAppsScriptUrl?.() || '';
      state.sheetsStatus = { authorized: !!Profile.getSheetsToken() || !!appsScriptUrl, appsScriptConfigured: !!appsScriptUrl, sheetsAuthorized: !!Profile.getSheetsToken() };
    }

    _setLoadMsg('Building dashboard…');
    UI.renderAll();
    UI.updateStatus(state);
    scheduleOutcomeSync();

    // Initialize sports date controls
    const sportsDate = document.getElementById('sports-date-filter');
    if (sportsDate && !sportsDate.value) {
      const today = new Date();
      const local = new Date(today.getTime() - today.getTimezoneOffset() * 60000);
      sportsDate.value = local.toISOString().slice(0, 10);
    }
    state.initialized = true;
    syncResolvedSportsPicks().catch(() => {});

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

      if (state.sheetsStatus?.authorized) {
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
          sport: pick.sport, game: pick.game, betType: pick.bet_type,
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

      if (state.sheetsStatus?.authorized) {
        await globalThis.SheetsClient?.logSportsSession?.(result);
        const agents = await AgentManager.getAllAgents();
        await globalThis.SheetsClient?.syncAgentPerformance?.(agents.filter(a => a.domain === 'sports'));
      }

      UI.renderSportsResults(result);
      window._sageState = state;
      syncResolvedSportsPicks().catch(() => {});
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
    await DB.put(DB.STORES.picks, { ...pick, correct, returnPct, profitLoss: returnPct, outcomeDate: new Date().toISOString() });

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

    if (pick.domain === 'sports' && state.sheetsStatus?.authorized) {
      const allPicks = await DB.getAllPicks();
      const runningRoi = computeRunningRoi(allPicks);
      await globalThis.SheetsClient?.markSportsOutcome?.({
        sessionId: pick.sessionId,
        identifier: `${pick.game}||${pick.pick || pick.ticker || ''}`,
        outcome: correct ? 'win' : 'loss',
        pnl: Number(returnPct || 0),
        runningRoi,
        agentWeight: pick.agentWeight ?? pick.source_weight ?? '',
      });
    }

    await AgentManager.applyDarwinianUpdate(pick.domain);
    const agents = await AgentManager.getAllAgents();
    if (state.sheetsStatus?.authorized) {
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
      if (LLM.IS_LOCAL) {
        state.sheetsStatus = await fetch('/api/health').then(r => r.json()).catch(() => ({}));
      } else {
        const _scriptUrl = globalThis.SheetsClient?.getAppsScriptUrl?.() || '';
        state.sheetsStatus = { authorized: !!Profile.getSheetsToken() || !!_scriptUrl, sheetsAuthorized: !!Profile.getSheetsToken(), appsScriptConfigured: !!_scriptUrl };
      }
      UI.updateStatus(state);
    },
  };
})();

// ── App boots only after successful login (called from profile.js) ──
// See: Profile.doLogin() and Profile.doRegister() in profile.js

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
      const appsScriptUrl = SheetsClient.getAppsScriptUrl();
      state.sheetsStatus = { authorized: !!Profile.getSheetsToken() || !!appsScriptUrl, appsScriptConfigured: !!appsScriptUrl, sheetsAuthorized: !!Profile.getSheetsToken() };
    }

    _setLoadMsg('Building dashboard…');
    UI.renderAll();
    UI.updateStatus(state);

    // Initialize sports date controls
    const sportsDate = document.getElementById('sports-date-filter');
    if (sportsDate && !sportsDate.value) {
      const today = new Date();
      const local = new Date(today.getTime() - today.getTimezoneOffset() * 60000);
      sportsDate.value = local.toISOString().slice(0, 10);
    }
    const sportsMode = document.getElementById('sports-date-mode');
    if (sportsMode) sportsMode.value = localStorage.getItem('sage_sports_date_mode') || 'day';
    state.initialized = true;

    if (!window.__sageFocusListenersAdded) {
      window.__sageFocusListenersAdded = true;
      document.addEventListener('visibilitychange', () => UI.updateStatus(window._sageState || state));
      window.addEventListener('focus', () => UI.updateStatus(window._sageState || state));
      window.addEventListener('blur', () => UI.updateStatus(window._sageState || state));
    }

    window._sageState = state;
    console.log('✅ SAGE2 ready |', LLM.activeProviderLabel(), '| Consensus:', LLM.isConsensusMode());
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
        await SheetsClient.logTradingSession(result, agents.reduce((acc, a) => { acc[a.id] = a.weight; return acc; }, {}));
        await SheetsClient.syncAgentPerformance(agents.filter(a => a.domain === 'trading'));
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
      const sportsMode = document.getElementById('sports-date-mode')?.value || 'day';
      const feedResult = await DataFeeds.buildSportsContext(keys, userNotes, { date: sportsDate, mode: sportsMode, activeScreen: isForeground() });

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
        { gamesContext: feedResult.context },
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
          timestamp: new Date().toISOString(),
        });
      }

      await AgentManager.applyDarwinianUpdate('sports');

      if (state.sheetsStatus?.authorized) {
        await SheetsClient.logSportsSession(result);
        const agents = await AgentManager.getAllAgents();
        await SheetsClient.syncAgentPerformance(agents.filter(a => a.domain === 'sports'));
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
    const safeMode = mode === 'week' ? 'week' : 'day';
    localStorage.setItem('sage_sports_date_mode', safeMode);
    const label = document.getElementById('sports-date-label');
    if (label) label.textContent = safeMode === 'week' ? 'Week start date' : 'Game start date';
    const dateInput = document.getElementById('sports-date-filter');
    if (dateInput && !dateInput.value) {
      const today = new Date();
      const local = new Date(today.getTime() - today.getTimezoneOffset() * 60000);
      dateInput.value = local.toISOString().slice(0, 10);
    }
    return safeMode;
  }

  // ── Run autoresearch on weakest agent ──
  async function runAutoresearch(domain) {
    if (!requireForeground('Autoresearch')) return;
    UI.showToast('Starting autoresearch...', 'info');
    const result = await AgentManager.triggerAutoresearch(domain);
    if (result.success) {
      UI.showToast(`Autoresearch: shadow mode started for ${result.agentName}`, 'success');
      UI.renderAgents();
    } else {
      UI.showToast('Autoresearch: ' + result.reason, 'warning');
    }
  }

  // ── Detect blind spots ──
  async function runBlindSpotDetection(domain) {
    if (!requireForeground('Blind spot scan')) return;
    UI.showToast('Scanning for blind spots...', 'info');
    const spots = await AgentManager.detectBlindSpots(domain);
    const spawnCheck = await AgentManager.checkSpawnCondition(domain);

    if (spawnCheck?.shouldSpawn) {
      const confirmed = window.confirm(`SAGE detected a repeated blind spot pattern:\n\n"${spawnCheck.suggestion}"\n\nSpawn a new specialist agent?`);
      if (confirmed) {
        const newAgent = await AgentManager.spawnAgent(domain, spawnCheck.suggestion, 'blind spot detection');
        if (newAgent) UI.showToast(`New agent spawned: ${newAgent.name}`, 'success');
      }
    } else if (spots.length > 0) {
      UI.showToast(`Found ${spots.length} blind spot(s). Check agent cards.`, 'warning');
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
    await AgentManager.recordOutcome(pick.agentId, pick.domain, correct, returnPct);
    await AgentManager.applyDarwinianUpdate(pick.domain);
    const agents = await AgentManager.getAllAgents();
    if (state.sheetsStatus?.authorized) {
      await SheetsClient.syncAgentPerformance(agents);
    }
    UI.renderPerformance();
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
        const _scriptUrl = SheetsClient.getAppsScriptUrl();
        state.sheetsStatus = { authorized: !!Profile.getSheetsToken() || !!_scriptUrl, sheetsAuthorized: !!Profile.getSheetsToken(), appsScriptConfigured: !!_scriptUrl };
      }
      UI.updateStatus(state);
    },
  };
})();

// ── App boots only after successful login (called from profile.js) ──
// See: Profile.doLogin() and Profile.doRegister() in profile.js

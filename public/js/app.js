// app.js — SAGE2 main application controller

const SAGE = (() => {

  let state = {
    initialized: false,
    activeTab: 'trading',
    lastTradingSession: null,
    lastSportsSession: null,
    runningSession: false,
    sheetsStatus: { authorized: false },
    regimes: { trading: 'bull', sports: 'mid_season' },
    hyperMode: false,
  };

  // ── Boot ──
  async function init() {
    console.log('🧠 SAGE2 initializing...');
    UI.showLoading('Initializing SAGE2...');

    const session = Auth.getSession();
    if (session) {
      const avatar = document.getElementById('header-avatar');
      const name = document.getElementById('header-username');
      if (avatar) avatar.textContent = session.displayName[0].toUpperCase();
      if (name) name.textContent = session.displayName;
    }

    const provEl = document.getElementById('status-provider');
    if (provEl) provEl.value = LLM.getProviderMode();

    const oddsNudge = document.getElementById('odds-key-nudge');
    if (oddsNudge) {
      oddsNudge.style.display = Auth.getKeys().odds_api_key ? 'none' : 'flex';
    }

    // Reset model indices for new session
    LLM.resetModelIndices?.();

    await AgentManager.init();
    await RegimeEngine.loadRegime();
    state.regimes = RegimeEngine.currentRegime();

    if (Profile.hydrateSheetsToken) {
      await Profile.hydrateSheetsToken().catch(() => {});
    }
    if (LLM.IS_LOCAL) {
      state.sheetsStatus = await fetch('/api/health').then(r => r.json()).catch(() => ({}));
    } else {
      state.sheetsStatus = { authorized: !!Profile.getSheetsToken(), configured: !!Auth.getKeys().google_client_id };
    }

    UI.renderAll();
    UI.updateStatus(state);

    // Initialize sports date control — single date only
    const sportsDate = document.getElementById('sports-date-filter');
    if (sportsDate && !sportsDate.value) {
      const today = new Date();
      const local = new Date(today.getTime() - today.getTimezoneOffset() * 60000);
      sportsDate.value = local.toISOString().slice(0, 10);
    }

    state.initialized = true;
    console.log('✅ SAGE2 ready |', LLM.activeProviderLabel());
    UI.hideLoading();
  }

  // ── Toggle Hyper Mode ──
  function toggleHyperMode(enabled) {
    state.hyperMode = enabled;
    DebateEngine.setHyperMode(enabled);
    const btn = document.getElementById('hyper-mode-btn');
    if (btn) {
      btn.textContent = enabled ? '⚡ HYPER MODE ON' : '⚡ Hyper Mode';
      btn.style.background = enabled
        ? 'linear-gradient(135deg, #7c3aed, #f59e0b)'
        : '';
      btn.style.border = enabled ? '2px solid #f59e0b' : '';
    }
    const indicator = document.getElementById('hyper-mode-indicator');
    if (indicator) indicator.style.display = enabled ? 'flex' : 'none';
    UI.showToast(enabled ? '⚡ Hyper Mode ON — all available providers will consult on each agent' : 'Hyper Mode OFF', enabled ? 'warning' : 'info');
  }

  // ── Run a trading session ──
  async function runTradingSession(userNotes) {
    if (state.runningSession) return;
    state.runningSession = true;
    UI.setRunning(true, 'trading');
    LLM.resetModelIndices?.();

    try {
      UI.updateProgress({ stage: 'fetch', message: '🔍 Fetching live market data (Reddit, RSS, indices)...' });
      const keys = Auth.getKeys();
      const feedResult = await DataFeeds.buildTradingContext(keys, userNotes);

      UI.updateProgress({
        stage: 'layer1',
        message: `✅ Fetched: ${feedResult.sources.join(', ') || 'general knowledge'} — starting debate${state.hyperMode ? ' [HYPER MODE]' : ''}...`,
      });
      UI.showFetchSummary?.('trading', feedResult);

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

      if (state.sheetsStatus?.sheetsAuthorized || Profile.getSheetsToken()) {
        const agents = await AgentManager.getAllAgents();
        await SheetsClient.logTradingSession(result, agents.reduce((acc, a) => { acc[a.id] = a.weight; return acc; }, {}));
        await SheetsClient.syncAgentPerformance(agents.filter(a => a.domain === 'trading'));
      }

      UI.renderTradingResults(result);
      UI.showToast(`Trading session complete — ${result.finalPicks?.length || 0} picks`, 'success');

    } catch (err) {
      console.error('[SAGE2] Trading session error:', err);
      UI.renderTradingResults({ error: err.message, layers: {}, finalPicks: [] });
      UI.showToast('Session error: ' + err.message, 'error');
    }

    state.runningSession = false;
    UI.setRunning(false, 'trading');
  }

  // ── Run a sports session — single date ──
  async function runSportsSession(userNotes) {
    if (state.runningSession) return;
    state.runningSession = true;
    UI.setRunning(true, 'sports');
    LLM.resetModelIndices?.();

    try {
      UI.updateProgress({ stage: 'fetch', message: '🔍 Fetching schedules, odds, and injury reports...' });
      const keys = Auth.getKeys();
      const sportsDate = document.getElementById('sports-date-filter')?.value || new Date().toISOString().slice(0,10);

      const feedResult = await DataFeeds.buildSportsContext(keys, userNotes, { date: sportsDate });

      if (!feedResult.hasOdds) {
        UI.showToast('⚠️ No Odds API key — add one free in Profile for real moneylines', 'warning');
      }

      UI.updateProgress({
        stage: 'layer1',
        message: `✅ Fetched: ${feedResult.sources.join(', ') || 'ESPN schedules'} — starting debate${state.hyperMode ? ' [HYPER MODE]' : ''}...`,
      });
      UI.showFetchSummary?.('sports', feedResult);

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

      if (state.sheetsStatus?.sheetsAuthorized || Profile.getSheetsToken()) {
        await SheetsClient.logSportsSession(result);
        const agents = await AgentManager.getAllAgents();
        await SheetsClient.syncAgentPerformance(agents.filter(a => a.domain === 'sports'));
      }

      UI.renderSportsResults(result);
      UI.showToast(`Sports session complete — ${result.finalPicks?.length || 0} best picks (≥ -200)`, 'success');

    } catch (err) {
      console.error('[SAGE2] Sports session error:', err);
      UI.renderSportsResults({ error: err.message, layers: {}, finalPicks: [] });
      UI.showToast('Session error: ' + err.message, 'error');
    }

    state.runningSession = false;
    UI.setRunning(false, 'sports');
  }

  async function runAutoresearch(domain) {
    UI.showToast('Starting autoresearch...', 'info');
    const result = await AgentManager.triggerAutoresearch(domain);
    if (result.success) {
      UI.showToast(`Autoresearch: shadow mode started for ${result.agentName}`, 'success');
      UI.renderAgents();
    } else {
      UI.showToast('Autoresearch: ' + result.reason, 'warning');
    }
  }

  async function runBlindSpotDetection(domain) {
    UI.showToast('Scanning for blind spots...', 'info');
    const spots = await AgentManager.detectBlindSpots(domain);
    const spawnCheck = await AgentManager.checkSpawnCondition(domain);

    if (spawnCheck?.shouldSpawn) {
      const confirmed = window.confirm(`SAGE2 detected a repeated blind spot pattern:\n\n"${spawnCheck.suggestion}"\n\nSpawn a new specialist agent?`);
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

  async function recordPickOutcome(pickId, correct, returnPct) {
    const pick = await DB.get(DB.STORES.picks, pickId);
    if (!pick) return;
    await DB.put(DB.STORES.picks, { ...pick, correct, returnPct, outcomeDate: new Date().toISOString() });
    await AgentManager.recordOutcome(pick.agentId, pick.domain, correct, returnPct);
    await AgentManager.applyDarwinianUpdate(pick.domain);
    const agents = await AgentManager.getAllAgents();
    if (state.sheetsStatus.authorized) {
      await SheetsClient.syncAgentPerformance(agents);
    }
    UI.renderPerformance();
    UI.showToast('Outcome recorded ✅', 'success');
  }

  async function runBacktest(config) {
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
    toggleHyperMode,
    runTradingSession,
    runSportsSession,
    runAutoresearch,
    runBlindSpotDetection,
    recordPickOutcome,
    runBacktest,
    getState: () => state,
    updateSheetsStatus: async () => {
      if (LLM.IS_LOCAL) {
        state.sheetsStatus = await fetch('/api/health').then(r => r.json()).catch(() => ({}));
      } else {
        state.sheetsStatus = { authorized: !!Profile.getSheetsToken(), sheetsAuthorized: !!Profile.getSheetsToken() };
      }
      UI.updateStatus(state);
    },
  };
})();

// engine/regime.js — Market regime detection and meta-layer cohort weighting

const RegimeEngine = (() => {

  // ── Regime definitions ──
  const TRADING_REGIMES = {
    bull:     { label: 'Bull Market',    color: '#22c55e', icon: '🐂', description: 'Trending up, low volatility, risk-on' },
    bear:     { label: 'Bear Market',    color: '#ef4444', icon: '🐻', description: 'Trending down, elevated fear, risk-off' },
    sideways: { label: 'Sideways',       color: '#f59e0b', icon: '↔️', description: 'Range-bound, mean reverting' },
    high_vol: { label: 'High Volatility', color: '#f97316', icon: '⚡', description: 'VIX elevated, sharp moves, choppy' },
    low_vol:  { label: 'Low Volatility',  color: '#06b6d4', icon: '💤', description: 'VIX compressed, melt-up conditions' },
    crisis:   { label: 'Crisis',          color: '#dc2626', icon: '🚨', description: 'Systemic stress, correlations → 1' },
  };

  const SPORTS_REGIMES = {
    early_season:  { label: 'Early Season',   color: '#3b82f6', icon: '🏁', description: 'Small sample sizes, high variance' },
    mid_season:    { label: 'Mid Season',     color: '#22c55e', icon: '📊', description: 'Large samples, stable lines' },
    playoffs:      { label: 'Playoffs',       color: '#f59e0b', icon: '🏆', description: 'Motivation/intensity elevated' },
    championship:  { label: 'Championship',   color: '#a855f7', icon: '🎯', description: 'Peak intensity, max sample usage' },
  };

  // ── Cohort definitions: which agents work best in each regime ──
  const TRADING_COHORTS = {
    bull: {
      primaryAgents: ['t_simons', 't_lynch', 't_semis', 't_software'],
      boost: 1.2,
      suppress: ['t_cro'],
      suppressFactor: 0.8,
      description: 'Momentum and growth work in bull markets. CRO naturally more cautious.',
    },
    bear: {
      primaryAgents: ['t_cro', 't_druckenmiller', 't_geopolitical', 't_volatility'],
      boost: 1.3,
      suppress: ['t_lynch', 't_buffett'],
      suppressFactor: 0.7,
      description: 'Risk management and macro top-down dominate in bear markets.',
    },
    sideways: {
      primaryAgents: ['t_buffett', 't_simons', 't_alpha'],
      boost: 1.2,
      suppress: ['t_druckenmiller'],
      suppressFactor: 0.8,
      description: 'Value and mean-reversion strategies outperform in choppy markets.',
    },
    high_vol: {
      primaryAgents: ['t_volatility', 't_cro', 't_liquidity'],
      boost: 1.4,
      suppress: ['t_semis', 't_software'],
      suppressFactor: 0.6,
      description: 'Risk management and volatility specialists critical in high-vol.',
    },
    low_vol: {
      primaryAgents: ['t_simons', 't_semis', 't_software', 't_lynch'],
      boost: 1.2,
      suppress: ['t_volatility'],
      suppressFactor: 0.7,
      description: 'Growth and momentum strategies benefit from low-vol melt-up.',
    },
    crisis: {
      primaryAgents: ['t_cro', 't_liquidity', 't_druckenmiller'],
      boost: 1.5,
      suppress: ['t_buffett', 't_lynch', 't_alpha'],
      suppressFactor: 0.5,
      description: 'Only macro, liquidity, and risk-aware agents trusted in crisis.',
    },
  };

  const SPORTS_COHORTS = {
    early_season: {
      primaryAgents: ['s_sharp', 's_injury'],
      boost: 1.3,
      suppress: ['s_trends'],
      suppressFactor: 0.6,
      description: 'Line movement and injury news more valuable than small samples.',
    },
    mid_season: {
      primaryAgents: ['s_trends', 's_nfl', 's_nba', 's_mlb', 's_nhl'],
      boost: 1.1,
      suppress: [],
      suppressFactor: 1.0,
      description: 'All agents reliable with large sample sizes.',
    },
    playoffs: {
      primaryAgents: ['s_situational', 's_sharp', 's_injury'],
      boost: 1.3,
      suppress: ['s_trends'],
      suppressFactor: 0.8,
      description: 'Motivation, health, and sharp money dominate playoff betting.',
    },
    championship: {
      primaryAgents: ['s_sharp', 's_situational', 's_mma'],
      boost: 1.4,
      suppress: [],
      suppressFactor: 1.0,
      description: 'Maximum research and motivation at championship level.',
    },
  };

  // ── Current regime state ──
  let currentRegime = { trading: 'bull', sports: 'mid_season' };

  async function loadRegime() {
    const saved = await DB.getSetting('currentRegime');
    if (saved) currentRegime = saved;
    return currentRegime;
  }

  async function setRegime(domain, regime) {
    currentRegime[domain] = regime;
    await DB.setSetting('currentRegime', currentRegime);
    await DB.put(DB.STORES.regimes, {
      domain,
      regime,
      date: new Date().toISOString(),
      setBy: 'user',
    });
    return currentRegime;
  }

  // ── Auto-detect regime from CIO output ──
  async function updateRegimeFromCIO(cioOutput) {
    if (cioOutput?.regime_call) {
      await setRegime('trading', cioOutput.regime_call);
    }
  }

  // ── Get cohort-adjusted weights for current regime ──
  async function getCohortWeights(domain) {
    const regime = currentRegime[domain];
    const cohorts = domain === 'trading' ? TRADING_COHORTS : SPORTS_COHORTS;
    const cohort = cohorts[regime];
    if (!cohort) return {};

    const agents = await AgentManager.getAllAgents();
    const weights = {};

    for (const agent of agents.filter(a => a.domain === domain)) {
      let w = agent.weight;
      if (cohort.primaryAgents?.includes(agent.id)) {
        w *= cohort.boost;
      } else if (cohort.suppress?.includes(agent.id)) {
        w *= cohort.suppressFactor;
      }
      weights[agent.id] = Math.min(3.0, Math.max(0.1, w));
    }
    return weights;
  }

  // ── Meta-layer: track which cohort performed best per regime ──
  async function recordCohortPerformance(domain, regime, returnPct) {
    const key = `cohort_perf_${domain}_${regime}`;
    const existing = await DB.getSetting(key, { regime, returns: [], sessions: 0 });
    existing.returns.push(returnPct);
    existing.sessions++;
    existing.avgReturn = existing.returns.reduce((s, r) => s + r, 0) / existing.returns.length;
    await DB.setSetting(key, existing);
  }

  async function getCohortTrustMetrics(domain) {
    const regimes = domain === 'trading' ? Object.keys(TRADING_REGIMES) : Object.keys(SPORTS_REGIMES);
    const metrics = {};
    for (const regime of regimes) {
      const key = `cohort_perf_${domain}_${regime}`;
      const data = await DB.getSetting(key, { sessions: 0, avgReturn: 0 });
      metrics[regime] = data;
    }
    return metrics;
  }

  return {
    TRADING_REGIMES,
    SPORTS_REGIMES,
    TRADING_COHORTS,
    SPORTS_COHORTS,
    currentRegime: () => currentRegime,
    loadRegime,
    setRegime,
    updateRegimeFromCIO,
    getCohortWeights,
    recordCohortPerformance,
    getCohortTrustMetrics,
  };
})();

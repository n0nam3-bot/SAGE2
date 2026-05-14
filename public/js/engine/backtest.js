// engine/backtest.js — Backtest simulation engine

const BacktestEngine = (() => {

  function normalizeConfidence100(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 50;
    return n <= 10 ? Math.round(n * 10) : Math.max(0, Math.min(100, Math.round(n)));
  }

  // ── Run a backtest for a given domain and context ──
  async function run(config, onProgress) {
    const {
      domain,         // 'trading' | 'sports'
      sessions,       // number of sessions to simulate
      marketContexts, // array of context strings (one per session)
      startingCapital = 100000,
      betUnit = 100,  // for sports: 1 unit = $100
    } = config;

    const results = {
      id: `bt_${domain}_${Date.now()}`,
      domain,
      config,
      sessions: [],
      equityCurve: [],
      agentStats: {},
      startTime: new Date().toISOString(),
    };

    let capital = startingCapital;
    let units = 0;

    for (let i = 0; i < sessions; i++) {
      const ctx = marketContexts?.[i] || buildSyntheticContext(domain, i);
      onProgress?.({ session: i + 1, total: sessions, message: `Running session ${i + 1}/${sessions}...` });

      let sessionResult;
      try {
        if (domain === 'trading') {
          sessionResult = await DebateEngine.runTradingDebate({ marketContext: ctx });
          const outcome = simulateTradingOutcome(sessionResult.finalPicks || []);
          capital *= (1 + outcome.totalReturn);
          results.equityCurve.push({
            session: i + 1,
            capital: Math.round(capital),
            dailyReturn: outcome.totalReturn,
            picks: outcome.picks,
          });
          // Update agent stats from simulated outcomes
          for (const pick of outcome.picks) {
            await AgentManager.recordOutcome(pick.agentId, 'trading', pick.correct, pick.returnPct);
          }
        } else {
          sessionResult = await DebateEngine.runSportsDebate({ gamesContext: ctx });
          const outcome = simulateSportsOutcome(sessionResult.finalPicks || []);
          units += outcome.totalUnits;
          results.equityCurve.push({
            session: i + 1,
            units: Math.round(units * 100) / 100,
            roi: units > 0 ? ((units * betUnit) / (startingCapital)) * 100 : 0,
            picks: outcome.picks,
          });
          for (const pick of outcome.picks) {
            await AgentManager.recordOutcome(pick.agentId, 'sports', pick.correct, pick.profitLoss);
          }
        }

        results.sessions.push({ session: i + 1, result: sessionResult });
        await AgentManager.applyDarwinianUpdate(domain);
      } catch (err) {
        console.error(`[Backtest] Session ${i + 1} error:`, err.message);
        results.sessions.push({ session: i + 1, error: err.message });
      }

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 2000));
    }

    // Final agent weight snapshot
    const agents = await AgentManager.getAllAgents();
    results.finalAgentWeights = agents
      .filter(a => a.domain === domain)
      .map(a => ({ id: a.id, name: a.name, weight: a.weight, stats: a.stats }));

    results.endTime = new Date().toISOString();
    results.summary = computeSummary(results, domain, startingCapital, capital, units);

    // Save backtest locally (server only)
    if (typeof LLM !== 'undefined' && LLM.IS_LOCAL) {
      try {
        await fetch('/api/results/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: `${results.id}.json`, data: results }),
        });
      } catch { /* non-critical */ }
    }

    onProgress?.({ session: sessions, total: sessions, message: 'Backtest complete!', final: true });
    return results;
  }

  // ── Simulate trading outcomes (random with realistic properties) ──
  function simulateTradingOutcome(picks) {
    const outcomes = picks.map(pick => {
      const confidence = normalizeConfidence100(pick.confidence ?? 50) / 100;
      const winProb = 0.45 + confidence * 0.25; // 45-70% based on confidence
      const correct = Math.random() < winProb;
      const returnPct = correct
        ? (Math.random() * 0.15 + 0.02) // +2% to +17%
        : -(Math.random() * 0.08 + 0.01); // -1% to -9%
      return {
        ...pick,
        correct,
        returnPct,
        agentId: pick.primary_agent_source || 't_cio',
      };
    });

    const totalReturn = outcomes.length > 0
      ? outcomes.reduce((s, o) => s + (o.returnPct * (1 / outcomes.length)), 0)
      : 0;

    return { picks: outcomes, totalReturn };
  }

  // ── Simulate sports outcomes ──
  function simulateSportsOutcome(picks) {
    // Only -200 or worse odds — implied prob > 66.7%
    const outcomes = picks.map(pick => {
      const odds = pick.odds || -210;
      const impliedProb = Math.abs(odds) / (Math.abs(odds) + 100);
      // True probability slightly above market due to edge
      const trueProb = impliedProb + 0.02 + (normalizeConfidence100(pick.confidence ?? 60) / 100) * 0.05;
      const correct = Math.random() < trueProb;
      const decimalOdds = 1 + (100 / Math.abs(odds));
      const profitLoss = correct ? (decimalOdds - 1) * (pick.stake_units || 1) : -(pick.stake_units || 1);
      return {
        ...pick,
        correct,
        profitLoss,
        agentId: pick.source_agent || 's_cio',
      };
    });

    const totalUnits = outcomes.reduce((s, o) => s + o.profitLoss, 0);
    return { picks: outcomes, totalUnits };
  }

  function buildSyntheticContext(domain, sessionIndex) {
    if (domain === 'trading') {
      const contexts = [
        'Markets near all-time highs, VIX at 13, FOMC in 2 weeks, AI spending cycle intact',
        'Pullback after strong earnings, 10Y yield rising toward 4.5%, dollar strengthening',
        'Tech selloff on valuation concerns, energy outperforming, credit spreads widening slightly',
        'Soft landing narrative intact, strong jobs report, Fed on hold, rotation to small caps',
        'Crisis mode: bank stress headlines, VIX spike to 35, flight to safety, gold up',
      ];
      return contexts[sessionIndex % contexts.length];
    } else {
      const contexts = [
        'NBA: 8 games tonight, multiple back-to-backs. NFL: divisional week 14. UFC Fight Night Saturday.',
        'MLB playoff race: 12 games, aces going for both teams in 3 matchups. NHL: 6 games, 2 goalies questionable.',
        'NFL divisional playoffs. NBA: LeBron listed questionable, Curry returning from 2-week absence.',
        'UFC 298 card: 5 main card fights. NBA: 6 games with 3 teams on back-to-backs. NHL trade deadline dust settling.',
      ];
      return contexts[sessionIndex % contexts.length];
    }
  }

  function computeSummary(results, domain, startCapital, endCapital, totalUnits) {
    if (domain === 'trading') {
      const totalReturn = ((endCapital - startCapital) / startCapital) * 100;
      const returns = results.equityCurve.map(e => e.dailyReturn).filter(Boolean);
      const avgReturn = returns.length ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
      const stdReturn = returns.length > 1
        ? Math.sqrt(returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / returns.length)
        : 0;
      const sharpe = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0;
      const maxDrawdown = computeMaxDrawdown(results.equityCurve.map(e => e.capital));
      return { totalReturn, sharpe, maxDrawdown, sessions: results.sessions.length };
    } else {
      const roi = (totalUnits * 100) / (results.sessions.length * 100) * 100;
      return { totalUnits, roi, sessions: results.sessions.length };
    }
  }

  function computeMaxDrawdown(capitals) {
    let peak = capitals[0] || 0;
    let maxDD = 0;
    for (const c of capitals) {
      if (c > peak) peak = c;
      const dd = (peak - c) / peak;
      if (dd > maxDD) maxDD = dd;
    }
    return maxDD * 100;
  }

  return { run };
})();

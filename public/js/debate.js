// engine/debate.js — Multi-agent layered debate engine

const DebateEngine = (() => {

  // ── Call LLM for a single agent (Ollama → Gemini → Groq → OpenRouter) ──
  // Includes retry with exponential backoff for rate limits (Groq free tier)
  async function callAgent(agent, contextData, domain) {
    const systemPrompt = agent.shadowMode
      ? agent.shadowMode.newPrompt
      : agent.prompt;

    const userMessage = buildUserMessage(agent, contextData, domain);
    const MAX_RETRIES = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await LLM.chat({
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
          maxTokens: 1500,
        });

        const rawText = result.text || '';
        let parsed = null;
        try {
          // Try multiple extraction strategies
          const jsonMatch =
            rawText.match(/```(?:json)?\s*([\s\S]*?)```/) ||
            rawText.match(/(\[[\s\S]*?\]|\{[\s\S]*?\})/);
          if (jsonMatch) {
            parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
          } else {
            parsed = JSON.parse(rawText);
          }
        } catch {
          // If JSON parse fails, wrap raw text so something is still returned
          parsed = { raw_response: rawText.slice(0, 500) };
        }

        return {
          agentId: agent.id,
          agentName: agent.name,
          layer: agent.layer,
          domain: agent.domain,
          weight: agent.weight,
          provider: result.provider,
          raw: rawText,
          parsed,
          timestamp: new Date().toISOString(),
        };

      } catch (err) {
        lastError = err;
        const isRateLimit = err.message?.includes('429') ||
                            err.message?.toLowerCase().includes('rate limit') ||
                            err.message?.toLowerCase().includes('too many');

        if (isRateLimit && attempt < MAX_RETRIES) {
          // Exponential backoff: 5s, 15s, 30s
          const wait = [5000, 15000, 30000][attempt - 1];
          console.warn(`[Debate] Rate limited on ${agent.id} — waiting ${wait/1000}s (attempt ${attempt}/${MAX_RETRIES})`);
          if (_onRateLimitCb) _onRateLimitCb(agent.name, wait, attempt);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }

        // Non-rate-limit error or out of retries — return error object
        console.error(`[Debate] ${agent.id} failed after ${attempt} attempt(s):`, err.message);
        return {
          agentId: agent.id,
          agentName: agent.name,
          layer: agent.layer,
          domain: agent.domain,
          weight: agent.weight,
          raw: '',
          parsed: { error: err.message },
          timestamp: new Date().toISOString(),
          error: true,
          errorMessage: err.message,
        };
      }
    }

    // Exhausted retries
    return {
      agentId: agent.id, agentName: agent.name, layer: agent.layer,
      domain: agent.domain, weight: agent.weight,
      raw: '', parsed: { error: lastError?.message || 'Max retries exceeded' },
      timestamp: new Date().toISOString(), error: true,
      errorMessage: lastError?.message || 'Max retries exceeded',
    };
  }

  // ── Build context message for agent ──
  function buildUserMessage(agent, ctx, domain) {
    if (domain === 'trading') {
      return buildTradingContext(agent, ctx);
    } else {
      return buildSportsContext(agent, ctx);
    }
  }

  function buildTradingContext(agent, ctx) {
    const base = `Today's date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}

Market context provided by user:
${ctx.marketContext || 'No specific context provided. Use your general knowledge of current market conditions.'}

${ctx.priorLayerOutput ? `\n--- PRIOR LAYER ANALYSIS (for your reference) ---\n${JSON.stringify(ctx.priorLayerOutput, null, 2)}\n---` : ''}

${agent.weight !== 1.0 ? `\nYour current Darwinian trust weight: ${agent.weight.toFixed(2)} / 2.5` : ''}

Provide your analysis in the specified JSON format. Be specific with tickers, entry prices, targets, and stops. Today is a live trading session.`;
    return base;
  }

  function buildSportsContext(agent, ctx) {
    return `Today's date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}

Available games/events today (provided by user):
${ctx.gamesContext || 'Please analyze today\'s available games across NFL, NBA, MMA, MLB, and NHL as appropriate for your specialization.'}

${ctx.priorLayerOutput ? `\n--- PRIOR AGENT ANALYSIS ---\n${JSON.stringify(ctx.priorLayerOutput, null, 2)}\n---` : ''}

${ctx.injuryNews ? `\nLatest injury news: ${ctx.injuryNews}` : ''}
${ctx.lineMovements ? `\nLine movements: ${ctx.lineMovements}` : ''}

REMEMBER: ONLY recommend bets with American odds -200 or higher. All other bets must be excluded.
${agent.weight !== 1.0 ? `\nYour current Darwinian trust weight: ${agent.weight.toFixed(2)} / 2.5` : ''}

Provide your picks in the specified JSON format.`;
  }

  // ── Run a full trading debate (all 4 layers) ──
  async function runTradingDebate(ctx, onProgress) {
    const sessionId = Date.now();
    const results = { sessionId, domain: 'trading', startTime: new Date().toISOString(), layers: {}, finalPicks: [] };
    const agents = await AgentManager.getAllAgents();
    const tradingAgents = agents.filter(a => a.domain === 'trading' && a.active);

    // ── Layer 1: Macro ──
    onProgress?.({ stage: 'layer1', message: 'Running macro analysis (5 agents)...' });
    const macroAgents = tradingAgents.filter(a => a.layer === 1);
    const macroResults = await runLayerParallel(macroAgents, { marketContext: ctx.marketContext }, 'trading');
    results.layers.macro = macroResults;

    // Synthesize macro for Layer 2 context
    const macroSummary = synthesizeMacro(macroResults);
    onProgress?.({ stage: 'layer1_done', message: `Macro: ${macroSummary.regime} regime, ${macroSummary.riskPosture}`, data: macroResults });

    // ── Layer 2: Sector Specialists ──
    onProgress?.({ stage: 'layer2', message: 'Running sector analysis (7 agents)...' });
    const sectorAgents = tradingAgents.filter(a => a.layer === 2);
    const sectorCtx = { marketContext: ctx.marketContext, priorLayerOutput: macroSummary };
    const sectorResults = await runLayerSequential(sectorAgents, sectorCtx, 'trading');
    results.layers.sector = sectorResults;
    const sectorSummary = extractSectorIdeas(sectorResults);
    onProgress?.({ stage: 'layer2_done', message: `Sector: ${sectorSummary.length} ideas identified`, data: sectorResults });

    // ── Layer 3: Superinvestors ──
    onProgress?.({ stage: 'layer3', message: 'Running superinvestor analysis (4 agents)...' });
    const investorAgents = tradingAgents.filter(a => a.layer === 3);
    const investorCtx = {
      marketContext: ctx.marketContext,
      priorLayerOutput: { macro: macroSummary, sectorIdeas: sectorSummary }
    };
    const investorResults = await runLayerParallel(investorAgents, investorCtx, 'trading');
    results.layers.superinvestors = investorResults;
    onProgress?.({ stage: 'layer3_done', message: 'Superinvestor theses complete', data: investorResults });

    // ── Layer 4: Decision Layer ──
    onProgress?.({ stage: 'layer4', message: 'Running decision layer (4 agents)...' });
    const decisionAgents = tradingAgents.filter(a => a.layer === 4);
    const allIdeas = [...sectorSummary, ...extractInvestorIdeas(investorResults)];
    const agentWeights = tradingAgents.reduce((acc, a) => { acc[a.id] = a.weight; return acc; }, {});
    const decisionCtx = {
      marketContext: ctx.marketContext,
      priorLayerOutput: {
        macroRegime: macroSummary,
        sectorIdeas: sectorSummary,
        investorTheses: extractInvestorIdeas(investorResults),
        agentWeights,
        allIdeas,
      }
    };
    const decisionResults = await runLayerSequential(decisionAgents, decisionCtx, 'trading');
    results.layers.decision = decisionResults;

    // Extract final CIO picks
    const cioResult = decisionResults.find(r => r.agentId === 't_cio');
    if (cioResult?.parsed?.top_ideas) {
      results.finalPicks = cioResult.parsed.top_ideas;
      results.regime = cioResult.parsed.regime_call;
      results.posture = cioResult.parsed.portfolio_posture;
      results.summary = cioResult.parsed.session_summary;
    }
    results.endTime = new Date().toISOString();

    results.finalPicks = results.finalPicks || [];
    onProgress?.({ stage: 'complete', message: `Session complete — ${results.finalPicks?.length || 0} final picks`, data: results });
    return results;
  }

  // ── Run a full sports debate ──
  async function runSportsDebate(ctx, onProgress) {
    const sessionId = Date.now();
    const results = { sessionId, domain: 'sports', startTime: new Date().toISOString(), layers: {}, finalPicks: [] };
    const agents = await AgentManager.getAllAgents();
    const sportsAgents = agents.filter(a => a.domain === 'sports' && a.active);

    // ── Layer 1: Sport Specialists (parallel) ──
    onProgress?.({ stage: 'layer1', message: 'Running sport specialist analysis (5 agents)...' });
    const specialists = sportsAgents.filter(a => a.layer === 1);
    const specialistCtx = { gamesContext: ctx.gamesContext, injuryNews: ctx.injuryNews };
    const specialistResults = await runLayerParallel(specialists, specialistCtx, 'sports');
    results.layers.specialists = specialistResults;
    const rawPicks = extractSportsPicks(specialistResults);
    onProgress?.({ stage: 'layer1_done', message: `Specialists: ${rawPicks.length} raw picks`, data: specialistResults });

    // ── Layer 2: Support Analysts (parallel) ──
    onProgress?.({ stage: 'layer2', message: 'Running support analysis (4 agents)...' });
    const supportAgents = sportsAgents.filter(a => a.layer === 2);
    const supportCtx = {
      gamesContext: ctx.gamesContext,
      injuryNews: ctx.injuryNews,
      lineMovements: ctx.lineMovements,
      priorLayerOutput: { rawPicks },
    };
    const supportResults = await runLayerParallel(supportAgents, supportCtx, 'sports');
    results.layers.support = supportResults;
    onProgress?.({ stage: 'layer2_done', message: 'Support analysis complete', data: supportResults });

    // ── Layer 3: Decision ──
    onProgress?.({ stage: 'layer3', message: 'Running value filter and Kelly sizing...' });
    const decisionAgents = sportsAgents.filter(a => a.layer === 3);
    const agentWeights = sportsAgents.reduce((acc, a) => { acc[a.id] = a.weight; return acc; }, {});
    const decisionCtx = {
      gamesContext: ctx.gamesContext,
      priorLayerOutput: {
        specialistPicks: rawPicks,
        supportAnalysis: extractSupportData(supportResults),
        agentWeights,
      },
    };
    const decisionResults = await runLayerSequential(decisionAgents, decisionCtx, 'sports');
    results.layers.decision = decisionResults;

    // Extract Sports CIO final picks
    const cioResult = decisionResults.find(r => r.agentId === 's_cio');
    if (cioResult?.parsed?.final_picks) {
      results.finalPicks = normalizeSportsFinalPicks(cioResult.parsed.final_picks || []);
      results.summary = cioResult.parsed.session_edge_summary;
    }
    results.endTime = new Date().toISOString();

    results.finalPicks = results.finalPicks || [];
    onProgress?.({ stage: 'complete', message: `Session complete — ${results.finalPicks?.length || 0} final picks`, data: results });
    return results;
  }

  // ── Run agents in parallel with staggered starts (avoids rate limits) ──
  async function runLayerParallel(agentList, ctx, domain) {
    const STAGGER_MS = 1500; // 1.5s between starts — safe for Groq free tier
    const promises = agentList.map((agent, i) =>
      new Promise(resolve =>
        setTimeout(() => callAgent(agent, ctx, domain).then(resolve), i * STAGGER_MS)
      )
    );
    return Promise.all(promises);
  }

  // ── Run agents sequentially (each sees prior output) with delay between ──
  async function runLayerSequential(agentList, ctx, domain) {
    const BETWEEN_MS = 2000; // 2s between sequential calls
    const results = [];
    let runningOutput = ctx.priorLayerOutput || {};
    for (const agent of agentList) {
      const result = await callAgent(agent, { ...ctx, priorLayerOutput: runningOutput }, domain);
      results.push(result);
      runningOutput = { ...runningOutput, [`${agent.id}`]: result.parsed };
      if (agentList.indexOf(agent) < agentList.length - 1) {
        await new Promise(r => setTimeout(r, BETWEEN_MS));
      }
    }
    return results;
  }

  // ── Rate limit callback hook (set by UI to show live status) ──
  let _onRateLimitCb = null;
  function setRateLimitHandler(fn) { _onRateLimitCb = fn; }

  // Patch callAgent to call the handler
  const _origCallAgent = callAgent;
  // (handler is called inline inside callAgent above via DebateEngine._onRateLimit)

  // ── Synthesis helpers ──
  function synthesizeMacro(macroResults) {
    const regimes = macroResults.map(r => r.parsed?.macro_regime || r.parsed?.global_risk_level).filter(Boolean);
    const postures = macroResults.map(r => r.parsed?.risk_posture || r.parsed?.geopolitical_risk_level).filter(Boolean);
    return {
      regime: mode(regimes) || 'unknown',
      riskPosture: mode(postures) || 'neutral',
      summaries: macroResults.map(r => ({ agent: r.agentName, thesis: r.parsed?.key_thesis || '' })),
    };
  }

  function extractSectorIdeas(sectorResults) {
    const ideas = [];
    for (const r of sectorResults) {
      const picks = r.parsed?.best_ideas || [];
      for (const p of picks) {
        ideas.push({ ...p, sourceAgent: r.agentId, sourceWeight: r.weight });
      }
    }
    return ideas;
  }

  function extractInvestorIdeas(investorResults) {
    const ideas = [];
    for (const r of investorResults) {
      const picks = r.parsed?.quality_screen || r.parsed?.category_picks?.fast_growers || r.parsed?.momentum_signals || [];
      const bigTrade = r.parsed?.big_trade;
      if (bigTrade) ideas.push({ ...bigTrade, sourceAgent: r.agentId });
      for (const p of picks) ideas.push({ ...p, sourceAgent: r.agentId, sourceWeight: r.weight });
    }
    return ideas;
  }

  function extractSportsPicks(specialistResults) {
    const picks = [];
    for (const r of specialistResults) {
      const arr = Array.isArray(r.parsed) ? r.parsed : (r.parsed?.picks || []);
      for (const p of arr) {
        if (isAllowedSportsOdds(p.odds)) {
          picks.push({ ...p, sourceAgent: r.agentId, sourceWeight: r.weight });
        }
      }
    }
    return picks;
  }

  function isAllowedSportsOdds(odds) {
    // Must be -200 or MORE NEGATIVE (e.g. -210, -300, -575 are OK; -130, -110 are not)
    // On the number line: -300 < -200 < -130, so we want n <= -200
    const n = Number(odds);
    return Number.isFinite(n) && n <= -200;
  }

  function normalizeConfidence(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (n <= 10) return Math.round(n * 10);
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  function dedupeSportsPickKey(p) {
    return [
      (p.sport || '').toLowerCase(),
      (p.game || p.event || '').toLowerCase(),
      (p.bet_type || '').toLowerCase(),
      (p.pick || '').toLowerCase(),
      String(p.odds ?? '').trim(),
    ].join('|');
  }

  function normalizeSportsFinalPicks(picks) {
    const seen = new Set();
    const out = [];
    for (const raw of Array.isArray(picks) ? picks : []) {
      if (!isAllowedSportsOdds(raw?.odds)) continue;
      const pick = { ...raw };
      pick.confidence = normalizeConfidence(pick.confidence);
      if (pick.stake_units == null && pick.units != null) pick.stake_units = pick.units;
      const key = dedupeSportsPickKey(pick);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(pick);
    }
    return out;
  }

  function extractSupportData(supportResults) {
    return supportResults.map(r => ({
      agent: r.agentId,
      data: r.parsed,
    }));
  }

  function mode(arr) {
    if (!arr.length) return null;
    const freq = {};
    arr.forEach(v => freq[v] = (freq[v] || 0) + 1);
    return Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
  }

  return {
    runTradingDebate,
    runSportsDebate,
    callAgent,
    setRateLimitHandler,
  };
})();

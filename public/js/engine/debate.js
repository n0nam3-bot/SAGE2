// engine/debate.js — Multi-agent layered debate engine with Hyper Mode

const DebateEngine = (() => {

  // ── Global Hyper Mode flag ──
  let _hyperMode = false;

  function setHyperMode(enabled) { _hyperMode = enabled; }
  function isHyperMode() { return _hyperMode; }

  function normalizeConfidence(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 50;
    return n <= 10 ? Math.round(n * 10) : Math.max(0, Math.min(100, Math.round(n)));
  }

  function isAllowedSportsOdds(odds) {
    const n = Number(odds);
    if (!Number.isFinite(n)) return false;
    return n >= -200;
  }

  // ── Call LLM for a single agent ──
  // In Hyper Mode: calls all available providers and synthesizes their responses
  async function callAgent(agent, contextData, domain) {
    const systemPrompt = agent.shadowMode ? agent.shadowMode.newPrompt : agent.prompt;
    const userMessage = buildUserMessage(agent, contextData, domain);
    const MAX_RETRIES = 3;
    let lastError = null;

    if (_hyperMode) {
      return callAgentHyper(agent, systemPrompt, userMessage, domain);
    }

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
          const jsonMatch =
            rawText.match(/```(?:json)?\s*([\s\S]*?)```/) ||
            rawText.match(/(\[[\s\S]*?\]|\{[\s\S]*?\})/);
          if (jsonMatch) {
            parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
          } else {
            parsed = JSON.parse(rawText);
          }
        } catch {
          parsed = { raw_response: rawText.slice(0, 500) };
        }

        return {
          agentId: agent.id,
          agentName: agent.name,
          layer: agent.layer,
          domain: agent.domain,
          weight: agent.weight,
          provider: result.provider,
          model: result.model,
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
          const wait = [5000, 15000, 30000][attempt - 1];
          console.warn(`[Debate] Rate limited on ${agent.id} — waiting ${wait/1000}s (attempt ${attempt}/${MAX_RETRIES})`);
          if (_onRateLimitCb) _onRateLimitCb(agent.name, wait, attempt);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }

        console.error(`[Debate] ${agent.id} failed after ${attempt} attempt(s):`, err.message);
        return {
          agentId: agent.id, agentName: agent.name, layer: agent.layer,
          domain: agent.domain, weight: agent.weight,
          raw: '', parsed: { error: err.message },
          timestamp: new Date().toISOString(), error: true, errorMessage: err.message,
        };
      }
    }

    return {
      agentId: agent.id, agentName: agent.name, layer: agent.layer,
      domain: agent.domain, weight: agent.weight,
      raw: '', parsed: { error: lastError?.message || 'Max retries exceeded' },
      timestamp: new Date().toISOString(), error: true,
      errorMessage: lastError?.message || 'Max retries exceeded',
    };
  }

  // ── Hyper Mode: call all available providers for this agent, then synthesize ──
  async function callAgentHyper(agent, systemPrompt, userMessage, domain) {
    let hyperResults = [];

    try {
      if (LLM.IS_LOCAL) {
        // Server handles parallel calls
        const res = await fetch('/api/chat/hyper', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system: systemPrompt,
            messages: [{ role: 'user', content: userMessage }],
            max_tokens: 1500,
          }),
        });
        if (res.ok) {
          const data = await res.json();
          hyperResults = data.results || [];
        }
      } else {
        hyperResults = await LLM.chatHyper({
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
          maxTokens: 1500,
        });
      }
    } catch (e) {
      console.warn('[HyperMode] Parallel call failed, falling back to single:', e.message);
    }

    // If only one result or fallback, use it directly
    if (hyperResults.length <= 1) {
      const single = hyperResults[0] || await LLM.chat({
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
        maxTokens: 1500,
      }).catch(e => ({ text: '', error: e.message }));

      const rawText = single.text || '';
      let parsed = null;
      try {
        const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/) || rawText.match(/(\[[\s\S]*?\]|\{[\s\S]*?\})/);
        parsed = jsonMatch ? JSON.parse(jsonMatch[1] || jsonMatch[0]) : JSON.parse(rawText);
      } catch { parsed = { raw_response: rawText.slice(0, 500) }; }

      return {
        agentId: agent.id, agentName: agent.name, layer: agent.layer,
        domain: agent.domain, weight: agent.weight,
        provider: single.provider || 'auto', model: single.model || '',
        raw: rawText, parsed,
        timestamp: new Date().toISOString(),
        hyperMode: false,
      };
    }

    // Multiple results: synthesize via cross-consultation
    const combinedRaw = hyperResults.map((r, i) => `[Provider ${i+1}: ${r.provider}/${r.model}]\n${r.text}`).join('\n\n---\n\n');

    // Parse all responses and merge
    const allParsed = hyperResults.map(r => {
      try {
        const jsonMatch = r.text.match(/```(?:json)?\s*([\s\S]*?)```/) || r.text.match(/(\[[\s\S]*?\]|\{[\s\S]*?\})/);
        return jsonMatch ? JSON.parse(jsonMatch[1] || jsonMatch[0]) : JSON.parse(r.text);
      } catch { return null; }
    }).filter(Boolean);

    // Synthesize: merge picks from all providers, deduplicate, boost confidence for agreed picks
    const merged = mergeHyperResults(allParsed, domain, agent);

    return {
      agentId: agent.id, agentName: agent.name, layer: agent.layer,
      domain: agent.domain, weight: agent.weight,
      provider: hyperResults.map(r => r.provider).join('+'),
      model: hyperResults.map(r => r.model).join('+'),
      raw: combinedRaw,
      parsed: merged,
      timestamp: new Date().toISOString(),
      hyperMode: true,
      hyperProviders: hyperResults.map(r => ({ provider: r.provider, model: r.model })),
    };
  }

  // ── Merge multiple provider responses for a single agent ──
  function mergeHyperResults(parsedList, domain, agent) {
    if (!parsedList.length) return { error: 'No valid responses' };

    // For sports: merge pick arrays and boost confidence for picks that multiple providers agree on
    if (domain === 'sports') {
      const allPicks = [];
      for (const parsed of parsedList) {
        const picks = Array.isArray(parsed) ? parsed : (parsed.final_picks || parsed.picks || []);
        allPicks.push(...picks);
      }

      // Group picks by game+pick+bet_type
      const grouped = {};
      for (const pick of allPicks) {
        const key = `${(pick.game||'').toLowerCase()}|${(pick.pick||'').toLowerCase()}|${(pick.bet_type||'').toLowerCase()}`;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(pick);
      }

      // Picks agreed on by multiple providers get confidence boost
      const merged = Object.values(grouped).map(group => {
        const base = group[0];
        const agreementCount = group.length;
        const avgConf = group.reduce((s, p) => s + (Number(p.confidence) || 60), 0) / group.length;
        const boostedConf = Math.min(99, avgConf + (agreementCount - 1) * 8);
        return {
          ...base,
          confidence: Math.round(boostedConf),
          agents_in_agreement: group.map((_, i) => parsedList[i] ? `Provider ${i+1}` : null).filter(Boolean),
          hyper_agreement: agreementCount,
        };
      });

      // Sort by agreement count then confidence
      merged.sort((a, b) => (b.hyper_agreement - a.hyper_agreement) || (b.confidence - a.confidence));
      return merged;
    }

    // For trading: merge idea arrays
    const allIdeas = [];
    for (const parsed of parsedList) {
      const ideas = parsed.top_ideas || parsed.best_ideas || parsed.quality_screen || [];
      if (Array.isArray(ideas)) allIdeas.push(...ideas);
      if (parsed.big_trade) allIdeas.push(parsed.big_trade);
    }

    // Group by ticker
    const tickerGroups = {};
    for (const idea of allIdeas) {
      const ticker = (idea.ticker || idea.ticker_or_asset || '').toUpperCase();
      if (!ticker) continue;
      if (!tickerGroups[ticker]) tickerGroups[ticker] = [];
      tickerGroups[ticker].push(idea);
    }

    const mergedIdeas = Object.entries(tickerGroups).map(([ticker, group]) => {
      const base = group[0];
      const avgConf = group.reduce((s, p) => s + (Number(p.confidence) || 60), 0) / group.length;
      return { ...base, ticker, confidence: Math.min(99, Math.round(avgConf + (group.length - 1) * 8)), hyper_agreement: group.length };
    });

    mergedIdeas.sort((a, b) => (b.hyper_agreement - a.hyper_agreement) || (b.confidence - a.confidence));

    // Return in format compatible with CIO
    const firstParsed = parsedList[0];
    return {
      ...firstParsed,
      top_ideas: mergedIdeas,
      best_ideas: mergedIdeas,
    };
  }

  // ── Build context message for agent ──
  function buildUserMessage(agent, ctx, domain) {
    if (domain === 'trading') return buildTradingContext(agent, ctx);
    return buildSportsContext(agent, ctx);
  }

  function buildTradingContext(agent, ctx) {
    return `Today's date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}

Market context provided by user:
${ctx.marketContext || 'No specific context provided. Use your general knowledge of current market conditions.'}

${ctx.priorLayerOutput ? `\n--- PRIOR LAYER ANALYSIS (for your reference) ---\n${JSON.stringify(ctx.priorLayerOutput, null, 2)}\n---` : ''}

${agent.weight !== 1.0 ? `\nYour current Darwinian trust weight: ${agent.weight.toFixed(2)} / 2.5` : ''}
${_hyperMode ? '\n[HYPER MODE ACTIVE: Multiple AI models are consulting on this. Be specific and decisive.]' : ''}

Provide your analysis in the specified JSON format. Be specific with tickers, entry prices, targets, and stops. Today is a live trading session.`;
  }

  function buildSportsContext(agent, ctx) {
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const todayISO = new Date().toISOString().slice(0, 10);

    const agentSport = agent.sport;
    let gamesSection = ctx.gamesContext || 'No specific games provided. If you have sport-specific knowledge of upcoming events, apply it.';

    if (agentSport && ctx.gamesContext) {
      const filtered = filterGamesBySport(ctx.gamesContext, agentSport);
      if (filtered.trim().length > 20) {
        gamesSection = filtered;
      } else {
        gamesSection = `NO ${agentSport} GAMES FOUND IN TODAY'S SLATE. Output an empty array [] only.`;
      }
    }

    return `Today's date: ${today} (${todayISO})
Today's games/events for YOUR SPORT (${agentSport || 'all sports'}):
${gamesSection}

${ctx.priorLayerOutput ? `\n--- PRIOR AGENT ANALYSIS ---\n${JSON.stringify(ctx.priorLayerOutput, null, 2)}\n---` : ''}
${ctx.injuryNews ? `\nLatest injury news: ${ctx.injuryNews}` : ''}
${ctx.lineMovements ? `\nLine movements: ${ctx.lineMovements}` : ''}

CRITICAL REMINDERS:
1. ONLY analyze ${agentSport || 'the sports'} games listed above.
2. ONLY recommend bets with American odds -200 or higher (e.g., -200, -180, -150, +100, +250 are all valid).
3. NEVER recommend odds below -200 (e.g., -201, -250, -300 are REJECTED).
4. ALWAYS include event_date (YYYY-MM-DD) and game_time for every pick.
5. If no ${agentSport || ''} games are listed above, output an empty JSON array [].
6. Provide BEST PICKS ONLY — focus on highest confidence, best value bets.
${_hyperMode ? '7. [HYPER MODE: Be highly specific. Other AI models are also analyzing this. Provide your strongest conviction picks only.]' : ''}
${agent.weight !== 1.0 ? `\nYour current Darwinian trust weight: ${agent.weight.toFixed(2)} / 2.5` : ''}

Provide your picks in the specified JSON format.`;
  }

  function filterGamesBySport(gamesText, sport) {
    if (!gamesText || !sport) return gamesText;
    const lines = gamesText.split('\n');
    const sportLower = sport.toLowerCase();

    const aliases = {
      'nfl': ['nfl', 'football', 'national football'],
      'nba': ['nba', 'basketball', 'national basketball'],
      'mlb': ['mlb', 'baseball', 'major league baseball'],
      'nhl': ['nhl', 'hockey', 'national hockey'],
      'mma': ['mma', 'ufc', 'mixed martial arts', 'boxing'],
    };
    const matchTerms = aliases[sportLower] || [sportLower];
    const sportHeaderPattern = new RegExp(`\\b(${matchTerms.join('|')})\\b`, 'i');
    const anyHeaderPattern = /^\s*(NFL|NBA|MLB|NHL|MMA|UFC|Soccer|Tennis|Golf|NCAAF|NCAAB)[\s:]/i;

    let inSection = false;
    let foundSection = false;
    const filtered = [];

    for (const line of lines) {
      const isHeader = anyHeaderPattern.test(line);
      if (isHeader) {
        inSection = sportHeaderPattern.test(line);
        if (inSection) { foundSection = true; filtered.push(line); }
        continue;
      }
      if (inSection) filtered.push(line);
    }

    if (!foundSection) return gamesText;
    return filtered.join('\n').trim();
  }

  // ── Run a full trading debate (all 4 layers) ──
  async function runTradingDebate(ctx, onProgress) {
    const sessionId = Date.now();
    const results = { sessionId, domain: 'trading', startTime: new Date().toISOString(), layers: {}, finalPicks: [], hyperMode: _hyperMode };
    const agents = await AgentManager.getAllAgents();
    const tradingAgents = agents.filter(a => a.domain === 'trading' && a.active);

    onProgress?.({ stage: 'layer1', message: `Running macro analysis (5 agents)${_hyperMode ? ' [HYPER MODE]' : ''}...` });
    const macroAgents = tradingAgents.filter(a => a.layer === 1);
    const macroResults = await runLayerParallel(macroAgents, { marketContext: ctx.marketContext }, 'trading');
    results.layers.macro = macroResults;

    const macroSummary = synthesizeMacro(macroResults);
    onProgress?.({ stage: 'layer1_done', message: `Macro: ${macroSummary.regime} regime, ${macroSummary.riskPosture}`, data: macroResults });

    onProgress?.({ stage: 'layer2', message: 'Running sector analysis (7 agents)...' });
    const sectorAgents = tradingAgents.filter(a => a.layer === 2);
    const sectorCtx = { marketContext: ctx.marketContext, priorLayerOutput: macroSummary };
    const sectorResults = await runLayerSequential(sectorAgents, sectorCtx, 'trading');
    results.layers.sector = sectorResults;
    const sectorSummary = extractSectorIdeas(sectorResults);
    onProgress?.({ stage: 'layer2_done', message: `Sector: ${sectorSummary.length} ideas identified`, data: sectorResults });

    onProgress?.({ stage: 'layer3', message: 'Running superinvestor analysis (4 agents)...' });
    const investorAgents = tradingAgents.filter(a => a.layer === 3);
    const investorCtx = {
      marketContext: ctx.marketContext,
      priorLayerOutput: { macro: macroSummary, sectorIdeas: sectorSummary }
    };
    const investorResults = await runLayerParallel(investorAgents, investorCtx, 'trading');
    results.layers.superinvestors = investorResults;
    onProgress?.({ stage: 'layer3_done', message: 'Superinvestor theses complete', data: investorResults });

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

  // ── Run a full sports debate — returns best 5 picks ──
  async function runSportsDebate(ctx, onProgress) {
    const sessionId = Date.now();
    const results = { sessionId, domain: 'sports', startTime: new Date().toISOString(), layers: {}, finalPicks: [], hyperMode: _hyperMode };
    const agents = await AgentManager.getAllAgents();
    const sportsAgents = agents.filter(a => a.domain === 'sports' && a.active);

    onProgress?.({ stage: 'layer1', message: `Running sport specialists${_hyperMode ? ' [HYPER MODE — all providers consulting]' : ''}...` });
    const specialists = sportsAgents.filter(a => a.layer === 1);
    const specialistResults = await runLayerParallel(
      specialists,
      { gamesContext: ctx.gamesContext, injuryNews: ctx.injuryNews },
      'sports'
    );
    results.layers.specialists = specialistResults;
    const rawPicks = extractSportsPicks(specialistResults);
    onProgress?.({ stage: 'layer1_done', message: `Specialists: ${rawPicks.length} raw picks`, data: specialistResults });

    onProgress?.({ stage: 'layer2', message: 'Running support analysis...' });
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

    onProgress?.({ stage: 'layer3', message: 'Running value filter, Kelly sizing, and Sports CIO...' });
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

    const cioResult = decisionResults.find(r => r.agentId === 's_cio');
    const cioPicks = normalizeSportsFinalPicks(cioResult?.parsed?.final_picks || []);
    const allCandidates = collectSportsCandidates([...specialistResults, ...supportResults, ...decisionResults]);
    const fallbackPicks = buildSportsFallbackPicks(allCandidates, 5, 3);
    const mergedPicks = normalizeSportsFinalPicks([...cioPicks, ...fallbackPicks]);

    // Cap at 5 best picks (sorted by confidence + hyper agreement)
    const sorted = mergedPicks.sort((a, b) => {
      const aScore = (Number(a.confidence) || 50) + (Number(a.hyper_agreement) || 1) * 5;
      const bScore = (Number(b.confidence) || 50) + (Number(b.hyper_agreement) || 1) * 5;
      return bScore - aScore;
    });

    results.finalPicks = sorted.slice(0, 5);

    if (results.finalPicks.length < 3 && fallbackPicks.length) {
      results.finalPicks = normalizeSportsFinalPicks(fallbackPicks).slice(0, 5);
    }

    results.summary = cioResult?.parsed?.session_edge_summary
      || `${results.finalPicks.length} top picks (odds -200 or better) across ${[...new Set(results.finalPicks.map(p => p.sport).filter(Boolean))].join(', ') || 'multiple sports'}.`;
    results.endTime = new Date().toISOString();
    results.finalPicks = results.finalPicks || [];
    onProgress?.({ stage: 'complete', message: `Session complete — ${results.finalPicks?.length || 0} final picks`, data: results });
    return results;
  }

  async function runLayerParallel(agentList, ctx, domain) {
    const STAGGER_MS = _hyperMode ? 2000 : 1500; // slightly longer stagger in hyper mode
    const promises = agentList.map((agent, i) =>
      new Promise(resolve =>
        setTimeout(() => callAgent(agent, ctx, domain).then(resolve), i * STAGGER_MS)
      )
    );
    return Promise.all(promises);
  }

  async function runLayerSequential(agentList, ctx, domain) {
    const BETWEEN_MS = _hyperMode ? 3000 : 2000;
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

  let _onRateLimitCb = null;
  function setRateLimitHandler(fn) { _onRateLimitCb = fn; }

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
      for (const p of picks) ideas.push({ ...p, sourceAgent: r.agentId, sourceWeight: r.weight });
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
    return collectSportsCandidates(specialistResults).filter(p => isAllowedSportsOdds(p.odds));
  }

  function collectSportsCandidates(resultList) {
    const picks = [];
    const seenNodes = new WeakSet();
    for (const r of Array.isArray(resultList) ? resultList : []) {
      const meta = { agentId: r.agentId, agentName: r.agentName, weight: r.weight, layer: r.layer };
      walkSportsCandidateTree(r.parsed, meta, picks, seenNodes);
      if (r.raw && typeof r.raw === 'string' && r.raw.trim()) {
        walkSportsCandidateTree(r.raw, meta, picks, seenNodes);
      }
    }
    return picks;
  }

  function walkSportsCandidateTree(node, meta, out, seenNodes) {
    const value = parseMaybeJson(node);
    if (value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) walkSportsCandidateTree(item, meta, out, seenNodes);
      return;
    }
    if (typeof value !== 'object') return;
    if (seenNodes.has(value)) return;
    seenNodes.add(value);
    const candidate = extractSportsCandidateObject(value, meta);
    if (candidate) out.push(candidate);
    for (const item of Object.values(value)) {
      if (item && (typeof item === 'object' || typeof item === 'string')) {
        walkSportsCandidateTree(item, meta, out, seenNodes);
      }
    }
  }

  function extractSportsCandidateObject(obj, meta) {
    const oddsValue = obj.odds ?? obj.price ?? obj.line ?? obj.original_bet?.odds ?? obj.bet?.odds;
    const odds = Number(String(oddsValue ?? '').replace(/[^\d+\-]/g, ''));
    if (!Number.isFinite(odds)) return null;

    const pickValue = obj.pick ?? obj.selection ?? obj.recommended_bet ?? obj.bet ?? obj.original_bet?.pick ?? obj.winner;
    const gameValue = obj.game ?? obj.event ?? obj.matchup ?? obj.fight ?? obj.fixture ?? obj.original_bet?.game ?? '';
    const betType = obj.bet_type ?? obj.market ?? obj.type ?? obj.original_bet?.bet_type ?? '';
    const sport = obj.sport ?? obj.league ?? obj.original_bet?.sport ?? '';
    const pick = typeof pickValue === 'string' ? pickValue : (pickValue != null ? String(pickValue) : '');
    const game = typeof gameValue === 'string' ? gameValue : (gameValue != null ? String(gameValue) : '');

    if (!pick || !game) return null;
    if (!isAllowedSportsOdds(odds)) return null;

    const eventDate = obj.event_date ?? obj.game_date ?? obj.date ?? obj.original_bet?.event_date ?? '';
    const gameTime = obj.game_time ?? obj.time ?? obj.start_time ?? obj.original_bet?.game_time ?? '';

    const confidence = normalizeConfidence(
      obj.confidence ?? obj.confidence_pct ?? obj.original_bet?.confidence ?? obj.score
    );
    const stakeUnits = obj.stake_units ?? obj.units ?? obj.recommended_units ?? obj.original_bet?.stake_units ?? obj.original_bet?.units ?? null;
    const reasoning = obj.reasoning ?? obj.full_reasoning ?? obj.original_bet?.reasoning ?? '';
    const agentsInAgreement = obj.agents_in_agreement ?? obj.corroborating_agents ?? [];

    return {
      ...obj,
      sport,
      game,
      event_date: eventDate,
      game_time: gameTime,
      bet_type: betType || 'Moneyline',
      pick,
      odds,
      implied_prob_pct: calcImpliedProbPct(odds),
      confidence: confidence ?? obj.confidence ?? 0,
      stake_units: stakeUnits,
      units: stakeUnits,
      reasoning,
      full_reasoning: obj.full_reasoning ?? reasoning,
      agents_in_agreement: agentsInAgreement,
      source_agent: meta.agentId,
      source_agent_name: meta.agentName,
      source_weight: meta.weight,
      source_layer: meta.layer,
    };
  }

  function calcImpliedProbPct(odds) {
    const n = Number(odds);
    if (!Number.isFinite(n) || n === 0) return null;
    const pct = n < 0
      ? (Math.abs(n) / (Math.abs(n) + 100)) * 100
      : (100 / (n + 100)) * 100;
    return Math.round(pct * 10) / 10;
  }

  function buildSportsFallbackPicks(candidates, target = 5, minimum = 3) {
    const scored = [];
    const seen = new Set();
    for (const c of Array.isArray(candidates) ? candidates : []) {
      const normalized = normalizeSportsPick(c);
      if (!normalized) continue;
      const key = dedupeSportsPickKey(normalized);
      if (seen.has(key)) continue;
      seen.add(key);
      const conf = Number.isFinite(Number(normalized.confidence)) ? Number(normalized.confidence) : 0;
      const oddsBoost = normalized.odds != null ? Math.max(0, 12 - Math.max(0, Math.abs(Number(normalized.odds)) - 100) / 50) : 0;
      const weightBoost = Number(normalized.source_weight || 1) * 5;
      const hyperBoost = (normalized.hyper_agreement || 1) * 10;
      const score = conf + oddsBoost + weightBoost + hyperBoost;
      scored.push({ pick: normalized, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const out = [];
    const outSeen = new Set();
    for (const { pick } of scored) {
      const key = dedupeSportsPickKey(pick);
      if (outSeen.has(key)) continue;
      outSeen.add(key);
      out.push(pick);
      if (out.length >= target) break;
    }
    return out;
  }

  function normalizeSportsPick(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const odds = Number(String(raw.odds ?? raw.price ?? raw.line ?? '').replace(/[^\d+\-]/g, ''));
    if (!Number.isFinite(odds) || !isAllowedSportsOdds(odds)) return null;
    const pick = raw.pick ?? raw.selection ?? raw.recommended_bet ?? raw.original_bet?.pick;
    const game = raw.game ?? raw.event ?? raw.matchup ?? raw.fight ?? raw.original_bet?.game ?? '';
    if (!pick || !game) return null;

    const normalized = {
      ...raw,
      sport: raw.sport || raw.original_bet?.sport || '',
      game,
      event_date: raw.event_date ?? raw.game_date ?? raw.date ?? raw.original_bet?.event_date ?? '',
      game_time: raw.game_time ?? raw.time ?? raw.start_time ?? raw.original_bet?.game_time ?? '',
      bet_type: raw.bet_type || raw.market || raw.original_bet?.bet_type || 'Moneyline',
      pick: typeof pick === 'string' ? pick : String(pick),
      odds,
      implied_prob_pct: raw.implied_prob_pct != null ? Number(raw.implied_prob_pct) : calcImpliedProbPct(odds),
      confidence: normalizeConfidence(raw.confidence ?? raw.confidence_pct ?? raw.original_bet?.confidence ?? raw.score),
      agents_in_agreement: raw.agents_in_agreement ?? raw.corroborating_agents ?? [],
      source_agent: raw.source_agent || raw.sourceAgent || raw.agentId || raw.primary_agent_source || 's_cio',
      source_weight: raw.source_weight ?? raw.sourceWeight ?? 1,
    };
    if (normalized.stake_units == null && normalized.units != null) normalized.stake_units = normalized.units;
    if (normalized.stake_units == null && raw.original_bet?.stake_units != null) normalized.stake_units = raw.original_bet.stake_units;
    normalized.units = normalized.stake_units;
    return normalized;
  }

  function dedupeSportsPickKey(p) {
    return [
      (p.sport || '').toLowerCase(),
      (p.game || p.event || '').toLowerCase(),
      (p.bet_type || '').toLowerCase(),
      (p.pick || '').toLowerCase(),
    ].join('|');
  }

  function normalizeSportsFinalPicks(picks) {
    const seen = new Set();
    const out = [];
    for (const raw of Array.isArray(picks) ? picks : []) {
      const pick = normalizeSportsPick(raw);
      if (!pick) continue;
      const key = dedupeSportsPickKey(pick);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(pick);
    }
    return out;
  }

  function extractSupportData(supportResults) {
    return supportResults.map(r => ({ agent: r.agentId, data: r.parsed }));
  }

  function mode(arr) {
    if (!arr.length) return null;
    const freq = {};
    arr.forEach(v => freq[v] = (freq[v] || 0) + 1);
    return Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
  }

  function parseMaybeJson(value) {
    if (value == null) return null;
    if (typeof value === 'object') return value;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    try { return JSON.parse(trimmed); } catch { /* not JSON */ }
    const m = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/) || trimmed.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
    if (m) { try { return JSON.parse(m[1] || m[0]); } catch { /* bad JSON */ } }
    return null;
  }

  return {
    runTradingDebate,
    runSportsDebate,
    callAgent,
    setRateLimitHandler,
    setHyperMode,
    isHyperMode,
  };
})();

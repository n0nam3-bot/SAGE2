// agents/manager.js — Agent lifecycle: weights, Darwinian scoring, prompt evolution

const AgentManager = (() => {

  // ── Initialize all agents in DB from definitions ──
  async function init() {
    const existing = await DB.getAllAgents();
    const existingIds = new Set(existing.map(a => a.id));
    const defsSource = (typeof globalThis !== 'undefined' && globalThis.AGENT_DEFS)
      || (typeof window !== 'undefined' && window.AGENT_DEFS)
      || (typeof AGENT_DEFS !== 'undefined' ? AGENT_DEFS : null);
    if (!defsSource) {
      throw new Error('Agent definitions not loaded. Ensure js/agents/definitions.js is included before manager.js');
    }
    const defs = Object.values(defsSource);

    // Check if any NEW agents need writing (skip if all already exist)
    const newDefs = defs.filter(def => !existingIds.has(def.id));

    if (newDefs.length === 0) {
      // Fast path: all agents already in DB — no writes needed
      console.log('[AgentManager] All', defs.length, 'agents already initialized');
      return;
    }

    // Batch all writes in parallel — dramatically faster than sequential awaits
    // (32 sequential writes ~= 800ms; parallel ~= 80ms)
    const now = new Date().toISOString();
    await Promise.all(newDefs.map(def =>
      DB.saveAgent({
        ...def,
        weight: 1.0,
        promptHistory: [{ prompt: def.prompt, date: now, reason: 'initial' }],
        stats: { predictions: 0, correct: 0, totalReturn: 0, sharpe: 0, roi: 0 },
        rewrites: 0,
        blindSpots: [],
        shadowMode: null,
        spawned: false,
        active: true,
      })
    ));

    console.log('[AgentManager] Initialized', newDefs.length, 'new agents (', defs.length, 'total)');
  }

  // ── Get current agent state ──
  async function getAgent(id) {
    return DB.getAgent(id);
  }

  async function getAllAgents() {
    return DB.getAllAgents();
  }

  // ── Darwinian weight update after each session ──
  async function applyDarwinianUpdate(domain) {
    const agents = (await DB.getAllAgents()).filter(a => a.domain === domain && a.active);
    if (agents.length < 4) return;

    // Sort by Sharpe (trading) or ROI (sports)
    const scored = agents.map(a => ({
      id: a.id,
      score: domain === 'trading' ? (a.stats?.sharpe || 0) : (a.stats?.roi || 0),
      weight: a.weight,
    })).sort((a, b) => b.score - a.score);

    const n = scored.length;
    const topQ = Math.ceil(n * 0.25);
    const botQ = Math.floor(n * 0.75);

    for (let i = 0; i < scored.length; i++) {
      const agent = await DB.getAgent(scored[i].id);
      let newWeight;
      if (i < topQ) {
        newWeight = Math.min(2.5, agent.weight * 1.05); // top quartile +5%
      } else if (i >= botQ) {
        newWeight = Math.max(0.3, agent.weight * 0.95); // bottom quartile -5%
      } else {
        newWeight = agent.weight; // middle 50% unchanged
      }
      await DB.saveAgent({ ...agent, weight: newWeight });
    }
    console.log('[Darwinian] Weight update applied for', domain);
  }

  // ── Record pick outcome and update stats ──
  async function recordOutcome(agentId, domain, wasCorrect, returnPct) {
    const agent = await DB.getAgent(agentId);
    if (!agent) return;

    const stats = agent.stats || { predictions: 0, correct: 0, totalReturn: 0, sharpe: 0, roi: 0 };
    stats.predictions++;
    if (wasCorrect) stats.correct++;
    stats.totalReturn += returnPct || 0;
    stats.roi = stats.predictions > 0 ? (stats.totalReturn / stats.predictions) : 0;
    // Simplified Sharpe: avg return / std dev (tracked in returns array)
    agent.returnsHistory = agent.returnsHistory || [];
    agent.returnsHistory.push(returnPct || 0);
    if (agent.returnsHistory.length > 2) {
      const avg = agent.returnsHistory.reduce((s, r) => s + r, 0) / agent.returnsHistory.length;
      const variance = agent.returnsHistory.reduce((s, r) => s + (r - avg) ** 2, 0) / agent.returnsHistory.length;
      stats.sharpe = variance > 0 ? (avg / Math.sqrt(variance)) : 0;
    }

    await DB.saveAgent({ ...agent, stats });
    await DB.savePerf({ agentId, ...stats, lastUpdated: new Date().toISOString() });

    // Check if shadow mode prompt should be evaluated
    if (agent.shadowMode) {
      await evaluateShadowMode(agentId);
    }
  }

  // ── Detect worst-performing agent (trigger for autoresearch) ──
  async function findWorstAgent(domain) {
    const agents = (await DB.getAllAgents())
      .filter(a => a.domain === domain && a.active && !a.shadowMode && (a.stats?.predictions || 0) >= 5);
    if (agents.length === 0) return null;
    return agents.sort((a, b) => {
      const sa = domain === 'trading' ? (a.stats?.sharpe || 0) : (a.stats?.roi || 0);
      const sb = domain === 'trading' ? (b.stats?.sharpe || 0) : (b.stats?.roi || 0);
      return sa - sb;
    })[0];
  }

  // ── Trigger autoresearch: rewrite worst agent's prompt ──
  async function triggerAutoresearch(domain) {
    const worst = await findWorstAgent(domain);
    if (!worst) return { success: false, reason: 'No agents with enough data' };

    console.log('[Autoresearch] Targeting:', worst.id, worst.name);
    const metric = domain === 'trading' ? `Sharpe: ${worst.stats?.sharpe?.toFixed(3)}` : `ROI: ${worst.stats?.roi?.toFixed(2)}%`;

    // Build context about recent failures
    const picks = await DB.getPicksByAgent(worst.id);
    const recentPicks = picks.slice(-10);
    const failedPicks = recentPicks.filter(p => !p.correct);
    const failPatterns = failedPicks.map(p => p.thesis || p.reasoning || '').join('\n');

    const rewritePrompt = `You are a prompt engineer optimizing AI trading/betting agents.

The following agent is underperforming (${metric}):
Agent: ${worst.name}
Layer: ${worst.layerName}
Domain: ${worst.domain}
Current prompt:
"""
${worst.prompt}
"""

Recent failure patterns from losing predictions:
${failPatterns || 'No pattern data available yet.'}

Known blind spots: ${worst.blindSpots?.join(', ') || 'None identified yet'}

Your task: Write an IMPROVED version of this agent's system prompt that:
1. Fixes the identified weaknesses without abandoning core strengths
2. Adds more specific, quantifiable criteria
3. Improves pattern recognition for the failure types observed
4. Keeps the exact same JSON output format
5. Is no longer than 150% of the original prompt length

Return ONLY the new prompt text, nothing else.`;

    try {
      const result = await LLM.chat({
        messages: [{ role: 'user', content: rewritePrompt }],
        maxTokens: 2000,
      });
      const newPrompt = result.text?.trim();
      if (!newPrompt) throw new Error('Empty response from rewrite');

      // Enter shadow mode: run new prompt for 5 sessions, then compare
      const updated = await DB.getAgent(worst.id);
      await DB.saveAgent({
        ...updated,
        shadowMode: {
          newPrompt,
          oldPrompt: updated.prompt,
          startDate: new Date().toISOString(),
          sessionCount: 0,
          oldStats: { ...updated.stats },
          newStats: { predictions: 0, correct: 0, totalReturn: 0, roi: 0, sharpe: 0 },
        }
      });

      console.log('[Autoresearch] Shadow mode started for', worst.id);
      return { success: true, agentId: worst.id, agentName: worst.name };
    } catch (err) {
      console.error('[Autoresearch] Error:', err);
      return { success: false, reason: err.message };
    }
  }

  // ── Evaluate shadow mode after 5 sessions ──
  async function evaluateShadowMode(agentId) {
    const agent = await DB.getAgent(agentId);
    if (!agent?.shadowMode) return;

    const shadow = agent.shadowMode;
    if (shadow.sessionCount < 5) return; // Not enough data yet

    const oldMetric = agent.domain === 'trading'
      ? shadow.oldStats.sharpe : shadow.oldStats.roi;
    const newMetric = agent.domain === 'trading'
      ? shadow.newStats.sharpe : shadow.newStats.roi;

    const improved = newMetric > oldMetric;
    console.log(`[Autoresearch] Evaluating ${agentId}: old=${oldMetric.toFixed(3)} new=${newMetric.toFixed(3)} → ${improved ? 'KEEP' : 'REVERT'}`);

    if (improved) {
      // Keep new prompt, add to history
      const promptHistory = [...(agent.promptHistory || []), {
        prompt: shadow.newPrompt,
        date: new Date().toISOString(),
        reason: `autoresearch improvement: ${oldMetric.toFixed(3)} → ${newMetric.toFixed(3)}`,
      }];
      await DB.saveAgent({
        ...agent,
        prompt: shadow.newPrompt,
        shadowMode: null,
        promptHistory,
        rewrites: (agent.rewrites || 0) + 1,
      });
      return { kept: true, improvement: newMetric - oldMetric };
    } else {
      // Revert to old prompt
      await DB.saveAgent({
        ...agent,
        prompt: shadow.oldPrompt,
        shadowMode: null,
        promptHistory: [...(agent.promptHistory || []), {
          prompt: shadow.newPrompt,
          date: new Date().toISOString(),
          reason: `autoresearch REVERTED: no improvement (${oldMetric.toFixed(3)} vs ${newMetric.toFixed(3)})`,
        }],
      });
      return { kept: false };
    }
  }

  // ── Detect blind spots (repeated loss patterns) ──
  async function detectBlindSpots(domain) {
    const agents = (await DB.getAllAgents()).filter(a => a.domain === domain);
    const newSpots = [];

    for (const agent of agents) {
      const picks = await DB.getPicksByAgent(agent.id);
      const failed = picks.filter(p => p.outcome === 'loss' || p.correct === false);
      if (failed.length < 3) continue;

      // Build pattern analysis prompt
      const failTexts = failed.slice(-10).map(p => p.reasoning || p.thesis || '').join('\n---\n');
      const analysisPrompt = `Analyze these losing bet/trade reasoning snippets from an AI agent. Identify any repeating blind spot or systematic error pattern in 1-2 sentences. If there's no clear pattern, say "No pattern detected."

Agent: ${agent.name}
Failed reasoning snippets:
${failTexts}`;

      try {
        const result = await LLM.chat({
          messages: [{ role: 'user', content: analysisPrompt }],
          maxTokens: 200,
        });
        const pattern = result.text?.trim();
        if (pattern && !pattern.includes('No pattern')) {
          const updated = await DB.getAgent(agent.id);
          const spots = updated.blindSpots || [];
          if (!spots.includes(pattern)) {
            spots.push(pattern);
            await DB.saveAgent({ ...updated, blindSpots: spots });
            newSpots.push({ agentId: agent.id, name: agent.name, pattern });
          }
        }
      } catch (e) { /* non-critical */ }
    }
    return newSpots;
  }

  // ── Spawn new specialist agent when blind spots repeat across agents ──
  async function checkSpawnCondition(domain) {
    const agents = (await DB.getAllAgents()).filter(a => a.domain === domain);
    const allBlindSpots = agents.flatMap(a => (a.blindSpots || []).map(b => b.toLowerCase()));
    if (allBlindSpots.length < 3) return null;

    // Find common themes
    const themePrompt = `Given these blind spot patterns from different AI agents in a ${domain} research system, is there a common theme that suggests a NEW specialist agent should be created? If yes, describe what that agent should focus on in 2-3 sentences. If no clear theme, say "No spawn needed."

Blind spots:
${allBlindSpots.join('\n')}`;

    try {
      const result = await LLM.chat({
        messages: [{ role: 'user', content: themePrompt }],
        maxTokens: 300,
      });
      const suggestion = result.text?.trim();
      if (suggestion && !suggestion.includes('No spawn')) {
        return { shouldSpawn: true, suggestion };
      }
    } catch (e) { /* */ }
    return null;
  }

  // ── Spawn a new agent with AI-generated prompt ──
  async function spawnAgent(domain, specialization, reason) {
    const newId = `${domain === 'trading' ? 't' : 's'}_spawned_${Date.now()}`;
    const genPrompt = `You are a prompt engineer creating a new AI ${domain === 'trading' ? 'trading analyst' : 'sports betting analyst'} agent for a multi-agent research framework.

Specialization needed: ${specialization}
Reason for spawning: ${reason}

Write a complete system prompt for this new agent. The prompt must:
1. Define the agent's role and specialization clearly
2. List the analytical framework they should use
3. Specify the exact JSON output format (matching other agents in the system)
4. Be specific enough to catch the blind spots identified
5. Be 200-400 words

For trading agents, output JSON must include: best_ideas array with ticker, action, target, stop, thesis, timeframe fields.
For sports agents, output JSON must be an array of bets with: sport, game, bet_type, pick, odds (must be -200 or higher), implied_prob_pct, confidence, stake_units, reasoning fields.`;

    try {
      const result = await LLM.chat({
        messages: [{ role: 'user', content: genPrompt }],
        maxTokens: 1000,
      });
      const newPrompt = result.text?.trim();
      if (!newPrompt) throw new Error('Empty prompt generated');

      const newAgent = {
        id: newId,
        domain,
        layer: 2,
        layerName: 'Spawned Specialist',
        name: `Spawned: ${specialization.slice(0, 40)}`,
        description: `Auto-spawned to address blind spot: ${reason.slice(0, 100)}`,
        weight: 0.7, // start below average, must earn trust
        prompt: newPrompt,
        promptHistory: [{ prompt: newPrompt, date: new Date().toISOString(), reason: `spawned: ${reason}` }],
        stats: { predictions: 0, correct: 0, totalReturn: 0, sharpe: 0, roi: 0 },
        rewrites: 0,
        blindSpots: [],
        shadowMode: null,
        spawned: true,
        active: true,
      };
      await DB.saveAgent(newAgent);
      console.log('[AgentManager] Spawned new agent:', newId);
      return newAgent;
    } catch (err) {
      console.error('[Spawn] Error:', err);
      return null;
    }
  }

  return {
    init,
    getAgent,
    getAllAgents,
    applyDarwinianUpdate,
    recordOutcome,
    findWorstAgent,
    triggerAutoresearch,
    detectBlindSpots,
    checkSpawnCondition,
    spawnAgent,
  };
})();

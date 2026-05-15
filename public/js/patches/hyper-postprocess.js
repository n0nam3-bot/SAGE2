(() => {
  if (typeof window === 'undefined') return;

  const safe = v => (v == null ? '' : String(v));

  function normalizeMarketFamily(value) {
    const raw = safe(value).toLowerCase();
    if (!raw) return 'moneyline';
    if (/money\s*line|\bml\b|h2h|head\s*to\s*head/.test(raw)) return 'moneyline';
    if (/spread|runline|puckline/.test(raw) && !/total|over|under|ou/.test(raw)) return 'spread';
    if (/total|over\s*under|\bou\b|o\/u/.test(raw)) return 'total';
    if (/prop/.test(raw)) return 'prop';
    return raw.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'moneyline';
  }

  function normalizeGameLabel(game) {
    const raw = safe(game).toLowerCase()
      .replace(/\(game\s*\d+\)/g, ' ')
      .replace(/\bgame\s*\d+\b/g, ' ')
      .replace(/\b(playoffs?|finals?)\b/g, ' ')
      .replace(/[\[\]{}()]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const parts = raw.split(/\s*(?:@|vs\.?|versus|v\.?|at)\s*/i).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    return parts.length > 1 ? parts.sort().join('|') : raw;
  }

  function normalizePickLabel(pick, family) {
    let cleaned = safe(pick).toLowerCase().trim()
      .replace(/\b(money\s*line|moneyline|\bml\b|spread|total|totals?|over\/?under|ou)\b/g, ' ');
    if (family === 'moneyline') {
      cleaned = cleaned.replace(/(?<!\b(?:over|under)\s)[+-]?\d{2,4}(?:\.\d+)?\b/g, ' ');
      cleaned = cleaned.replace(/\b(?:favorite|underdog)\b/g, ' ');
    }
    return cleaned.replace(/\s+/g, ' ').trim();
  }

  function sportsKey(pick) {
    const family = normalizeMarketFamily(pick.bet_type || pick.market);
    return [
      safe(pick.sport).toUpperCase(),
      normalizeGameLabel(pick.game || pick.event || ''),
      family,
      normalizePickLabel(pick.pick, family),
    ].join('|');
  }

  function isLiveLike(pick) {
    const txt = `${safe(pick.game_time)} ${safe(pick.game)} ${safe(pick.status)} ${safe(pick.statusState)}`.toLowerCase();
    return /\blive\b|\bin[-\s]?progress\b|\bfinal\b|\bpostponed\b|\bdelayed\b|\btbd\b|\btba\b|\bunknown\b/.test(txt);
  }

  function extractCandidatePicks(value, out = []) {
    if (value == null) return out;
    if (Array.isArray(value)) {
      for (const item of value) extractCandidatePicks(item, out);
      return out;
    }
    if (typeof value !== 'object') return out;

    const obviousArrays = [
      value.final_picks, value.approved_picks, value.finalPicks,
      value.approved_bets, value.sized_bets, value.approved_ideas,
      value.rejected_picks, value.rejected_bets,
    ].filter(Array.isArray);
    for (const arr of obviousArrays) extractCandidatePicks(arr, out);

    if ((value.game || value.event || value.matchup || value.fight || value.fixture) && (value.pick || value.selection || value.bet || value.market || value.bet_type)) {
      out.push(value);
    }

    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') extractCandidatePicks(child, out);
    }
    return out;
  }

  function deriveConfidence(existing, agreementCount, providerCount, agentCount) {
    const base = Number(existing);
    if (Number.isFinite(base) && base > 50) return Math.min(95, Math.round(base));
    const boost = Math.max(0, (agreementCount - 1) * 9 + (providerCount - 1) * 7 + (agentCount - 1) * 3);
    return Math.max(50, Math.min(95, 56 + boost));
  }

  function postProcessSportsResult(result) {
    if (!result || !Array.isArray(result.finalPicks)) return result;

    const map = new Map();
    const layers = result.layers || {};
    const allResults = Object.values(layers).flat().filter(Boolean);

    for (const layerResult of allResults) {
      const agents = [layerResult.agentName, layerResult.agentId].filter(Boolean);
      const providerLabels = [
        ...(Array.isArray(layerResult.providerOutputs) ? layerResult.providerOutputs.map(p => p?.provider).filter(Boolean) : []),
        layerResult.consensus ? 'consensus' : null,
      ].filter(Boolean);

      const candidates = extractCandidatePicks(layerResult.parsed);
      for (const c of candidates) {
        const norm = { ...c };
        if (!norm.sport && /nba|nfl|mlb|nhl|mma/i.test(safe(layerResult.agentName))) {
          const m = safe(layerResult.agentName).match(/(nba|nfl|mlb|nhl|mma)/i);
          if (m) norm.sport = m[1].toUpperCase();
        }
        const key = sportsKey(norm);
        if (!map.has(key)) {
          map.set(key, { agents: new Set(), providers: new Set(), confidences: [], samples: [] });
        }
        const g = map.get(key);
        agents.forEach(a => g.agents.add(a));
        providerLabels.forEach(p => g.providers.add(p));
        const conf = Number(norm.confidence);
        if (Number.isFinite(conf)) g.confidences.push(conf);
        g.samples.push(norm);
      }
    }

    result.finalPicks = result.finalPicks
      .map(pick => {
        const key = sportsKey(pick);
        const g = map.get(key) || { agents: new Set(), providers: new Set(), confidences: [], samples: [] };
        const baseAgents = [...new Set([...(Array.isArray(pick.agents_in_agreement) ? pick.agents_in_agreement : []), ...g.agents])].filter(Boolean);
        const providers = [...g.providers].filter(Boolean);
        const decisionAgentId = pick.decision_agent_id || (baseAgents.includes('s_cio') ? 's_cio' : 's_cio');
        const reviewAgentId = pick.review_agent_id || (baseAgents.includes('s_final_review') ? 's_final_review' : 's_final_review');
        const creditedAgents = [...new Set([
          ...(Array.isArray(pick.credited_agents) ? pick.credited_agents : []),
          ...(Array.isArray(pick.agreement_agent_ids) ? pick.agreement_agent_ids : []),
          decisionAgentId,
          reviewAgentId,
        ].map(v => String(v || '').trim()).filter(Boolean))];
        const agents = [...new Set([...baseAgents, decisionAgentId, reviewAgentId, ...creditedAgents])].filter(Boolean);
        const agreementCount = Math.max(agents.length, providers.length, creditedAgents.length);
        const confidence = deriveConfidence(pick.confidence, agreementCount, providers.length, agents.length);
        const breakdownParts = [];
        if (providers.length) breakdownParts.push(...providers.map(p => `${p} LLM`));
        if (agents.length) breakdownParts.push(agents.join(', '));
        return {
          ...pick,
          decision_agent_id: decisionAgentId,
          review_agent_id: reviewAgentId,
          credited_agents: creditedAgents,
          confidence,
          agents_in_agreement: agents.length ? agents : (pick.agents_in_agreement || []),
          agreement_agent_ids: creditedAgents,
          agreement_llms: providers,
          source_providers: providers,
          agreement_count: agreementCount,
          agreement_breakdown: breakdownParts.join(' | '),
        };
      })
      .filter(pick => !isLiveLike(pick));

    result.finalPicks.sort((a, b) => (Number(b.agreement_count) || 0) - (Number(a.agreement_count) || 0) || (Number(b.confidence) || 0) - (Number(a.confidence) || 0));

    return result;
  }


  const originalChatMulti = window.LLM?.chatMultiProvider;
  if (window.LLM && typeof originalChatMulti === 'function') {
    window.LLM.chatMultiProvider = async function patchedChatMultiProvider(opts) {
      const result = await originalChatMulti.call(this, opts);
      try {
        const parsed = JSON.parse(result.text);
        if (Array.isArray(parsed)) {
          const quorum = Math.max(2, Math.ceil(((result.quorumRequired || result.providerCount || parsed.length) * 2) / 3));
          const filtered = parsed.filter(item => {
            const providers = Array.isArray(item.agreement_llms) ? item.agreement_llms : [];
            const count = Number(item.agreement_count || item._provider_count || providers.length || 0);
            return Math.max(providers.length, count) >= quorum;
          });
          if (filtered.length) {
            result.text = JSON.stringify(filtered);
          }
        }
      } catch {
        // leave result untouched if it is not JSON
      }
      return result;
    };
  }

  function postProcessTradingResult(result) {
    if (!result || !Array.isArray(result.finalPicks)) return result;
    const layers = result.layers || {};
    const allResults = Object.values(layers).flat().filter(Boolean);
    const map = new Map();

    for (const layerResult of allResults) {
      const agents = [layerResult.agentName, layerResult.agentId].filter(Boolean);
      const providerLabels = [
        ...(Array.isArray(layerResult.providerOutputs) ? layerResult.providerOutputs.map(p => p?.provider).filter(Boolean) : []),
      ].filter(Boolean);
      const candidates = extractCandidatePicks(layerResult.parsed);
      for (const c of candidates) {
        const key = [safe(c.ticker || c.symbol || c.name).toLowerCase(), safe(c.action || c.side || c.bet || '').toLowerCase(), safe(c.entry || c.entry_price || c.price || ''), safe(c.target || c.stop || '')].join('|');
        if (!map.has(key)) map.set(key, { agents: new Set(), providers: new Set(), confidences: [] });
        const g = map.get(key);
        agents.forEach(a => g.agents.add(a));
        providerLabels.forEach(p => g.providers.add(p));
        const conf = Number(c.confidence);
        if (Number.isFinite(conf)) g.confidences.push(conf);
      }
    }

    result.finalPicks = result.finalPicks.map(pick => {
      const key = [safe(pick.ticker || pick.symbol || pick.name).toLowerCase(), safe(pick.action || pick.side || pick.bet || '').toLowerCase(), safe(pick.entry || pick.entry_price || pick.price || ''), safe(pick.target || pick.stop || '')].join('|');
      const g = map.get(key) || { agents: new Set(), providers: new Set(), confidences: [] };
      const decisionAgentId = pick.decision_agent_id || 't_cio';
      const reviewAgentId = pick.review_agent_id || 't_review';
      const creditedAgents = [...new Set([
        ...(Array.isArray(pick.credited_agents) ? pick.credited_agents : []),
        ...(Array.isArray(pick.agreement_agent_ids) ? pick.agreement_agent_ids : []),
        decisionAgentId,
        reviewAgentId,
      ].map(v => String(v || '').trim()).filter(Boolean))];
      const agents = [...new Set([...(Array.isArray(pick.agents_in_agreement) ? pick.agents_in_agreement : []), ...g.agents, decisionAgentId, reviewAgentId, ...creditedAgents])].filter(Boolean);
      const providers = [...g.providers].filter(Boolean);
      const agreementCount = Math.max(agents.length, providers.length, creditedAgents.length);
      const confidence = deriveConfidence(pick.confidence, agreementCount, providers.length, agents.length);
      const breakdownParts = [];
      if (providers.length) breakdownParts.push(...providers.map(p => `${p} LLM`));
      if (agents.length) breakdownParts.push(agents.join(', '));
      return { ...pick, decision_agent_id: decisionAgentId, review_agent_id: reviewAgentId, credited_agents: creditedAgents, confidence, agents_in_agreement: agents, agreement_agent_ids: creditedAgents, agreement_llms: providers, source_providers: providers, agreement_count: agreementCount, agreement_breakdown: breakdownParts.join(' | ') };
    });
    return result;
  }

  const originalSports = window.DebateEngine?.runSportsDebate;
  const originalTrading = window.DebateEngine?.runTradingDebate;
  if (window.DebateEngine && typeof originalSports === 'function') {
    window.DebateEngine.runSportsDebate = async function (...args) {
      const result = await originalSports.apply(this, args);
      return postProcessSportsResult(result);
    };
  }
  if (window.DebateEngine && typeof originalTrading === 'function') {
    window.DebateEngine.runTradingDebate = async function (...args) {
      const result = await originalTrading.apply(this, args);
      return postProcessTradingResult(result);
    };
  }
})();

// providers-client.js — Browser-side LLM provider cascade
// Ollama → Gemini → Groq → OpenRouter, called directly from browser
// When running on localhost with server.js, uses /api/chat proxy instead

const LLM = (() => {

  // Detect if local server is available (self-host mode)
  // Covers localhost, 127.0.0.1, and local network IPs (192.168.x.x, 10.x.x.x)
  const IS_LOCAL = (() => {
    const h = window.location.hostname;
    return h === 'localhost' || h === '127.0.0.1' ||
           h.startsWith('192.168.') || h.startsWith('10.') ||
           h.startsWith('172.') || h === '';
  })();

  // Provider metadata
  const PROVIDER_INFO = {
    auto:       { name: 'Auto',             icon: '🤖', cors: true  },
    ollama:     { name: 'Ollama (Local)',   icon: '🖥️', cors: false }, // blocked on HTTPS
    gemini:     { name: 'Google Gemini',    icon: '✨', cors: true  },
    groq:       { name: 'Groq',             icon: '⚡', cors: true  },
    openrouter: { name: 'OpenRouter',       icon: '🌐', cors: true  },
  };

  const PROVIDER_ORDER = ['ollama', 'gemini', 'groq', 'openrouter'];
  const PROVIDER_MODE_KEY = 'sage_provider_mode';
  const VALID_PROVIDER_MODES = new Set(['auto', ...PROVIDER_ORDER]);
  const PROVIDER_COOLDOWN_KEY = 'sage_provider_cooldowns';
  const PROVIDER_COOLDOWN_MS = 60_000;

  function readProviderCooldowns() {
    try {
      const raw = localStorage.getItem(PROVIDER_COOLDOWN_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeProviderCooldowns(state) {
    try {
      localStorage.setItem(PROVIDER_COOLDOWN_KEY, JSON.stringify(state || {}));
    } catch {
      // ignore storage failures
    }
  }

  function isRateLimitError(err) {
    const msg = String(err?.message || err || '').toLowerCase();
    return msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests');
  }

  function setProviderCooldown(provider, ms = PROVIDER_COOLDOWN_MS) {
    if (!provider) return;
    const state = readProviderCooldowns();
    state[provider] = Date.now() + ms;
    writeProviderCooldowns(state);
  }

  function getProviderCooldownRemaining(provider) {
    if (!provider) return 0;
    const state = readProviderCooldowns();
    const until = Number(state[provider] || 0);
    return Math.max(0, until - Date.now());
  }

  function clearExpiredCooldowns() {
    const state = readProviderCooldowns();
    const now = Date.now();
    let changed = false;
    for (const [provider, until] of Object.entries(state)) {
      if (!until || Number(until) <= now) {
        delete state[provider];
        changed = true;
      }
    }
    if (changed) writeProviderCooldowns(state);
  }

  function getProviderMode() {
    const stored = (localStorage.getItem(PROVIDER_MODE_KEY) || 'auto').toLowerCase();
    return VALID_PROVIDER_MODES.has(stored) ? stored : 'auto';
  }

  function setProviderMode(mode) {
    const next = VALID_PROVIDER_MODES.has(mode) ? mode : 'auto';
    localStorage.setItem(PROVIDER_MODE_KEY, next);
    const el = document.getElementById('status-provider');
    if (el && el.tagName === 'SELECT' && el.value !== next) el.value = next;
    return next;
  }

  function providerModeLabel(mode = getProviderMode()) {
    return PROVIDER_INFO[mode]?.icon
      ? `${PROVIDER_INFO[mode].icon} ${PROVIDER_INFO[mode].name}`
      : '🤖 Auto';
  }

  function resolveProviderOrder(preferredProvider = getProviderMode()) {
    if (!preferredProvider || preferredProvider === 'auto') return [...PROVIDER_ORDER];
    if (!VALID_PROVIDER_MODES.has(preferredProvider)) return [...PROVIDER_ORDER];
    return [preferredProvider, ...PROVIDER_ORDER.filter(p => p !== preferredProvider)];
  }

  async function getRuntimeProviderAvailability() {
    const fallback = { ollama: false, gemini: true, groq: true, openrouter: true };
    try {
      if (!IS_LOCAL) return fallback;
      const res = await fetch('/api/providers');
      if (!res.ok) return fallback;
      const data = await res.json().catch(() => ({}));
      const providers = data?.status || data?.providers || data || {};
      return {
        ollama: !!providers.ollama?.available || !!providers.ollama,
        gemini: !!providers.gemini?.available || !!providers.gemini,
        groq: !!providers.groq?.available || !!providers.groq,
        openrouter: !!providers.openrouter?.available || !!providers.openrouter,
      };
    } catch {
      return fallback;
    }
  }

  // ── Main chat function ──
  async function chat({ system, messages, maxTokens = 2000, forceProvider = null }) {
    const providerMode = forceProvider || getProviderMode();
    const resolvedProvider = providerMode === 'auto' ? null : providerMode;
    // If server is running locally, proxy through it (supports Ollama too)
    if (IS_LOCAL) {
      return callServerProxy({ system, messages, maxTokens, forceProvider: resolvedProvider });
    }
    // Otherwise call providers directly from browser
    return callCascade({ system, messages, maxTokens, preferredProvider: providerMode });
  }

  // ── Multi-provider consensus: call all configured providers in parallel ──
  // Returns merged picks/analysis from Gemini + Groq + OpenRouter simultaneously.
  // Each provider runs the same prompt; results are merged before returning.
  async function chatMultiProvider({ system, messages, maxTokens = 2000 }) {
    clearExpiredCooldowns();
    const keys = Auth.getKeys();
    const runtime = await getRuntimeProviderAvailability();
    const configured = [];
    if (runtime.ollama || IS_LOCAL) configured.push('ollama');
    if (keys.gemini && runtime.gemini !== false) configured.push('gemini');
    if (keys.groq && runtime.groq !== false) configured.push('groq');
    if (keys.openrouter && runtime.openrouter !== false) configured.push('openrouter');

    const eligible = configured.filter(provider => getProviderCooldownRemaining(provider) <= 0);
    const cooling = configured.filter(provider => getProviderCooldownRemaining(provider) > 0);

    if (eligible.length <= 1) {
      if (eligible.length === 1) return chat({ system, messages, maxTokens, forceProvider: eligible[0] });
      if (cooling.length) {
        const provider = cooling[0];
        const remaining = Math.ceil(getProviderCooldownRemaining(provider) / 1000);
        throw new Error(`${PROVIDER_INFO[provider]?.name || provider} is cooling down for ${remaining}s. Try another provider or wait a moment.`);
      }
      return chat({ system, messages, maxTokens });
    }

    const results = await Promise.allSettled(
      eligible.map(provider => callCascade({ system, messages, maxTokens, preferredProvider: provider }))
    );

    const successes = results
      .map((r, i) => r.status === 'fulfilled' ? { provider: eligible[i], text: r.value.text, model: r.value.model } : null)
      .filter(Boolean);

    if (successes.length === 0) {
      const provider = cooling[0] || eligible[0];
      const remaining = provider ? Math.ceil(getProviderCooldownRemaining(provider) / 1000) : 0;
      const providerName = PROVIDER_INFO[provider]?.name || provider || 'LLM';
      if (provider && remaining > 0) {
        throw new Error(`${providerName} is cooling down for ${remaining}s. Try another provider or wait a moment.`);
      }
      throw new Error('All providers failed in hyper mode');
    }
    if (successes.length === 1) return {
      text: successes[0].text,
      provider: successes[0].provider,
      model: successes[0].model,
      consensus: false,
      providerOutputs: successes,
    };

    const merged = mergeProviderResponses(successes);
    return {
      text: merged,
      provider: `hyper(${successes.map(s=>s.provider).join('+')})`,
      model: 'multi',
      consensus: true,
      providerCount: successes.length,
      providerOutputs: successes,
    };
  }

  function getQuorumThreshold(providerCount) {
    const n = Math.max(0, Number(providerCount) || 0);
    if (n <= 1) return 1;
    return Math.max(2, Math.ceil((n * 2) / 3));
  }

  function normalizeQuorumKey(item = {}) {
    const sport = String(item.sport || item.league || item.asset_class || '').toLowerCase().trim();
    const game = String(item.game || item.event || item.matchup || item.symbol || item.ticker || item.name || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const market = String(item.bet_type || item.market || item.type || item.action || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const pick = String(item.pick || item.selection || item.winner || item.side || item.direction || item.ticker || item.symbol || item.name || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const extra = [item.event_date, item.game_time, item.entry, item.target, item.stop].filter(v => v != null && String(v).trim() !== '').map(v => String(v).toLowerCase().trim());
    return [sport, game, market, pick, ...extra].join('|');
  }

  function parseProviderPayload(text, provider) {
    try {
      const m = String(text || '').match(/```(?:json)?\s*([\s\S]*?)```/) || String(text || '').match(/(\[[\s\S]*?\]|\{[\s\S]*?\})/);
      const payload = m ? JSON.parse(m[1] || m[0]) : JSON.parse(String(text || '').trim());
      return { provider, data: payload };
    } catch {
      return { provider, data: null, raw: String(text || '') };
    }
  }

  function mergeProviderResponses(responses) {
    const parsed = responses.map(r => parseProviderPayload(r.text, r.provider));
    const validParsed = parsed.filter(p => p.data != null);
    if (validParsed.length === 0) {
      const best = responses.reduce((a, b) => (a.text?.length || 0) > (b.text?.length || 0) ? a : b);
      return best.text;
    }

    const quorumRequired = getQuorumThreshold(validParsed.length);

    if (validParsed.every(p => Array.isArray(p.data))) {
      const allItems = validParsed.flatMap(p => p.data.map(item => ({ ...item, _source_provider: p.provider })));
      const merged = mergeArrayItemsWithQuorum(allItems, quorumRequired, validParsed.length);
      return JSON.stringify(merged);
    }

    if (validParsed.every(p => !Array.isArray(p.data) && typeof p.data === 'object')) {
      const merged = mergeJsonObjectsWithQuorum(validParsed, quorumRequired);
      merged._consensus_providers = validParsed.map(p => p.provider);
      merged._quorum_required = quorumRequired;
      merged._provider_count = validParsed.length;
      return JSON.stringify(merged);
    }

    const best = validParsed.reduce((a, b) => {
      const sa = Array.isArray(a.data) ? a.data.length : (a.data?.conviction || a.data?.confidence || 0);
      const sb = Array.isArray(b.data) ? b.data.length : (b.data?.conviction || b.data?.confidence || 0);
      return sa >= sb ? a : b;
    });
    if (best.data && typeof best.data === 'object') {
      best.data._consensus_providers = validParsed.map(p => p.provider);
      best.data._quorum_required = quorumRequired;
      best.data._provider_count = validParsed.length;
    }
    return JSON.stringify(best.data);
  }

  function mergeArrayItemsWithQuorum(items, quorumRequired, providerCount) {
    const groups = new Map();
    for (const item of Array.isArray(items) ? items : []) {
      const key = normalizeQuorumKey(item);
      if (!groups.has(key)) {
        groups.set(key, { items: [], providers: new Set() });
      }
      const group = groups.get(key);
      group.items.push(item);
      if (item._source_provider) group.providers.add(item._source_provider);
    }

    const out = [];
    for (const group of groups.values()) {
      const providerList = [...group.providers].filter(Boolean);
      const required = Math.max(1, quorumRequired || getQuorumThreshold(providerCount || providerList.length));
      if (providerList.length < required) continue;
      const representative = group.items.reduce((best, current) => {
        const bestScore = Number(best?.confidence || best?.score || 0) + (String(best?.reasoning || best?.full_reasoning || '').length / 100);
        const currentScore = Number(current?.confidence || current?.score || 0) + (String(current?.reasoning || current?.full_reasoning || '').length / 100);
        return currentScore > bestScore ? current : best;
      }, group.items[0]);
      const numericConfidence = group.items.map(p => Number(p.confidence) || 0).filter(Number.isFinite);
      const confidence = numericConfidence.length ? Math.round(numericConfidence.reduce((a, b) => a + b, 0) / numericConfidence.length) : (Number(representative.confidence) || 0);
      const agentAgreements = [...new Set(group.items.flatMap(p => Array.isArray(p.agents_in_agreement) ? p.agents_in_agreement : []).filter(Boolean))];
      const llms = [...providerList];
      out.push({
        ...representative,
        confidence: Math.min(95, Math.max(0, confidence + Math.max(0, providerList.length - 1) * 3)),
        agents_in_agreement: agentAgreements.length ? agentAgreements : llms.map(p => `${p} LLM`),
        agreement_llms: llms,
        agreement_count: Math.max(providerList.length, agentAgreements.length, llms.length),
        _provider_count: providerList.length,
        _quorum_required: required,
        _consensus_providers: llms,
      });
    }

    out.sort((a, b) => (Number(b._provider_count) - Number(a._provider_count)) || (Number(b.confidence) - Number(a.confidence)));
    return out;
  }

  function mergeJsonObjectsWithQuorum(entries, quorumRequired) {
    const merged = {};
    const keys = [...new Set(entries.flatMap(entry => Object.keys(entry.data || {})))];
    for (const key of keys) {
      const values = entries.map(entry => ({ provider: entry.provider, value: entry.data?.[key] })).filter(v => v.value !== undefined);
      if (!values.length) continue;

      const arrays = values.filter(v => Array.isArray(v.value));
      if (arrays.length === values.length) {
        const items = arrays.flatMap(v => v.value.map(item => ({ ...item, _source_provider: v.provider })));
        const mergedArray = mergeArrayItemsWithQuorum(items, quorumRequired, entries.length);
        if (mergedArray.length) merged[key] = mergedArray;
        continue;
      }

      const nestedObjects = values.filter(v => v.value && typeof v.value === 'object' && !Array.isArray(v.value));
      if (nestedObjects.length === values.length) {
        merged[key] = mergeJsonObjectsWithQuorum(nestedObjects.map(v => ({ provider: v.provider, data: v.value })), quorumRequired);
        continue;
      }

      const numericValues = values.map(v => Number(v.value)).filter(v => Number.isFinite(v));
      if (numericValues.length === values.length && values.length) {
        merged[key] = numericValues.reduce((a, b) => a + b, 0) / numericValues.length;
        continue;
      }

      const nonEmptyStrings = values.map(v => String(v.value).trim()).filter(Boolean);
      if (nonEmptyStrings.length) {
        const counts = new Map();
        for (const str of nonEmptyStrings) counts.set(str, (counts.get(str) || 0) + 1);
        const [best] = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length));
        merged[key] = best ? best[0] : nonEmptyStrings.sort((a, b) => b.length - a.length)[0];
      }
    }
    return merged;
  }

  function isHyperMode() {
    return localStorage.getItem('sage_hyper_mode') === 'on' || localStorage.getItem('sage_consensus_mode') === 'on';
  }

  function setHyperMode(on) {
    localStorage.setItem('sage_hyper_mode', on ? 'on' : 'off');
    localStorage.setItem('sage_consensus_mode', on ? 'on' : 'off');
  }

  function toggleHyperMode() {
    const next = !isHyperMode();
    setHyperMode(next);
    return next;
  }

  function isConsensusMode() {
    return isHyperMode();
  }

  function setConsensusMode(on) {
    setHyperMode(on);
  }



  // ── Server proxy (localhost self-host mode) ──
  async function callServerProxy({ system, messages, maxTokens, forceProvider = null }) {
    const body = { system, messages, max_tokens: maxTokens };
    if (forceProvider) body.forceProvider = forceProvider;
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Server error ${res.status}`);
    }
    const data = await res.json();
    return { text: data.content?.[0]?.text || '', provider: data.provider || 'server', model: data.model || '' };
  }

  // ── Direct browser cascade ──
  async function callCascade({ system, messages, maxTokens, preferredProvider = 'auto' }) {
    clearExpiredCooldowns();
    const keys = Auth.getKeys();
    const errors = [];
    const order = resolveProviderOrder(preferredProvider);

    for (const provider of order) {
      // Ollama skipped on GitHub Pages (mixed content: HTTPS → HTTP)
      if (!IS_LOCAL && provider === 'ollama') continue;
      if (!keys[provider] && provider !== 'ollama') continue;

      const cooldownRemaining = getProviderCooldownRemaining(provider);
      if (cooldownRemaining > 0) {
        errors.push(`${provider.charAt(0).toUpperCase() + provider.slice(1)}: cooling down for ${Math.ceil(cooldownRemaining / 1000)}s`);
        continue;
      }

      try {
        if (provider === 'ollama') return await callServerProxy({ system, messages, maxTokens });
        if (provider === 'gemini') return await callGemini(keys.gemini, system, messages, maxTokens);
        if (provider === 'groq') return await callGroq(keys.groq, system, messages, maxTokens);
        if (provider === 'openrouter') return await callOpenRouter(keys.openrouter, system, messages, maxTokens);
      } catch (e) {
        if (isRateLimitError(e)) setProviderCooldown(provider);
        errors.push(`${provider.charAt(0).toUpperCase() + provider.slice(1)}: ${e.message}`);
      }
    }

    if (errors.length === 0)
      throw new Error('No API keys configured. Go to Profile → API Keys to add your free keys.');
    throw new Error('All providers failed. ' + errors.join(' | '));
  }

  // ── Gemini key test (lightweight model discovery call) ──
  async function testGeminiKey(apiKey) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (res.status === 429) {
      throw new Error('Gemini rate limited (429)');
    }
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error?.message || `Gemini model list HTTP ${res.status}`);
    }

    const data = await res.json();
    const models = Array.isArray(data.models) ? data.models : [];
    const flashModel = models.find(m => String(m.name || '').includes('gemini-2.5-flash'))?.name
      || models.find(m => String(m.name || '').includes('gemini-2.0-flash'))?.name
      || models[0]?.name
      || 'Gemini';
    return { text: `Gemini ready (${models.length} models)`, provider: 'gemini', model: flashModel };
  }

  // ── Gemini — native API (more reliable than OpenAI-compat endpoint) ──
  async function callGemini(apiKey, system, messages, maxTokens) {
    // Build Gemini-format contents array
    const contents = [];
    // Gemini doesn't have a system role — prepend as first user/model turn
    if (system) {
      contents.push({ role: 'user',  parts: [{ text: system }] });
      contents.push({ role: 'model', parts: [{ text: 'Understood. I will follow these instructions.' }] });
    }
    messages.forEach(m => {
      contents.push({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      });
    });

    // Try gemini models
    const models = ['gemini-2.5-flash', 'gemini-2.0-flash'];
    let lastErr = null;

    for (const model of models) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 },
          safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
          ],
        }),
      });

      if (res.status === 429) {
        // Rate limited on this model — try next
        lastErr = new Error(`Gemini ${model} rate limited (429)`);
        continue;
      }
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        lastErr = new Error(e.error?.message || `Gemini ${model} HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (!text) { lastErr = new Error(`Gemini ${model} returned empty response`); continue; }
      return { text, provider: 'gemini', model };
    }

    throw lastErr || new Error('All Gemini models failed');
  }

  // ── Groq ──
  async function callGroq(apiKey, system, messages, maxTokens) {
    const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: msgs, max_tokens: maxTokens, temperature: 0.7 }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      const msg = e.error?.message || `Groq HTTP ${res.status}`;
      if (res.status === 429) throw new Error('Groq rate limited (429)');
      throw new Error(msg);
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    if (!text) throw new Error('Groq returned empty response');
    return { text, provider: 'groq', model: data.model || 'llama-3.3-70b-versatile' };
  }

  // ── OpenRouter — tries multiple free models until one works ──
  const OPENROUTER_FREE_MODELS = [
    'mistralai/mistral-7b-instruct:free',
    'meta-llama/llama-3.2-3b-instruct:free',
    'google/gemma-2-9b-it:free',
    'qwen/qwen-2.5-7b-instruct:free',
    'microsoft/phi-3-mini-128k-instruct:free',
    'nvidia/nemotron-3-super-120b-a12b:free',
    'openrouter/owl-alpha',
    'openai/gpt-oss-120b:free',
    'inclusionai/ring-2.6-1t:free',
  ];

  async function callOpenRouter(apiKey, system, messages, maxTokens) {
    const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
    let lastErr = null;

    for (const model of OPENROUTER_FREE_MODELS) {
      try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': window.location.origin,
            'X-Title': 'SAGE',
          },
          body: JSON.stringify({ model, messages: msgs, max_tokens: maxTokens }),
        });

        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          const msg = e.error?.message || `HTTP ${res.status}`;
          lastErr = new Error(`OpenRouter ${model}: ${res.status === 429 ? 'rate limited (429)' : msg}`);
          continue;
        }

        const data = await res.json();
        const text = data.choices?.[0]?.message?.content || '';
        if (!text) { lastErr = new Error(`OpenRouter ${model}: empty response`); continue; }
        return { text, provider: 'openrouter', model };
      } catch (e) {
        lastErr = e;
      }
    }

    throw lastErr || new Error('All OpenRouter free models failed');
  }

  // ── Test a specific provider key ──
  async function testKey(provider, apiKey, options = {}) {
    const { ignoreCooldown = true } = options || {};
    const testMsg = [{ role: 'user', content: 'Reply with exactly three words: SAGE is online' }];
    try {
      if (!ignoreCooldown) {
        const remaining = getProviderCooldownRemaining(provider);
        if (remaining > 0) {
          return { success: false, error: `${PROVIDER_INFO[provider]?.name || provider} is cooling down for ${Math.ceil(remaining / 1000)}s` };
        }
      }
      let result;
      if (provider === 'gemini')     result = await testGeminiKey(apiKey);
      else if (provider === 'groq')  result = await callGroq(apiKey, null, testMsg, 30);
      else                           result = await callOpenRouter(apiKey, null, testMsg, 30);
      return { success: true, response: result.text.trim().slice(0, 80), model: result.model };
    } catch (e) {
      // Make error messages more human-readable
      let msg = e.message;
      if (provider === 'gemini' && isRateLimitError(e)) {
        // Do not persist a cooldown for manual key testing; Gemini quota can be transient.
        msg = 'Google Gemini is rate limited right now. The key may still be valid — try again later or switch providers.';
      } else if (isRateLimitError(e)) {
        setProviderCooldown(provider);
        const seconds = Math.ceil(getProviderCooldownRemaining(provider) / 1000);
        msg = `${PROVIDER_INFO[provider]?.name || provider} is temporarily unavailable; try again in about ${seconds}s`;
      }
      if (msg.includes('401'))        msg = 'Invalid API key — double-check you copied it correctly';
      if (msg.includes('403'))        msg = 'Access denied — your account may need verification';
      if (msg.includes('empty'))      msg = 'Key works but model returned empty — try again';
      if (msg.includes('Provider'))   msg = 'Upstream model unavailable — trying next free model...';
      return { success: false, error: msg };
    }
  }

  // ── Active provider name (for status bar) ──
  function activeProviderLabel() {
    if (isHyperMode()) return '🔥 HYPER MODE ON';
    const mode = getProviderMode();
    if (mode === 'auto') return '🤖 Auto';
    return providerModeLabel(mode);
  }

  return { chat, chatMultiProvider, isConsensusMode, setConsensusMode, isHyperMode, setHyperMode, toggleHyperMode, testKey, activeProviderLabel, IS_LOCAL, PROVIDER_INFO, getProviderMode, setProviderMode, providerModeLabel, resolveProviderOrder };
})();

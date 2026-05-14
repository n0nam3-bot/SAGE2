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
    const keys = Auth.getKeys();
    const configured = [];
    if (keys.gemini)     configured.push('gemini');
    if (keys.groq)       configured.push('groq');
    if (keys.openrouter) configured.push('openrouter');

    // If only one (or zero) providers, fall back to regular chat
    if (configured.length <= 1) return chat({ system, messages, maxTokens });

    // Call all configured providers in parallel
    const results = await Promise.allSettled(
      configured.map(provider => callCascade({ system, messages, maxTokens, preferredProvider: provider }))
    );

    const successes = results
      .map((r, i) => r.status === 'fulfilled' ? { provider: configured[i], text: r.value.text, model: r.value.model } : null)
      .filter(Boolean);

    if (successes.length === 0) throw new Error('All providers failed in consensus mode');
    if (successes.length === 1) return {
      text: successes[0].text,
      provider: successes[0].provider,
      model: successes[0].model,
      consensus: false,
      providerOutputs: successes,
    };

    // Merge the responses for the agent to read, but preserve every provider output
    const merged = mergeProviderResponses(successes);
    return {
      text: merged,
      provider: `consensus(${successes.map(s=>s.provider).join('+')})`,
      model: 'multi',
      consensus: true,
      providerCount: successes.length,
      providerOutputs: successes,
    };
  }

  // Merge multiple JSON responses from different providers into one unified result.
  // Strategy: parse each, union arrays, average scalar confidence fields.
  function mergeProviderResponses(responses) {
    const parsed = [];
    for (const r of responses) {
      try {
        const m = r.text.match(/```(?:json)?\s*([\s\S]*?)```/) || r.text.match(/(\[[\s\S]*?\]|\{[\s\S]*?\})/);
        if (m) parsed.push({ provider: r.provider, data: JSON.parse(m[1] || m[0]) });
        else parsed.push({ provider: r.provider, data: JSON.parse(r.text) });
      } catch {
        // If can't parse, keep raw text
        parsed.push({ provider: r.provider, data: null, raw: r.text });
      }
    }

    const validParsed = parsed.filter(p => p.data != null);
    if (validParsed.length === 0) {
      // All failed to parse — return the longest raw text
      const best = responses.reduce((a, b) => (a.text?.length || 0) > (b.text?.length || 0) ? a : b);
      return best.text;
    }

    // If all are arrays (sports picks), merge them
    if (validParsed.every(p => Array.isArray(p.data))) {
      const allPicks = validParsed.flatMap(p => p.data.map(pick => ({ ...pick, _source_provider: p.provider })));
      const deduped = dedupePicksByKey(allPicks);
      // Average confidence across duplicate picks
      const avgd = boostConsensusConfidence(allPicks, deduped);
      return JSON.stringify(avgd);
    }

    // If all are objects, merge fields
    if (validParsed.every(p => !Array.isArray(p.data) && typeof p.data === 'object')) {
      const merged = mergeJsonObjects(validParsed.map(p => p.data));
      // Mark which providers agreed
      merged._consensus_providers = validParsed.map(p => p.provider);
      return JSON.stringify(merged);
    }

    // Mixed — return best (highest confidence or longest)
    const best = validParsed.reduce((a, b) => {
      const sa = Array.isArray(a.data) ? a.data.length : (a.data?.conviction || a.data?.confidence || 0);
      const sb = Array.isArray(b.data) ? b.data.length : (b.data?.conviction || b.data?.confidence || 0);
      return sa >= sb ? a : b;
    });
    best.data._consensus_providers = validParsed.map(p => p.provider);
    return JSON.stringify(best.data);
  }

  function dedupePicksByKey(picks) {
    const seen = new Map();
    for (const pick of picks) {
      const key = [
        (pick.sport || '').toLowerCase(),
        (pick.game || pick.event || '').toLowerCase().slice(0, 30),
        (pick.bet_type || '').toLowerCase(),
        (pick.pick || '').toLowerCase().slice(0, 20),
      ].join('|');
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push(pick);
    }
    return [...seen.values()].map(group => group[0]); // take first of each group
  }

  function boostConsensusConfidence(allPicks, deduped) {
    return deduped.map(pick => {
      const key = [
        (pick.sport || '').toLowerCase(),
        (pick.game || pick.event || '').toLowerCase().slice(0, 30),
        (pick.bet_type || '').toLowerCase(),
        (pick.pick || '').toLowerCase().slice(0, 20),
      ].join('|');
      const matches = allPicks.filter(p => [
        (p.sport || '').toLowerCase(),
        (p.game || p.event || '').toLowerCase().slice(0, 30),
        (p.bet_type || '').toLowerCase(),
        (p.pick || '').toLowerCase().slice(0, 20),
      ].join('|') === key);
      const avgConf = matches.reduce((s, p) => s + (Number(p.confidence) || 50), 0) / matches.length;
      const agreementBoost = (matches.length - 1) * 5; // +5 per extra provider that agrees
      const providers = [...new Set(matches.map(p => p._source_provider).filter(Boolean))];
      return {
        ...pick,
        confidence: Math.min(95, Math.round(avgConf + agreementBoost)),
        agents_in_agreement: [...(pick.agents_in_agreement || []), ...providers.map(p => p + ' LLM')],
        _provider_count: matches.length,
      };
    });
  }

  function mergeJsonObjects(objects) {
    const merged = {};
    for (const obj of objects) {
      for (const [key, val] of Object.entries(obj)) {
        if (!(key in merged)) { merged[key] = val; continue; }
        // Arrays: concatenate and dedupe
        if (Array.isArray(merged[key]) && Array.isArray(val)) {
          merged[key] = [...merged[key], ...val.filter(v =>
            !merged[key].some(existing => JSON.stringify(existing) === JSON.stringify(v))
          )];
          continue;
        }
        // Numbers: average
        if (typeof merged[key] === 'number' && typeof val === 'number') {
          merged[key] = (merged[key] + val) / 2;
          continue;
        }
        // Strings: keep the longer/more detailed one
        if (typeof merged[key] === 'string' && typeof val === 'string') {
          if (val.length > merged[key].length) merged[key] = val;
        }
      }
    }
    return merged;
  }

  function isConsensusMode() {
    return localStorage.getItem('sage_consensus_mode') === 'on';
  }

  function setConsensusMode(on) {
    localStorage.setItem('sage_consensus_mode', on ? 'on' : 'off');
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
    const keys = Auth.getKeys();
    const errors = [];
    const order = resolveProviderOrder(preferredProvider);

    for (const provider of order) {
      // Ollama skipped on GitHub Pages (mixed content: HTTPS → HTTP)
      if (!IS_LOCAL && provider === 'ollama') continue;
      if (!keys[provider] && provider !== 'ollama') continue;
      try {
        if (provider === 'ollama') return await callServerProxy({ system, messages, maxTokens });
        if (provider === 'gemini') return await callGemini(keys.gemini, system, messages, maxTokens);
        if (provider === 'groq') return await callGroq(keys.groq, system, messages, maxTokens);
        if (provider === 'openrouter') return await callOpenRouter(keys.openrouter, system, messages, maxTokens);
      } catch (e) {
        errors.push(`${provider.charAt(0).toUpperCase() + provider.slice(1)}: ${e.message}`);
      }
    }

    if (errors.length === 0)
      throw new Error('No API keys configured. Go to Profile → API Keys to add your free keys.');
    throw new Error('All providers failed. ' + errors.join(' | '));
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
        lastErr = new Error(`Gemini ${model} rate limited (429) — try again in 60s or add Groq key`);
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
      if (res.status === 429) throw new Error('Groq rate limited (429) — falling back to next provider');
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
  async function testKey(provider, apiKey) {
    const testMsg = [{ role: 'user', content: 'Reply with exactly three words: SAGE is online' }];
    try {
      let result;
      if (provider === 'gemini')     result = await callGemini(apiKey, null, testMsg, 30);
      else if (provider === 'groq')  result = await callGroq(apiKey, null, testMsg, 30);
      else                           result = await callOpenRouter(apiKey, null, testMsg, 30);
      return { success: true, response: result.text.trim().slice(0, 80), model: result.model };
    } catch (e) {
      // Make error messages more human-readable
      let msg = e.message;
      if (msg.includes('429'))        msg = 'Rate limited — wait 60 seconds and try again';
      if (msg.includes('401'))        msg = 'Invalid API key — double-check you copied it correctly';
      if (msg.includes('403'))        msg = 'Access denied — your account may need verification';
      if (msg.includes('empty'))      msg = 'Key works but model returned empty — try again';
      if (msg.includes('Provider'))   msg = 'Upstream model unavailable — trying next free model...';
      return { success: false, error: msg };
    }
  }

  // ── Active provider name (for status bar) ──
  function activeProviderLabel() {
    const mode = getProviderMode();
    if (mode === 'auto') return '🤖 Auto';
    return providerModeLabel(mode);
  }

  return { chat, chatMultiProvider, isConsensusMode, setConsensusMode, testKey, activeProviderLabel, IS_LOCAL, PROVIDER_INFO, getProviderMode, setProviderMode, providerModeLabel, resolveProviderOrder };
})();

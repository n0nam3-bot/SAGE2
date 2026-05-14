// providers-client.js — Browser-side LLM provider cascade
// Best free models: Gemini → Groq → OpenRouter → Ollama
// Cascade continues where it left off when tokens are exhausted

const LLM = (() => {

  const IS_LOCAL = (() => {
    const h = window.location.hostname;
    return h === 'localhost' || h === '127.0.0.1' ||
           h.startsWith('192.168.') || h.startsWith('10.') ||
           h.startsWith('172.') || h === '';
  })();

  const PROVIDER_INFO = {
    auto:       { name: 'Auto',             icon: '🤖', cors: true  },
    ollama:     { name: 'Ollama (Local)',   icon: '🖥️', cors: false },
    gemini:     { name: 'Google Gemini',    icon: '✨', cors: true  },
    groq:       { name: 'Groq',             icon: '⚡', cors: true  },
    openrouter: { name: 'OpenRouter',       icon: '🌐', cors: true  },
  };

  const PROVIDER_ORDER = ['ollama', 'gemini', 'groq', 'openrouter'];
  const PROVIDER_MODE_KEY = 'sage_provider_mode';
  const VALID_PROVIDER_MODES = new Set(['auto', ...PROVIDER_ORDER]);

  // Best 5 free models per provider — ordered by quality for trading/sports analysis
  const GEMINI_FREE_MODELS = [
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-1.5-flash',
    'gemini-1.5-flash-8b',
  ];

  const GROQ_FREE_MODELS = [
    'llama-3.3-70b-versatile',
    'llama-3.1-70b-versatile',
    'mixtral-8x7b-32768',
    'llama3-70b-8192',
    'gemma2-9b-it',
  ];

  const OPENROUTER_FREE_MODELS = [
    'meta-llama/llama-3.3-70b-instruct:free',
    'google/gemini-2.0-flash-exp:free',
    'mistralai/mistral-7b-instruct:free',
    'qwen/qwen-2.5-72b-instruct:free',
    'microsoft/phi-4:free',
  ];

  // Per-session model index tracker (persists across cascade calls in a session)
  const _modelIndex = { gemini: 0, groq: 0, openrouter: 0 };

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
    if (IS_LOCAL) {
      return callServerProxy({ system, messages, maxTokens, forceProvider: resolvedProvider });
    }
    return callCascade({ system, messages, maxTokens, preferredProvider: providerMode });
  }

  // ── Hyper Mode: call ALL available providers in parallel for a single agent ──
  // Returns array of results from each provider
  async function chatHyper({ system, messages, maxTokens = 2000 }) {
    if (IS_LOCAL) {
      // Server handles hyper mode
      return callServerProxy({ system, messages, maxTokens, hyperMode: true })
        .then(r => [r]).catch(() => []);
    }
    const keys = Auth.getKeys();
    const results = [];
    const providers = [];

    if (keys.gemini) providers.push(callGemini(keys.gemini, system, messages, maxTokens).then(r => ({ ...r, provider: 'gemini' })).catch(() => null));
    if (keys.groq) providers.push(callGroq(keys.groq, system, messages, maxTokens).then(r => ({ ...r, provider: 'groq' })).catch(() => null));
    if (keys.openrouter) providers.push(callOpenRouter(keys.openrouter, system, messages, maxTokens).then(r => ({ ...r, provider: 'openrouter' })).catch(() => null));

    const settled = await Promise.allSettled(providers);
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value) results.push(s.value);
    }
    return results.length ? results : [await callCascade({ system, messages, maxTokens, preferredProvider: 'auto' })];
  }

  // ── Server proxy ──
  async function callServerProxy({ system, messages, maxTokens, forceProvider = null, hyperMode = false }) {
    const body = { system, messages, max_tokens: maxTokens };
    if (forceProvider) body.forceProvider = forceProvider;
    if (hyperMode) body.hyperMode = true;
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

  // ── Direct browser cascade — continues from last successful model index ──
  async function callCascade({ system, messages, maxTokens, preferredProvider = 'auto' }) {
    const keys = Auth.getKeys();
    const errors = [];
    const order = resolveProviderOrder(preferredProvider);

    for (const provider of order) {
      if (!IS_LOCAL && provider === 'ollama') continue;
      if (!keys[provider] && provider !== 'ollama') continue;
      try {
        if (provider === 'ollama') return await callServerProxy({ system, messages, maxTokens });
        if (provider === 'gemini') return await callGemini(keys.gemini, system, messages, maxTokens);
        if (provider === 'groq') return await callGroq(keys.groq, system, messages, maxTokens);
        if (provider === 'openrouter') return await callOpenRouter(keys.openrouter, system, messages, maxTokens);
      } catch (e) {
        errors.push(`${provider}: ${e.message}`);
      }
    }

    if (errors.length === 0)
      throw new Error('No API keys configured. Go to Profile → API Keys to add your free keys.');
    throw new Error('All providers failed. ' + errors.join(' | '));
  }

  // ── Gemini — tries all 5 free models, remembers which worked last ──
  async function callGemini(apiKey, system, messages, maxTokens) {
    const contents = [];
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

    // Start from last working model index
    const startIdx = _modelIndex.gemini;
    let lastErr = null;

    for (let i = 0; i < GEMINI_FREE_MODELS.length; i++) {
      const idx = (startIdx + i) % GEMINI_FREE_MODELS.length;
      const model = GEMINI_FREE_MODELS[idx];
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      try {
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
          // Rate limited — try next model
          lastErr = new Error(`Gemini ${model} rate limited (429)`);
          _modelIndex.gemini = (idx + 1) % GEMINI_FREE_MODELS.length;
          continue;
        }
        if (res.status === 503 || res.status === 500) {
          lastErr = new Error(`Gemini ${model} unavailable (${res.status})`);
          _modelIndex.gemini = (idx + 1) % GEMINI_FREE_MODELS.length;
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

        // Remember this working model index
        _modelIndex.gemini = idx;
        return { text, provider: 'gemini', model };
      } catch (e) {
        lastErr = e;
      }
    }

    throw lastErr || new Error('All Gemini free models exhausted');
  }

  // ── Groq — tries all 5 free models, continues from last working ──
  async function callGroq(apiKey, system, messages, maxTokens) {
    const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
    const startIdx = _modelIndex.groq;
    let lastErr = null;

    for (let i = 0; i < GROQ_FREE_MODELS.length; i++) {
      const idx = (startIdx + i) % GROQ_FREE_MODELS.length;
      const model = GROQ_FREE_MODELS[idx];
      try {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages: msgs, max_tokens: maxTokens, temperature: 0.7 }),
        });

        if (res.status === 429) {
          lastErr = new Error(`Groq ${model} rate limited (429)`);
          _modelIndex.groq = (idx + 1) % GROQ_FREE_MODELS.length;
          continue;
        }
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          lastErr = new Error(e.error?.message || `Groq ${model} HTTP ${res.status}`);
          // Model may not exist on this account — try next
          if (res.status === 404 || res.status === 400) {
            _modelIndex.groq = (idx + 1) % GROQ_FREE_MODELS.length;
          }
          continue;
        }

        const data = await res.json();
        const text = data.choices?.[0]?.message?.content || '';
        if (!text) { lastErr = new Error(`Groq ${model} returned empty response`); continue; }

        _modelIndex.groq = idx;
        return { text, provider: 'groq', model: data.model || model };
      } catch (e) {
        lastErr = e;
      }
    }

    throw lastErr || new Error('All Groq free models exhausted');
  }

  // ── OpenRouter — tries all 5 free models, continues from last working ──
  async function callOpenRouter(apiKey, system, messages, maxTokens) {
    const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
    const startIdx = _modelIndex.openrouter;
    let lastErr = null;

    for (let i = 0; i < OPENROUTER_FREE_MODELS.length; i++) {
      const idx = (startIdx + i) % OPENROUTER_FREE_MODELS.length;
      const model = OPENROUTER_FREE_MODELS[idx];
      try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': window.location.origin,
            'X-Title': 'SAGE2',
          },
          body: JSON.stringify({ model, messages: msgs, max_tokens: maxTokens }),
        });

        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          const msg = e.error?.message || `HTTP ${res.status}`;
          if (res.status === 429) {
            lastErr = new Error(`OpenRouter ${model} rate limited (429)`);
            _modelIndex.openrouter = (idx + 1) % OPENROUTER_FREE_MODELS.length;
          } else {
            lastErr = new Error(`OpenRouter ${model}: ${msg}`);
            _modelIndex.openrouter = (idx + 1) % OPENROUTER_FREE_MODELS.length;
          }
          continue;
        }

        const data = await res.json();
        const text = data.choices?.[0]?.message?.content || '';
        if (!text) { lastErr = new Error(`OpenRouter ${model}: empty response`); continue; }

        _modelIndex.openrouter = idx;
        return { text, provider: 'openrouter', model };
      } catch (e) {
        lastErr = e;
        _modelIndex.openrouter = (idx + 1) % OPENROUTER_FREE_MODELS.length;
      }
    }

    throw lastErr || new Error('All OpenRouter free models exhausted');
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
      let msg = e.message;
      if (msg.includes('429'))        msg = 'Rate limited — wait 60 seconds and try again';
      if (msg.includes('401'))        msg = 'Invalid API key — double-check you copied it correctly';
      if (msg.includes('403'))        msg = 'Access denied — your account may need verification';
      if (msg.includes('empty'))      msg = 'Key works but model returned empty — try again';
      return { success: false, error: msg };
    }
  }

  // Reset model indices at the start of a new session
  function resetModelIndices() {
    _modelIndex.gemini = 0;
    _modelIndex.groq = 0;
    _modelIndex.openrouter = 0;
  }

  function activeProviderLabel() {
    const mode = getProviderMode();
    if (mode === 'auto') return '🤖 Auto';
    return providerModeLabel(mode);
  }

  return {
    chat, chatHyper, testKey, activeProviderLabel, resetModelIndices,
    IS_LOCAL, PROVIDER_INFO, getProviderMode, setProviderMode,
    providerModeLabel, resolveProviderOrder,
    GEMINI_FREE_MODELS, GROQ_FREE_MODELS, OPENROUTER_FREE_MODELS,
  };
})();

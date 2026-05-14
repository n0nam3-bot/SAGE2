// providers.js — LLM provider cascade: Ollama → Gemini → Groq → OpenRouter
// Best 5 free models per provider — cascade continues where it left off
require('dotenv').config();
const fetch = require('node-fetch');

// ─────────────────────────────────────────
// PROVIDER CONFIGS
// ─────────────────────────────────────────
const PROVIDERS = {
  ollama: {
    name: 'Ollama (Local)',
    icon: '🖥️',
    baseUrl: process.env.OLLAMA_HOST || 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL || 'llama3.3',
    free: true,
    local: true,
  },
  gemini: {
    name: 'Google Gemini',
    icon: '✨',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: [
      'gemini-2.5-flash',
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-1.5-flash',
      'gemini-1.5-flash-8b',
    ],
    apiKey: () => process.env.GEMINI_API_KEY,
    free: true,
    local: false,
  },
  groq: {
    name: 'Groq',
    icon: '⚡',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: [
      'llama-3.3-70b-versatile',
      'llama-3.1-70b-versatile',
      'mixtral-8x7b-32768',
      'llama3-70b-8192',
      'gemma2-9b-it',
    ],
    apiKey: () => process.env.GROQ_API_KEY,
    free: true,
    local: false,
  },
  openrouter: {
    name: 'OpenRouter',
    icon: '🌐',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      'meta-llama/llama-3.3-70b-instruct:free',
      'google/gemini-2.0-flash-exp:free',
      'mistralai/mistral-7b-instruct:free',
      'qwen/qwen-2.5-72b-instruct:free',
      'microsoft/phi-4:free',
    ],
    apiKey: () => process.env.OPENROUTER_API_KEY,
    free: true,
    local: false,
  },
};

const PROVIDER_ORDER = ['ollama', 'gemini', 'groq', 'openrouter'];

// Per-process model index tracker (continues where last left off)
const _modelIndex = { gemini: 0, groq: 0, openrouter: 0 };

// ─────────────────────────────────────────
// CHECK AVAILABILITY
// ─────────────────────────────────────────
async function isOllamaAvailable() {
  try {
    const res = await fetch(`${PROVIDERS.ollama.baseUrl}/api/tags`, { timeout: 2000 });
    return res.ok;
  } catch {
    return false;
  }
}

async function checkProviderStatus() {
  const ollamaUp = await isOllamaAvailable();
  return {
    ollama: { available: ollamaUp, reason: ollamaUp ? 'Running locally' : 'Not reachable (is Ollama running?)' },
    gemini: { available: !!process.env.GEMINI_API_KEY, reason: process.env.GEMINI_API_KEY ? 'API key set' : 'GEMINI_API_KEY not set in .env' },
    groq:   { available: !!process.env.GROQ_API_KEY,   reason: process.env.GROQ_API_KEY   ? 'API key set' : 'GROQ_API_KEY not set in .env' },
    openrouter: { available: !!process.env.OPENROUTER_API_KEY, reason: process.env.OPENROUTER_API_KEY ? 'API key set' : 'OPENROUTER_API_KEY not set in .env' },
  };
}

// ─────────────────────────────────────────
// CALL OLLAMA (local)
// ─────────────────────────────────────────
async function callOllama(messages, system, maxTokens) {
  const cfg = PROVIDERS.ollama;
  const body = {
    model: cfg.model,
    messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
    stream: false,
    options: { num_predict: maxTokens || 2000, temperature: 0.7 },
  };
  const res = await fetch(`${cfg.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = await res.json();
  const text = data.message?.content || '';
  return { text, provider: 'ollama', model: cfg.model };
}

// ─────────────────────────────────────────
// CALL GEMINI — tries all 5 free models, continues from last working
// ─────────────────────────────────────────
async function callGemini(messages, system, maxTokens) {
  const cfg = PROVIDERS.gemini;
  const apiKey = cfg.apiKey();
  if (!apiKey) throw new Error('No Gemini API key');

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

  const startIdx = _modelIndex.gemini;
  let lastErr = null;

  for (let i = 0; i < cfg.models.length; i++) {
    const idx = (startIdx + i) % cfg.models.length;
    const model = cfg.models[idx];
    try {
      const url = `${cfg.baseUrl}/models/${model}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          generationConfig: { maxOutputTokens: maxTokens || 2000, temperature: 0.7 },
          safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
          ],
        }),
      });

      if (res.status === 429 || res.status === 503) {
        lastErr = new Error(`Gemini ${model} unavailable (${res.status})`);
        _modelIndex.gemini = (idx + 1) % cfg.models.length;
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

      _modelIndex.gemini = idx;
      console.log(`[LLM] ✅ Gemini (${model}) responded`);
      return { text, provider: 'gemini', model };
    } catch (e) {
      lastErr = e;
      _modelIndex.gemini = (idx + 1) % cfg.models.length;
    }
  }
  throw lastErr || new Error('All Gemini models exhausted');
}

// ─────────────────────────────────────────
// CALL GROQ — tries all 5 free models, continues from last working
// ─────────────────────────────────────────
async function callGroq(messages, system, maxTokens) {
  const cfg = PROVIDERS.groq;
  const apiKey = cfg.apiKey();
  if (!apiKey) throw new Error('No Groq API key');

  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const startIdx = _modelIndex.groq;
  let lastErr = null;

  for (let i = 0; i < cfg.models.length; i++) {
    const idx = (startIdx + i) % cfg.models.length;
    const model = cfg.models[idx];
    try {
      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: msgs, max_tokens: maxTokens || 2000, temperature: 0.7 }),
      });

      if (res.status === 429) {
        lastErr = new Error(`Groq ${model} rate limited (429)`);
        _modelIndex.groq = (idx + 1) % cfg.models.length;
        continue;
      }
      if (!res.ok) {
        const errText = await res.text();
        lastErr = new Error(`Groq ${model} HTTP ${res.status}: ${errText.slice(0, 200)}`);
        if (res.status === 404 || res.status === 400) {
          _modelIndex.groq = (idx + 1) % cfg.models.length;
        }
        continue;
      }
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || '';
      if (!text) { lastErr = new Error(`Groq ${model} returned empty response`); continue; }

      _modelIndex.groq = idx;
      console.log(`[LLM] ✅ Groq (${model}) responded`);
      return { text, provider: 'groq', model: data.model || model };
    } catch (e) {
      lastErr = e;
      _modelIndex.groq = (idx + 1) % cfg.models.length;
    }
  }
  throw lastErr || new Error('All Groq models exhausted');
}

// ─────────────────────────────────────────
// CALL OPENROUTER — tries all 5 free models
// ─────────────────────────────────────────
async function callOpenRouter(messages, system, maxTokens) {
  const cfg = PROVIDERS.openrouter;
  const apiKey = cfg.apiKey();
  if (!apiKey) throw new Error('No OpenRouter API key');

  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const startIdx = _modelIndex.openrouter;
  let lastErr = null;

  for (let i = 0; i < cfg.models.length; i++) {
    const idx = (startIdx + i) % cfg.models.length;
    const model = cfg.models[idx];
    try {
      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'http://localhost:3000',
          'X-Title': 'SAGE2',
        },
        body: JSON.stringify({ model, messages: msgs, max_tokens: maxTokens || 2000 }),
      });

      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        lastErr = new Error(`OpenRouter ${model}: ${e.error?.message || `HTTP ${res.status}`}`);
        _modelIndex.openrouter = (idx + 1) % cfg.models.length;
        continue;
      }
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || '';
      if (!text) { lastErr = new Error(`OpenRouter ${model}: empty response`); continue; }

      _modelIndex.openrouter = idx;
      console.log(`[LLM] ✅ OpenRouter (${model}) responded`);
      return { text, provider: 'openrouter', model };
    } catch (e) {
      lastErr = e;
      _modelIndex.openrouter = (idx + 1) % cfg.models.length;
    }
  }
  throw lastErr || new Error('All OpenRouter free models exhausted');
}

// ─────────────────────────────────────────
// MAIN CASCADE FUNCTION
// ─────────────────────────────────────────
async function chat({ messages, system, maxTokens = 2000, forceProvider = null }) {
  const errors = [];

  const order = forceProvider && PROVIDER_ORDER.includes(forceProvider)
    ? [forceProvider, ...PROVIDER_ORDER.filter(p => p !== forceProvider)]
    : PROVIDER_ORDER;

  for (const providerId of order) {
    try {
      if (providerId === 'ollama') {
        const up = await isOllamaAvailable();
        if (!up) { errors.push({ provider: 'ollama', error: 'Not running' }); continue; }
        const result = await callOllama(messages, system, maxTokens);
        return result;
      } else if (providerId === 'gemini') {
        const result = await callGemini(messages, system, maxTokens);
        return result;
      } else if (providerId === 'groq') {
        const result = await callGroq(messages, system, maxTokens);
        return result;
      } else if (providerId === 'openrouter') {
        const result = await callOpenRouter(messages, system, maxTokens);
        return result;
      }
    } catch (err) {
      console.warn(`[LLM] ⚠️  ${PROVIDERS[providerId].name} failed: ${err.message}`);
      errors.push({ provider: providerId, error: err.message });
    }
  }

  const errorSummary = errors.map(e => `${e.provider}: ${e.error}`).join(' | ');
  throw new Error(`All LLM providers failed. Errors: ${errorSummary}`);
}

// ─────────────────────────────────────────
// HYPER MODE — call all available providers in parallel
// Returns array of results for cross-agent consultation
// ─────────────────────────────────────────
async function chatHyper({ messages, system, maxTokens = 2000 }) {
  const status = await checkProviderStatus();
  const tasks = [];

  if (status.ollama.available) {
    tasks.push(callOllama(messages, system, maxTokens).catch(e => ({ error: e.message, provider: 'ollama' })));
  }
  if (status.gemini.available) {
    tasks.push(callGemini(messages, system, maxTokens).catch(e => ({ error: e.message, provider: 'gemini' })));
  }
  if (status.groq.available) {
    tasks.push(callGroq(messages, system, maxTokens).catch(e => ({ error: e.message, provider: 'groq' })));
  }
  if (status.openrouter.available) {
    tasks.push(callOpenRouter(messages, system, maxTokens).catch(e => ({ error: e.message, provider: 'openrouter' })));
  }

  const results = await Promise.all(tasks);
  return results.filter(r => !r.error && r.text);
}

// ─────────────────────────────────────────
// GET OLLAMA INSTALLED MODELS
// ─────────────────────────────────────────
async function getOllamaModels() {
  try {
    const res = await fetch(`${PROVIDERS.ollama.baseUrl}/api/tags`, { timeout: 2000 });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map(m => m.name);
  } catch {
    return [];
  }
}

module.exports = { chat, chatHyper, checkProviderStatus, getOllamaModels, PROVIDERS, PROVIDER_ORDER };

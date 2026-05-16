// providers.js — LLM provider cascade: Ollama → Gemini → Groq → OpenRouter
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
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    apiKey: () => process.env.GEMINI_API_KEY,
    free: true,
    local: false,
  },
  groq: {
    name: 'Groq',
    icon: '⚡',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    apiKey: () => process.env.GROQ_API_KEY,
    free: true,
    local: false,
  },
  openrouter: {
    name: 'OpenRouter',
    icon: '🌐',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    apiKey: () => process.env.OPENROUTER_API_KEY,
    free: true,
    local: false,
  },
};

// Priority order
const PROVIDER_ORDER = ['ollama', 'gemini', 'groq', 'openrouter'];

const PROVIDER_COOLDOWN_MS = 60_000;
const providerCooldowns = new Map();

function isRateLimitError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests');
}

function setProviderCooldown(providerId, ms = PROVIDER_COOLDOWN_MS) {
  if (!providerId) return;
  providerCooldowns.set(providerId, Date.now() + ms);
}

function getProviderCooldownRemaining(providerId) {
  const until = Number(providerCooldowns.get(providerId) || 0);
  return Math.max(0, until - Date.now());
}

function clearExpiredCooldowns() {
  const now = Date.now();
  for (const [provider, until] of [...providerCooldowns.entries()]) {
    if (!until || Number(until) <= now) providerCooldowns.delete(provider);
  }
}

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
  clearExpiredCooldowns();
  return {
    ollama: { available: ollamaUp, reason: ollamaUp ? 'Running locally' : 'Not reachable (is Ollama running?)' },
    gemini: { available: !!process.env.GEMINI_API_KEY, reason: providerCooldowns.has('gemini') ? `Cooling down (${Math.ceil(getProviderCooldownRemaining('gemini') / 1000)}s left)` : (process.env.GEMINI_API_KEY ? 'API key set' : 'GEMINI_API_KEY not set in .env') },
    groq:   { available: !!process.env.GROQ_API_KEY,   reason: providerCooldowns.has('groq') ? `Cooling down (${Math.ceil(getProviderCooldownRemaining('groq') / 1000)}s left)` : (process.env.GROQ_API_KEY   ? 'API key set' : 'GROQ_API_KEY not set in .env') },
    openrouter: { available: !!process.env.OPENROUTER_API_KEY, reason: providerCooldowns.has('openrouter') ? `Cooling down (${Math.ceil(getProviderCooldownRemaining('openrouter') / 1000)}s left)` : (process.env.OPENROUTER_API_KEY ? 'API key set' : 'OPENROUTER_API_KEY not set in .env') },
  };
}

// ─────────────────────────────────────────
// CALL A SPECIFIC PROVIDER (OpenAI-compatible)
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

async function callOpenAICompat(providerId, messages, system, maxTokens) {
  const cfg = PROVIDERS[providerId];
  const apiKey = cfg.apiKey();
  if (!apiKey) throw new Error(`No API key for ${providerId}`);

  const body = {
    model: cfg.model,
    messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
    max_tokens: maxTokens || 2000,
    temperature: 0.7,
  };

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };

  // OpenRouter extras
  if (providerId === 'openrouter') {
    headers['HTTP-Referer'] = 'http://localhost:3000';
    headers['X-Title'] = 'SAGE';
  }

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    const errMsg = `${providerId} HTTP ${res.status}: ${errText.slice(0, 200)}`;
    throw new Error(errMsg);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  if (!text) throw new Error(`${providerId} returned empty response`);
  return { text, provider: providerId, model: data.model || cfg.model };
}

// ─────────────────────────────────────────
// MAIN CASCADE FUNCTION
// ─────────────────────────────────────────
async function chat({ messages, system, maxTokens = 2000, forceProvider = null }) {
  clearExpiredCooldowns();
  const errors = [];

  // If a specific provider is forced, try it first, then continue through the rest
  const order = forceProvider && PROVIDER_ORDER.includes(forceProvider)
    ? [forceProvider, ...PROVIDER_ORDER.filter(p => p !== forceProvider)]
    : PROVIDER_ORDER;

  for (const providerId of order) {
    const cooldownRemaining = getProviderCooldownRemaining(providerId);
    if (cooldownRemaining > 0) {
      errors.push({ provider: providerId, error: `Cooling down (${Math.ceil(cooldownRemaining / 1000)}s left)` });
      continue;
    }
    try {
      if (providerId === 'ollama') {
        // Quick availability check before trying
        const up = await isOllamaAvailable();
        if (!up) { errors.push({ provider: 'ollama', error: 'Not running' }); continue; }
        const result = await callOllama(messages, system, maxTokens);
        console.log(`[LLM] ✅ ${PROVIDERS[providerId].name} responded`);
        return result;
      } else {
        const result = await callOpenAICompat(providerId, messages, system, maxTokens);
        console.log(`[LLM] ✅ ${PROVIDERS[providerId].name} responded`);
        return result;
      }
    } catch (err) {
      if (isRateLimitError(err)) setProviderCooldown(providerId);
      console.warn(`[LLM] ⚠️  ${PROVIDERS[providerId].name} failed: ${err.message}`);
      errors.push({ provider: providerId, error: err.message });
    }
  }

  // All providers failed
  const errorSummary = errors.map(e => `${e.provider}: ${e.error}`).join(' | ');
  throw new Error(`All LLM providers failed. Errors: ${errorSummary}`);
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

module.exports = { chat, checkProviderStatus, getOllamaModels, PROVIDERS, PROVIDER_ORDER };

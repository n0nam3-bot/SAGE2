require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');
const { chat, chatHyper, checkProviderStatus, getOllamaModels, PROVIDERS } = require('./providers');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ──────────────────────────────────────────────
// LLM PROXY — Cascade with continuation
// ──────────────────────────────────────────────
async function handleChat(req, res) {
  const { system, messages, max_tokens, forceProvider, hyperMode } = req.body;
  if (!messages || !Array.isArray(messages))
    return res.status(400).json({ error: 'messages array required' });
  try {
    if (hyperMode) {
      // Hyper mode: call all available providers in parallel
      const results = await chatHyper({ messages, system, maxTokens: max_tokens || 2000 });
      if (!results.length) throw new Error('No providers returned results in hyper mode');
      // Return the first (best) result; client handles merging
      const best = results[0];
      return res.json({
        content: [{ type: 'text', text: best.text }],
        provider: best.provider,
        model: best.model,
        hyperResults: results.map(r => ({ provider: r.provider, model: r.model, text: r.text })),
      });
    }
    const result = await chat({ messages, system, maxTokens: max_tokens || 2000, forceProvider });
    res.json({ content: [{ type: 'text', text: result.text }], provider: result.provider, model: result.model });
  } catch (err) {
    console.error('[/api/chat]', err.message);
    res.status(503).json({ error: err.message });
  }
}

app.post('/api/chat', handleChat);
app.post('/api/claude', handleChat); // legacy alias

// ── Hyper mode parallel endpoint ──
app.post('/api/chat/hyper', async (req, res) => {
  const { system, messages, max_tokens } = req.body;
  if (!messages || !Array.isArray(messages))
    return res.status(400).json({ error: 'messages array required' });
  try {
    const results = await chatHyper({ messages, system, maxTokens: max_tokens || 1500 });
    res.json({ results: results.map(r => ({ provider: r.provider, model: r.model, text: r.text })) });
  } catch (err) {
    res.status(503).json({ error: err.message, results: [] });
  }
});

// ──────────────────────────────────────────────
// PROVIDER STATUS & MANAGEMENT
// ──────────────────────────────────────────────
app.get('/api/providers', async (req, res) => {
  const status = await checkProviderStatus();
  const ollamaModels = await getOllamaModels();
  res.json({ providers: PROVIDERS, status, ollamaModels });
});

app.post('/api/providers/test', async (req, res) => {
  const { provider } = req.body;
  try {
    const result = await chat({
      messages: [{ role: 'user', content: 'Reply with exactly three words: SAGE is online' }],
      maxTokens: 30,
      forceProvider: provider,
    });
    res.json({ success: true, response: result.text.trim(), provider: result.provider, model: result.model });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post('/api/providers/ollama/model', (req, res) => {
  const { model } = req.body;
  if (!model) return res.status(400).json({ error: 'model required' });
  PROVIDERS.ollama.model = model;
  res.json({ success: true, model });
});

// ──────────────────────────────────────────────
// GOOGLE SHEETS
// ──────────────────────────────────────────────
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const TOKEN_PATH = path.join(__dirname, 'token.json');
const SHEET_ID = process.env.GOOGLE_SHEET_ID || '1ZkrcVO7Ev7pv8hRltL4_TMasMYPI7hGFtrhD6x3-bgo';

function getOAuthClient() {
  const id = process.env.GOOGLE_CLIENT_ID, secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) return null;
  return new google.auth.OAuth2(id, secret, `http://localhost:${PORT}/auth/callback`);
}

app.get('/auth/google', (req, res) => {
  const c = getOAuthClient();
  if (!c) return res.status(400).send('Google credentials not set in .env');
  res.redirect(c.generateAuthUrl({ access_type: 'offline', scope: SCOPES }));
});

app.get('/auth/callback', async (req, res) => {
  const c = getOAuthClient();
  if (!c) return res.status(400).send('Not configured');
  try {
    const { tokens } = await c.getToken(req.query.code);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    res.send('<script>window.close();</script><p style="font-family:sans-serif;padding:24px;color:#22c55e">✅ Google Sheets authorized! You may close this tab.</p>');
  } catch (err) { res.status(500).send('Auth error: ' + err.message); }
});

app.get('/auth/status', (req, res) => res.json({
  authorized: fs.existsSync(TOKEN_PATH),
  configured: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
}));

async function getSheetsClient() {
  const c = getOAuthClient();
  if (!c || !fs.existsSync(TOKEN_PATH)) return null;
  c.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH)));
  return google.sheets({ version: 'v4', auth: c });
}

async function appendViaBearerToken({ token, sheetId, tab, rows }) {
  if (!token || !sheetId || !tab || !rows?.length) return false;
  const range = encodeURIComponent(`'${tab}'!A1`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: rows }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Sheets API ${res.status}`);
  }
  return true;
}

async function ensureSheets(sheets) {
  const required = ['Trading Picks', 'Sports Picks', 'Agent Performance', 'Equity Curve'];
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const existing = meta.data.sheets.map(s => s.properties.title);
    const toCreate = required.filter(r => !existing.includes(r));
    if (toCreate.length) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        resource: { requests: toCreate.map(title => ({ addSheet: { properties: { title } } })) },
      });
      const headers = {
        'Trading Picks':    [['Date','Session','Agent','Layer','Symbol','Action','Entry','Target','Stop','Confidence','Weight','Thesis','Timeframe','Outcome','Return %','Sharpe','Regime','Notes']],
        'Sports Picks':     [['Date','Session','Agent','Sport','Game','Event Date','Game Time','Bet Type','Pick','Odds (American)','Implied Prob %','Confidence','Units','Outcome','P&L (units)','Running ROI %','Agent Weight','Reasoning','Agents in Agreement']],
        'Agent Performance':[['Agent ID','Name','Domain','Layer','Weight','Predictions','Correct','Accuracy %','Sharpe','ROI %','Rewrites','Last Rewrite','Delta','Blind Spots','Status']],
        'Equity Curve':     [['Date','Session','Domain','Value','Daily Return %','Drawdown %','Regime','Top Agent','Notes']],
      };
      for (const [tab, vals] of Object.entries(headers)) {
        if (toCreate.includes(tab))
          await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `'${tab}'!A1`, valueInputOption: 'RAW', resource: { values: vals } });
      }
    }
  } catch (e) { console.error('[Sheets] ensureSheets:', e.message); }
}

async function ensureSheetsDirect(token, sheetId) {
  const required = ['Trading Picks', 'Sports Picks', 'Agent Performance', 'Equity Curve'];
  const headers = {
    'Trading Picks':    ['Date','Session','Agent','Layer','Symbol','Action','Entry','Target','Stop','Confidence','Weight','Thesis','Timeframe','Outcome','Return %','Sharpe','Regime','Notes'],
    'Sports Picks':     ['Date','Session','Agent','Sport','Game','Bet Type','Pick','Odds','Implied Prob %','Confidence','Units','Outcome','P&L (units)','Running ROI %','Agent Weight','Reasoning'],
    'Agent Performance':['Agent ID','Name','Domain','Layer','Weight','Predictions','Correct','Accuracy %','Sharpe','ROI %','Rewrites','Last Rewrite','Delta','Blind Spots','Status'],
    'Equity Curve':     ['Date','Session','Domain','Value','Daily Return %','Drawdown %','Regime','Top Agent','Notes'],
  };
  const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!metaRes.ok) throw new Error(`Sheets metadata ${metaRes.status}`);
  const meta = await metaRes.json();
  const existing = new Set((meta.sheets || []).map(s => s.properties?.title).filter(Boolean));
  const missing = required.filter(t => !existing.has(t));
  if (missing.length) {
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: missing.map(title => ({ addSheet: { properties: { title } } })) }),
    });
    for (const tab of missing) {
      const values = [headers[tab] || []];
      if (values[0].length) {
        const range = encodeURIComponent(`'${tab}'!A1`);
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueInputOption=RAW`, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values }),
        }).catch(() => {});
      }
    }
  }
}

app.post('/api/sheets/append', async (req, res) => {
  const { tab, rows, token, sheetId } = req.body;
  if (!tab || !rows) return res.status(400).json({ error: 'tab and rows required' });
  try {
    if (token && sheetId) {
      await ensureSheetsDirect(token, sheetId).catch(() => {});
      await appendViaBearerToken({ token, sheetId, tab, rows });
      return res.json({ success: true, rowsAdded: rows.length, mode: 'direct' });
    }
    const sheets = await getSheetsClient();
    if (!sheets) return res.status(401).json({ error: 'Not authorized with Google Sheets' });
    await ensureSheets(sheets);
    await sheets.spreadsheets.values.append({ spreadsheetId: SHEET_ID, range: `'${tab}'!A1`, valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS', resource: { values: rows } });
    res.json({ success: true, rowsAdded: rows.length, mode: 'server' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/sheets/upsert-agent', async (req, res) => {
  const { row, token, sheetId } = req.body;
  try {
    if (token && sheetId) {
      await ensureSheetsDirect(token, sheetId).catch(() => {});
      await appendViaBearerToken({ token, sheetId, tab: 'Agent Performance', rows: [row] });
      return res.json({ success: true, mode: 'direct' });
    }
    const sheets = await getSheetsClient();
    if (!sheets) return res.status(401).json({ error: 'Not authorized' });
    await ensureSheets(sheets);
    const existing = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "'Agent Performance'!A:A" });
    const vals = existing.data.values || [];
    const idx = vals.findIndex(r => r[0] === row[0]);
    if (idx >= 1) {
      await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `'Agent Performance'!A${idx + 1}`, valueInputOption: 'USER_ENTERED', resource: { values: [row] } });
    } else {
      await sheets.spreadsheets.values.append({ spreadsheetId: SHEET_ID, range: "'Agent Performance'!A1", valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS', resource: { values: [row] } });
    }
    res.json({ success: true, mode: 'server' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/sheets/read', async (req, res) => {
  const { tab, limit = 100 } = req.query;
  if (!tab) return res.status(400).json({ error: 'tab required' });
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return res.status(401).json({ error: 'Not authorized with Google Sheets' });
    const lastRow = parseInt(limit) + 1;
    const range = `'${tab}'!A1:T${lastRow + 1}`;
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
    const rows = resp.data.values || [];
    if (rows.length < 2) return res.json([]);
    const headers = rows[0];
    const data = rows.slice(1, parseInt(limit) + 1).map(row =>
      Object.fromEntries(headers.map((h, i) => [h, row[i] || '']))
    );
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ──────────────────────────────────────────────
// LOCAL RESULTS
// ──────────────────────────────────────────────
const RESULTS_DIR = path.join(__dirname, 'results');
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR);

app.post('/api/results/save', (req, res) => {
  const safe = path.basename(req.body.filename || 'result.json').replace(/[^a-z0-9_\-\.]/gi, '_');
  try { fs.writeFileSync(path.join(RESULTS_DIR, safe), JSON.stringify(req.body.data, null, 2)); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/results/load/:filename', (req, res) => {
  const fp = path.join(RESULTS_DIR, path.basename(req.params.filename).replace(/[^a-z0-9_\-\.]/gi, '_'));
  try { res.json(fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp)) : null); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/results/list', (_req, res) => {
  try { res.json(fs.readdirSync(RESULTS_DIR).filter(f => f.endsWith('.json'))); }
  catch { res.json([]); }
});

// ──────────────────────────────────────────────
// HEALTH
// ──────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  const providerStatus = await checkProviderStatus();
  const availableProviders = Object.entries(providerStatus).filter(([, v]) => v.available).map(([k]) => k);
  res.json({
    status: 'ok',
    anyProviderAvailable: availableProviders.length > 0,
    availableProviders,
    providers: providerStatus,
    sheetsConfigured: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    sheetsAuthorized: fs.existsSync(TOKEN_PATH),
    sheetId: SHEET_ID,
  });
});

// ──────────────────────────────────────────────
// START
// ──────────────────────────────────────────────
app.listen(PORT, async () => {
  const status = await checkProviderStatus();
  const models = await getOllamaModels();
  console.log(`\n🧠 SAGE2 → http://localhost:${PORT}\n`);
  console.log('LLM Providers (priority order):');
  console.log(`  1. 🖥️  Ollama      ${status.ollama.available    ? '✅  models: ' + (models.join(', ') || 'none found') : '❌  ' + status.ollama.reason}`);
  console.log(`  2. ✨ Gemini     ${status.gemini.available    ? '✅  5 free models ready' : '⚠️   ' + status.gemini.reason}`);
  console.log(`  3. ⚡ Groq       ${status.groq.available      ? '✅  5 free models ready' : '⚠️   ' + status.groq.reason}`);
  console.log(`  4. 🌐 OpenRouter ${status.openrouter.available ? '✅  5 free models ready' : '⚠️   ' + status.openrouter.reason}`);
  const active = Object.entries(status).filter(([, v]) => v.available);
  console.log(active.length
    ? `\n▶  Active providers: ${active.map(([k]) => k).join(', ')}\n`
    : '\n⚠️  No providers available — add keys to .env or start Ollama.\n');
  console.log(`⚡ Hyper Mode: uses all ${active.length} available provider(s) in parallel per agent`);
  console.log(`Google Sheets: ${fs.existsSync(TOKEN_PATH) ? '✅ authorized' : '⚠️  visit Settings to authorize'}\n`);
});

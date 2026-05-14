require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');
const { chat, checkProviderStatus, getOllamaModels, PROVIDERS } = require('./providers');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ──────────────────────────────────────────────
// LLM PROXY — Ollama → Gemini → Groq → OpenRouter
// ──────────────────────────────────────────────
async function handleChat(req, res) {
  const { system, messages, max_tokens, forceProvider } = req.body;
  if (!messages || !Array.isArray(messages))
    return res.status(400).json({ error: 'messages array required' });
  try {
    const result = await chat({ messages, system, maxTokens: max_tokens || 2000, forceProvider });
    res.json({ content: [{ type: 'text', text: result.text }], provider: result.provider, model: result.model });
  } catch (err) {
    console.error('[/api/chat]', err.message);
    res.status(503).json({ error: err.message });
  }
}

app.post('/api/chat', handleChat);
app.post('/api/claude', handleChat); // legacy alias — kept for any cached bookmarks

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
        'Sports Picks':     [['Date','Session','Agent','Sport','Game','Bet Type','Pick','Odds','Implied Prob %','Confidence','Units','Outcome','P&L (units)','Running ROI %','Agent Weight','Reasoning']],
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

app.post('/api/sheets/append', async (req, res) => {
  const sheets = await getSheetsClient();
  if (!sheets) return res.status(401).json({ error: 'Not authorized with Google Sheets' });
  const { tab, rows } = req.body;
  if (!tab || !rows) return res.status(400).json({ error: 'tab and rows required' });
  try {
    await ensureSheets(sheets);
    await sheets.spreadsheets.values.append({ spreadsheetId: SHEET_ID, range: `'${tab}'!A1`, valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS', resource: { values: rows } });
    res.json({ success: true, rowsAdded: rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/sheets/upsert-agent', async (req, res) => {
  const sheets = await getSheetsClient();
  if (!sheets) return res.status(401).json({ error: 'Not authorized' });
  const { row } = req.body;
  try {
    await ensureSheets(sheets);
    const existing = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "'Agent Performance'!A:A" });
    const vals = existing.data.values || [];
    const idx = vals.findIndex(r => r[0] === row[0]);
    if (idx >= 1) {
      await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `'Agent Performance'!A${idx + 1}`, valueInputOption: 'USER_ENTERED', resource: { values: [row] } });
    } else {
      await sheets.spreadsheets.values.append({ spreadsheetId: SHEET_ID, range: "'Agent Performance'!A1", valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS', resource: { values: [row] } });
    }
    res.json({ success: true });
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
  res.json({
    status: 'ok',
    anyProviderAvailable: Object.values(providerStatus).some(p => p.available),
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
  console.log(`\n🧠 SAGE → http://localhost:${PORT}\n`);
  console.log('LLM Providers (priority order):');
  console.log(`  1. 🖥️  Ollama    ${status.ollama.available    ? '✅  models: ' + (models.join(', ') || 'none found') : '❌  ' + status.ollama.reason}`);
  console.log(`  2. ✨ Gemini    ${status.gemini.available    ? '✅  ready' : '⚠️   ' + status.gemini.reason}`);
  console.log(`  3. ⚡ Groq      ${status.groq.available      ? '✅  ready' : '⚠️   ' + status.groq.reason}`);
  console.log(`  4. 🌐 OpenRouter ${status.openrouter.available ? '✅  ready' : '⚠️   ' + status.openrouter.reason}`);
  const active = Object.entries(status).find(([, v]) => v.available);
  console.log(active ? `\n▶  Will use: ${active[0].toUpperCase()}\n` : '\n⚠️  No providers available — add keys to .env or start Ollama.\n');
  console.log(`Google Sheets: ${fs.existsSync(TOKEN_PATH) ? '✅ authorized' : '⚠️  visit Settings to authorize'}\n`);
});

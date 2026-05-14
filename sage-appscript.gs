// ═══════════════════════════════════════════════════════════════════
// SAGE Google Apps Script
// ═══════════════════════════════════════════════════════════════════
// SETUP INSTRUCTIONS:
// 1. Go to https://script.google.com and click "New project"
// 2. Delete all existing code, paste this entire file
// 3. Click Deploy → New deployment → Web app
// 4. Execute as: Me | Who has access: Anyone
// 5. Click Deploy, copy the web app URL
// 6. In SAGE → Profile → paste the URL under "Apps Script URL"
// That's it — no OAuth, no client IDs, works on any device forever.
// ═══════════════════════════════════════════════════════════════════

const SHEET_TABS = {
  TRADING:     'Trading Picks',
  SPORTS:      'Sports Picks',
  AGENTS:      'Agent Performance',
  EQUITY:      'Equity Curve',
  IMPROVEMENT: 'Improvement Log',
};

const HEADERS = {
  [SHEET_TABS.TRADING]: [
    'Date','Session','Agent','Layer','Symbol','Action',
    'Entry','Target','Stop','Confidence','Weight','Thesis',
    'Timeframe','Catalysts','Outcome','Return %','Regime','Notes'
  ],
  [SHEET_TABS.SPORTS]: [
    'Date','Session','Agent','Sport','Game','Event Date','Event Time',
    'Bet Type','Pick','Odds','Implied Prob %','Confidence','Units',
    'Key Factors','Line Movement','Outcome','P&L (units)','Running ROI %','Agent Weight','Reasoning'
  ],
  [SHEET_TABS.AGENTS]: [
    'Agent ID','Name','Domain','Layer','Weight','Predictions',
    'Correct','Accuracy %','Sharpe','ROI %','Rewrites',
    'Last Rewrite','Delta','Blind Spots','Status','Last Updated'
  ],
  [SHEET_TABS.EQUITY]: [
    'Date','Session','Domain','Portfolio Value','Daily Return %',
    'Drawdown %','Regime','Top Agent','Notes'
  ],
  [SHEET_TABS.IMPROVEMENT]: [
    'Date','Agent ID','Agent Name','Domain','Old Prompt Hash',
    'New Prompt Hash','Old Score','New Score','Delta','Decision','Reason'
  ],
};

// ── Entry point ──
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const result = handleAction(data);
    return jsonResponse({ success: true, ...result });
  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

function doGet(e) {
  // Health check
  return jsonResponse({ status: 'SAGE Apps Script running', version: '1.0' });
}

function handleAction(data) {
  const ss = getSpreadsheet(data.sheetId);
  ensureAllTabs(ss);

  switch (data.action) {

    case 'append_trading':
      return appendRows(ss, SHEET_TABS.TRADING, data.rows);

    case 'append_sports':
      return appendRows(ss, SHEET_TABS.SPORTS, data.rows);

    case 'upsert_agent':
      return upsertAgent(ss, data.row);

    case 'append_equity':
      return appendRows(ss, SHEET_TABS.EQUITY, data.rows);

    case 'log_improvement':
      return appendRows(ss, SHEET_TABS.IMPROVEMENT, data.rows);

    case 'update_outcome_trading':
      return updateOutcome(ss, SHEET_TABS.TRADING, data.sessionId, data.ticker, data.outcome, data.returnPct);

    case 'update_outcome_sports':
      return updateOutcome(ss, SHEET_TABS.SPORTS, data.sessionId, data.pick, data.outcome, data.pnl);

    case 'sync_all_agents':
      return syncAllAgents(ss, data.agents);

    case 'health':
      return { status: 'ok', sheetId: data.sheetId };

    default:
      throw new Error('Unknown action: ' + data.action);
  }
}

// ── Get spreadsheet (use active if no ID given) ──
function getSpreadsheet(sheetId) {
  if (sheetId) return SpreadsheetApp.openById(sheetId);
  return SpreadsheetApp.getActiveSpreadsheet();
}

// ── Ensure all tabs exist with headers ──
function ensureAllTabs(ss) {
  for (const [tabName, headers] of Object.entries(HEADERS)) {
    let sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      sheet = ss.insertSheet(tabName);
      sheet.appendRow(headers);
      // Format header row
      const headerRange = sheet.getRange(1, 1, 1, headers.length);
      headerRange.setBackground('#1a2035');
      headerRange.setFontColor('#06b6d4');
      headerRange.setFontWeight('bold');
      headerRange.setFontSize(10);
      sheet.setFrozenRows(1);
    }
  }
}

// ── Append rows to a tab ──
function appendRows(ss, tabName, rows) {
  const sheet = ss.getSheetByName(tabName);
  if (!rows || !rows.length) return { rowsAdded: 0 };
  rows.forEach(row => sheet.appendRow(row));

  // Auto-resize columns for readability
  try { sheet.autoResizeColumns(1, Math.min(8, sheet.getLastColumn())); } catch(e) {}

  return { rowsAdded: rows.length };
}

// ── Upsert agent performance row (find by Agent ID, update or insert) ──
function upsertAgent(ss, row) {
  const sheet = ss.getSheetByName(SHEET_TABS.AGENTS);
  const data = sheet.getDataRange().getValues();
  const agentId = row[0];

  // Find existing row (skip header at index 0)
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(agentId)) {
      const range = sheet.getRange(i + 1, 1, 1, row.length);
      range.setValues([row]);
      // Color by weight
      colorWeightCell(sheet, i + 1, 5, parseFloat(row[4]));
      return { updated: true, row: i + 1 };
    }
  }

  // Not found — append
  sheet.appendRow(row);
  const newRow = sheet.getLastRow();
  colorWeightCell(sheet, newRow, 5, parseFloat(row[4]));
  return { inserted: true };
}

// ── Sync all agents at once ──
function syncAllAgents(ss, agents) {
  if (!agents?.length) return { synced: 0 };
  agents.forEach(row => upsertAgent(ss, row));
  return { synced: agents.length };
}

// ── Update outcome on an existing pick row ──
function updateOutcome(ss, tabName, sessionId, identifier, outcome, value) {
  const sheet = ss.getSheetByName(tabName);
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    // Match by session ID (col B = index 1) and ticker/pick (col E = index 4 or col I = index 8)
    if (String(row[1]) === String(sessionId) &&
        (String(row[4]) === String(identifier) || String(row[8]) === String(identifier))) {
      // Outcome column: col O (index 14 for trading), col P (index 15 for sports)
      const outCol = tabName === SHEET_TABS.TRADING ? 15 : 16;
      const valCol = tabName === SHEET_TABS.TRADING ? 16 : 17;
      sheet.getRange(i + 1, outCol).setValue(outcome);
      sheet.getRange(i + 1, valCol).setValue(value);

      // Color the row
      const color = outcome === 'win' ? '#0f2d1a' : '#2d0f0f';
      sheet.getRange(i + 1, 1, 1, sheet.getLastColumn()).setBackground(color);
      return { updated: true };
    }
  }
  return { updated: false, reason: 'Row not found' };
}

// ── Color weight cell by value ──
function colorWeightCell(sheet, row, col, weight) {
  try {
    const cell = sheet.getRange(row, col);
    if (weight >= 1.5) cell.setBackground('#0f2d1a').setFontColor('#22c55e');
    else if (weight <= 0.5) cell.setBackground('#2d0f0f').setFontColor('#ef4444');
    else cell.setBackground('#1a2035').setFontColor('#f59e0b');
  } catch(e) {}
}

// ── JSON response helper ──
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

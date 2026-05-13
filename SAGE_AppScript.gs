/**
 * ============================================================
 *  SAGE — Google Apps Script Integration
 *  Version: 2.0
 * ============================================================
 *
 *  HOW TO SET UP (do this once):
 *  ─────────────────────────────
 *  1. Open your Google Sheet (or create a new one at sheets.google.com)
 *  2. Click Extensions → Apps Script
 *  3. Delete any existing code, then paste this entire file
 *  4. Click File → Save (name it anything, e.g. "SAGE")
 *  5. Click Deploy → New deployment
 *     - Type: "Web app"
 *     - Execute as: "Me"
 *     - Who has access: "Anyone"  ← Required for SAGE to reach it
 *  6. Click Deploy → copy the Web App URL
 *  7. In SAGE → Settings → Integrations, paste that URL
 *
 *  SWITCHING DEVICES:
 *  ──────────────────
 *  Paste the same Web App URL in Settings on your new device.
 *  SAGE will automatically sync your picks from this sheet.
 *
 *  REFRESHING YOUR DEPLOYMENT (if you edit this script):
 *  ─────────────────────────────────────────────────────
 *  Deploy → Manage deployments → Edit → Version "New version" → Deploy
 * ============================================================
 */

// ── Sheet name constants ──
const TABS = {
  SPORTS:  'Sports Picks',
  TRADING: 'Trading Picks',
  AGENTS:  'Agent Performance',
  EQUITY:  'Equity Curve',
  LOG:     'Sync Log',
};

// ── Column headers for each tab ──
const HEADERS = {
  [TABS.SPORTS]: [
    'Date', 'Session ID', 'Source Agent', 'Sport', 'Game',
    'Event Date', 'Game Time', 'Bet Type', 'Pick',
    'Odds (American)', 'Implied Prob %', 'Confidence', 'Units',
    'Outcome', 'P&L (units)', 'Running ROI %', 'Agent Weight',
    'Reasoning', 'Agents in Agreement',
  ],
  [TABS.TRADING]: [
    'Date', 'Session ID', 'Agent', 'Layer',
    'Ticker', 'Action', 'Entry $', 'Target $', 'Stop $',
    'Confidence', 'Agent Weight', 'Thesis',
    'Timeframe', 'Outcome', 'Return %', 'Sharpe', 'Regime', 'Notes',
  ],
  [TABS.AGENTS]: [
    'Agent ID', 'Name', 'Domain', 'Layer',
    'Weight', 'Predictions', 'Correct', 'Accuracy %',
    'Sharpe', 'ROI %', 'Rewrites', 'Last Rewrite',
    'Weight Delta', 'Blind Spots', 'Status', 'Last Sync',
  ],
  [TABS.EQUITY]: [
    'Date', 'Session', 'Domain', 'Portfolio Value',
    'Daily Return %', 'Drawdown %', 'Regime', 'Top Agent', 'Notes',
  ],
  [TABS.LOG]: [
    'Timestamp', 'Action', 'Tab', 'Rows', 'Device', 'Status',
  ],
};

// ── Colors ──
const COLORS = {
  headerBg:    '#1e293b',  // dark slate
  headerText:  '#f8fafc',
  sports:      '#0f172a',
  trading:     '#0f172a',
  win:         '#dcfce7',
  loss:        '#fee2e2',
  altRow:      '#f8fafc',
};


// ════════════════════════════════════════════════════════════
//  SETUP — Run this once manually to create all tabs
// ════════════════════════════════════════════════════════════

/**
 * Creates all required tabs with headers and formatting.
 * Run this manually from the Apps Script editor (click Run → setupSAGE)
 * before deploying, or it runs automatically on first POST.
 */
function setupSAGE() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setName('SAGE — Sports & Trading Intelligence');

  for (const [tabName, headers] of Object.entries(HEADERS)) {
    let sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      sheet = ss.insertSheet(tabName);
    }

    // Only write headers if row 1 is empty
    const firstCell = sheet.getRange(1, 1).getValue();
    if (!firstCell) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      formatHeaderRow(sheet, headers.length);
    }

    // Freeze header row
    sheet.setFrozenRows(1);
    // Auto-resize columns
    sheet.autoResizeColumns(1, headers.length);
  }

  // Delete default "Sheet1" if it still exists and is empty
  const defaultSheet = ss.getSheetByName('Sheet1');
  if (defaultSheet && defaultSheet.getLastRow() <= 1) {
    try { ss.deleteSheet(defaultSheet); } catch(e) {}
  }

  SpreadsheetApp.flush();
  Logger.log('✅ SAGE setup complete — all tabs created.');
  SpreadsheetApp.getUi().alert('✅ SAGE setup complete!\n\nAll tabs created:\n' + Object.values(TABS).join('\n'));
}

function formatHeaderRow(sheet, numCols) {
  const headerRange = sheet.getRange(1, 1, 1, numCols);
  headerRange
    .setBackground(COLORS.headerBg)
    .setFontColor(COLORS.headerText)
    .setFontWeight('bold')
    .setFontSize(10);
}


// ════════════════════════════════════════════════════════════
//  WEB APP ENDPOINTS — doGet and doPost
// ════════════════════════════════════════════════════════════

/**
 * GET endpoint — used by SAGE to read picks for cross-device sync.
 * URL params: ?action=read&tab=Sports Picks&limit=100
 */
function doGet(e) {
  const params = e?.parameter || {};
  const action = params.action || 'read';
  const tab    = params.tab || TABS.SPORTS;
  const limit  = parseInt(params.limit || '100', 10);

  try {
    if (action === 'read') {
      const data = readRows(tab, limit);
      return jsonResponse({ success: true, tab, rows: data, count: data.length });
    }
    if (action === 'status') {
      return jsonResponse({ success: true, status: 'SAGE Apps Script online', tabs: Object.values(TABS) });
    }
    return jsonResponse({ success: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

/**
 * POST endpoint — used by SAGE to write picks, sessions, and agent data.
 * Body JSON: { action: "append", tab: "Sports Picks", rows: [[...],[...]] }
 */
function doPost(e) {
  let payload;
  try {
    payload = JSON.parse(e?.postData?.contents || '{}');
  } catch {
    return jsonResponse({ success: false, error: 'Invalid JSON payload' });
  }

  const { action, tab, rows, row } = payload;
  const device = e?.parameter?.device || 'unknown';

  try {
    // Ensure tabs exist on first write
    ensureTabsExist();

    if (action === 'append') {
      if (!tab || !rows) return jsonResponse({ success: false, error: 'tab and rows required' });
      const count = appendRows(tab, rows);
      writeLog('append', tab, count, device, 'ok');
      return jsonResponse({ success: true, action: 'append', tab, rowsAdded: count });
    }

    if (action === 'upsert_agent') {
      if (!row) return jsonResponse({ success: false, error: 'row required for upsert_agent' });
      upsertAgentRow(row);
      writeLog('upsert_agent', TABS.AGENTS, 1, device, 'ok');
      return jsonResponse({ success: true, action: 'upsert_agent' });
    }

    if (action === 'mark_outcome') {
      // payload: { action, tab, sessionId, identifier, outcome: "win"|"loss", pnl }
      const { sessionId, identifier, outcome, pnl } = payload;
      markOutcome(tab || TABS.SPORTS, sessionId, identifier, outcome, pnl);
      writeLog('mark_outcome', tab, 1, device, 'ok');
      return jsonResponse({ success: true, action: 'mark_outcome' });
    }

    return jsonResponse({ success: false, error: 'Unknown action: ' + action });

  } catch (err) {
    writeLog(action || 'unknown', tab || '?', 0, device, 'error: ' + err.message);
    return jsonResponse({ success: false, error: err.message });
  }
}


// ════════════════════════════════════════════════════════════
//  CORE SHEET OPERATIONS
// ════════════════════════════════════════════════════════════

function appendRows(tabName, rows) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(tabName);
  if (!sheet) {
    sheet = ss.insertSheet(tabName);
    const headers = HEADERS[tabName];
    if (headers) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      formatHeaderRow(sheet, headers.length);
      sheet.setFrozenRows(1);
    }
  }

  if (!rows || rows.length === 0) return 0;

  const lastRow = sheet.getLastRow();
  const numCols = Math.max(...rows.map(r => r.length));
  sheet.getRange(lastRow + 1, 1, rows.length, numCols).setValues(rows);

  // Apply alternating row colors for readability
  applyRowFormatting(sheet, lastRow + 1, rows.length, tabName);

  SpreadsheetApp.flush();
  return rows.length;
}

function applyRowFormatting(sheet, startRow, numRows, tabName) {
  for (let i = 0; i < numRows; i++) {
    const row = startRow + i;
    const rowRange = sheet.getRange(row, 1, 1, sheet.getLastColumn() || 1);
    const bg = (row % 2 === 0) ? COLORS.altRow : '#ffffff';
    rowRange.setBackground(bg);
  }
}

function readRows(tabName, limit) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) return [];

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const startRow = Math.max(2, lastRow - limit + 1);
  const numRows  = lastRow - startRow + 1;
  const numCols  = sheet.getLastColumn();

  const headerRow = sheet.getRange(1, 1, 1, numCols).getValues()[0];
  const dataRows  = sheet.getRange(startRow, 1, numRows, numCols).getValues();

  return dataRows.map(row =>
    Object.fromEntries(headerRow.map((h, i) => [h, row[i] ?? '']))
  );
}

function upsertAgentRow(row) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TABS.AGENTS);
  if (!sheet) { appendRows(TABS.AGENTS, [row]); return; }

  const agentId   = row[0];
  const lastRow   = sheet.getLastRow();
  const idColData = lastRow > 1
    ? sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat()
    : [];

  const existingIdx = idColData.findIndex(id => id === agentId);
  if (existingIdx >= 0) {
    const sheetRow = existingIdx + 2; // +2 for 1-indexed + header
    sheet.getRange(sheetRow, 1, 1, row.length).setValues([row]);
  } else {
    appendRows(TABS.AGENTS, [row]);
  }
}

function markOutcome(tabName, sessionId, identifier, outcome, pnl) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(tabName);
  if (!sheet || sheet.getLastRow() < 2) return;

  const numCols = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, numCols).getValues()[0];
  const outcomeCol = headers.findIndex(h => String(h).toLowerCase() === 'outcome') + 1;
  const pnlCol     = headers.findIndex(h => String(h).toLowerCase().includes('p&l')) + 1;
  const sessionCol = headers.findIndex(h => String(h).toLowerCase().includes('session')) + 1;
  const pickCol    = headers.findIndex(h => String(h).toLowerCase() === 'pick') + 1;

  if (!outcomeCol) return;

  const data    = sheet.getRange(2, 1, sheet.getLastRow() - 1, numCols).getValues();
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const matchSession = !sessionId || String(row[sessionCol - 1]) === String(sessionId);
    const matchPick    = !identifier || String(row[pickCol - 1]).toLowerCase().includes(identifier.toLowerCase());
    const alreadyMarked = row[outcomeCol - 1] !== '';

    if (matchSession && matchPick && !alreadyMarked) {
      const sheetRow = i + 2;
      sheet.getRange(sheetRow, outcomeCol).setValue(outcome === 'win' ? 'WIN ✅' : 'LOSS ❌');
      if (pnlCol && pnl !== undefined) {
        sheet.getRange(sheetRow, pnlCol).setValue(pnl);
      }
      // Color the row
      const rowRange = sheet.getRange(sheetRow, 1, 1, numCols);
      rowRange.setBackground(outcome === 'win' ? COLORS.win : COLORS.loss);
      break; // mark first unresolved match only
    }
  }
  SpreadsheetApp.flush();
}

function writeLog(action, tab, rows, device, status) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let logSheet = ss.getSheetByName(TABS.LOG);
    if (!logSheet) {
      logSheet = ss.insertSheet(TABS.LOG);
      logSheet.getRange(1, 1, 1, HEADERS[TABS.LOG].length).setValues([HEADERS[TABS.LOG]]);
      formatHeaderRow(logSheet, HEADERS[TABS.LOG].length);
      logSheet.setFrozenRows(1);
    }
    const lastRow = logSheet.getLastRow();
    logSheet.getRange(lastRow + 1, 1, 1, 6).setValues([[
      new Date().toISOString(), action, tab, rows, device, status
    ]]);
  } catch (e) {
    Logger.log('Log write error: ' + e.message);
  }
}

function ensureTabsExist() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  for (const [tabName, headers] of Object.entries(HEADERS)) {
    const existing = ss.getSheetByName(tabName);
    if (!existing) {
      const sheet = ss.insertSheet(tabName);
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      formatHeaderRow(sheet, headers.length);
      sheet.setFrozenRows(1);
    }
  }
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}


// ════════════════════════════════════════════════════════════
//  DASHBOARD FORMULAS — Add summary stats automatically
// ════════════════════════════════════════════════════════════

/**
 * Call this after setup to add a "Summary" tab with live stats.
 * Run manually: Extensions → Apps Script → Run → addSummaryDashboard
 */
function addSummaryDashboard() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let dash = ss.getSheetByName('📊 Summary');
  if (!dash) dash = ss.insertSheet('📊 Summary');
  ss.setActiveSheet(dash);
  ss.moveActiveSheet(1); // Put it first

  dash.clearContents();
  dash.clearFormats();

  const data = [
    ['SAGE Performance Summary', '', '', '', ''],
    ['Last updated:', '=NOW()', '', '', ''],
    ['', '', '', '', ''],
    ['─── SPORTS BETTING ───', '', '', '', ''],
    ['Total Picks', `=COUNTA('Sports Picks'!A2:A)`, '', 'Total Units Wagered', `=SUMIF('Sports Picks'!N2:N,"WIN ✅",'Sports Picks'!M2:M)+SUMIF('Sports Picks'!N2:N,"LOSS ❌",'Sports Picks'!M2:M)`],
    ['Wins', `=COUNTIF('Sports Picks'!N2:N,"WIN ✅")`, '', 'Net P&L (units)', `=SUMIF('Sports Picks'!N2:N,"WIN ✅",'Sports Picks'!O2:O)+SUMIF('Sports Picks'!N2:N,"LOSS ❌",'Sports Picks'!O2:O)`],
    ['Losses', `=COUNTIF('Sports Picks'!N2:N,"LOSS ❌")`, '', 'Win Rate', `=IFERROR(COUNTIF('Sports Picks'!N2:N,"WIN ✅")/COUNTIFS('Sports Picks'!N2:N,"WIN ✅",'Sports Picks'!N2:N,"WIN ✅")+COUNTIFS('Sports Picks'!N2:N,"LOSS ❌",'Sports Picks'!N2:N,"LOSS ❌"),0)`],
    ['', '', '', '', ''],
    ['─── TRADING ───', '', '', '', ''],
    ['Total Picks', `=COUNTA('Trading Picks'!A2:A)`, '', 'Avg Confidence', `=IFERROR(AVERAGE('Trading Picks'!J2:J),"—")`],
    ['Wins', `=COUNTIF('Trading Picks'!N2:N,"WIN ✅")`, '', '', ''],
    ['Losses', `=COUNTIF('Trading Picks'!N2:N,"LOSS ❌")`, '', '', ''],
    ['', '', '', '', ''],
    ['─── TOP AGENTS (Sports) ───', '', '', '', ''],
    ['Agent', 'Predictions', 'Accuracy %', 'ROI %', 'Weight'],
  ];

  dash.getRange(1, 1, data.length, 5).setValues(data);

  // Header formatting
  dash.getRange(1, 1).setFontSize(16).setFontWeight('bold');
  dash.getRange(4, 1).setFontWeight('bold').setFontColor('#3b82f6');
  dash.getRange(9, 1).setFontWeight('bold').setFontColor('#22c55e');
  dash.getRange(14, 1).setFontWeight('bold').setFontColor('#f59e0b');
  dash.getRange(15, 1, 1, 5)
    .setBackground(COLORS.headerBg)
    .setFontColor(COLORS.headerText)
    .setFontWeight('bold');

  // Pull top agents from Agent Performance tab
  const agentFormula = [
    [`='Agent Performance'!B2`, `='Agent Performance'!F2`, `='Agent Performance'!H2`, `='Agent Performance'!J2`, `='Agent Performance'!E2`],
    [`='Agent Performance'!B3`, `='Agent Performance'!F3`, `='Agent Performance'!H3`, `='Agent Performance'!J3`, `='Agent Performance'!E3`],
    [`='Agent Performance'!B4`, `='Agent Performance'!F4`, `='Agent Performance'!H4`, `='Agent Performance'!J4`, `='Agent Performance'!E4`],
    [`='Agent Performance'!B5`, `='Agent Performance'!F5`, `='Agent Performance'!H5`, `='Agent Performance'!J5`, `='Agent Performance'!E5`],
  ];
  dash.getRange(16, 1, agentFormula.length, 5).setValues(agentFormula);

  dash.autoResizeColumns(1, 5);
  SpreadsheetApp.flush();
  Logger.log('✅ Summary dashboard added.');
}


// ════════════════════════════════════════════════════════════
//  MENU — Adds a SAGE menu to the spreadsheet UI
// ════════════════════════════════════════════════════════════

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🧠 SAGE')
    .addItem('▶ Setup all tabs', 'setupSAGE')
    .addItem('📊 Add Summary Dashboard', 'addSummaryDashboard')
    .addSeparator()
    .addItem('🔁 Refresh column widths', 'refreshColumnWidths')
    .addItem('🗑️ Clear Sync Log', 'clearSyncLog')
    .addToUi();
}

function refreshColumnWidths() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  for (const tabName of Object.values(TABS)) {
    const sheet = ss.getSheetByName(tabName);
    if (sheet && sheet.getLastColumn() > 0) {
      sheet.autoResizeColumns(1, sheet.getLastColumn());
    }
  }
  Logger.log('Column widths refreshed.');
}

function clearSyncLog() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logSheet = ss.getSheetByName(TABS.LOG);
  if (!logSheet) return;
  const lastRow = logSheet.getLastRow();
  if (lastRow > 1) {
    logSheet.deleteRows(2, lastRow - 1);
  }
}

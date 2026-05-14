// integrations/sheets-bootstrap.js
// Safe placeholder so early login/profile code never crashes before sheets.js loads.

(() => {
  const existing = globalThis.SheetsClient || {};
  const noop = async () => {};
  var SheetsClient = globalThis.SheetsClient = {
    checkStatus: existing.checkStatus || (async () => ({ authorized: false, configured: false })),
    authorize: existing.authorize || (async () => false),
    appendViaAppsScript: existing.appendViaAppsScript || noop,
    loadSportsPicks: existing.loadSportsPicks || (async () => null),
    loadTradingPicks: existing.loadTradingPicks || (async () => null),
    logTradingSession: existing.logTradingSession || noop,
    logSportsSession: existing.logSportsSession || noop,
    logFreshOddsSnapshot: existing.logFreshOddsSnapshot || noop,
    syncAgentPerformance: existing.syncAgentPerformance || noop,
    logEquityPoint: existing.logEquityPoint || noop,
    overwriteRows: existing.overwriteRows || noop,
    markSportsOutcome: existing.markSportsOutcome || noop,
    getAppsScriptUrl: existing.getAppsScriptUrl || (() => ''),
    setAppsScriptUrl: existing.setAppsScriptUrl || (() => {}),
  };
})();

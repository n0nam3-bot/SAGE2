// data-feeds.js — Autonomous data fetching from free, no-auth sources
// Sources: ESPN (no key), Reddit (no key), The Odds API (free key), RSS2JSON (no key), FRED (free key)

const DataFeeds = (() => {

  const ESPN    = 'https://site.api.espn.com/apis/site/v2/sports';
  const ODDS    = 'https://api.the-odds-api.com/v4';
  const REDDIT  = 'https://www.reddit.com';
  const RSS2J   = 'https://api.rss2json.com/v1/api.json?rss_url=';
  const FRED    = 'https://api.stlouisfed.org/fred';
  const ALLORI  = 'https://api.allorigins.win/get?url=';

  function userTimeZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
  }

  // ── Safe fetch with timeout ──
  async function sf(url, timeout = 7000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    } catch (e) {
      clearTimeout(t);
      return null; // silent fail — feeds are best-effort
    }
  }

  const ODDS_CACHE_KEY = 'sage_odds_cache_v2';
  const ODDS_CACHE_TTL_MS = 30 * 60 * 1000;

  function readOddsCache() {
    try { const raw = localStorage.getItem(ODDS_CACHE_KEY); if (!raw) return null; const parsed = JSON.parse(raw); return parsed && typeof parsed === 'object' ? parsed : null; } catch { return null; }
  }
  function writeOddsCache(snapshot) { try { localStorage.setItem(ODDS_CACHE_KEY, JSON.stringify(snapshot)); } catch {} }
  function isFreshTimestamp(iso, maxAgeMs = ODDS_CACHE_TTL_MS) { if (!iso) return false; const ts = Date.parse(iso); return Number.isFinite(ts) && (Date.now() - ts) < maxAgeMs; }
  function normalizeOddPrice(price) { if (price == null || price === '') return null; const n = Number(String(price).replace(/[^\d+\-]/g, '')); return Number.isFinite(n) ? n : null; }


  function buildSportsDateLabel(pickedDate) {
    const d = new Date(`${pickedDate}T00:00:00`);
    if (Number.isNaN(d.getTime())) return 'Today';
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }

  function buildDateRange(pickedDate) {
    const base = new Date(`${pickedDate}T00:00:00`);
    if (Number.isNaN(base.getTime())) return {};
    const start = new Date(base);
    const end = new Date(base);
    end.setDate(end.getDate() + 1);
    return { from: start.toISOString(), to: end.toISOString() };
  }

  function getSportsDateList(pickedDate) {
    const base = new Date(`${pickedDate}T00:00:00`);
    if (Number.isNaN(base.getTime())) return [new Date().toISOString().slice(0, 10)];
    return [base.toISOString().slice(0, 10)];
  }

  // ── ESPN: Schedule for a sport on a specific date (YYYY-MM-DD optional) ──
  async function getESPNGames(sport, league, date = null) {
    const datePart = date ? `?dates=${String(date).replace(/-/g, '')}` : '';
    const d = await sf(`${ESPN}/${sport}/${league}/scoreboard${datePart}`);
    if (!d?.events?.length) return [];
    return d.events.map(e => {
      const comps = e.competitions?.[0];
      const home = comps?.competitors?.find(c => c.homeAway === 'home');
      const away = comps?.competitors?.find(c => c.homeAway === 'away');
      const start = new Date(e.date);
      const state = String(e.status?.type?.state || '').toLowerCase();
      const detail = e.status?.type?.detail || e.status?.type?.shortDetail || e.status?.type?.description || '';
      const time = Number.isFinite(start.getTime())
        ? start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: userTimeZone(), timeZoneName: 'short' })
        : '';
      const hasScheduledTime = !!time && !/tbd|tba|postponed|delayed/i.test(time);
      return {
        name: e.name,
        shortName: e.shortName,
        awayTeam: away?.team?.displayName || '',
        homeTeam: home?.team?.displayName || '',
        awayRecord: away?.records?.[0]?.summary || '',
        homeRecord: home?.records?.[0]?.summary || '',
        awayScore: away?.score,
        homeScore: home?.score,
        status: detail,
        statusState: state,
        isLive: state !== 'pre',
        hasScheduledTime,
        startTime: Number.isFinite(start.getTime()) ? start.toISOString() : '',
        time: detail && state !== 'pre' ? detail : time,
        venue: comps?.venue?.fullName || '',
      };
    });
  }

  // ── ESPN: Team news / injuries ──
  async function getESPNNews(sport, league) {
    const d = await sf(`${ESPN}/${sport}/${league}/news?limit=12`);
    if (!d?.articles?.length) return [];
    return d.articles.map(a => ({ headline: a.headline, description: a.description?.slice(0, 200) || '' }));
  }

  // ── The Odds API: Real moneylines, spreads, totals ──
  async function getLiveOdds(sportKey, apiKey, range = {}, options = {}) {
    const cacheKey = `${sportKey}|${range?.from || ''}|${range?.to || ''}`;
    const cached = readOddsCache();
    const cachedEntry = cached?.sports?.[cacheKey];

    if (cachedEntry && isFreshTimestamp(cachedEntry.fetchedAt)) {
      return { rows: cachedEntry.rows || [], fetchedAt: cachedEntry.fetchedAt, fromCache: true };
    }
    if (options.useCacheOnly) {
      return cachedEntry ? { rows: cachedEntry.rows || [], fetchedAt: cachedEntry.fetchedAt, fromCache: true } : null;
    }
    if (!apiKey) {
      return cachedEntry ? { rows: cachedEntry.rows || [], fetchedAt: cachedEntry.fetchedAt, fromCache: true } : null;
    }

    const params = new URLSearchParams({ apiKey, regions: 'us', markets: 'h2h,spreads,totals', oddsFormat: 'american', dateFormat: 'iso' });
    if (range?.from) params.set('commenceTimeFrom', range.from);
    if (range?.to) params.set('commenceTimeTo', range.to);
    const d = await sf(`${ODDS}/sports/${sportKey}/odds/?${params.toString()}`);
    if (!Array.isArray(d)) {
      return cachedEntry ? { rows: cachedEntry.rows || [], fetchedAt: cachedEntry.fetchedAt, fromCache: true } : null;
    }

    const rows = d.map(game => {
      const bm = game.bookmakers?.[0];
      if (!bm) return null;
      const h2h = bm.markets?.find(m => m.key === 'h2h');
      const spreads = bm.markets?.find(m => m.key === 'spreads');
      const totals = bm.markets?.find(m => m.key === 'totals');
      const homeML = normalizeOddPrice(h2h?.outcomes?.find(o => o.name === game.home_team)?.price);
      const awayML = normalizeOddPrice(h2h?.outcomes?.find(o => o.name === game.away_team)?.price);
      const homeSpread = spreads?.outcomes?.find(o => o.name === game.home_team);
      const total = totals?.outcomes?.[0]?.point != null ? Number(totals.outcomes[0].point) : null;
      return {
        home: game.home_team,
        away: game.away_team,
        commenceTime: game.commence_time,
        homeML: homeML != null ? (homeML > 0 ? `+${homeML}` : `${homeML}`) : null,
        awayML: awayML != null ? (awayML > 0 ? `+${awayML}` : `${awayML}`) : null,
        spread: homeSpread ? `${game.home_team} ${homeSpread.point > 0 ? '+' : ''}${homeSpread.point}` : null,
        total,
        book: bm.title,
      };
    }).filter(Boolean);

    const fetchedAt = new Date().toISOString();
    const nextCache = cached && typeof cached === 'object' ? cached : { sports: {} };
    nextCache.fetchedAt = fetchedAt;
    nextCache.sports = nextCache.sports || {};
    nextCache.sports[cacheKey] = { fetchedAt, rows };
    writeOddsCache(nextCache);

    if (options.persistFreshOdds && globalThis.SheetsClient?.logFreshOddsSnapshot) {
      globalThis.SheetsClient.logFreshOddsSnapshot({ sportKey, sportName: options.sportName || sportKey, fetchedAt, rows, range }).catch(() => {});
    }

    return { rows, fetchedAt, fromCache: false };
  }

  // ── Reddit: Hot posts from subreddit ──
  async function getRedditPosts(sub, limit = 12) {
    const d = await sf(`${REDDIT}/r/${sub}/hot.json?limit=${limit}&raw_json=1`);
    if (!d?.data?.children?.length) return [];
    return d.data.children
      .filter(p => !p.data.stickied && p.data.score > 10)
      .map(p => ({
        title: p.data.title,
        score: p.data.score,
        flair: p.data.link_flair_text || '',
        selftext: p.data.selftext?.slice(0, 250) || '',
        comments: p.data.num_comments,
      }));
  }

  // ── RSS via rss2json.com ──
  async function getRSS(feedUrl, count = 8) {
    const d = await sf(`${RSS2J}${encodeURIComponent(feedUrl)}&count=${count}`);
    if (!d?.items?.length) return [];
    return d.items.map(i => ({
      title: i.title,
      summary: i.description?.replace(/<[^>]*>/g, '').slice(0, 200) || '',
      date: i.pubDate,
    }));
  }

  // ── Yahoo Finance snapshot (via allorigins proxy) ──
  async function getYahooQuote(symbol) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=2d`;
    const d = await sf(`${ALLORI}${encodeURIComponent(url)}`);
    try {
      const parsed = JSON.parse(d?.contents || '{}');
      const meta = parsed?.chart?.result?.[0]?.meta;
      if (!meta) return null;
      return {
        symbol,
        price: meta.regularMarketPrice,
        prevClose: meta.previousClose,
        change: ((meta.regularMarketPrice - meta.previousClose) / meta.previousClose * 100).toFixed(2),
      };
    } catch { return null; }
  }

  // ── FRED: Latest value of an economic series ──
  async function getFRED(seriesId, apiKey) {
    if (!apiKey) return null;
    const d = await sf(`${FRED}/series/observations?series_id=${seriesId}&api_key=${apiKey}&sort_order=desc&limit=2&file_type=json`);
    return d?.observations?.[0]?.value || null;
  }

  // ═══════════════════════════════════════════════
  // BUILD TRADING CONTEXT — auto-assembled
  // ═══════════════════════════════════════════════
  async function buildTradingContext(keys = {}, userNotes = '') {
    const lines = [`Auto-fetched market data — ${new Date().toLocaleString()}\n`];
    const fetched = [];

    // ── Market indices (Yahoo Finance) ──
    const indices = [
      { sym: '%5EGSPC', name: 'S&P 500' },
      { sym: '%5ENDX', name: 'NASDAQ 100' },
      { sym: '%5EVIX', name: 'VIX' },
      { sym: 'GC%3DF', name: 'Gold' },
      { sym: 'CL%3DF', name: 'Crude Oil' },
    ];
    const quotes = await Promise.all(indices.map(({ sym, name }) =>
      getYahooQuote(sym).then(q => q ? `${name}: ${q.price} (${q.change > 0 ? '+' : ''}${q.change}%)` : null)
    ));
    const validQuotes = quotes.filter(Boolean);
    if (validQuotes.length) {
      lines.push('=== MARKET INDICES ===');
      validQuotes.forEach(q => lines.push(q));
      fetched.push('Market indices');
    }

    // ── FRED economic data ──
    if (keys.fred_key) {
      const [fedFunds, cpi, unemployment, dxy] = await Promise.all([
        getFRED('FEDFUNDS', keys.fred_key),
        getFRED('CPIAUCSL', keys.fred_key),
        getFRED('UNRATE', keys.fred_key),
        getFRED('DTWEXBGS', keys.fred_key),
      ]);
      if (fedFunds || cpi || unemployment) {
        lines.push('\n=== FRED ECONOMIC DATA ===');
        if (fedFunds) lines.push(`Fed Funds Rate: ${fedFunds}%`);
        if (cpi) lines.push(`CPI (latest): ${cpi}`);
        if (unemployment) lines.push(`Unemployment: ${unemployment}%`);
        if (dxy) lines.push(`US Dollar Index: ${dxy}`);
        fetched.push('FRED economic data');
      }
    }

    // ── Financial news RSS ──
    const newsFeeds = [
      { url: 'https://feeds.marketwatch.com/marketwatch/topstories/', name: 'MarketWatch' },
      { url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', name: 'CNBC Markets' },
      { url: 'https://feeds.reuters.com/reuters/businessNews', name: 'Reuters Business' },
      { url: 'https://feeds.bloomberg.com/markets/news.rss', name: 'Bloomberg Markets' },
    ];
    for (const { url, name } of newsFeeds) {
      const items = await getRSS(url, 6);
      if (items.length) {
        lines.push(`\n=== ${name} ===`);
        items.slice(0, 5).forEach(i => lines.push(`• ${i.title}${i.summary ? ': ' + i.summary : ''}`));
        fetched.push(name);
        break; // one news feed is enough to avoid rate limits
      }
    }

    // ── Reddit sentiment ──
    const wsbPosts = await getRedditPosts('wallstreetbets', 10);
    if (wsbPosts.length) {
      lines.push('\n=== r/wallstreetbets (hot) ===');
      wsbPosts.slice(0, 8).forEach(p => lines.push(`[${p.score}↑] ${p.title}`));
      fetched.push('r/wallstreetbets');
    }

    const stocksPosts = await getRedditPosts('stocks', 8);
    if (stocksPosts.length) {
      lines.push('\n=== r/stocks (hot) ===');
      stocksPosts.slice(0, 5).forEach(p => lines.push(`[${p.score}↑] ${p.title}`));
      fetched.push('r/stocks');
    }

    const investingPosts = await getRedditPosts('investing', 6);
    if (investingPosts.length) {
      lines.push('\n=== r/investing (hot) ===');
      investingPosts.slice(0, 4).forEach(p => lines.push(`[${p.score}↑] ${p.title}`));
      fetched.push('r/investing');
    }

    // ── User's additional notes ──
    if (userNotes?.trim()) {
      lines.push(`\n=== ADDITIONAL CONTEXT FROM USER ===\n${userNotes.trim()}`);
    }

    return {
      context: lines.join('\n'),
      sources: fetched,
      timestamp: new Date().toISOString(),
    };
  }

  // ═══════════════════════════════════════════════
  // BUILD SPORTS CONTEXT — auto-assembled
  // ═══════════════════════════════════════════════
  async function buildSportsContext(keys = {}, userNotes = '', options = {}) {
    const pickedDate = options.date || new Date().toISOString().slice(0, 10);
    const dateMode = 'day';
    const dateLabel = buildSportsDateLabel(pickedDate, dateMode);
    const range = buildDateRange(pickedDate, dateMode);
    const tz = userTimeZone();
    const prefs = options.sportsPreferences || {};
    const availableSports = {
      NFL: { label: 'NFL', espn: ['football', 'nfl'], odds: 'americanfootball_nfl', reddit: 'nfl', schedule: true, news: true },
      NBA: { label: 'NBA', espn: ['basketball', 'nba'], odds: 'basketball_nba', reddit: 'nba', schedule: true, news: true },
      MLB: { label: 'MLB', espn: ['baseball', 'mlb'], odds: 'baseball_mlb', reddit: 'baseball', schedule: true, news: true },
      NHL: { label: 'NHL', espn: ['hockey', 'nhl'], odds: 'icehockey_nhl', reddit: 'hockey', schedule: true, news: true },
      MMA: { label: 'MMA/UFC', espn: null, odds: 'mma_mixed_martial_arts', reddit: 'MMA', schedule: false, news: false },
    };
    const normalizeSportCode = value => {
      const raw = String(value ?? '').trim().toUpperCase();
      if (!raw) return '';
      if (raw === 'UFC' || raw === 'MMA/UFC' || raw.includes('MIXED MARTIAL')) return 'MMA';
      if (availableSports[raw]) return raw;
      if (/football/.test(raw)) return 'NFL';
      if (/basketball/.test(raw)) return 'NBA';
      if (/baseball/.test(raw)) return 'MLB';
      if (/hockey/.test(raw)) return 'NHL';
      if (/mma|ufc/.test(raw)) return 'MMA';
      return raw;
    };
    const selectedSports = (() => {
      const raw = Array.isArray(prefs.allowedSports) && prefs.allowedSports.length
        ? prefs.allowedSports
        : Object.keys(availableSports);
      const normalized = [...new Set(raw.map(normalizeSportCode).filter(code => availableSports[code]))];
      return normalized.length ? normalized : Object.keys(availableSports);
    })();
    const selectedSportLabels = selectedSports.map(code => availableSports[code]?.label || code).join(', ');
    const lines = [`Auto-fetched sports data — ${new Date().toLocaleString()}
User timezone: ${tz}
Selected date: ${dateLabel}
`];
    if (prefs && Object.keys(prefs).length) {
      const marketLabelMap = {
        moneyline: 'Moneyline',
        spread: 'Spread / run line / puck line',
        total: 'Totals',
        player_prop: 'Player props',
        game_prop: 'Game props',
        team_prop: 'Team props',
        special: 'Special / other props',
      };
      const selectedMarkets = Array.isArray(prefs.allowedMarkets) && prefs.allowedMarkets.length
        ? prefs.allowedMarkets.map(m => marketLabelMap[m] || m).join(', ')
        : 'All available';
      const profileLabel = {
        balanced: 'Balanced',
        conservative: 'Conservative',
        positive_only: 'Positive odds only',
        lotto: 'Lotto / high-upside',
      }[prefs.oddsProfile] || 'Balanced';
      lines.push(`=== USER-SELECTED PREFERENCES ===`);
      lines.push(`Risk profile: ${profileLabel}`);
      lines.push(`Target pick count: ${Math.max(1, Math.min(20, Number(prefs.pickCount) || 5))}`);
      lines.push(`Allowed bet types: ${selectedMarkets}`);
      lines.push(`Selected sports: ${selectedSportLabels || 'All available'}`);
    }
    const fetched = [];
    const oddsKey = keys.odds_api_key;

    const uniqueBy = (items, keyFn) => {
      const seen = new Set();
      return items.filter(item => {
        const key = keyFn(item);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };

    const upcomingOnly = games => (Array.isArray(games) ? games : []).filter(g => {
      const startMs = g.startTime ? Date.parse(g.startTime) : NaN;
      const hasValidTime = !!g.hasScheduledTime && !!g.time && !/tbd|tba|postponed|delayed|live|in progress|final/i.test(String(g.time));
      const preGame = String(g.statusState || 'pre').toLowerCase() === 'pre';
      return preGame && !!g.awayTeam && !!g.homeTeam && hasValidTime && Number.isFinite(startMs) && startMs > Date.now();
    });

    const scheduleData = {};

    // ── ESPN schedules — only the sports the user selected ──
    for (const sportCode of selectedSports) {
      const cfg = availableSports[sportCode];
      if (!cfg?.schedule || !Array.isArray(cfg.espn)) {
        scheduleData[sportCode] = [];
        continue;
      }
      const [espnSport, espnLeague] = cfg.espn;
      const gamesByDate = await Promise.all(getSportsDateList(pickedDate, dateMode).map(async day => getESPNGames(espnSport, espnLeague, day)));
      const allGames = uniqueBy(gamesByDate.flat(), g => `${g.shortName || g.name || ''}|${g.awayTeam}|${g.homeTeam}|${g.time}`);
      const upcomingGames = upcomingOnly(allGames);
      scheduleData[sportCode] = upcomingGames;
      if (!upcomingGames.length) continue;
      lines.push(`
=== ${cfg.label} SCHEDULE (${dateLabel}) ===`);
      upcomingGames.forEach(g => {
        const record = g.awayRecord && g.homeRecord ? ` (${g.awayRecord} vs ${g.homeRecord})` : '';
        const when = g.time || 'TBD';
        lines.push(`${g.awayTeam} @ ${g.homeTeam}${record} — ${when}`);
      });
      fetched.push(`${cfg.label} schedule`);
    }

    // ── Real odds from The Odds API ──
    if (oddsKey) {
      for (const sportCode of selectedSports) {
        const cfg = availableSports[sportCode];
        if (!cfg?.odds) continue;
        const oddsResult = await getLiveOdds(cfg.odds, oddsKey, range, { useCacheOnly: !options.activeScreen, persistFreshOdds: !!options.activeScreen, sportName: cfg.label });
        const odds = oddsResult?.rows || [];
        if (!odds.length) continue;
        lines.push(`
=== ${cfg.label} LIVE ODDS (${dateLabel}) ===`);
        odds.slice(0, 8).forEach(g => {
          const time = g.commenceTime ? new Date(g.commenceTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: userTimeZone(), timeZoneName: 'short' }) : '';
          const ml = `${g.away} (${g.awayML ?? '—'}) @ ${g.home} (${g.homeML ?? '—'})`;
          const spread = g.spread ? ` | Spread: ${g.spread}` : '';
          const total = g.total != null ? ` | O/U: ${g.total}` : '';
          lines.push(`${ml}${spread}${total}${time ? ' — ' + time : ''} [${g.book}]`);
        });
        fetched.push(`${cfg.label} odds${oddsResult?.fromCache ? ' (cache)' : ''}`);
      }
    } else {
      lines.push(`
=== ODDS NOTE ===
No Odds API key set — add a free key from the-odds-api.com in Profile to get real moneylines, spreads, and totals. The system will still analyze matchups using schedules above.`);
    }

    // ── ESPN team news & injuries ──
    const newsFetches = selectedSports.filter(code => availableSports[code]?.news).map(async code => {
      const cfg = availableSports[code];
      const [espnSport, espnLeague] = cfg.espn || [];
      if (!espnSport || !espnLeague) return { code, news: [], label: cfg.label };
      const news = await getESPNNews(espnSport, espnLeague);
      return { code, news, label: cfg.label };
    });
    const newsResults = await Promise.all(newsFetches);
    for (const { news, label } of newsResults) {
      if (!news.length) continue;
      const injuryNews = news.filter(n => /injur|out|questionable|scratch|ruled|doubt|miss|return/i.test(n.headline));
      if (injuryNews.length) {
        lines.push(`
=== ${label} INJURY / ROSTER NEWS ===`);
        injuryNews.slice(0, 5).forEach(n => lines.push(`• ${n.headline}${n.description ? ' — ' + n.description : ''}`));
        fetched.push(`${label} injury news`);
      }
    }

    // ── Reddit injury & analysis threads ──
    const sportsReddits = selectedSports
      .map(code => ({ sub: availableSports[code]?.reddit, sport: availableSports[code]?.label || code }))
      .filter(item => item.sub);

    for (const { sub } of sportsReddits) {
      const posts = await getRedditPosts(sub, 10);
      const relevant = posts.filter(p =>
        /injur|out|questionable|scratch|ruled|doubt|starter|lineup|preview|matchup|odds/i.test(p.title + p.flair)
      );
      if (relevant.length) {
        lines.push(`
=== r/${sub} — Injury & Game News ===`);
        relevant.slice(0, 5).forEach(p => lines.push(`[${p.score}↑] ${p.title}`));
        fetched.push(`r/${sub}`);
      }
    }

    // ── User's additional notes ──
    if (userNotes?.trim()) {
      lines.push(`
=== ADDITIONAL NOTES FROM USER ===
${userNotes.trim()}`);
    }

    return {
      context: lines.join('\n'),
      scheduleData,
      sources: fetched,
      hasOdds: !!oddsKey,
      selectedDate: pickedDate,
      dateMode,
      dateLabel,
      range,
      timestamp: new Date().toISOString(),
    };
  }


  return {
    buildTradingContext,
    buildSportsContext,
    getESPNGames,
    getRedditPosts,
    getRSS,
    getLiveOdds,
  };
})();

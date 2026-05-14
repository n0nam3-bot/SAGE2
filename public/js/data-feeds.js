// data-feeds.js — Autonomous data fetching from free, no-auth sources
// Sources: ESPN (no key), Reddit (no key), The Odds API (free key), RSS2JSON (no key), FRED (free key)

const DataFeeds = (() => {

  const ESPN    = 'https://site.api.espn.com/apis/site/v2/sports';
  const ODDS    = 'https://api.the-odds-api.com/v4';
  const REDDIT  = 'https://www.reddit.com';
  const RSS2J   = 'https://api.rss2json.com/v1/api.json?rss_url=';
  const FRED    = 'https://api.stlouisfed.org/fred';
  const ALLORI  = 'https://api.allorigins.win/get?url=';

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


  function buildSportsDateLabel(pickedDate, mode) {
    const d = new Date(`${pickedDate}T00:00:00`);
    if (Number.isNaN(d.getTime())) return 'Today';
    if (mode === 'week') {
      const start = startOfWeekSunday(d);
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      return `Week of ${start.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} – ${end.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;
    }
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }

  function startOfWeekSunday(date) {
    const d = new Date(date);
    const day = d.getDay();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - day);
    return d;
  }

  function buildDateRange(pickedDate, mode) {
    const base = new Date(`${pickedDate}T00:00:00`);
    if (Number.isNaN(base.getTime())) return {};
    let start = base;
    let end = new Date(base);
    if (mode === 'week') {
      start = startOfWeekSunday(base);
      end = new Date(start);
      end.setDate(end.getDate() + 7);
    } else {
      end.setDate(end.getDate() + 1);
    }
    return { from: start.toISOString(), to: end.toISOString() };
  }

  // ── ESPN: Today's schedule for a sport ──
  async function getESPNGames(sport, league) {
    const d = await sf(`${ESPN}/${sport}/${league}/scoreboard`);
    if (!d?.events?.length) return [];
    return d.events.map(e => {
      const comps = e.competitions?.[0];
      const home = comps?.competitors?.find(c => c.homeAway === 'home');
      const away = comps?.competitors?.find(c => c.homeAway === 'away');
      const time = new Date(e.date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
      return {
        name: e.name,
        shortName: e.shortName,
        awayTeam: away?.team?.displayName || '',
        homeTeam: home?.team?.displayName || '',
        awayRecord: away?.records?.[0]?.summary || '',
        homeRecord: home?.records?.[0]?.summary || '',
        awayScore: away?.score,
        homeScore: home?.score,
        status: e.status?.type?.description || '',
        time,
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
  async function getLiveOdds(sportKey, apiKey, range = {}) {
    if (!apiKey) return null;
    const params = new URLSearchParams({ apiKey, regions: 'us', markets: 'h2h,spreads,totals', oddsFormat: 'american', dateFormat: 'iso' });
    if (range?.from) params.set('commenceTimeFrom', range.from);
    if (range?.to) params.set('commenceTimeTo', range.to);
    const d = await sf(`${ODDS}/sports/${sportKey}/odds/?${params.toString()}`);
    if (!Array.isArray(d)) return null;
    return d.map(game => {
      const bm = game.bookmakers?.[0];
      if (!bm) return null;
      const h2h     = bm.markets?.find(m => m.key === 'h2h');
      const spreads = bm.markets?.find(m => m.key === 'spreads');
      const totals  = bm.markets?.find(m => m.key === 'totals');
      const homeML  = h2h?.outcomes?.find(o => o.name === game.home_team)?.price;
      const awayML  = h2h?.outcomes?.find(o => o.name === game.away_team)?.price;
      const homeSpread = spreads?.outcomes?.find(o => o.name === game.home_team);
      const total   = totals?.outcomes?.[0]?.point;
      return {
        home: game.home_team, away: game.away_team,
        commenceTime: game.commence_time,
        homeML: homeML != null ? (homeML > 0 ? `+${homeML}` : `${homeML}`) : null,
        awayML: awayML != null ? (awayML > 0 ? `+${awayML}` : `${awayML}`) : null,
        spread: homeSpread ? `${game.home_team} ${homeSpread.point > 0 ? '+' : ''}${homeSpread.point}` : null,
        total,
        book: bm.title,
      };
    }).filter(Boolean);
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
    const dateMode = options.mode === 'week' ? 'week' : 'day';
    const dateLabel = buildSportsDateLabel(pickedDate, dateMode);
    const range = buildDateRange(pickedDate, dateMode);
    const lines = [`Auto-fetched sports data — ${new Date().toLocaleString()}\nSelected range: ${dateLabel}\n`];
    const fetched = [];
    const oddsKey = keys.odds_api_key;

    // ── ESPN schedules — all sports simultaneously ──
    const [nflGames, nbaGames, mlbGames, nhlGames] = await Promise.all([
      getESPNGames('football', 'nfl'),
      getESPNGames('basketball', 'nba'),
      getESPNGames('baseball', 'mlb'),
      getESPNGames('hockey', 'nhl'),
    ]);

    const scheduleMap = [
      { games: nflGames, name: 'NFL' },
      { games: nbaGames, name: 'NBA' },
      { games: mlbGames, name: 'MLB' },
      { games: nhlGames, name: 'NHL' },
    ];

    let hasSchedule = false;
    for (const { games, name } of scheduleMap) {
      if (!games.length) continue;
      hasSchedule = true;
      lines.push(`\n=== ${name} SCHEDULE (${dateLabel}) ===`);
      games.forEach(g => {
        const record = g.awayRecord && g.homeRecord ? ` (${g.awayRecord} vs ${g.homeRecord})` : '';
        const score = g.awayScore != null ? ` — Score: ${g.awayScore}-${g.homeScore} (${g.status})` : ` — ${g.time}`;
        lines.push(`${g.awayTeam} @ ${g.homeTeam}${record}${score}`);
      });
      fetched.push(`${name} schedule`);
    }

    // ── Real odds from The Odds API ──
    if (oddsKey) {
      const oddsSports = [
        { key: 'americanfootball_nfl', name: 'NFL' },
        { key: 'basketball_nba', name: 'NBA' },
        { key: 'baseball_mlb', name: 'MLB' },
        { key: 'icehockey_nhl', name: 'NHL' },
        { key: 'mma_mixed_martial_arts', name: 'MMA/UFC' },
      ];
      for (const { key, name } of oddsSports) {
        const odds = await getLiveOdds(key, oddsKey, range);
        if (!odds?.length) continue;
        lines.push(`\n=== ${name} LIVE ODDS (${dateLabel}) ===`);
        odds.slice(0, 8).forEach(g => {
          const time = g.commenceTime ? new Date(g.commenceTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }) : '';
          const ml = `${g.away} (${g.awayML}) @ ${g.home} (${g.homeML})`;
          const spread = g.spread ? ` | Spread: ${g.spread}` : '';
          const total = g.total ? ` | O/U: ${g.total}` : '';
          lines.push(`${ml}${spread}${total}${time ? ' — ' + time : ''} [${g.book}]`);
        });
        fetched.push(`${name} odds`);
      }
    } else {
      lines.push('\n=== ODDS NOTE ===\nNo Odds API key set — add a free key from the-odds-api.com in Profile to get real moneylines, spreads, and totals. The system will still analyze matchups using schedules above.');
    }

    // ── ESPN team news & injuries ──
    const [nflNews, nbaNews, mlbNews, nhlNews] = await Promise.all([
      getESPNNews('football', 'nfl'),
      getESPNNews('basketball', 'nba'),
      getESPNNews('baseball', 'mlb'),
      getESPNNews('hockey', 'nhl'),
    ]);

    const newsMap = [
      { news: nflNews, name: 'NFL' },
      { news: nbaNews, name: 'NBA' },
      { news: mlbNews, name: 'MLB' },
      { news: nhlNews, name: 'NHL' },
    ];

    for (const { news, name } of newsMap) {
      if (!news.length) continue;
      const injuryNews = news.filter(n =>
        /injur|out|questionable|scratch|ruled|doubt|miss|return/i.test(n.headline)
      );
      if (injuryNews.length) {
        lines.push(`\n=== ${name} INJURY / ROSTER NEWS ===`);
        injuryNews.slice(0, 5).forEach(n => lines.push(`• ${n.headline}${n.description ? ' — ' + n.description : ''}`));
        fetched.push(`${name} injury news`);
      }
    }

    // ── Reddit injury & analysis threads ──
    const sportsReddits = [
      { sub: 'nfl', sport: 'NFL' },
      { sub: 'nba', sport: 'NBA' },
      { sub: 'baseball', sport: 'MLB' },
      { sub: 'hockey', sport: 'NHL' },
      { sub: 'MMA', sport: 'MMA' },
    ];

    for (const { sub, sport } of sportsReddits) {
      const posts = await getRedditPosts(sub, 10);
      const relevant = posts.filter(p =>
        /injur|out|questionable|scratch|ruled|doubt|starter|lineup|preview|matchup|odds/i.test(p.title + p.flair)
      );
      if (relevant.length) {
        lines.push(`\n=== r/${sub} — Injury & Game News ===`);
        relevant.slice(0, 5).forEach(p => lines.push(`[${p.score}↑] ${p.title}`));
        fetched.push(`r/${sub}`);
      }
    }

    // ── User's additional notes ──
    if (userNotes?.trim()) {
      lines.push(`\n=== ADDITIONAL NOTES FROM USER ===\n${userNotes.trim()}`);
    }

    return {
      context: lines.join('\n'),
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

/*
 * Parser for "Trade With Mordy" #recaps Discord channel exports.
 * Works on the raw HTML you get from saving/exporting the channel
 * (View Source / Save As, or a scraped chat-log export) OR on plain
 * text copy-pasted straight out of Discord.
 *
 * Exposed as window.MordyParser = { parseRecapText, computeStats, dedupeKey }
 */
(function (global) {
  'use strict';

  function decodeEntities(str) {
    return str
      .replace(/&gt;/g, '>')
      .replace(/&lt;/g, '<')
      .replace(/&amp;/g, '&')
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&nbsp;/g, ' ');
  }

  function toFlatText(raw) {
    // Discord custom emojis arrive as <:name:id> or <a:name:id> (animated).
    // Preserve the :name: part BEFORE stripping all HTML tags so that
    // truncation markers like :GIFCryptoRiseUp: still work after stripping.
    let text = raw.replace(/<a?:([A-Za-z0-9_]+):\d+>/g, ':$1:');
    // Convert structural HTML elements to spaces/breaks before stripping tags
    text = text.replace(/<\/?(?:div|p|br|hr|tr|li)[^>]*>/gi, ' \n ');
    text = text.replace(/<[^>]+>/g, ' ');
    text = decodeEntities(text);
    text = text.replace(/[*`~]/g, '');
    text = text.replace(/[—\-]{3,}/g, ' ');
    text = text.replace(/\s+/g, ' ');
    return text;
  }

  const MONTHS = {
    JANUARY: '01', FEBRUARY: '02', MARCH: '03', APRIL: '04', MAY: '05', JUNE: '06',
    JULY: '07', AUGUST: '08', SEPTEMBER: '09', OCTOBER: '10', NOVEMBER: '11', DECEMBER: '12'
  };

  function parseDateLabel(label) {
    // Supports "AUGUST 20, 2026" as well as "14 SEPTEMBER, 2026" / "14 SEPTEMBER 2026"
    const clean = label.trim().toUpperCase().replace(/,/g, '');
    let m = clean.match(/^([A-Z]+)\s+(\d+)\s+(\d+)$/);
    if (m) {
      const month = MONTHS[m[1]];
      if (!month) return null;
      return `${m[3]}-${month}-${String(m[2]).padStart(2, '0')}`;
    }
    m = clean.match(/^(\d+)\s+([A-Z]+)\s+(\d+)$/);
    if (m) {
      const month = MONTHS[m[2]];
      if (!month) return null;
      return `${m[3]}-${month}-${String(m[1]).padStart(2, '0')}`;
    }
    return null;
  }

  const DAY_HEADER_RE = /(?:SHOWTIME\s*TRADES|TRADE WITH MORDY|MR\.?\s*SWINGER)?\s*DAILY RECAP\s*\|\s*([A-Za-z0-9, ]+?\d{4})/gi;
  const CALL_HEADER_RE = /([A-Za-z0-9 ._♛]+?)\s+CALLS:/gi;
  const TRADE_FULL_RE = /(🟩|🟥)\s*\$([A-Za-z0-9]+)\s*-?\s*([^\-]*?)@\s*([\d.]+)\s*-->\s*([\d.]+)\s*\|\s*([+-]?[\d,]+\.\d+)%\s*\|\s*(-?\$?[\d,]+\.\d+)/gu;
  const TRADE_NODOLLAR_RE = /(🟩|🟥)\s*\$([A-Za-z0-9]+)\s*-?\s*([^\-]*?)@\s*([\d.]+)\s*-->\s*([\d.]+)\s*\|\s*([+-]?[\d,]+\.\d+)%/gu;
  const TRADE_BARE_RE = /(🟩|🟥)\s*\$([A-Za-z0-9]+)\s*[^|🟩🟥🟨]*?\|\s*([+-]?[\d,]+(?:\.\d+)?)%/gu;
  const TRADE_SHOWTIME_PCT_RE = /(🟩|🟥|🟨)\s*(?:\$([A-Za-z0-9]+)|([A-Za-z0-9]+))\b[^|🟩🟥🟨\n]*?\|\s*([+-]?[\d,]+(?:\.\d+)?)%/gu;
  const TRADE_SHOWTIME_TEXT_RE = /(🟩|🟥|🟨)\s*(?:\$([A-Za-z0-9]+)|([A-Za-z0-9]+))\b[^🟩🟥🟨\n]*/gu;

  const KNOWN_ANALYSTS = [
    'BRAD INVESTMENTS', 'SHAI INVESTMENTS', 'ISRAEL INVESTMENTS',
    'TAKINGFEES', 'ZONATRADES', 'SHOWTIME', 'LINK'
  ];

  function cleanAnalystName(raw) {
    const s = String(raw).replace(/[♛*:`_]/g, '').trim().toUpperCase();
    for (const a of KNOWN_ANALYSTS) {
      if (s.includes(a)) return a;
    }
    return s;
  }

  // Format 1 (Mordy / Standard Swinger): Total Trades: 9 Today's Winrate: 66.67% Total Gains: +335.01% ...
  const FOOTER_STD_RE = /Total Trades:\s*(\d+)\s*Today'?s Win\s*rate:\s*([\d.]+)%\s*Total Gains:\s*([+-]?[\d,]+\.\d+)%\s*Average Gains Per Call:\s*([+-]?[\d,]+\.\d+)%\s*Total Profits:\s*(-?\$?[\d,]+\.\d+)/i;
  // Format 2 (Swinger variant): Wins: 11 / Losses: 0 Win-rate: 100% Gains: +2,015.00% · Avg. Gains: +183.18% Profits (Per Con): $5,040.15
  const FOOTER_ALT_RE = /Wins:\s*(\d+)\s*\/\s*Losses:\s*(\d+)\s*Win-?rate:\s*([\d.]+)%\s*Gains:\s*([+-]?[\d,]+\.\d+)%\s*·?\s*Avg\.?\s*Gains:\s*([+-]?[\d,]+\.\d+)%\s*Profits\s*(?:\([^)]*\))?:\s*(-?\$?[\d,]+\.\d+)/i;
  // Format 3 (Swinger variant): 7 Trades | 4 Wins - 3 Losses | 57.14% Win-rate +790.61% Gains | +112.94% Avg. Gains (Per Trade) | $2,445.25 Profits (Per Con)
  const FOOTER_3_RE = /(\d+)\s*Trades\s*\|\s*(\d+)\s*Wins\s*-\s*(\d+)\s*Losses\s*\|\s*([\d.]+)%\s*Win-?rate\s*([+-]?[\d,]+\.\d+)%\s*Gains\s*\|\s*([+-]?[\d,]+\.\d+)%\s*Avg\.?\s*Gains(?:\s*\([^)]*\))?\s*\|\s*(-?\$?[\d,]+\.\d+)\s*Profits/i;

  function parseFooterSummary(chunk, dateIso) {
    let m = chunk.match(FOOTER_STD_RE);
    if (m) {
      return {
        date: dateIso,
        totalTrades: parseInt(m[1], 10),
        winRate: num(m[2]),
        totalGainsPct: num(m[3]),
        avgGainsPct: num(m[4]),
        totalProfit: num(m[5])
      };
    }
    m = chunk.match(FOOTER_ALT_RE);
    if (m) {
      return {
        date: dateIso,
        totalTrades: parseInt(m[1], 10) + parseInt(m[2], 10),
        winRate: num(m[3]),
        totalGainsPct: num(m[4]),
        avgGainsPct: num(m[5]),
        totalProfit: num(m[6])
      };
    }
    m = chunk.match(FOOTER_3_RE);
    if (m) {
      return {
        date: dateIso,
        totalTrades: parseInt(m[1], 10),
        winRate: num(m[4]),
        totalGainsPct: num(m[5]),
        avgGainsPct: num(m[6]),
        totalProfit: num(m[7])
      };
    }
    return null;
  }

  const TRUNCATE_MARKERS = [
    ':GIFCryptoRiseUp:', 'PLAY OF THE DAY', 'TOP PLAY:', 'Total Trades:',
    'UNLOCK PREMIUM', 'Unlock All Our Trading', 'Wins:', 'Trades |'
  ];

  function num(str) {
    return parseFloat(String(str).replace(/\$/g, '').replace(/,/g, ''));
  }

  function splitDays(text) {
    const matches = [];
    let m;
    const re = new RegExp(DAY_HEADER_RE);
    while ((m = re.exec(text)) !== null) {
      matches.push({ index: m.index, label: m[1] });
    }
    const days = [];
    for (let i = 0; i < matches.length; i++) {
      const start = matches[i].index;
      const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
      days.push({ dateLabel: matches[i].label, chunk: text.slice(start, end) });
    }
    return days;
  }

  function truncateAt(str) {
    let cut = str.length;
    for (const marker of TRUNCATE_MARKERS) {
      const idx = str.indexOf(marker);
      if (idx !== -1 && idx < cut) cut = idx;
    }
    return str.slice(0, cut);
  }

  function markConsumed(consumed, start, end) {
    for (let i = start; i < end; i++) consumed[i] = true;
  }

  function blankConsumed(str, consumed) {
    let out = '';
    for (let i = 0; i < str.length; i++) out += consumed[i] ? ' ' : str[i];
    return out;
  }

  function parseAnalystChunk(sub, dateIso, analyst, trades) {
    const consumed = new Array(sub.length).fill(false);
    let parsedCount = 0;

    let m;
    // Tier 1: Full dollar regex ($TICKER @ entry --> exit | +pct% | $dollar)
    const fullRe = new RegExp(TRADE_FULL_RE);
    while ((m = fullRe.exec(sub)) !== null) {
      const [, marker, ticker, , entry, exitp, pct, dollar] = m;
      trades.push({
        date: dateIso, analyst, ticker: ticker.toUpperCase(),
        win: marker === '🟩',
        entry: num(entry), exit: num(exitp),
        pct: num(pct), dollar: num(dollar)
      });
      parsedCount += 1;
      markConsumed(consumed, m.index, m.index + m[0].length);
    }

    // Tier 2: No-dollar ($TICKER @ entry --> exit | +pct%)
    let remaining = blankConsumed(sub, consumed);
    const noDollarRe = new RegExp(TRADE_NODOLLAR_RE);
    while ((m = noDollarRe.exec(remaining)) !== null) {
      const [, marker, ticker, , entry, exitp, pct] = m;
      trades.push({
        date: dateIso, analyst, ticker: ticker.toUpperCase(),
        win: marker === '🟩',
        entry: num(entry), exit: num(exitp),
        pct: num(pct), dollar: Math.round(num(pct) * 100) / 100
      });
      parsedCount += 1;
      markConsumed(consumed, m.index, m.index + m[0].length);
    }

    // Tier 3: Bare format ($TICKER | +pct%)
    let remaining2 = blankConsumed(sub, consumed);
    const bareRe = new RegExp(TRADE_BARE_RE);
    while ((m = bareRe.exec(remaining2)) !== null) {
      const [, marker, ticker, pct] = m;
      trades.push({
        date: dateIso, analyst, ticker: ticker.toUpperCase(),
        win: marker === '🟩',
        entry: null, exit: null,
        pct: num(pct), dollar: Math.round(num(pct) * 100) / 100
      });
      parsedCount += 1;
      markConsumed(consumed, m.index, m.index + m[0].length);
    }

    // Tier 4: Showtime format with %
    let remaining3 = blankConsumed(sub, consumed);
    const stPctRe = new RegExp(TRADE_SHOWTIME_PCT_RE);
    while ((m = stPctRe.exec(remaining3)) !== null) {
      const marker = m[1];
      const ticker = (m[2] || m[3] || 'CALL').toUpperCase();
      const pct = num(m[4]);
      const chunkText = m[0];
      const prices = chunkText.match(/@\s*\$?([\d.]+)/g) || [];
      const entry = prices.length ? num(prices[0].replace(/@\s*\$?/, '')) : null;
      trades.push({
        date: dateIso, analyst, ticker,
        win: marker === '🟩' || pct > 0,
        entry, exit: null,
        pct, dollar: Math.round(pct * 100) / 100
      });
      parsedCount += 1;
      markConsumed(consumed, m.index, m.index + m[0].length);
    }

    // Tier 5: Showtime format with descriptive outcome (loss, breakeven, small gain, trim)
    let remaining4 = blankConsumed(sub, consumed);
    const stTextRe = new RegExp(TRADE_SHOWTIME_TEXT_RE);
    while ((m = stTextRe.exec(remaining4)) !== null) {
      const marker = m[1];
      const ticker = (m[2] || m[3] || 'CALL').toUpperCase();
      const lineText = m[0].toLowerCase();
      let pct = 0;
      let win = false;
      if (lineText.includes('small gain') || lineText.includes('gain') || lineText.includes('tp hit')) {
        pct = 15; win = true;
      } else if (lineText.includes('loss') || lineText.includes('stop out') || lineText.includes('stop loss')) {
        pct = -20; win = false;
      } else if (lineText.includes('breakeven') || lineText.includes('be exit') || lineText.includes('at be')) {
        pct = 0; win = false;
      } else if (marker === '🟩') {
        pct = 20; win = true;
      } else if (marker === '🟥') {
        pct = -20; win = false;
      } else {
        pct = 0; win = false;
      }
      trades.push({
        date: dateIso, analyst, ticker,
        win,
        entry: null, exit: null,
        pct, dollar: Math.round(pct * 100) / 100
      });
      parsedCount += 1;
      markConsumed(consumed, m.index, m.index + m[0].length);
    }

    const markerCount = (sub.match(/🟩|🟥|🟨/gu) || []).length;
    return { markerCount, parsedCount };
  }

  function parseRecapText(rawInput) {
    const text = toFlatText(rawInput);
    const days = splitDays(text);
    const trades = [];
    const dailySummaries = [];
    const unparsedWarnings = []; // {date, analyst, markerCount, parsedCount} where they differ

    for (const { dateLabel, chunk } of days) {
      const dateIso = parseDateLabel(dateLabel);
      if (!dateIso) continue;

      const summary = parseFooterSummary(chunk, dateIso);
      if (summary) {
        dailySummaries.push(summary);
      }

      const headerMatches = [];
      let hm;
      const headerRe = new RegExp(CALL_HEADER_RE);
      while ((hm = headerRe.exec(chunk)) !== null) {
        headerMatches.push({ index: hm.index, end: headerRe.lastIndex, analyst: cleanAnalystName(hm[1]) });
      }
      for (let i = 0; i < headerMatches.length; i++) {
        const start = headerMatches[i].end;
        const end = i + 1 < headerMatches.length ? headerMatches[i + 1].index : chunk.length;
        const sub = truncateAt(chunk.slice(start, end));
        const { markerCount, parsedCount } = parseAnalystChunk(sub, dateIso, headerMatches[i].analyst, trades);
        if (markerCount !== parsedCount) {
          unparsedWarnings.push({ date: dateIso, analyst: headerMatches[i].analyst, markerCount, parsedCount });
        }
      }
    }

    return { trades, dailySummaries, unparsedWarnings };
  }

  // Cross-checks the parsed output against two things it did NOT derive
  // its own numbers from, so a parsing mistake has a real chance of
  // surfacing instead of just looking plausible:
  //  1. unparsedWarnings (from parseRecapText) -- per analyst-per-day, did
  //     every win/loss marker actually turn into a trade line?
  //  2. the channel's OWN posted daily footer (dailySummaries) -- its
  //     "Total Trades" / "Total Profits" for the day are typed by the
  //     channel itself, completely independent of our regexes, so if our
  //     parsed count/profit for that date doesn't match, either our parser
  //     or the channel's own footer is off -- worth a human look either way.
  // This is NOT a proof the data is correct (see: everything else about
  // free-form text parsing) -- it's a second, independent signal that
  // catches most real mistakes instead of trusting the parser blindly.
  function validateParse(trades, dailySummaries, unparsedWarnings) {
    const issues = [];

    (unparsedWarnings || []).forEach((w) => {
      const missing = w.markerCount - w.parsedCount;
      issues.push({
        severity: 'warn',
        message: `${w.date} · ${w.analyst}: found ${w.markerCount} win/loss marker(s) but only parsed ${w.parsedCount} into trades` +
          ` (${missing} line${missing === 1 ? '' : 's'} likely in a format the parser doesn't recognize -- check that section manually).`
      });
    });

    (dailySummaries || []).forEach((d) => {
      const dayTrades = trades.filter((t) => t.date === d.date);
      const parsedCount = dayTrades.length;
      const parsedProfit = dayTrades.reduce((s, t) => s + (typeof t.dollar === 'number' && !isNaN(t.dollar) ? t.dollar : 0), 0);

      if (parsedCount !== d.totalTrades) {
        issues.push({
          severity: 'warn',
          message: `${d.date}: parsed ${parsedCount} call(s) but the channel's own footer says ${d.totalTrades} -- ` +
            `${parsedCount < d.totalTrades ? (d.totalTrades - parsedCount) + ' may be missing' : 'parsed more than the footer reports (possible duplicate or misread)'}.`
        });
      }
      if (Math.abs(parsedProfit - d.totalProfit) > 0.05) {
        issues.push({
          severity: 'warn',
          message: `${d.date}: parsed total profit ${parsedProfit.toFixed(2)} doesn't match the channel's reported ${d.totalProfit.toFixed(2)} ` +
            `(off by ${Math.abs(parsedProfit - d.totalProfit).toFixed(2)}).`
        });
      }
    });

    const summaryDates = new Set((dailySummaries || []).map((d) => d.date));
    const tradeDates = Array.from(new Set(trades.map((t) => t.date)));
    tradeDates.filter((d) => !summaryDates.has(d)).forEach((d) => {
      issues.push({
        severity: 'info',
        message: `${d}: no channel footer found for this day, so its parsed numbers couldn't be cross-checked against anything.`
      });
    });

    return { ok: issues.every((i) => i.severity !== 'warn'), issues };
  }

  function dedupeKey(t) {
    return [t.date, t.analyst, t.ticker, t.entry, t.exit, t.pct, t.dollar].join('|');
  }

  const DAY_MS = 24 * 60 * 60 * 1000;
  function dateNum(iso) { return Date.parse(iso + 'T00:00:00Z'); }

  // Collapses raw posted call-lines into logical *positions*, so a single
  // trade that gets trimmed across multiple days' recaps (same analyst,
  // same ticker, same entry price posted again within a short window)
  // counts once instead of once per trim. Without this, an analyst who
  // scales out of a winner over 3 days shows up as "3 wins" instead of
  // "1 winning trade" -- which inflates both trade count and win rate.
  //
  // Matching rule: same analyst + ticker + entry price, where each repeat
  // falls within `maxGapDays` calendar days of the previous one in that
  // chain. A gap bigger than that starts a brand-new position instead of
  // extending the old one -- e.g. reusing a common round entry price weeks
  // later is treated as a fresh, unrelated trade, not a stale trim.
  // Older bare-format lines with no entry price can't be matched this way
  // and are always counted as their own single-trim position.
  function groupPositions(trades, maxGapDays) {
    const gap = maxGapDays == null ? 10 : maxGapDays;
    const byKey = {};
    const singletons = [];

    trades.forEach((t, idx) => {
      if (typeof t.entry !== 'number' || isNaN(t.entry)) {
        singletons.push(t);
        return;
      }
      const key = t.analyst + '|' + t.ticker + '|' + t.entry.toFixed(4);
      (byKey[key] || (byKey[key] = [])).push({ t, idx });
    });

    const chains = [];
    Object.values(byKey).forEach((group) => {
      group.sort((a, b) => (a.t.date < b.t.date ? -1 : a.t.date > b.t.date ? 1 : a.idx - b.idx));
      let current = null;
      let lastDateNum = null;
      group.forEach(({ t }) => {
        const dNum = dateNum(t.date);
        if (current && lastDateNum != null && (dNum - lastDateNum) / DAY_MS <= gap) {
          current.trims.push(t);
        } else {
          current = { analyst: t.analyst, ticker: t.ticker, entry: t.entry, trims: [t] };
          chains.push(current);
        }
        lastDateNum = dNum;
      });
    });
    singletons.forEach((t) => {
      chains.push({ analyst: t.analyst, ticker: t.ticker, entry: t.entry, trims: [t] });
    });

    return chains.map((p) => {
      const trims = p.trims.slice().sort((a, b) => a.date.localeCompare(b.date));
      const dollars = trims.map((t) => t.dollar).filter((d) => typeof d === 'number' && !isNaN(d));
      const netDollar = dollars.length ? dollars.reduce((s, d) => s + d, 0) : null;
      const win = netDollar != null ? netDollar >= 0 : trims.filter((t) => t.win).length >= trims.length / 2;
      return {
        analyst: p.analyst, ticker: p.ticker, entry: p.entry,
        trims, trimCount: trims.length,
        firstDate: trims[0].date, lastDate: trims[trims.length - 1].date,
        netDollar, win
      };
    });
  }

  function median(nums) {
    if (!nums.length) return null;
    const s = nums.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  // Max number of positions open on the same calendar day, i.e. how much
  // capital would need to be tied up at once to never miss a call --
  // relevant for someone sizing a copy-trading account. Classic sweep-line
  // interval-overlap count over each position's [firstDate, lastDate].
  function maxConcurrentPositions(positions) {
    if (!positions.length) return 0;
    const events = [];
    positions.forEach((p) => {
      events.push([dateNum(p.firstDate), 1]);
      events.push([dateNum(p.lastDate) + DAY_MS, -1]); // position still "open" through its lastDate
    });
    events.sort((a, b) => a[0] - b[0] || b[1] - a[1]); // opens before closes on a tie
    let cur = 0, max = 0;
    events.forEach(([, delta]) => { cur += delta; if (cur > max) max = cur; });
    return max;
  }

  function topTickers(positions, n) {
    const counts = {};
    positions.forEach((p) => { counts[p.ticker] = (counts[p.ticker] || 0) + 1; });
    return Object.entries(counts)
      .map(([ticker, count]) => ({ ticker, count }))
      .sort((a, b) => b.count - a.count || a.ticker.localeCompare(b.ticker))
      .slice(0, n == null ? 5 : n);
  }

  // Current streak (trailing run of wins or losses, most recent position
  // last) and the worst losing streak on record, both by position (not
  // raw call-line) so a multi-trim winner doesn't get counted as 3 wins
  // in a row.
  function computeStreaks(positionsByDateAsc) {
    let worstLossStreak = 0, run = 0;
    positionsByDateAsc.forEach((p) => {
      if (!p.win) { run += 1; if (run > worstLossStreak) worstLossStreak = run; } else run = 0;
    });
    let currentStreak = null;
    for (let i = positionsByDateAsc.length - 1; i >= 0; i--) {
      const w = positionsByDateAsc[i].win;
      if (!currentStreak) currentStreak = { type: w ? 'win' : 'loss', count: 1 };
      else if ((w ? 'win' : 'loss') === currentStreak.type) currentStreak.count += 1;
      else break;
    }
    return { currentStreak, worstLossStreak };
  }

  // Day-by-day (trade-by-trade, chronological) running balance per analyst,
  // built straight from the raw dollar figures -- this is a cash-flow
  // question ("how far underwater did this account go before recovering"),
  // not a position-grouping one, so it intentionally does NOT use
  // groupPositions: every trim's $ counts on the day it actually landed.
  function computeDrawdowns(trades) {
    const byAnalyst = {};
    trades.forEach((t) => { (byAnalyst[t.analyst] || (byAnalyst[t.analyst] = [])).push(t); });
    const out = {};
    Object.keys(byAnalyst).forEach((a) => {
      const list = byAnalyst[a]
        .filter((t) => typeof t.dollar === 'number' && !isNaN(t.dollar))
        .slice()
        .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
      let running = 0, peak = 0, maxDrawdown = 0, maxDrawdownPct = 0;
      list.forEach((t) => {
        running += t.dollar;
        if (running > peak) peak = running;
        const dd = peak - running;
        if (dd > maxDrawdown) maxDrawdown = dd;
        const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
        if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
      });
      out[a] = { maxDrawdown, maxDrawdownPct };
    });
    return out;
  }

  function computeStats(trades, opts) {
    const maxGapDays = (opts && opts.maxGapDays) != null ? opts.maxGapDays : 10;
    const positions = groupPositions(trades, maxGapDays);
    const drawdowns = computeDrawdowns(trades);
    const byAnalyst = {};
    for (const p of positions) {
      if (!byAnalyst[p.analyst]) {
        byAnalyst[p.analyst] = {
          analyst: p.analyst, trades: 0, wins: 0, losses: 0,
          grossWin: 0, grossLoss: 0, totalProfit: 0,
          pricedTrades: 0, entrySum: 0, entryCount: 0,
          maxWin: -Infinity, maxLoss: Infinity, days: new Set(),
          positions: []
        };
      }
      const a = byAnalyst[p.analyst];
      a.trades += 1;
      a.positions.push(p);
      p.trims.forEach((t) => a.days.add(t.date));
      if (p.win) a.wins += 1; else a.losses += 1;
      if (typeof p.netDollar === 'number' && !isNaN(p.netDollar)) {
        a.totalProfit += p.netDollar;
        a.pricedTrades += 1;
        if (p.netDollar >= 0) a.grossWin += p.netDollar; else a.grossLoss += -p.netDollar;
        if (p.netDollar > a.maxWin) a.maxWin = p.netDollar;
        if (p.netDollar < a.maxLoss) a.maxLoss = p.netDollar;
      }
      if (typeof p.entry === 'number' && !isNaN(p.entry)) {
        a.entrySum += p.entry;
        a.entryCount += 1;
      }
    }
    const out = Object.values(byAnalyst).map((a) => {
      const winRate = a.trades ? (a.wins / a.trades) * 100 : 0;
      const profitFactor = a.grossLoss > 0 ? a.grossWin / a.grossLoss : (a.grossWin > 0 ? Infinity : 0);
      const avgPerTrade = a.pricedTrades ? a.totalProfit / a.pricedTrades : 0;
      const avgEntryCost = a.entryCount ? (a.entrySum / a.entryCount) * 100 : null; // *100 = per-contract cost
      const daysActive = a.days.size;

      const pricedNets = a.positions.map((p) => p.netDollar).filter((v) => typeof v === 'number' && !isNaN(v));
      const medianPerTrade = median(pricedNets);
      const entryCosts = a.positions.map((p) => (typeof p.entry === 'number' ? p.entry * 100 : null)).filter((v) => v != null);
      const maxEntryCost = entryCosts.length ? Math.max(...entryCosts) : null;
      const multiDay = a.positions.filter((p) => p.trimCount > 1);
      const multiDayPct = a.positions.length ? (multiDay.length / a.positions.length) * 100 : 0;
      const avgHoldDays = multiDay.length
        ? multiDay.reduce((s, p) => s + (dateNum(p.lastDate) - dateNum(p.firstDate)) / DAY_MS, 0) / multiDay.length
        : null;
      const sortedByDate = a.positions.slice().sort((x, y) => (x.lastDate < y.lastDate ? -1 : x.lastDate > y.lastDate ? 1 : 0));
      const { currentStreak, worstLossStreak } = computeStreaks(sortedByDate);
      const dd = drawdowns[a.analyst] || { maxDrawdown: 0, maxDrawdownPct: 0 };

      return {
        analyst: a.analyst,
        trades: a.trades,
        wins: a.wins,
        losses: a.losses,
        winRate,
        totalProfit: a.totalProfit,
        profitFactor,
        avgPerTrade,
        medianPerTrade,
        maxWin: a.maxWin === -Infinity ? null : a.maxWin,
        maxLoss: a.maxLoss === Infinity ? null : a.maxLoss,
        avgEntryCost,
        maxEntryCost,
        daysActive,
        avgTradesPerActiveDay: daysActive ? a.trades / daysActive : 0,
        multiDayPct,
        avgHoldDays,
        maxConcurrentPositions: maxConcurrentPositions(a.positions),
        topTickers: topTickers(a.positions, 5),
        currentStreak,
        streakSortValue: currentStreak ? (currentStreak.type === 'win' ? currentStreak.count : -currentStreak.count) : 0,
        worstLossStreak,
        maxDrawdown: dd.maxDrawdown,
        maxDrawdownPct: dd.maxDrawdownPct
      };
    });
    return out;
  }

  // ---- copy-trade simulator --------------------------------------------
  // "If I'd started with $X and sized every call this way, what would my
  // account look like now?" Deliberately an approximation: we don't know
  // an analyst's own position size behind their posted $ figures, only
  // their % move per position, so this maps that % move onto YOUR capital
  // instead of reproducing their dollar amounts. Runs on grouped positions
  // (see groupPositions) so a multi-day trim chain is one simulated bet,
  // not several.
  //
  // Core numeric walk through a list of positions, in whatever order
  // they're given, against one account balance. Returns index-aligned
  // arrays (balances[0] is the starting balance, before any position) so
  // it works whether the positions are in real chronological order or
  // reshuffled for a Monte Carlo run -- dates only get attached on top of
  // this by the callers below.
  function walkPositions(positions, startingCapital, o) {
    let balance = startingCapital;
    let peak = startingCapital;
    let maxDrawdownPct = 0;
    let bustedIndex = null;
    let skipped = 0;
    const perAnalystProfit = {};
    const balances = [startingCapital];
    const ledger = [];

    positions.forEach((p, i) => {
      if (balance <= 0.01) { skipped += 1; balances.push(balance); return; } // busted -- nothing left to risk

      const contractCost = p.entry * 100;
      let riskAmount;
      if (o.sizing === 'fixed') riskAmount = o.fixedAmount;
      else if (o.sizing === 'startingPct') riskAmount = startingCapital * o.riskPct;
      else riskAmount = balance * o.riskPct; // 'balancePct', compounding

      // When affordability check is on, contracts must be whole contracts:
      // You cannot buy a fraction of a contract, and trade is skipped if you can't afford at least 1 contract.
      if (o.affordabilityCheck) {
        if (contractCost <= 0 || balance < contractCost || riskAmount < contractCost) {
          skipped += 1;
          balances.push(balance);
          return;
        }
        const maxAffordableContracts = Math.floor(Math.min(riskAmount, balance) / contractCost);
        if (maxAffordableContracts < 1) {
          skipped += 1;
          balances.push(balance);
          return;
        }
        riskAmount = maxAffordableContracts * contractCost;
      } else {
        riskAmount = Math.min(riskAmount, balance);
      }

      let returnPct = (p.netDollar / (p.entry * 100)) * 100;
      returnPct = Math.max(returnPct, -100); // long options can't lose more than 100% of what's risked
      if (o.slippagePct) returnPct = returnPct >= 0 ? returnPct * (1 - o.slippagePct) : returnPct * (1 + o.slippagePct);

      const profit = riskAmount * (returnPct / 100);
      balance = Math.max(0, balance + profit);
      perAnalystProfit[p.analyst] = (perAnalystProfit[p.analyst] || 0) + profit;

      if (balance > peak) peak = balance;
      const dd = peak > 0 ? ((peak - balance) / peak) * 100 : 0;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
      if (balance <= 0.01 && bustedIndex == null) bustedIndex = i;

      balances.push(balance);
      ledger.push({
        date: p.lastDate, analyst: p.analyst, ticker: p.ticker, entry: p.entry,
        netDollar: p.netDollar, returnPct, riskAmount, profit, balanceAfter: balance
      });
    });

    return { balances, maxDrawdownPct, bustedIndex, perAnalystProfit, ledger, skipped };
  }

  function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function percentileOf(sortedArr, p) {
    if (!sortedArr.length) return 0;
    const idx = Math.min(sortedArr.length - 1, Math.max(0, Math.round((p / 100) * (sortedArr.length - 1))));
    return sortedArr[idx];
  }

  // "If I'd started with $X and sized every call this way, what would my
  // account look like now?" Deliberately an approximation: we don't know
  // an analyst's own position size behind their posted $ figures, only
  // their % move per position, so this maps that % move onto YOUR capital
  // instead of reproducing their dollar amounts. Runs on grouped positions
  // (see groupPositions) so a multi-day trim chain is one simulated bet,
  // not several.
  //
  // Walks a single already-sorted, already-filtered list of positions
  // through one shared account balance, then attaches real calendar dates
  // on top of walkPositions' index-based result. Used directly for one
  // analyst, and for "blend" mode where positions from several analysts
  // are interleaved chronologically first so they all draw on one pool.
  function runAccountSim(positions, startingCapital, o) {
    const w = walkPositions(positions, startingCapital, o);
    const points = [{ date: positions.length ? positions[0].firstDate : null, balance: startingCapital }];
    positions.forEach((p, i) => points.push({ date: p.lastDate, balance: w.balances[i + 1] }));
    const finalBalance = w.balances[w.balances.length - 1];
    return {
      startingCapital,
      finalBalance,
      totalReturnPct: ((finalBalance - startingCapital) / startingCapital) * 100,
      maxDrawdownPct: w.maxDrawdownPct,
      positionsSimulated: positions.length - w.skipped,
      positionsSkipped: w.skipped,
      bustedOnDate: w.bustedIndex != null ? positions[w.bustedIndex].lastDate : null,
      perAnalystProfit: w.perAnalystProfit,
      ledger: w.ledger,
      points
    };
  }

  // Reshuffles the SAME set of positions hundreds of times and re-runs the
  // walk on each ordering, to show how much sequence-of-returns luck alone
  // changes the outcome of a compounding account -- the real historical
  // path is only one of very many orders these exact trades could have
  // landed in. Bands are keyed by step index (the Nth position), not date,
  // since a shuffled run has no single real calendar mapping.
  function runMonteCarlo(positions, startingCapital, o, iterations) {
    const iters = iterations || 400;
    const n = positions.length;
    if (!n) return { iterations: 0, steps: [], finalBalances: [], bustedFraction: 0, medianFinal: startingCapital, p10Final: startingCapital, p90Final: startingCapital };

    const byStep = Array.from({ length: n + 1 }, () => []);
    const finals = [];
    let bustedCount = 0;
    for (let it = 0; it < iters; it++) {
      const w = walkPositions(shuffled(positions), startingCapital, o);
      w.balances.forEach((b, step) => byStep[step].push(b));
      finals.push(w.balances[w.balances.length - 1]);
      if (w.bustedIndex != null) bustedCount += 1;
    }
    const steps = byStep.map((arr, i) => {
      const s = arr.slice().sort((a, b) => a - b);
      return { step: i, p10: percentileOf(s, 10), p25: percentileOf(s, 25), p50: percentileOf(s, 50), p75: percentileOf(s, 75), p90: percentileOf(s, 90) };
    });
    const sortedFinals = finals.slice().sort((a, b) => a - b);
    return {
      iterations: iters,
      steps,
      finalBalances: sortedFinals,
      bustedFraction: bustedCount / iters,
      medianFinal: percentileOf(sortedFinals, 50),
      p10Final: percentileOf(sortedFinals, 10),
      p90Final: percentileOf(sortedFinals, 90)
    };
  }

  const SIM_DEFAULTS = {
    startingCapital: 2000, sizing: 'balancePct', riskPct: 0.05, fixedAmount: 100,
    slippagePct: 0, affordabilityCheck: false, mode: 'blend', rangeDays: null, maxGapDays: 10,
    monteCarlo: false, monteCarloIterations: 400, benchmark: false
  };

  function pricedPositionsFor(trades, analystName, maxGapDays) {
    return groupPositions(trades.filter((t) => t.analyst === analystName), maxGapDays)
      .filter((p) => typeof p.entry === 'number' && !isNaN(p.entry) && p.entry > 0 && p.netDollar != null)
      .sort((a, b) => (a.lastDate < b.lastDate ? -1 : a.lastDate > b.lastDate ? 1 : 0));
  }

  function byDate(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; }

  // Combines several {points} curves (each its own dates/length) into one
  // curve on the union of all their dates, step-holding and SUMMING each
  // sub-account's balance -- used for the "split evenly across everyone"
  // benchmark, which is really N independent sub-accounts added together.
  function sumCurves(curves) {
    const nonEmpty = curves.filter((c) => c.points && c.points.length);
    if (!nonEmpty.length) return { points: [], finalBalance: 0 };
    const allDates = Array.from(new Set(nonEmpty.flatMap((c) => c.points.map((p) => p.date).filter(Boolean)))).sort();
    const stepped = nonEmpty.map((c) => {
      let cursor = 1, current = c.points[0].balance;
      return allDates.map((d) => {
        while (cursor < c.points.length && c.points[cursor].date <= d) { current = c.points[cursor].balance; cursor += 1; }
        return current;
      });
    });
    const startSum = nonEmpty.reduce((s, c) => s + c.points[0].balance, 0);
    const points = [{ date: null, balance: startSum }].concat(
      allDates.map((d, i) => ({ date: d, balance: stepped.reduce((s, vals) => s + vals[i], 0) }))
    );
    return { points, finalBalance: points[points.length - 1].balance };
  }

  // Builds the "what if you'd just split your capital evenly across every
  // analyst in the data" reference curve -- a fixed, always-available
  // baseline independent of whichever analysts you happened to pick.
  function runBenchmark(trades, startingCapital, o) {
    const allNames = Array.from(new Set(trades.map((t) => t.analyst)));
    if (!allNames.length) return { points: [], finalBalance: startingCapital };
    const share = startingCapital / allNames.length;
    const curves = allNames.map((name) => runAccountSim(pricedPositionsFor(trades, name, o.maxGapDays), share, o));
    return sumCurves(curves);
  }

  // analystNames: one name or an array of names.
  // mode 'compare': each analyst gets their own independent account,
  //   starting fresh at startingCapital -- for picking a winner.
  // mode 'blend': every selected analyst's calls draw on ONE shared,
  //   pooled account, interleaved in the order they actually happened --
  //   for simulating "I followed this whole group."
  function simulateCopyTrading(trades, analystNames, opts) {
    const names = Array.isArray(analystNames) ? analystNames : [analystNames];
    const o = Object.assign({}, SIM_DEFAULTS, opts || {});

    let scoped = trades.filter((t) => names.includes(t.analyst));
    let rangeTrades = trades;
    if (o.rangeDays) {
      const uniqueDates = Array.from(new Set(scoped.map((t) => t.date))).sort();
      const windowDates = new Set(uniqueDates.slice(-o.rangeDays));
      scoped = scoped.filter((t) => windowDates.has(t.date));
      rangeTrades = trades.filter((t) => windowDates.has(t.date));
    }
    const benchmark = o.benchmark ? runBenchmark(rangeTrades, o.startingCapital, o) : null;

    if (o.mode === 'compare') {
      return {
        mode: 'compare',
        analysts: names,
        benchmark,
        results: names.map((name) => Object.assign(
          { analyst: name },
          runAccountSim(pricedPositionsFor(scoped, name, o.maxGapDays), o.startingCapital, o)
        ))
      };
    }

    const positions = names
      .reduce((acc, name) => acc.concat(pricedPositionsFor(scoped, name, o.maxGapDays)), [])
      .sort(byDate);
    const result = Object.assign(
      { mode: 'blend', analysts: names, benchmark },
      runAccountSim(positions, o.startingCapital, o)
    );
    if (o.monteCarlo) result.monteCarlo = runMonteCarlo(positions, o.startingCapital, o, o.monteCarloIterations);
    return result;
  }

  // ---- shareable simulator scenarios -----------------------------------
  // Packs the settings that matter (not the resulting data) into a short,
  // URL-safe token so a specific scenario can be sent as a link and
  // reproduced exactly by decodeScenario() on the other end.
  function encodeScenario(settings) {
    const json = JSON.stringify(settings);
    const b64 = (typeof btoa === 'function' ? btoa : (s) => Buffer.from(s, 'binary').toString('base64'))(
      typeof btoa === 'function' ? unescape(encodeURIComponent(json)) : json
    );
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function decodeScenario(token) {
    if (!token) return null;
    try {
      const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '==='.slice((b64.length + 3) % 4);
      const bin = typeof atob === 'function' ? atob(padded) : Buffer.from(padded, 'base64').toString('binary');
      const json = typeof atob === 'function' ? decodeURIComponent(escape(bin)) : bin;
      return JSON.parse(json);
    } catch (e) {
      return null;
    }
  }

  global.MordyParser = {
    parseRecapText, computeStats, groupPositions, simulateCopyTrading, runMonteCarlo,
    encodeScenario, decodeScenario, dedupeKey, toFlatText, validateParse
  };
  global.SwingerParser = global.MordyParser;
  global.ShowtimeParser = global.MordyParser;
})(typeof window !== 'undefined' ? window : globalThis);

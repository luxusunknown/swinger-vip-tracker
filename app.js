(function () {
  'use strict';

  // ---- config -------------------------------------------------------
  // Admin login is checked server-side (functions/api/login.js) against
  // env vars set in Cloudflare Pages -- nothing secret lives in this file.
  const CONFIG = {
    DATA_URL: './data.json'
  };

  const COLOR_VARS = ['--series-1','--series-2','--series-3','--series-4','--series-5','--series-6','--series-7','--series-8'];

  // ---- state ----------------------------------------------------------
  const state = {
    trades: [],
    dailySummaries: [],
    rangeDays: null,        // null = all time
    sortCol: 'totalProfit',
    sortDir: 'desc',
    selectedAnalyst: null,
    colorMap: {},            // analyst -> css var
    adminUnlocked: false,
    pendingParsed: null      // { trades, dailySummaries } staged from paste, not yet merged
  };

  const root = document.documentElement;
  const css = (v) => getComputedStyle(root).getPropertyValue(v).trim();

  function fmtMoney(n, opts) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    const o = opts || {};
    const sign = n < 0 ? '-' : (o.plus ? '+' : '');
    return sign + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtPct(n, digits) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return (n >= 0 ? '+' : '') + n.toFixed(digits == null ? 1 : digits) + '%';
  }
  function fmtNum(n) { return n === null || n === undefined || isNaN(n) ? '—' : n.toLocaleString('en-US'); }
  // Drawdown is always >= 0 internally; this just decides whether to show it
  // as "-X.X%" (red) or a flat "0.0%" (muted) -- avoids ever printing the
  // "-0.0%" artifact you get from blindly prepending a minus sign to 0.
  function fmtDrawdown(pct) {
    if (pct === null || pct === undefined || isNaN(pct) || pct <= 0.05) return { text: '0.0%', cls: 'muted-cell' };
    return { text: '-' + pct.toFixed(1) + '%', cls: 'neg' };
  }

  // ---- lightweight animation helpers -------------------------------------
  const prefersReducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Draws SVG polylines in on render instead of popping in fully formed, and
  // fades the Monte Carlo percentile bands up to their target opacity.
  function animateSvgDraw(svg) {
    if (!svg || prefersReducedMotion()) return;
    const lines = svg.querySelectorAll('polyline');
    lines.forEach((el, i) => {
      let len = 0;
      try { len = el.getTotalLength(); } catch (e) { return; }
      if (!len) return;
      el.style.strokeDasharray = len;
      el.style.strokeDashoffset = len;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        el.style.transition = `stroke-dashoffset .7s cubic-bezier(.22,.8,.25,1) ${Math.min(i * 70, 280)}ms`;
        el.style.strokeDashoffset = '0';
      }));
    });
    svg.querySelectorAll('.band-outer, .band-inner').forEach((el) => {
      const target = el.classList.contains('band-outer') ? .16 : .28;
      el.style.opacity = '0';
      requestAnimationFrame(() => requestAnimationFrame(() => {
        el.style.transition = 'opacity .6s ease .15s';
        el.style.opacity = target;
      }));
    });
  }

  // Counts a `.tile .value`-style element up from whatever it last showed to
  // the new formatted value, instead of snapping straight to it. Parses the
  // sign/symbol/number/suffix out of the already-formatted string so callers
  // don't need to pass raw numbers through separately.
  function animateValue(el, finalText) {
    if (!el) return;
    if (prefersReducedMotion() || typeof finalText !== 'string') { el.textContent = finalText; return; }
    const m = finalText.match(/^(-?)([^0-9\-]*)([\d,]+(?:\.\d+)?)(.*)$/);
    if (!m) { el.textContent = finalText; return; }
    const [, signStr, symbol, numStr, suffix] = m;
    const to = parseFloat((signStr === '-' ? '-' : '') + numStr.replace(/,/g, ''));
    if (isNaN(to)) { el.textContent = finalText; return; }
    const decimals = (numStr.split('.')[1] || '').length;
    const from = el.dataset.animVal !== undefined ? parseFloat(el.dataset.animVal) : 0;
    el.dataset.animVal = to;
    const isMoney = symbol.indexOf('$') !== -1;
    const isPlus = symbol.indexOf('+') !== -1;
    const duration = 600;
    const t0 = performance.now();
    function step(now) {
      const t = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const val = from + (to - from) * eased;
      const abs = Math.abs(val).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
      el.textContent = isMoney
        ? (val < 0 ? '-' : '') + '$' + abs + suffix
        : (val < 0 ? '-' : (isPlus ? '+' : '')) + abs + suffix;
      if (t < 1) requestAnimationFrame(step); else el.textContent = finalText;
    }
    requestAnimationFrame(step);
  }

  function animateTiles(container) {
    if (!container) return;
    container.querySelectorAll('.tile .value').forEach(v => animateValue(v, v.textContent));
  }

  function buildColorMap(trades) {
    const names = Array.from(new Set(trades.map(t => t.analyst))).sort();
    const map = {};
    names.forEach((name, i) => { map[name] = COLOR_VARS[i % COLOR_VARS.length]; });
    return map;
  }

  function maxDate(trades) {
    let m = null;
    for (const t of trades) if (!m || t.date > m) m = t.date;
    return m;
  }

  function filteredTrades() {
    if (!state.rangeDays) return state.trades;
    // "last N days" = last N distinct days that actually have a posted recap,
    // not N calendar days -- the channel skips weekends/off days, so a
    // calendar cutoff would quietly shrink the window.
    const uniqueDates = Array.from(new Set(state.trades.map(t => t.date))).sort();
    const windowDates = new Set(uniqueDates.slice(-state.rangeDays));
    return state.trades.filter(t => windowDates.has(t.date));
  }

  // ---- rendering: filter bar -----------------------------------------
  function renderFilters() {
    const el = document.getElementById('filters');
    const options = [
      { label: 'Last 7d', v: 7 }, { label: 'Last 14d', v: 14 }, { label: 'Last 20d', v: 20 },
      { label: 'Last 30d', v: 30 }, { label: 'Last 60d', v: 60 }, { label: 'All time', v: null }
    ];
    el.innerHTML = '';
    options.forEach(opt => {
      const b = document.createElement('button');
      b.textContent = opt.label;
      if (state.rangeDays === opt.v) b.classList.add('active');
      b.onclick = () => { state.rangeDays = opt.v; renderAll(); };
      el.appendChild(b);
    });
  }

  // ---- rendering: tiles -----------------------------------------------
  function renderTiles(stats) {
    const el = document.getElementById('tiles');
    if (!stats.length) { el.innerHTML = ''; return; }
    const mostProfitable = stats.slice().sort((a,b)=>b.totalProfit-a.totalProfit)[0];
    const bestWinRate = stats.filter(s=>s.trades>=10).sort((a,b)=>b.winRate-a.winRate)[0] || stats.slice().sort((a,b)=>b.winRate-a.winRate)[0];
    const totalTrades = stats.reduce((s,x)=>s+x.trades,0);
    const totalProfit = stats.reduce((s,x)=>s+x.totalProfit,0);
    const tiles = [
      { label: 'Most profitable', value: mostProfitable.analyst, sub: fmtMoney(mostProfitable.totalProfit) },
      { label: 'Best win rate (10+ trades)', value: bestWinRate.analyst, sub: bestWinRate.winRate.toFixed(1)+'%' },
      { label: 'Tracked Trades', value: fmtNum(totalTrades), sub: stats.length + ' analysts' },
      { label: 'Combined profit', value: fmtMoney(totalProfit), sub: 'across everyone shown' }
    ];
    el.classList.add('stagger-in');
    el.innerHTML = tiles.map(t => `
      <div class="tile">
        <div class="label">${t.label}</div>
        <div class="value">${t.value}</div>
        <div class="hint" style="margin-top:2px">${t.sub}</div>
      </div>`).join('');
    animateTiles(el);
  }

  // ---- rendering: leaderboard table -----------------------------------
  const COLUMNS = [
    { key: 'analyst', label: 'Analyst' },
    { key: 'trades', label: 'Trades', tip: 'Distinct positions, not raw posted calls — if the same ticker gets re-posted at the same entry price within 10 days (a trim of an existing position), it counts once, not once per trim.' },
    { key: 'winRate', label: 'Win Rate', tip: 'Winning positions ÷ total positions (see "Trades" — trims of one position are judged on that position\'s net result, not each trim separately).' },
    { key: 'profitFactor', label: 'Profit Factor', tip: 'Gross $ won ÷ gross $ lost, by position net result. Above 1 = net profitable.' },
    { key: 'totalProfit', label: 'Total Profit' },
    { key: 'avgPerTrade', label: 'Avg $ / Trade', tip: 'Total profit ÷ priced positions — the blended expected outcome of one position, wins and losses combined.' },
    { key: 'maxLoss', label: 'Worst Loss', tip: 'Worst net result of any single position — if a position was trimmed at a loss but the remaining trims turned it net positive, it\'s not counted here as a loss.' },
    { key: 'avgEntryCost', label: 'Avg Contract Cost', tip: 'Average entry price × 100 across distinct positions — roughly what one contract costs to open. Hover a row for the most expensive single position.' },
    { key: 'daysActive', label: 'Days Active', tip: 'Hover a row for how often positions span multiple days and how many can be open at once.' },
    { key: 'streakSortValue', label: 'Streak', tip: 'Current run of wins or losses in a row, most recent call last. Hover a row for the worst losing streak on record.' },
    { key: 'maxDrawdown', label: 'Max Drawdown', tip: 'Worst peak-to-trough dip in this analyst\'s running tracked profit -- not the same as "Worst Loss" (one position); this is how far underwater the total ever went before recovering.' }
  ];

  function renderTable(stats) {
    const thead = document.getElementById('tableHead');
    const tbody = document.getElementById('tableBody');

    thead.innerHTML = '<tr>' + COLUMNS.map(c => {
      const sorted = state.sortCol === c.key;
      const cls = sorted ? ('sorted ' + (state.sortDir === 'asc' ? 'asc' : '')) : '';
      const tip = c.tip ? ` title="${c.tip}"` : '';
      return `<th data-key="${c.key}" class="${cls}"${tip}>${c.label}</th>`;
    }).join('') + '</tr>';

    thead.querySelectorAll('th').forEach(th => {
      th.onclick = () => {
        const key = th.dataset.key;
        if (state.sortCol === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        else { state.sortCol = key; state.sortDir = 'desc'; }
        renderAll();
      };
    });

    const sorted = stats.slice().sort((a, b) => {
      const dir = state.sortDir === 'asc' ? 1 : -1;
      const av = a[state.sortCol], bv = b[state.sortCol];
      if (typeof av === 'string') return av.localeCompare(bv) * dir;
      return ((av ?? -Infinity) - (bv ?? -Infinity)) * dir;
    });

    tbody.innerHTML = sorted.map(s => {
      const color = css(state.colorMap[s.analyst] || '--series-1');
      const selected = state.selectedAnalyst === s.analyst ? 'selected' : '';
      const medianTip = `Median $/trade: ${fmtMoney(s.medianPerTrade)} (less skewed by one huge outlier than the average)`;
      const entryTip = `Most expensive single position: ${s.maxEntryCost != null ? fmtMoney(s.maxEntryCost) : '—'}`;
      const daysTip = `${s.multiDayPct.toFixed(0)}% of positions span multiple days` +
        (s.avgHoldDays != null ? ` (avg ${s.avgHoldDays.toFixed(1)}d when they do)` : '') +
        ` · up to ${s.maxConcurrentPositions} position${s.maxConcurrentPositions === 1 ? '' : 's'} open at once`;
      const streakLabel = s.currentStreak ? `${s.currentStreak.type === 'win' ? '🔥' : '🧊'}${s.currentStreak.count}${s.currentStreak.type === 'win' ? 'W' : 'L'}` : '—';
      const streakTip = `Worst losing streak on record: ${s.worstLossStreak}`;
      const ddTip = 'Peak-to-trough dip in running tracked profit, not a single-position loss';
      return `<tr class="${selected}" data-analyst="${s.analyst}">
        <td class="name-cell"><span class="dot" style="background:${color}"></span>${s.analyst}</td>
        <td>${fmtNum(s.trades)}</td>
        <td>${s.winRate.toFixed(1)}%</td>
        <td>${isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞'}</td>
        <td class="${s.totalProfit >= 0 ? 'pos' : 'neg'}">${fmtMoney(s.totalProfit)}</td>
        <td class="${s.avgPerTrade >= 0 ? 'pos' : 'neg'}" title="${medianTip}">${fmtMoney(s.avgPerTrade)}</td>
        <td class="neg">${s.maxLoss != null ? fmtMoney(s.maxLoss) : '—'}</td>
        <td class="muted-cell" title="${entryTip}">${s.avgEntryCost != null ? fmtMoney(s.avgEntryCost) : '—'}</td>
        <td title="${daysTip}">${s.daysActive}</td>
        <td class="${s.currentStreak && s.currentStreak.type === 'win' ? 'pos' : (s.currentStreak ? 'neg' : 'muted-cell')}" title="${streakTip}">${streakLabel}</td>
        <td class="${s.maxDrawdown > 0 ? 'neg' : 'muted-cell'}" title="${ddTip}">${fmtMoney(s.maxDrawdown)}</td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('tr').forEach(tr => {
      tr.onclick = () => {
        const a = tr.dataset.analyst;
        state.selectedAnalyst = state.selectedAnalyst === a ? null : a;
        renderAll();
      };
    });
  }

  // ---- rendering: bar chart (total profit by analyst) -----------------
  function renderBarChart(stats, animate) {
    const wrap = document.getElementById('barChart');
    const sorted = stats.slice().sort((a,b)=>b.totalProfit-a.totalProfit);
    if (!sorted.length) { wrap.innerHTML = ''; return; }
    const w = wrap.clientWidth || 600;
    const rowH = 30, gap = 10, leftPad = 100, rightPad = 74, topPad = 6;
    const h = sorted.length * (rowH + gap) + topPad;
    const maxAbs = Math.max(1, ...sorted.map(s => Math.abs(s.totalProfit)));
    const plotW = w - leftPad - rightPad;

    const surface = css('--surface-1');
    let bars = '';
    let labels = '';
    sorted.forEach((s, i) => {
      const y = topPad + i * (rowH + gap);
      const color = css(state.colorMap[s.analyst] || '--series-1');
      const barW = Math.max(2, (Math.abs(s.totalProfit) / maxAbs) * plotW);
      const x = s.totalProfit >= 0 ? leftPad : leftPad - barW;
      const anchor = s.totalProfit >= 0 ? 'left' : 'right';
      bars += `<rect class="bar-rect" data-anchor="${anchor}" x="${x}" y="${y}" width="${barW}" height="${rowH}" rx="4" fill="${color}"></rect>`;
      // name label gets an opaque halo so it stays legible even if a
      // negative bar's left edge runs underneath it
      const haloW = s.analyst.length * 7.6 + 14;
      labels += `
        <rect x="${leftPad - 10 - haloW}" y="${y}" width="${haloW}" height="${rowH}" fill="${surface}"></rect>
        <text x="${leftPad - 10}" y="${y + rowH/2}" text-anchor="end" dominant-baseline="middle" font-weight="600" fill="${color}">${s.analyst}</text>
        <text x="${leftPad + Math.max(barW, 0) + 8}" y="${y + rowH/2}" dominant-baseline="middle" font-variant-numeric="tabular-nums">${fmtMoney(s.totalProfit, {plus:true})}</text>
      `;
    });

    wrap.innerHTML = `<svg width="100%" height="${h}" viewBox="0 0 ${w} ${h}">
      ${bars}
      <line class="axis-line" x1="${leftPad}" y1="0" x2="${leftPad}" y2="${h}"></line>
      ${labels}
    </svg>`;

    if (animate !== false && !prefersReducedMotion()) {
      wrap.querySelectorAll('.bar-rect').forEach((rect, i) => {
        rect.style.transformBox = 'fill-box';
        rect.style.transformOrigin = rect.dataset.anchor === 'right' ? '100% 50%' : '0% 50%';
        rect.style.transform = 'scaleX(0)';
        requestAnimationFrame(() => requestAnimationFrame(() => {
          rect.style.transition = `transform .5s cubic-bezier(.22,.8,.25,1) ${Math.min(i * 40, 240)}ms`;
          rect.style.transform = 'scaleX(1)';
        }));
      });
    }
  }

  // ---- rendering: cumulative profit line chart -------------------------
  let lineChartVisibility = {};

  function renderLineChart(trades, stats, animate) {
    const wrap = document.getElementById('lineChart');
    const legendEl = document.getElementById('lineLegend');
    const tooltip = document.getElementById('lineTooltip');
    const analysts = stats.map(s => s.analyst);
    analysts.forEach(a => { if (!(a in lineChartVisibility)) lineChartVisibility[a] = true; });

    // build per-analyst cumulative series over sorted unique dates
    const dates = Array.from(new Set(trades.filter(t=>typeof t.dollar === 'number').map(t => t.date))).sort();
    if (!dates.length) { wrap.innerHTML = '<div class="hint">No priced trades in this range.</div>'; legendEl.innerHTML=''; return; }

    const series = {};
    analysts.forEach(a => {
      let running = 0;
      series[a] = dates.map(d => {
        const dayTrades = trades.filter(t => t.analyst === a && t.date === d && typeof t.dollar === 'number');
        dayTrades.forEach(t => running += t.dollar);
        return running;
      });
    });

    const w = wrap.clientWidth || 600, h = 320, padL = 56, padR = 16, padT = 14, padB = 28;
    const plotW = w - padL - padR, plotH = h - padT - padB;

    let allVals = [0];
    analysts.forEach(a => { if (lineChartVisibility[a]) allVals = allVals.concat(series[a]); });
    const minV = Math.min(...allVals), maxV = Math.max(...allVals);
    const range = (maxV - minV) || 1;

    const xFor = (i) => padL + (dates.length === 1 ? plotW/2 : (i / (dates.length - 1)) * plotW);
    const yFor = (v) => padT + plotH - ((v - minV) / range) * plotH;

    let gridLines = '';
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = minV + (range * i / ticks);
      const y = yFor(v);
      gridLines += `<line class="grid-line" x1="${padL}" x2="${w-padR}" y1="${y}" y2="${y}"></line>
        <text x="${padL-8}" y="${y}" text-anchor="end" dominant-baseline="middle">${fmtMoney(v)}</text>`;
    }
    const zeroY = yFor(0);

    let paths = '';
    analysts.forEach(a => {
      if (!lineChartVisibility[a]) return;
      const color = css(state.colorMap[a] || '--series-1');
      const pts = series[a].map((v, i) => `${xFor(i)},${yFor(v)}`).join(' ');
      paths += `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" data-analyst="${a}"></polyline>`;
    });

    // sparse x-axis labels (start, middle, end)
    let xLabels = '';
    [0, Math.floor((dates.length-1)/2), dates.length-1].forEach(i => {
      if (i < 0 || i >= dates.length) return;
      xLabels += `<text x="${xFor(i)}" y="${h-8}" text-anchor="middle">${dates[i].slice(5)}</text>`;
    });

    wrap.innerHTML = `<svg id="lineSvg" width="100%" height="${h}" viewBox="0 0 ${w} ${h}" style="overflow:visible">
      ${gridLines}
      <line class="axis-line" x1="${padL}" x2="${w-padR}" y1="${zeroY}" y2="${zeroY}"></line>
      ${paths}
      ${xLabels}
      <rect id="hoverCatcher" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"></rect>
      <line id="crosshair" class="grid-line" x1="0" x2="0" y1="${padT}" y2="${padT+plotH}" style="display:none;stroke-dasharray:3,3"></line>
    </svg>`;

    legendEl.innerHTML = analysts.map(a => {
      const color = css(state.colorMap[a] || '--series-1');
      const off = lineChartVisibility[a] ? '' : 'off';
      return `<span class="item ${off}" data-analyst="${a}"><span class="swatch" style="background:${color}"></span>${a}</span>`;
    }).join('');
    legendEl.querySelectorAll('.item').forEach(item => {
      item.onclick = () => {
        const a = item.dataset.analyst;
        lineChartVisibility[a] = !lineChartVisibility[a];
        renderLineChart(trades, stats);
      };
    });

    const svg = document.getElementById('lineSvg');
    if (animate !== false) animateSvgDraw(svg);
    const catcher = document.getElementById('hoverCatcher');
    const crosshair = document.getElementById('crosshair');
    catcher.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      const scale = w / rect.width;
      const mx = (e.clientX - rect.left) * scale;
      let idx = Math.round(((mx - padL) / plotW) * (dates.length - 1));
      idx = Math.max(0, Math.min(dates.length - 1, idx));
      const x = xFor(idx);
      crosshair.setAttribute('x1', x); crosshair.setAttribute('x2', x);
      crosshair.style.display = 'block';
      let lines = `<div style="margin-bottom:3px;font-weight:600">${dates[idx]}</div>`;
      analysts.filter(a => lineChartVisibility[a]).forEach(a => {
        lines += `<div>${a}: ${fmtMoney(series[a][idx])}</div>`;
      });
      tooltip.innerHTML = lines;
      tooltip.style.display = 'block';
      tooltip.style.left = ((x/scale)) + 'px';
      tooltip.style.top = (padT) + 'px';
    });
    catcher.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; crosshair.style.display = 'none'; });
  }

  // ---- rendering: detail panel -----------------------------------------
  function renderDetail(trades, stats) {
    const panel = document.getElementById('detailPanel');
    if (!state.selectedAnalyst) { panel.classList.remove('open'); return; }
    panel.classList.add('open');
    const a = state.selectedAnalyst;
    const color = css(state.colorMap[a] || '--series-1');
    const rows = trades.filter(t => t.analyst === a).sort((x,y)=> y.date.localeCompare(x.date));

    const s = (stats || []).find(x => x.analyst === a);
    const statsEl = document.getElementById('detailStats');
    if (s) {
      const tickerList = s.topTickers.map(t => `${t.ticker} (${t.count})`).join(', ') || '—';
      statsEl.innerHTML = `Most active: ${tickerList} · up to ${s.maxConcurrentPositions} position${s.maxConcurrentPositions === 1 ? '' : 's'} open at once · ` +
        `${s.multiDayPct.toFixed(0)}% of positions held multi-day${s.avgHoldDays != null ? ` (avg ${s.avgHoldDays.toFixed(1)}d when they do)` : ''}`;
    } else {
      statsEl.innerHTML = '';
    }

    // Tag rows that are one trim of a multi-day position (see COLUMNS tip
    // on "Trades") so it's visible in the raw call list, not just baked
    // silently into the leaderboard math.
    const trimInfo = new Map();
    MordyParser.groupPositions(trades).forEach(p => {
      if (p.trimCount > 1) p.trims.forEach((t, i) => trimInfo.set(t, { i: i + 1, n: p.trimCount, net: p.netDollar }));
    });

    document.getElementById('detailTitle').innerHTML = `<span class="dot" style="background:${color}"></span>${a} — ${rows.length} calls in range`;
    document.getElementById('detailBody').innerHTML = rows.map(t => {
      const info = trimInfo.get(t);
      const trimTag = info
        ? ` <span class="trim-tag" title="Part of one position held across ${info.n} trims, net ${fmtMoney(info.net)} — counted once in the leaderboard, not ${info.n} times">trim ${info.i}/${info.n}</span>`
        : '';
      return `
      <tr>
        <td class="name-cell">${t.date}</td>
        <td>$${t.ticker}${trimTag}</td>
        <td class="${t.win ? 'pos' : 'neg'}">${t.win ? 'WIN' : 'LOSS'}</td>
        <td>${t.entry != null ? t.entry.toFixed(2) : '—'}</td>
        <td>${t.exit != null ? t.exit.toFixed(2) : '—'}</td>
        <td class="${t.pct >= 0 ? 'pos':'neg'}">${fmtPct(t.pct)}</td>
        <td class="${(t.dollar||0) >= 0 ? 'pos':'neg'}">${t.dollar != null ? fmtMoney(t.dollar) : '—'}</td>
      </tr>`;
    }).join('');
  }

  // ---- rendering: copy-trade simulator equity curve --------------------
  // Takes one or more named series (blend mode passes exactly one; compare
  // mode passes one per analyst). Series can have different dates/lengths
  // since each analyst trades on different days, so everything is drawn
  // against the UNION of all dates involved, step-holding each series at
  // its last known balance between its own trade dates -- same idea as
  // the main cumulative-profit chart, generalized to simulated accounts.
  let simLineVisibility = {};

  function renderSimChart(seriesList, animate) {
    const wrap = document.getElementById('simChart');
    const tooltip = document.getElementById('simTooltip');
    const legendEl = document.getElementById('simLegend');
    const series = seriesList.filter(s => s.points && s.points.length);
    if (!series.length) { wrap.innerHTML = ''; legendEl.innerHTML = ''; return; }

    series.forEach(s => { if (!(s.name in simLineVisibility)) simLineVisibility[s.name] = true; });
    const showLegend = series.length > 1;

    const allDates = Array.from(new Set(series.flatMap(s => s.points.map(p => p.date).filter(Boolean)))).sort();
    const stepSeries = series.map(s => {
      let cursor = 1; // index 0 is the synthetic pre-trade starting point
      let current = s.points[0].balance;
      const vals = allDates.map(d => {
        while (cursor < s.points.length && s.points[cursor].date <= d) { current = s.points[cursor].balance; cursor += 1; }
        return current;
      });
      return { name: s.name, color: s.color, vals };
    });

    const w = wrap.clientWidth || 600, h = 260, padL = 64, padR = 16, padT = 14, padB = 26;
    const plotW = w - padL - padR, plotH = h - padT - padB;

    let allVals = series.map(s => s.points[0].balance);
    stepSeries.forEach(s => { if (simLineVisibility[s.name]) allVals = allVals.concat(s.vals); });
    const minV = Math.min(0, ...allVals), maxV = Math.max(...allVals);
    const range = (maxV - minV) || 1;

    const n = allDates.length || 1;
    const xFor = (i) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const yFor = (v) => padT + plotH - ((v - minV) / range) * plotH;

    let gridLines = '';
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = minV + (range * i / ticks);
      const y = yFor(v);
      gridLines += `<line class="grid-line" x1="${padL}" x2="${w-padR}" y1="${y}" y2="${y}"></line>
        <text x="${padL-8}" y="${y}" text-anchor="end" dominant-baseline="middle">${fmtMoney(v)}</text>`;
    }
    const startingV = series[0].points[0].balance;
    const startY = yFor(startingV);

    let paths = '';
    stepSeries.forEach(s => {
      if (!simLineVisibility[s.name]) return;
      const pts = s.vals.map((v, i) => `${xFor(i)},${yFor(v)}`).join(' ');
      paths += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2" data-name="${s.name}"></polyline>`;
    });

    let xLabels = '';
    [0, Math.floor((n - 1) / 2), n - 1].forEach(i => {
      if (i < 0 || i >= n) return;
      xLabels += `<text x="${xFor(i)}" y="${h-6}" text-anchor="middle">${allDates[i].slice(5)}</text>`;
    });

    wrap.innerHTML = `<svg id="simSvg" width="100%" height="${h}" viewBox="0 0 ${w} ${h}" style="overflow:visible">
      ${gridLines}
      <line class="axis-line" x1="${padL}" x2="${w-padR}" y1="${startY}" y2="${startY}" style="stroke-dasharray:3,3"></line>
      ${paths}
      ${xLabels}
      <rect id="simHoverCatcher" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"></rect>
      <line id="simCrosshair" class="grid-line" x1="0" x2="0" y1="${padT}" y2="${padT+plotH}" style="display:none;stroke-dasharray:3,3"></line>
    </svg>`;

    legendEl.innerHTML = !showLegend ? '' : series.map(s => {
      const off = simLineVisibility[s.name] ? '' : 'off';
      return `<span class="item ${off}" data-name="${s.name}"><span class="swatch" style="background:${s.color}"></span>${s.name}</span>`;
    }).join('');
    legendEl.querySelectorAll('.item').forEach(item => {
      item.onclick = () => {
        simLineVisibility[item.dataset.name] = !simLineVisibility[item.dataset.name];
        renderSimChart(seriesList);
      };
    });

    const svg = document.getElementById('simSvg');
    if (animate !== false) animateSvgDraw(svg);
    const catcher = document.getElementById('simHoverCatcher');
    const crosshair = document.getElementById('simCrosshair');
    catcher.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      const scale = w / rect.width;
      const mx = (e.clientX - rect.left) * scale;
      let idx = Math.round(((mx - padL) / plotW) * (n - 1));
      idx = Math.max(0, Math.min(n - 1, idx));
      const x = xFor(idx);
      crosshair.setAttribute('x1', x); crosshair.setAttribute('x2', x);
      crosshair.style.display = 'block';
      let lines = `<div style="margin-bottom:3px;font-weight:600">${allDates[idx] || 'Start'}</div>`;
      stepSeries.forEach(s => { if (simLineVisibility[s.name]) lines += `<div>${showLegend ? s.name + ': ' : ''}${fmtMoney(s.vals[idx])}</div>`; });
      tooltip.innerHTML = lines;
      tooltip.style.display = 'block';
      tooltip.style.left = (x / scale) + 'px';
      tooltip.style.top = padT + 'px';
    });
    catcher.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; crosshair.style.display = 'none'; });
  }

  // ---- rendering: Monte Carlo fan chart ---------------------------------
  // x-axis is step index (the Nth position), not date -- a reshuffled run
  // has no single real calendar mapping. actualPoints (the real,
  // unshuffled history for this same scenario) lines up 1:1 by index with
  // mc.steps since it's the exact same positions, just not shuffled.
  function renderMonteCarloChart(mc, actualPoints, actualColor, animate) {
    const wrap = document.getElementById('simMcChart');
    const tooltip = document.getElementById('simMcTooltip');
    const legendEl = document.getElementById('simMcLegend');
    if (!mc || !mc.steps.length) { wrap.innerHTML = ''; legendEl.innerHTML = ''; return; }

    const n = mc.steps.length;
    const w = wrap.clientWidth || 600, h = 260, padL = 64, padR = 16, padT = 14, padB = 26;
    const plotW = w - padL - padR, plotH = h - padT - padB;

    const actualVals = actualPoints.slice(0, n).map(p => p.balance);
    const allVals = [0].concat(mc.steps.flatMap(s => [s.p10, s.p90])).concat(actualVals);
    const minV = Math.min(...allVals), maxV = Math.max(...allVals);
    const range = (maxV - minV) || 1;

    const xFor = (i) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const yFor = (v) => padT + plotH - ((v - minV) / range) * plotH;

    let gridLines = '';
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = minV + (range * i / ticks);
      const y = yFor(v);
      gridLines += `<line class="grid-line" x1="${padL}" x2="${w-padR}" y1="${y}" y2="${y}"></line>
        <text x="${padL-8}" y="${y}" text-anchor="end" dominant-baseline="middle">${fmtMoney(v)}</text>`;
    }

    const bandColor = css('--series-1');
    const outerTop = mc.steps.map((s, i) => `${xFor(i)},${yFor(s.p90)}`).join(' ');
    const outerBottom = mc.steps.slice().reverse().map((s, i) => `${xFor(n - 1 - i)},${yFor(s.p10)}`).join(' ');
    const innerTop = mc.steps.map((s, i) => `${xFor(i)},${yFor(s.p75)}`).join(' ');
    const innerBottom = mc.steps.slice().reverse().map((s, i) => `${xFor(n - 1 - i)},${yFor(s.p25)}`).join(' ');
    const medianPts = mc.steps.map((s, i) => `${xFor(i)},${yFor(s.p50)}`).join(' ');
    const actualPts = actualVals.map((v, i) => `${xFor(i)},${yFor(v)}`).join(' ');

    wrap.innerHTML = `<svg id="simMcSvg" width="100%" height="${h}" viewBox="0 0 ${w} ${h}" style="overflow:visible">
      ${gridLines}
      <polygon class="band-outer" points="${outerTop} ${outerBottom}" fill="${bandColor}"></polygon>
      <polygon class="band-inner" points="${innerTop} ${innerBottom}" fill="${bandColor}"></polygon>
      <polyline points="${medianPts}" fill="none" stroke="${css('--text-muted')}" stroke-width="1.5" stroke-dasharray="4,3"></polyline>
      <polyline points="${actualPts}" fill="none" stroke="${actualColor}" stroke-width="2.5"></polyline>
      <rect id="simMcHoverCatcher" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"></rect>
      <line id="simMcCrosshair" class="grid-line" x1="0" x2="0" y1="${padT}" y2="${padT+plotH}" style="display:none;stroke-dasharray:3,3"></line>
    </svg>`;

    legendEl.innerHTML = `
      <span class="item"><span class="swatch" style="background:${actualColor}"></span>Actual history</span>
      <span class="item"><span class="swatch" style="background:${css('--text-muted')}"></span>Median of ${mc.iterations} reorderings</span>
      <span class="item"><span class="swatch" style="background:${bandColor};opacity:.5"></span>25th–75th percentile</span>
      <span class="item"><span class="swatch" style="background:${bandColor};opacity:.28"></span>10th–90th percentile</span>`;

    const svg = document.getElementById('simMcSvg');
    if (animate !== false) animateSvgDraw(svg);
    const catcher = document.getElementById('simMcHoverCatcher');
    const crosshair = document.getElementById('simMcCrosshair');
    catcher.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      const scale = w / rect.width;
      const mx = (e.clientX - rect.left) * scale;
      let idx = Math.round(((mx - padL) / plotW) * (n - 1));
      idx = Math.max(0, Math.min(n - 1, idx));
      const x = xFor(idx);
      crosshair.setAttribute('x1', x); crosshair.setAttribute('x2', x);
      crosshair.style.display = 'block';
      const s = mc.steps[idx];
      tooltip.innerHTML = `<div style="margin-bottom:3px;font-weight:600">Position #${idx}</div>
        <div>Actual: ${fmtMoney(actualVals[idx])}</div>
        <div>90th pct: ${fmtMoney(s.p90)}</div>
        <div>Median: ${fmtMoney(s.p50)}</div>
        <div>10th pct: ${fmtMoney(s.p10)}</div>`;
      tooltip.style.display = 'block';
      tooltip.style.left = (x / scale) + 'px';
      tooltip.style.top = padT + 'px';
    });
    catcher.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; crosshair.style.display = 'none'; });
  }

  // ---- copy-trade simulator: CSV export ---------------------------------
  function ledgerToCsv(rows) {
    const header = ['date', 'account_or_analyst', 'ticker', 'entry', 'net_dollar_result', 'modeled_return_pct', 'risk_amount', 'profit', 'balance_after'];
    const lines = [header.join(',')];
    rows.forEach(r => {
      lines.push([
        r.date, r.analyst, r.ticker, r.entry, r.netDollar,
        r.returnPct.toFixed(2), r.riskAmount.toFixed(2), r.profit.toFixed(2), r.balanceAfter.toFixed(2)
      ].map(v => (typeof v === 'string' && v.includes(',')) ? `"${v}"` : v).join(','));
    });
    return lines.join('\n');
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ---- copy-trade simulator: settings UI --------------------------------
  let simSelectedAnalysts = new Set();
  let simMode = 'blend';
  let simLastResult = null; // { mode, ledgerRows } -- for CSV export

  function populateSimAnalystSelect() {
    const el = document.getElementById('simAnalystChips');
    if (!el) return;
    const names = Array.from(new Set(state.trades.map(t => t.analyst))).sort();
    if (!simSelectedAnalysts.size && names.length) simSelectedAnalysts.add(names[0]);
    // drop any selected name that no longer exists in the data
    Array.from(simSelectedAnalysts).forEach(n => { if (!names.includes(n)) simSelectedAnalysts.delete(n); });

    el.innerHTML = names.map(n => {
      const color = css(state.colorMap[n] || '--series-1');
      const active = simSelectedAnalysts.has(n);
      return `<button type="button" class="chip${active ? ' active' : ''}" data-name="${n}" style="${active ? `background:${color};border-color:${color}` : ''}">${n}</button>`;
    }).join('');

    el.querySelectorAll('.chip').forEach(chip => {
      chip.onclick = () => {
        const n = chip.dataset.name;
        if (simSelectedAnalysts.has(n)) simSelectedAnalysts.delete(n); else simSelectedAnalysts.add(n);
        populateSimAnalystSelect();
        updateSimModeVisibility();
      };
    });
    updateSimModeVisibility();
  }

  function updateSimModeVisibility() {
    const field = document.getElementById('simModeField');
    if (field) field.style.display = simSelectedAnalysts.size > 1 ? '' : 'none';
  }

  function currentSimSettings() {
    return {
      analysts: Array.from(simSelectedAnalysts),
      mode: simMode,
      startingCapital: Math.max(100, Number(document.getElementById('simCapital').value) || 2000),
      sizing: document.getElementById('simSizing').value,
      amount: Math.max(0, Number(document.getElementById('simSizingAmount').value) || 0),
      slippagePct: Number(document.getElementById('simSlippage').value) || 0,
      affordabilityCheck: document.getElementById('simAfford').checked,
      rangeDays: document.getElementById('simRange').value ? Number(document.getElementById('simRange').value) : null,
      benchmark: document.getElementById('simBenchmark').checked,
      monteCarlo: document.getElementById('simMonteCarlo').checked
    };
  }

  function applySimSettings(s) {
    if (!s) return;
    simSelectedAnalysts = new Set(s.analysts || []);
    simMode = s.mode === 'compare' ? 'compare' : 'blend';
    document.getElementById('simCapital').value = s.startingCapital || 2000;
    document.getElementById('simSizing').value = s.sizing || 'fixed';
    document.getElementById('simSizing').onchange();
    document.getElementById('simSizingAmount').value = s.amount != null ? s.amount : (s.sizing === 'fixed' ? 100 : 5);
    document.getElementById('simSlippage').value = String(s.slippagePct != null ? s.slippagePct : 0.05);
    document.getElementById('simAfford').checked = !!s.affordabilityCheck;
    document.getElementById('simRange').value = s.rangeDays ? String(s.rangeDays) : '';
    document.getElementById('simBenchmark').checked = !!s.benchmark;
    document.getElementById('simMonteCarlo').checked = !!s.monteCarlo;
    const modeToggle = document.getElementById('simModeToggle');
    modeToggle.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.mode === simMode));
    populateSimAnalystSelect();
    updateSimModeVisibility();
  }

  function wireSimulator() {
    const capitalInput = document.getElementById('simCapital');
    const rangeSel = document.getElementById('simRange');
    const sizingSel = document.getElementById('simSizing');
    const amountInput = document.getElementById('simSizingAmount');
    const amountLabel = document.getElementById('simSizingAmountLabel');
    const slippageSel = document.getElementById('simSlippage');
    const affordCheckbox = document.getElementById('simAfford');
    const benchmarkCheckbox = document.getElementById('simBenchmark');
    const monteCarloCheckbox = document.getElementById('simMonteCarlo');
    const modeToggle = document.getElementById('simModeToggle');
    const runBtn = document.getElementById('simRunBtn');
    const linkBtn = document.getElementById('simLinkBtn');
    const linkMsg = document.getElementById('simLinkMsg');
    const exportRow = document.getElementById('simExportRow');
    const exportBtn = document.getElementById('simExportBtn');
    const resultsEl = document.getElementById('simResults');
    const chartWrap = document.getElementById('simChartWrap');
    const mcBlock = document.getElementById('simMonteCarloBlock');
    if (!runBtn) return;

    sizingSel.onchange = () => {
      if (sizingSel.value === 'fixed') {
        amountLabel.textContent = '$ per call';
        amountInput.value = 100; amountInput.step = 10; amountInput.min = 1;
      } else {
        amountLabel.textContent = '% per call';
        amountInput.value = 5; amountInput.step = 1; amountInput.min = 1;
      }
    };

    if (modeToggle) {
      modeToggle.querySelectorAll('button').forEach(btn => {
        btn.onclick = () => {
          simMode = btn.dataset.mode;
          modeToggle.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
        };
      });
    }

    function run(opts) {
      const animate = !(opts && opts.silent);
      linkMsg.textContent = '';
      const names = Array.from(simSelectedAnalysts);
      if (!names.length) {
        resultsEl.innerHTML = '<div class="error-text">Pick at least one analyst first.</div>';
        chartWrap.style.display = 'none';
        mcBlock.style.display = 'none';
        exportRow.style.display = 'none';
        simLastResult = null;
        return;
      }
      const startingCapital = Math.max(100, Number(capitalInput.value) || 2000);
      const sizing = sizingSel.value;
      const rawAmount = Math.max(0, Number(amountInput.value) || 0);
      const riskPct = sizing === 'fixed' ? null : rawAmount / 100;
      const fixedAmount = sizing === 'fixed' ? Math.max(1, rawAmount) : null;
      const slippagePct = Number(slippageSel.value) || 0;
      const affordabilityCheck = affordCheckbox.checked;
      const rangeDays = rangeSel.value ? Number(rangeSel.value) : null;
      const mode = names.length > 1 ? simMode : 'blend';
      const wantBenchmark = benchmarkCheckbox.checked;
      const wantMonteCarlo = monteCarloCheckbox.checked && mode === 'blend';

      const sim = MordyParser.simulateCopyTrading(state.trades, names, {
        startingCapital, sizing, riskPct, fixedAmount, slippagePct, affordabilityCheck, rangeDays, mode,
        benchmark: wantBenchmark, monteCarlo: wantMonteCarlo, monteCarloIterations: 400
      });

      const benchSeries = (wantBenchmark && sim.benchmark && sim.benchmark.points.length)
        ? [{ name: 'Split evenly (benchmark)', color: css('--text-muted'), points: sim.benchmark.points }]
        : [];
      const benchNote = (wantBenchmark && sim.benchmark)
        ? `<div class="hint" style="margin-top:8px">Benchmark (split evenly across all analysts): ${fmtMoney(sim.benchmark.finalBalance)}</div>`
        : '';

      if (mode === 'compare') {
        const withPositions = sim.results.filter(r => r.positionsSimulated + r.positionsSkipped > 0);
        if (!withPositions.length) {
          resultsEl.innerHTML = '<div class="error-text">No priced, entry-priced positions found for these analysts in this range.</div>';
          chartWrap.style.display = 'none';
          mcBlock.style.display = 'none';
          exportRow.style.display = 'none';
          simLastResult = null;
          return;
        }
        const rows = sim.results.slice().sort((a, b) => b.finalBalance - a.finalBalance).map(r => {
          const gained = r.finalBalance >= r.startingCapital;
          const color = css(state.colorMap[r.analyst] || '--series-1');
          const dd = fmtDrawdown(r.maxDrawdownPct);
          return `<tr>
            <td class="name-cell"><span class="dot" style="background:${color}"></span>${r.analyst}</td>
            <td class="${gained ? 'pos' : 'neg'}">${fmtMoney(r.finalBalance)}</td>
            <td class="${gained ? 'pos' : 'neg'}">${fmtPct(r.totalReturnPct, 0)}</td>
            <td class="${dd.cls}">${dd.text}</td>
            <td>${fmtNum(r.positionsSimulated)}</td>
            <td>${r.bustedOnDate ? '<span class="error-text" style="font-size:11.5px">busted ' + r.bustedOnDate + '</span>' : '—'}</td>
          </tr>`;
        }).join('');
        resultsEl.innerHTML = `<div class="table-scroll"><table class="sim-compare-table">
          <thead><tr><th>Analyst</th><th>Final Balance</th><th>Return</th><th>Max Drawdown</th><th>Positions</th><th>Busted?</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>${benchNote}`;
        if (animate) resultsEl.querySelector('tbody').classList.add('stagger-in');
        chartWrap.style.display = 'block';
        mcBlock.style.display = 'none';
        renderSimChart(sim.results.map(r => ({ name: r.analyst, color: css(state.colorMap[r.analyst] || '--series-1'), points: r.points })).concat(benchSeries), animate);
        simLastResult = { mode: 'compare', rows: sim.results.flatMap(r => r.ledger.map(row => Object.assign({}, row, { analyst: r.analyst }))) };
      } else {
        if (!sim.positionsSimulated) {
          resultsEl.innerHTML = '<div class="error-text">No priced, entry-priced positions found for this selection in this range.</div>';
          chartWrap.style.display = 'none';
          mcBlock.style.display = 'none';
          exportRow.style.display = 'none';
          simLastResult = null;
          return;
        }
        const gained = sim.finalBalance >= sim.startingCapital;
        const dd = fmtDrawdown(sim.maxDrawdownPct);
        const bustedBanner = sim.bustedOnDate ? `<div class="busted-banner">Account hit $0 on ${sim.bustedOnDate} and couldn't keep trading — ${sim.positionsSkipped} later call(s) had to be skipped.</div>` : '';
        const breakdown = names.length > 1
          ? `<div class="hint" style="margin-top:10px">Contribution: ${names.map(n => `${n} ${fmtMoney(sim.perAnalystProfit[n] || 0, {plus:true})}`).join(' · ')}</div>`
          : '';
        resultsEl.innerHTML = `${bustedBanner}<div class="tiles">
          <div class="tile"><div class="label">Final Balance</div><div class="value ${gained ? 'pos' : 'neg'}">${fmtMoney(sim.finalBalance)}</div><div class="hint" style="margin-top:2px">from ${fmtMoney(sim.startingCapital)} start</div></div>
          <div class="tile"><div class="label">Total Return</div><div class="value ${gained ? 'pos' : 'neg'}">${fmtPct(sim.totalReturnPct, 0)}</div></div>
          <div class="tile"><div class="label">Max Drawdown</div><div class="value ${dd.cls}">${dd.text}</div><div class="hint" style="margin-top:2px">worst dip from a high point</div></div>
          <div class="tile"><div class="label">Positions Simulated</div><div class="value">${fmtNum(sim.positionsSimulated)}</div>${sim.positionsSkipped ? `<div class="hint" style="margin-top:2px">${sim.positionsSkipped} skipped (unaffordable)</div>` : ''}</div>
        </div>${breakdown}${benchNote}`;
        if (animate) { resultsEl.querySelector('.tiles').classList.add('stagger-in'); animateTiles(resultsEl); }
        chartWrap.style.display = 'block';
        const mainColor = css(state.colorMap[names[0]] || '--series-1');
        renderSimChart([{ name: names.length > 1 ? 'Blended' : names[0], color: mainColor, points: sim.points }].concat(benchSeries), animate);

        if (wantMonteCarlo && sim.monteCarlo && sim.monteCarlo.iterations) {
          mcBlock.style.display = 'block';
          const mc = sim.monteCarlo;
          document.getElementById('simMonteCarloSummary').innerHTML =
            `Reshuffled these same ${sim.positionsSimulated} trades ${mc.iterations} times. Median outcome: ${fmtMoney(mc.medianFinal)} ·
             unlucky (10th pct): ${fmtMoney(mc.p10Final)} · lucky (90th pct): ${fmtMoney(mc.p90Final)} ·
             busted the account in ${(mc.bustedFraction * 100).toFixed(0)}% of orderings.`;
          renderMonteCarloChart(mc, sim.points, mainColor, animate);
        } else {
          mcBlock.style.display = 'none';
        }
        simLastResult = { mode: 'blend', rows: sim.ledger };
      }

      exportRow.style.display = simLastResult && simLastResult.rows.length ? 'block' : 'none';
    }

    exportBtn.onclick = () => {
      if (!simLastResult || !simLastResult.rows.length) return;
      downloadText('copy-trade-simulation.csv', ledgerToCsv(simLastResult.rows));
    };

    linkBtn.onclick = async () => {
      const settings = currentSimSettings();
      const token = MordyParser.encodeScenario(settings);
      const url = `${location.origin}${location.pathname}?scenario=${token}`;
      linkMsg.classList.remove('copied');
      try {
        await navigator.clipboard.writeText(url);
        linkMsg.textContent = 'Link copied to clipboard.';
        linkMsg.classList.add('copied');
      } catch (e) {
        linkMsg.innerHTML = `Copy this link: <span style="word-break:break-all">${url}</span>`;
      }
    };

    runBtn.onclick = () => {
      runBtn.classList.add('is-loading');
      setTimeout(() => { run(); runBtn.classList.remove('is-loading'); }, 220);
    };
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (chartWrap.style.display !== 'none') run({ silent: true }); }, 120);
    });

    return run;
  }

  function restoreScenarioFromURL(run) {
    const token = new URLSearchParams(location.search).get('scenario');
    if (!token) return;
    const settings = MordyParser.decodeScenario(token);
    if (!settings) return;
    applySimSettings(settings);
    if (run) run();
  }

  // ---- master render ---------------------------------------------------
  function renderAll() {
    const trades = filteredTrades();
    const stats = MordyParser.computeStats(trades);
    renderFilters();
    renderTiles(stats);
    renderTable(stats);
    renderBarChart(stats);
    renderLineChart(trades, stats);
    renderDetail(trades, stats);
    populateSimAnalystSelect();
    const rangeLabel = state.rangeDays ? `last ${state.rangeDays} days` : 'all tracked days';
    document.getElementById('rangeNote').textContent = `Showing ${rangeLabel} · ${fmtNum(trades.length)} calls posted (${fmtNum(stats.reduce((s,x)=>s+x.trades,0))} distinct trades — see "Trades" tooltip) · updated through ${maxDate(state.trades) || '—'}`;
  }

  let pageResizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(pageResizeTimer);
    pageResizeTimer = setTimeout(() => {
      renderBarChart(MordyParser.computeStats(filteredTrades()), false);
      renderLineChart(filteredTrades(), MordyParser.computeStats(filteredTrades()), false);
    }, 120);
  });

  // ---- data loading ------------------------------------------------------
  async function loadData() {
    try {
      const res = await fetch(CONFIG.DATA_URL, { cache: 'no-store' });
      const json = await res.json();
      state.trades = json.trades || [];
      state.dailySummaries = json.dailySummaries || [];
    } catch (e) {
      state.trades = [];
      state.dailySummaries = [];
      console.error('Failed to load data.json', e);
    }
    state.colorMap = buildColorMap(state.trades);
    renderAll();
  }

  // ---- admin: real server-checked login -----------------------------------
  async function checkSession() {
    try {
      const res = await fetch('/api/session', { credentials: 'same-origin' });
      const json = await res.json();
      return !!json.loggedIn;
    } catch (e) {
      return false;
    }
  }

  function wireAdminUI() {
    const openBtn = document.getElementById('adminOpenBtn');
    const gateModal = document.getElementById('adminGateModal');
    const gateClose = document.getElementById('gateCloseBtn');
    const gateUser = document.getElementById('gateUsername');
    const gateInput = document.getElementById('gatePassword');
    const gateSubmit = document.getElementById('gateSubmit');
    const gateError = document.getElementById('gateError');

    const adminModal = document.getElementById('adminModal');
    const adminClose = document.getElementById('adminCloseBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const pasteArea = document.getElementById('pasteArea');
    const parseBtn = document.getElementById('parseBtn');
    const parseMsg = document.getElementById('parseMsg');
    const previewList = document.getElementById('previewList');
    const validateBox = document.getElementById('validateBox');
    const mergeBtn = document.getElementById('mergeBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const dropZone = document.getElementById('dropZone');
    const dropZoneLabel = document.getElementById('dropZoneLabel');
    const fileInput = document.getElementById('fileInput');
    const browseLink = document.getElementById('browseLink');

    function loadFile(file) {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        pasteArea.value = String(reader.result || '');
        dropZoneLabel.textContent = `Loaded "${file.name}" (${(file.size / 1024).toFixed(0)} KB) — click Parse below`;
        parseMsg.innerHTML = '';
      };
      reader.onerror = () => {
        parseMsg.innerHTML = '<div class="error-text">Could not read that file.</div>';
      };
      reader.readAsText(file);
    }

    browseLink.onclick = (e) => { e.preventDefault(); fileInput.click(); };
    fileInput.onchange = () => { if (fileInput.files[0]) loadFile(fileInput.files[0]); };
    ['dragenter', 'dragover'].forEach((evt) => {
      dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    });
    ['dragleave', 'drop'].forEach((evt) => {
      dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.remove('drag-over'); });
    });
    dropZone.addEventListener('drop', (e) => {
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) loadFile(file);
    });

    openBtn.onclick = async () => {
      if (state.adminUnlocked || (await checkSession())) {
        state.adminUnlocked = true;
        adminModal.classList.add('open');
      } else {
        gateModal.classList.add('open');
        gateUser.value = ''; gateInput.value = ''; gateError.textContent = '';
        gateUser.focus();
      }
    };
    gateClose.onclick = () => gateModal.classList.remove('open');
    adminClose.onclick = () => adminModal.classList.remove('open');

    async function submitLogin() {
      gateSubmit.disabled = true;
      gateError.textContent = '';
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: gateUser.value, password: gateInput.value })
        });
        const json = await res.json();
        if (json.ok) {
          state.adminUnlocked = true;
          gateModal.classList.remove('open');
          adminModal.classList.add('open');
        } else {
          gateError.textContent = json.error || 'Login failed.';
        }
      } catch (e) {
        gateError.textContent = 'Could not reach the login API. Is this deployed on Cloudflare Pages with the functions/ folder, not plain GitHub Pages?';
      }
      gateSubmit.disabled = false;
    }
    gateSubmit.onclick = submitLogin;
    gateInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitLogin(); });
    gateUser.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitLogin(); });

    logoutBtn.onclick = async () => {
      try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) {}
      state.adminUnlocked = false;
      adminModal.classList.remove('open');
    };

    parseBtn.onclick = () => {
      validateBox.innerHTML = '';
      const raw = pasteArea.value.trim();
      if (!raw) { parseMsg.innerHTML = '<div class="error-text">Paste some recap text/HTML first.</div>'; return; }
      let result;
      try {
        result = MordyParser.parseRecapText(raw);
      } catch (e) {
        parseMsg.innerHTML = '<div class="error-text">Could not parse that: ' + e.message + '</div>';
        return;
      }

      // Cross-check what we just parsed against the channel's OWN posted
      // daily footer (and against a per-line marker count) -- this is the
      // "prove it's accurate" ask: not a guarantee, but a second signal
      // independent of our own regexes that catches most real mistakes
      // instead of just trusting the parser. Runs on everything this paste
      // produced, before dedup, since the footer covers the whole day.
      const validation = MordyParser.validateParse(result.trades, result.dailySummaries, result.unparsedWarnings);
      const warnCount = validation.issues.filter(i => i.severity === 'warn').length;
      validateBox.innerHTML = !validation.issues.length ? '' : `
        <div class="validate-box ${warnCount ? 'validate-warn' : 'validate-info'}">
          <div class="validate-head">${warnCount
            ? `Cross-check found ${warnCount} thing${warnCount === 1 ? '' : 's'} that don't add up against the channel's own posted totals — take a look before merging:`
            : 'No mismatches against the channel\'s own posted totals — just a note:'}</div>
          <ul>${validation.issues.map(i => `<li class="${i.severity === 'warn' ? 'neg' : 'muted-cell'}">${i.message}</li>`).join('')}</ul>
        </div>`;

      const existingKeys = new Set(state.trades.map(MordyParser.dedupeKey));
      const newTrades = result.trades.filter(t => !existingKeys.has(MordyParser.dedupeKey(t)));
      const dupeCount = result.trades.length - newTrades.length;
      state.pendingParsed = { trades: newTrades, dailySummaries: result.dailySummaries };

      if (!newTrades.length) {
        parseMsg.innerHTML = `<div class="error-text">Found ${result.trades.length} call(s) but all already exist in the current data (0 new). Nothing to merge.</div>`;
        previewList.innerHTML = '';
        mergeBtn.disabled = true;
        return;
      }
      parseMsg.innerHTML = `<div class="ok-text">Found ${newTrades.length} new call(s)${dupeCount ? ' (' + dupeCount + ' already tracked, skipped)' : ''} across ${new Set(newTrades.map(t=>t.date)).size} day(s).</div>`;
      previewList.innerHTML = newTrades.slice(0, 200).map(t => `
        <div class="row">
          <span>${t.date} · ${t.analyst} · $${t.ticker}</span>
          <span class="${t.win?'pos':'neg'}">${t.win?'WIN':'LOSS'} ${t.dollar!=null?fmtMoney(t.dollar):''}</span>
        </div>`).join('');
      mergeBtn.disabled = false;
    };

    // Shared by the Merge button and by Publish/Download as a safety net --
    // if there's parsed data sitting in state.pendingParsed that never got
    // explicitly merged, folding it in here means clicking Publish can never
    // silently skip it. Returns how many trades it merged (0 if none pending).
    function mergePending() {
      if (!state.pendingParsed || !state.pendingParsed.trades.length) return 0;
      const count = state.pendingParsed.trades.length;
      state.trades = state.trades.concat(state.pendingParsed.trades);
      const existingDates = new Set(state.dailySummaries.map(d => d.date));
      state.pendingParsed.dailySummaries.forEach(d => {
        if (!existingDates.has(d.date)) state.dailySummaries.push(d);
      });
      state.colorMap = buildColorMap(state.trades);
      mergeBtn.disabled = true;
      state.pendingParsed = null;
      renderAll();
      return count;
    }

    mergeBtn.onclick = () => {
      const count = mergePending();
      if (!count) return;
      parseMsg.innerHTML = '<div class="ok-text">Merged into the live view below. Click "Publish to GitHub" to make it live for everyone (or download it and commit it yourself).</div>';
    };

    downloadBtn.onclick = () => {
      mergePending();
      const payload = JSON.stringify({ trades: state.trades, dailySummaries: state.dailySummaries }, null, 1);
      const blob = new Blob([payload], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'data.json';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    };

    const publishBtn = document.getElementById('publishBtn');
    const publishMsg = document.getElementById('publishMsg');
    publishBtn.onclick = async () => {
      const autoMerged = mergePending();
      publishBtn.disabled = true;
      publishBtn.textContent = 'Publishing…';
      publishMsg.innerHTML = '';
      const tradeCountBefore = state.trades.length;
      try {
        const res = await fetch('/api/publish', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trades: state.trades, dailySummaries: state.dailySummaries })
        });
        const json = await res.json();
        if (json.ok) {
          const mergedNote = autoMerged ? ` (included ${autoMerged} new call${autoMerged === 1 ? '' : 's'} you hadn't clicked "Merge into page" for yet)` : '';
          publishMsg.innerHTML = `<div class="ok-text">Published ${fmtNum(tradeCountBefore)} total trades${mergedNote}${json.commitUrl ? ' — <a href="' + json.commitUrl + '" target="_blank" rel="noopener">view commit</a>' : ''}. Cloudflare will redeploy in under a minute.</div>`;
        } else {
          publishMsg.innerHTML = `<div class="error-text">${json.error || 'Publish failed.'}</div>`;
        }
      } catch (e) {
        publishMsg.innerHTML = '<div class="error-text">Could not reach the publish API. Is GITHUB_TOKEN / GITHUB_REPO set on this Worker?</div>';
      }
      publishBtn.disabled = false;
      publishBtn.textContent = 'Publish to GitHub';
    };
  }

  document.addEventListener('DOMContentLoaded', async () => {
    wireAdminUI();
    const runSim = wireSimulator();
    await loadData();
    restoreScenarioFromURL(runSim);
  });
})();

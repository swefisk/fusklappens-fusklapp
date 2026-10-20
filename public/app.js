(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  // ------------------------------------------------------------ preferences
  const load = (k, d) => { try { return localStorage.getItem('ss.' + k) ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem('ss.' + k, v); } catch { /* storage unavailable */ } };
  let show;
  try { show = JSON.parse(load('show', 'null')); } catch { show = null; }

  const state = {
    ticker: null, company: null, prices: null, levels: null,
    range: load('range', '1y'),
    period: load('period', 'annual'),
    stmt: 'income',
    explain: load('explain', '1') === '1',
    sens: load('sens', 'med'),
    tsens: load('tsens', 'med'),
    trend: null,
    show: Object.assign({ trend: true, levels: true, sma50: true, sma200: true, volume: true, rsi: true }, show || {}),
  };

  // ------------------------------------------------------------ formatting
  const isNum = v => v !== null && v !== undefined && Number.isFinite(v);
  const MINUS = '−';
  function compact(v, prefix = '') {
    if (!isNum(v)) return '—';
    const a = Math.abs(v), s = v < 0 ? MINUS : '';
    for (const [n, l] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
      if (a >= n) { const x = a / n; return `${s}${prefix}${x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2)}${l}`; }
    }
    return `${s}${prefix}${a.toFixed(a >= 100 ? 0 : 2)}`;
  }
  const money = v => compact(v, '$');
  const pct = (v, dp = 1) => (isNum(v) ? (v < 0 ? MINUS : '') + Math.abs(v * 100).toFixed(dp) + '%' : '—');
  const signedPct = (v, dp = 1) => (isNum(v) ? (v > 0 ? '+' : v < 0 ? MINUS : '') + Math.abs(v * 100).toFixed(dp) + '%' : '—');
  const times = v => (isNum(v) ? (v < 0 ? MINUS : '') + Math.abs(v).toFixed(1) + '×' : '—');
  const usd = v => (isNum(v) ? (v < 0 ? MINUS : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—');
  const fmtUnit = (v, unit) => (unit === 'eps' ? usd(v) : unit === 'shares' ? compact(v) : money(v));
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (t, opts = { month: 'short', day: 'numeric', year: 'numeric' }) => new Date(t * 1000).toLocaleDateString('en-US', opts);
  const yoy = (cur, prev) => (isNum(cur) && isNum(prev) && prev !== 0 ? (cur - prev) / Math.abs(prev) : null);
  const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  // ------------------------------------------------------------ statement layouts
  // [key, label, plain-English note, options]  options: bold, inverse (up = bad), neutral, unit
  const LAYOUT = {
    income: {
      intro: 'What the company earned and spent over the period, from sales at the top down to profit at the bottom.',
      rows: [
        ['revenue', 'Revenue', 'Total sales: all the money customers paid for products and services.', { bold: true }],
        ['costOfRevenue', 'Cost of revenue', 'Direct cost of what was sold (materials, manufacturing, hosting).', { inverse: true }],
        ['grossProfit', 'Gross profit', 'Revenue minus cost of revenue: what is left to pay for everything else.', { bold: true }],
        ['rnd', 'Research & development', 'Spending on new products and technology.', { neutral: true }],
        ['sga', 'Selling, general & admin', 'Marketing, sales teams, offices and management.', { inverse: true }],
        ['operatingIncome', 'Operating income', 'Profit from the core business, before interest and taxes.', { bold: true }],
        ['ebitda', 'EBITDA', 'Operating income plus depreciation & amortization: a rough measure of operating cash earnings.', {}],
        ['interestExpense', 'Interest expense', 'What the company pays on its borrowings.', { inverse: true }],
        ['pretaxIncome', 'Pre-tax income', 'Profit after all costs and interest, before income tax.', {}],
        ['incomeTax', 'Income tax', 'Taxes on the period\'s profit.', { neutral: true }],
        ['netIncome', 'Net income', 'The bottom line: profit that belongs to shareholders.', { bold: true }],
        ['epsDiluted', 'EPS (diluted)', 'Net income per share, counting options and convertible securities as shares.', { bold: true, unit: 'eps' }],
        ['sharesDiluted', 'Diluted shares', 'Average number of shares. Falling = buybacks; rising = dilution of existing owners.', { inverse: true, unit: 'shares' }],
      ],
    },
    balance: {
      intro: 'A snapshot of what the company owns (assets) and owes (liabilities) on the last day of the period. Assets = liabilities + equity.',
      rows: [
        ['cash', 'Cash & equivalents', 'Money in the bank and very short-term holdings.', {}],
        ['shortTermInvestments', 'Short-term investments', 'Bonds and securities that can be sold quickly.', {}],
        ['receivables', 'Accounts receivable', 'Money customers still owe for things already delivered.', { neutral: true }],
        ['inventory', 'Inventory', 'Products and materials waiting to be sold.', { neutral: true }],
        ['currentAssets', 'Total current assets', 'Everything expected to turn into cash within a year.', { bold: true }],
        ['totalAssets', 'Total assets', 'Everything the company owns, including factories, patents and goodwill.', { bold: true }],
        ['accountsPayable', 'Accounts payable', 'Bills owed to suppliers.', { neutral: true }],
        ['currentLiabilities', 'Total current liabilities', 'Obligations due within a year.', { bold: true, neutral: true }],
        ['shortTermDebt', 'Current portion of debt', 'Loans and bonds that must be repaid within a year.', { inverse: true }],
        ['commercialPaper', 'Commercial paper / short borrowings', 'Very short-term IOUs, usually rolled over continuously.', { inverse: true }],
        ['longTermDebt', 'Long-term debt', 'Loans and bonds due in more than a year.', { inverse: true }],
        ['totalDebt', 'Total debt', 'All interest-bearing borrowings added together.', { bold: true, inverse: true }],
        ['totalLiabilities', 'Total liabilities', 'Everything the company owes, debt and non-debt.', { bold: true, inverse: true }],
        ['equity', "Shareholders' equity", 'Assets minus liabilities: the accounting value that belongs to owners (book value).', { bold: true }],
        ['netDebt', 'Net debt', 'Total debt minus cash and short-term investments. Negative = more cash than debt.', { inverse: true }],
      ],
    },
    cash: {
      intro: 'Where cash actually came from and went. Unlike profit, cash is hard to dress up, so this is often the most honest statement.',
      rows: [
        ['operatingCF', 'Operating cash flow', 'Cash produced by day-to-day business.', { bold: true }],
        ['capex', 'Capital expenditures', 'Cash spent on buildings, equipment and data centers (shown as a positive amount spent).', { neutral: true }],
        ['fcf', 'Free cash flow', 'Operating cash flow minus capex: cash available for dividends, buybacks, paying debt or acquisitions.', { bold: true }],
        ['investingCF', 'Investing cash flow', 'Net cash used for investments (capex, acquisitions, buying or selling securities).', { neutral: true }],
        ['financingCF', 'Financing cash flow', 'Net cash from borrowing and repaying debt, issuing or buying back shares, and dividends.', { neutral: true }],
        ['dividendsPaid', 'Dividends paid', 'Cash paid directly to shareholders.', { neutral: true }],
        ['buybacks', 'Share buybacks', 'Cash spent buying back the company\'s own shares.', { neutral: true }],
        ['sbc', 'Stock-based compensation', 'Employee pay given as shares. It is a real cost, but no cash leaves the company.', { inverse: true }],
        ['da', 'Depreciation & amortization', 'Accounting cost that spreads past investments over their useful life.', { neutral: true }],
      ],
    },
  };

  // ------------------------------------------------------------ data
  async function api(path) {
    const r = await fetch(path);
    const j = await r.json().catch(() => ({ error: `Unexpected response (HTTP ${r.status})` }));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  function setStatus(kind, msg) {
    const el = $('#status');
    el.hidden = !kind;
    el.className = 'status ' + (kind || '');
    el.textContent = msg || '';
  }

  let loadSeq = 0;
  async function loadTicker(raw) {
    const t = String(raw || '').trim().toUpperCase().replace(/\./g, '-');
    if (!t) return;
    const seq = ++loadSeq;
    state.ticker = t;
    if (decodeURIComponent(location.hash.slice(1)) !== t) history.replaceState(null, '', '#' + encodeURIComponent(t));
    $('#q').value = t;
    document.title = `${t} · Fusklappens fusklapp`;
    // Futures (GC=F), indexes (^GSPC) and the like have no SEC filings - chart only.
    const priceOnly = /[=^]/.test(t);
    setStatus('loading', priceOnly ? `Loading ${t} price history…` : `Loading ${t} - fetching SEC filings and price history…`);
    $('#app').classList.add('is-loading');
    const [co, px] = await Promise.allSettled([
      priceOnly ? Promise.resolve(null) : api('/api/company/' + encodeURIComponent(t)),
      api(`/api/prices/${encodeURIComponent(t)}?range=${state.range}`),
    ]);
    if (seq !== loadSeq) return;
    $('#app').classList.remove('is-loading');
    state.company = co.status === 'fulfilled' ? co.value : null;
    state.prices = px.status === 'fulfilled' ? px.value : null;
    if (!state.company && !state.prices) {
      setStatus('error', co.reason?.message || px.reason?.message || 'Could not load that ticker.');
      $('#results').hidden = true;
      $('#welcome').hidden = false;
      return;
    }
    if (!state.company && priceOnly) setStatus(null);
    else if (!state.company) setStatus('warn', `Price chart only - financial statements unavailable: ${co.reason?.message}`);
    else if (!state.prices) setStatus('warn', `Financials only - price data unavailable: ${px.reason?.message}`);
    else setStatus(null);
    $('#welcome').hidden = true;
    $('#results').hidden = false;
    renderAll();
  }

  async function changeRange(range) {
    state.range = range;
    save('range', range);
    syncControls();
    if (!state.ticker) return;
    try {
      state.prices = await api(`/api/prices/${encodeURIComponent(state.ticker)}?range=${range}`);
      renderChart();
    } catch (e) {
      setStatus('warn', `Could not load ${range} prices: ${e.message}`);
    }
  }

  // ------------------------------------------------------------ render: header
  function renderAll() {
    syncControls();
    renderHeader();
    renderChart();
    const hasFin = !!state.company;
    $('.fin-only').hidden = !hasFin;
    if (hasFin) {
      renderSnapshot();
      renderRatios();
      renderHighlights();
      renderStatement();
    }
  }

  function renderHeader() {
    const c = state.company, q = c?.quote || state.prices?.meta || {};
    const name = c?.name || q.name || state.ticker;
    const chg = isNum(q.price) && isNum(q.previousClose) ? q.price - q.previousClose : null;
    const chgPct = isNum(chg) ? chg / q.previousClose : null;
    const dir = chg > 0 ? 'up' : chg < 0 ? 'down' : '';
    const pos52 = isNum(q.high52) && isNum(q.low52) && q.high52 > q.low52 ? (q.price - q.low52) / (q.high52 - q.low52) : null;
    const stats = [];
    if (c) {
      stats.push(['Market cap', money(c.marketCap)]);
      stats.push(['Enterprise value', money(c.enterpriseValue)]);
      stats.push(['Shares outstanding', compact(c.shares)]);
    }
    if (isNum(pos52)) {
      stats.push(['52-week range', `${usd(q.low52)} – ${usd(q.high52)}<div class="range52" title="Where today's price sits in the 52-week range"><i style="left:${(pos52 * 100).toFixed(1)}%"></i></div>`]);
    }
    if (!c && isNum(q.dayLow) && isNum(q.dayHigh)) stats.unshift(['Day range', `${usd(q.dayLow)} – ${usd(q.dayHigh)}`]);
    if (q.assetType === 'commodity') stats.unshift(['Contract', esc(q.contract || q.symbol)]);
    if (c?.filing) {
      stats.push(['Latest filing', `<a href="${esc(c.secUrl)}" target="_blank" rel="noopener">${esc(c.filing.form)} · ${new Date(c.filing.filed + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</a>`]);
    }
    $('#company').innerHTML = `
      <div class="co-name">
        <h1>${esc(name)}</h1>
        <div class="co-meta"><span class="tick">${esc(state.ticker)}</span>${q.assetType === 'commodity' ? ' · Commodity futures' : ''}${q.exchange ? ' · ' + esc(q.exchange) : ''}${q.currency ? ' · ' + esc(q.currency) : ''}${q.unit ? ' ' + esc(q.unit) : ''}</div>
        <div class="co-price"><span class="px">${usd(q.price)}</span>
          ${isNum(chg) ? `<span class="delta ${dir}">${chg > 0 ? '▲' : chg < 0 ? '▼' : ''} ${usd(Math.abs(chg)).replace(MINUS, '')} (${signedPct(chgPct, 2)})</span><span class="muted sub">today</span>` : ''}
        </div>
      </div>
      <div class="stats">${stats.map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')}</div>`;
  }

  // ------------------------------------------------------------ render: price chart
  let mainChart = null, rsiChart = null;
  function destroyCharts() {
    mainChart?.remove(); rsiChart?.remove();
    mainChart = rsiChart = null;
  }

  function renderChart() {
    destroyCharts();
    const P = state.prices;
    $('#chart-card').hidden = !P || !P.bars?.length;
    if ($('#chart-card').hidden) return;
    const LC = window.LightweightCharts;
    if (!LC) {
      $('#price-chart').innerHTML = '<p class="lv-empty">The chart library could not be loaded (needs an internet connection to unpkg.com).</p>';
      return;
    }
    const bars = P.bars;
    const daily = P.meta.interval === '1d';
    const base = {
      autoSize: true,
      layout: { background: { type: 'solid', color: cssVar('--surface-1') }, textColor: cssVar('--text-muted'), fontFamily: getComputedStyle(document.body).fontFamily, fontSize: 11 },
      grid: { vertLines: { color: cssVar('--grid') }, horzLines: { color: cssVar('--grid') } },
      rightPriceScale: { borderColor: cssVar('--axis'), minimumWidth: 76 },
      timeScale: { borderColor: cssVar('--axis'), rightOffset: 3 },
      crosshair: { mode: LC.CrosshairMode.Normal },
      // Let the mouse wheel scroll the page; drag to pan, drag the axes (or pinch) to zoom.
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true },
      localization: { priceFormatter: p => '$' + p.toFixed(2) },
    };
    mainChart = LC.createChart($('#price-chart'), { ...base, timeScale: { ...base.timeScale, visible: !state.show.rsi } });
    const up = cssVar('--up'), down = cssVar('--down');
    const trend = state.show.trend ? TA.trendAnalysis(bars, state.tsens) : null;
    state.trend = trend;
    if (trend) {
      // Background shading for each trend regime, added first so it sits behind the candles.
      const shade = mainChart.addHistogramSeries({ priceScaleId: 'regime', base: 0, lastValueVisible: false, priceLineVisible: false });
      mainChart.priceScale('regime').applyOptions({ scaleMargins: { top: 0, bottom: 0 }, visible: false });
      const us = cssVar('--up-shade'), ds = cssVar('--down-shade');
      shade.setData(trend.points.map(p => ({ time: p.time, value: 1, color: p.dir > 0 ? us : ds })));
    }
    const candles = mainChart.addCandlestickSeries({ upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false, priceLineColor: cssVar('--text-muted') });
    candles.setData(bars);

    if (state.show.volume) {
      const vol = mainChart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
      mainChart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      const us = cssVar('--up-soft'), ds = cssVar('--down-soft');
      vol.setData(bars.map(b => ({ time: b.time, value: b.volume, color: b.close >= b.open ? us : ds })));
    }
    const line = color => ({ color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    if (state.show.sma50) mainChart.addLineSeries(line(cssVar('--sma50'))).setData(TA.sma(bars, 50));
    if (state.show.sma200) mainChart.addLineSeries(line(cssVar('--sma200'))).setData(TA.sma(bars, 200));

    if (trend) {
      // Trailing trend line (the level that would flip the trend), green under price / red above it.
      // One series per stretch, so the line breaks cleanly where the trend flips.
      const stretches = [];
      for (const p of trend.points) {
        const s = stretches[stretches.length - 1];
        if (s && s.dir === p.dir) s.pts.push({ time: p.time, value: p.line });
        else stretches.push({ dir: p.dir, pts: [{ time: p.time, value: p.line }] });
      }
      for (const s of stretches) mainChart.addLineSeries({ ...line(s.dir > 0 ? up : down), lineWidth: 2 }).setData(s.pts);
      // Trendlines through rising lows (uptrend) or falling highs (downtrend).
      for (const t of trend.trendlines) {
        mainChart.addLineSeries({ ...line(t.dir > 0 ? up : down), lineWidth: t.current ? 2 : 1, lineStyle: LC.LineStyle.Dashed, autoscaleInfoProvider: () => null })
          .setData([{ time: t.t1, value: t.p1 }, { time: t.t2, value: t.p2 }]);
      }
      candles.setMarkers(trend.signals.map(s => ({
        time: s.time, position: s.type === 'buy' ? 'belowBar' : 'aboveBar', color: s.type === 'buy' ? up : down,
        shape: s.type === 'buy' ? 'arrowUp' : 'arrowDown', text: s.type === 'buy' ? 'Buy' : 'Sell',
      })));
    }
    const trendAt = new Map(trend ? trend.points.map(p => [p.time, p.dir]) : []);

    state.levels = TA.findLevels(bars, state.sens);
    if (state.show.levels) {
      const draw = (l, i, kind) => candles.createPriceLine({
        price: l.price, color: cssVar(kind === 'R' ? '--resistance' : '--support'), lineWidth: l.strength,
        lineStyle: l.strength === 1 ? LC.LineStyle.Dashed : LC.LineStyle.Solid, axisLabelVisible: true, title: kind + (i + 1),
      });
      state.levels.resistance.forEach((l, i) => draw(l, i, 'R'));
      state.levels.support.forEach((l, i) => draw(l, i, 'S'));
    }

    // OHLC legend that follows the crosshair (latest bar by default).
    const idx = new Map(bars.map((b, i) => [b.time, i]));
    const legend = $('#ohlc-legend');
    const setLegend = i => {
      const b = bars[i], prev = bars[i - 1];
      const ch = prev ? (b.close - prev.close) / prev.close : null;
      legend.innerHTML = `<span>${fmtDate(b.time)}</span><span>O <b>${b.open.toFixed(2)}</b></span><span>H <b>${b.high.toFixed(2)}</b></span><span>L <b>${b.low.toFixed(2)}</b></span><span>C <b>${b.close.toFixed(2)}</b></span>` +
        (isNum(ch) ? `<span class="${ch >= 0 ? 'up' : 'down'}">${signedPct(ch, 2)}</span>` : '') + (b.volume ? `<span>Vol <b>${compact(b.volume)}</b></span>` : '') +
        (trendAt.has(b.time) ? `<span class="${trendAt.get(b.time) > 0 ? 'up' : 'down'}">${trendAt.get(b.time) > 0 ? '▲ Buy trend' : '▼ Sell trend'}</span>` : '');
    };
    setLegend(bars.length - 1);
    mainChart.subscribeCrosshairMove(p => setLegend(p.time && idx.has(p.time) ? idx.get(p.time) : bars.length - 1));

    $('#rsi-wrap').hidden = !state.show.rsi;
    const rsiData = TA.rsi(bars);
    if (state.show.rsi) {
      rsiChart = LC.createChart($('#rsi-chart'), { ...base, rightPriceScale: { ...base.rightPriceScale, scaleMargins: { top: 0.12, bottom: 0.08 } }, localization: { priceFormatter: p => p.toFixed(0) } });
      const rs = rsiChart.addLineSeries({ color: cssVar('--series-1'), lineWidth: 2, priceLineVisible: false, autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
      // Pad with whitespace so both charts have the same number of bars and stay aligned.
      const pad = bars.slice(0, bars.length - rsiData.length).map(b => ({ time: b.time }));
      rs.setData([...pad, ...rsiData]);
      for (const lvl of [70, 30]) rs.createPriceLine({ price: lvl, color: cssVar('--axis'), lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: true, title: '' });
      let syncing = false;
      const link = (a, b) => a.timeScale().subscribeVisibleLogicalRangeChange(r => {
        if (syncing || !r) return;
        syncing = true; b.timeScale().setVisibleLogicalRange(r); syncing = false;
      });
      link(mainChart, rsiChart); link(rsiChart, mainChart);
      mainChart.subscribeCrosshairMove(p => {
        if (!rsiChart) return;
        if (p.time) rsiChart.setCrosshairPosition(NaN, p.time, rs); else rsiChart.clearCrosshairPosition();
      });
    }
    mainChart.timeScale().fitContent();
    renderLevels(bars, rsiData, daily);
  }

  function strengthHtml(s) {
    const label = ['', 'weak', 'moderate', 'strong'][s];
    return `<span class="strength" title="${label} level" aria-label="${label}"><b>${'●'.repeat(s)}</b><span>${'●'.repeat(3 - s)}</span></span> ${label}`;
  }

  function trendPanel() {
    const T = state.trend;
    if (!T) return '';
    const c = T.current, up = c.dir > 0;
    const a = c.adx;
    const strength = !isNum(a) ? '—' : a < 20 ? `Weak / choppy (ADX ${a.toFixed(0)})` : a < 40 ? `Established (ADX ${a.toFixed(0)})` : `Very strong (ADX ${a.toFixed(0)})`;
    const rows = [
      [c.fromStart ? 'Since (start of chart)' : 'Started', `${fmtDate(c.since)} at ${usd(c.startPrice)}`],
      ['Move since then', `<span class="${c.change >= 0 ? 'pos' : 'neg'}">${signedPct(c.change)}</span>`],
      ['Trend strength', strength],
      [`Turns ${up ? 'sell' : 'buy'} on a close ${up ? 'below' : 'above'}`, `${usd(c.flipLevel)} <span class="muted">(${signedPct((c.flipLevel - state.prices.bars[state.prices.bars.length - 1].close) / state.prices.bars[state.prices.bars.length - 1].close)})</span>`],
    ];
    let html = `<div class="trend-now ${up ? 'up' : 'down'}">
        <div class="tn-head"><span aria-hidden="true">${up ? '▲' : '▼'}</span>${up ? 'Uptrend · buy trend' : 'Downtrend · sell trend'}</div>
        ${rows.map(([k, v]) => `<div class="tn-row"><span>${k}</span><b>${v}</b></div>`).join('')}
      </div>`;
    const recent = T.signals.slice(-5).reverse();
    const done = T.signals.filter(s => !s.open), ok = done.filter(s => s.worked).length;
    html += `<div class="lv-group"><h3>Recent signals</h3>`;
    if (!recent.length) html += '<p class="lv-empty">No trend flips in this range.</p>';
    else {
      html += `<ol class="lv-list">${recent.map(s => {
        const res = s.open ? 'open' : s.worked ? 'worked' : 'failed';
        const resLabel = s.open ? 'still open' : s.worked ? '✓ moved as signalled' : '✗ went the other way';
        return `<li class="sig" title="${s.open ? 'Move since the signal' : 'Move from this signal to the next one'}">
          <span class="sig-tag ${s.type}">${s.type === 'buy' ? '▲ Buy' : '▼ Sell'}</span>
          <span class="p">${usd(s.price)}</span>
          <span class="d ${s.move >= 0 ? 'pos' : 'neg'}">${signedPct(s.move)}</span>
          <span class="meta"><span>${fmtDate(s.time)}</span><span class="sig-res ${res}">${resLabel}</span></span>
        </li>`;
      }).join('')}</ol>`;
      html += `<p class="sig-sum">${done.length ? `<b>${ok} of ${done.length}</b> completed signals in this range moved in the signalled direction before the next flip.` : 'No completed signals in this range yet.'}</p>`;
    }
    return html + '</div>';
  }

  function renderLevels(bars, rsiData, daily) {
    const L = state.levels, last = bars[bars.length - 1].close;
    const item = (l, i, kind) => `<li class="lv">
        <span class="tag ${kind.toLowerCase()}">${kind}${i + 1}</span>
        <span class="p">${usd(l.price)}</span>
        <span class="d">${signedPct(l.distance)}</span>
        <span class="meta"><span>${strengthHtml(l.strength)}</span><span>${l.touches} touch${l.touches === 1 ? '' : 'es'} · ${fmtDate(l.lastTime, { month: 'short', year: 'numeric' })}${l.roleReversal ? ' · flipped' : ''}</span></span>
      </li>`;
    const res = [...L.resistance].reverse(); // highest at the top, like the chart
    const resIdx = new Map(L.resistance.map((l, i) => [l, i]));
    let html = trendPanel() + `<div class="lv-group"><h3><span class="sw" style="background:var(--resistance)"></span>Resistance (motstånd)</h3>
      ${res.length ? `<ol class="lv-list">${res.map(l => item(l, resIdx.get(l), 'R')).join('')}</ol>` : '<p class="lv-empty">No resistance above - price is at or near the high of this range.</p>'}</div>
      <div class="lv-now"><span>Price now</span><span>${usd(last)}</span></div>
      <div class="lv-group"><h3><span class="sw" style="background:var(--support)"></span>Support (stöd)</h3>
      ${L.support.length ? `<ol class="lv-list">${L.support.map((l, i) => item(l, i, 'S')).join('')}</ol>` : '<p class="lv-empty">No support below - price is at or near the low of this range.</p>'}</div>`;

    const sig = [];
    const r = rsiData[rsiData.length - 1]?.value;
    if (isNum(r)) sig.push(['Momentum · RSI 14', `<b>${r.toFixed(0)}</b> - ${r >= 70 ? 'overbought zone (above 70): the price has risen fast' : r <= 30 ? 'oversold zone (below 30): the price has fallen fast' : 'neutral (between 30 and 70)'}`]);
    const s200 = TA.sma(bars, 200).pop()?.value, s50 = TA.sma(bars, 50).pop()?.value;
    const unit = daily ? 'day' : 'bar';
    if (isNum(s200)) sig.push([`Trend · 200-${unit} average`, `Price is <b>${last >= s200 ? 'above' : 'below'}</b> it (${signedPct((last - s200) / s200)}) - ${last >= s200 ? 'long-term uptrend' : 'long-term downtrend'}`]);
    else if (isNum(s50)) sig.push([`Trend · 50-${unit} average`, `Price is <b>${last >= s50 ? 'above' : 'below'}</b> it (${signedPct((last - s50) / s50)})`]);
    if (isNum(s50) && isNum(s200)) sig.push(['Averages', s50 >= s200 ? '50 is above 200 (often called a "golden cross" setup)' : '50 is below 200 (often called a "death cross" setup)']);
    if (sig.length) html += `<div class="signals">${sig.map(([k, v]) => `<div><span class="k">${k}</span>${v}</div>`).join('')}</div>`;
    $('#levels').innerHTML = html;
  }

  // ------------------------------------------------------------ render: quick take
  function renderSnapshot() {
    const c = state.company, A = c.annual, d = A.data, p = A.periods;
    const out = [];
    const fy = p[0]?.label, prevFy = p[1]?.label;
    const g = yoy(d.revenue?.[0], d.revenue?.[1]);
    if (isNum(d.revenue?.[0])) out.push(`Revenue was <b>${money(d.revenue[0])}</b> in ${fy}${isNum(g) ? `, <b>${g >= 0 ? 'up' : 'down'} ${pct(Math.abs(g))}</b> from ${prevFy}` : ''}.`);
    if (isNum(c.ttm?.revenue) && c.ttmEnd && c.ttmEnd !== p[0]?.end) out.push(`Over the last four quarters (to ${new Date(c.ttmEnd + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}) revenue was <b>${money(c.ttm.revenue)}</b> and net income <b>${money(c.ttm.netIncome)}</b>.`);
    const nm = d.netIncome?.[0] / d.revenue?.[0];
    if (isNum(nm)) out.push(nm >= 0 ? `It kept <b>${(nm * 100).toFixed(0)}¢ of profit per $1 of sales</b> (net margin) in ${fy}.` : `It <b>lost money</b> in ${fy}: net loss of ${money(Math.abs(d.netIncome[0]))}.`);
    if (isNum(d.fcf?.[0])) out.push(d.fcf[0] >= 0 ? `It generated <b>${money(d.fcf[0])} of free cash flow</b>: cash left over after running and investing in the business.` : `Free cash flow was <b>negative (${money(d.fcf[0])})</b>: the business consumed more cash than it produced.`);
    const nd = d.netDebt?.[0];
    if (isNum(nd)) {
      const lev = isNum(d.ebitda?.[0]) && d.ebitda[0] > 0 ? nd / d.ebitda[0] : null;
      out.push(nd <= 0 ? `It has <b>more cash than debt</b> (net cash of ${money(-nd)}).` : `Net debt is <b>${money(nd)}</b>${isNum(lev) ? `, about <b>${lev.toFixed(1)} years</b> of EBITDA` : ''}.`);
    }
    const sh = yoy(d.sharesDiluted?.[0], d.sharesDiluted?.[1]);
    if (isNum(sh) && Math.abs(sh) >= 0.01) out.push(sh < 0 ? `The share count <b>fell ${pct(-sh)}</b>, so buybacks gave each share a bigger slice of the company.` : `The share count <b>rose ${pct(sh)}</b>, which dilutes existing shareholders.`);
    const pe = c.ratios.groups.flatMap(gr => gr.rows).find(r => r.key === 'pe')?.values[0];
    const q = c.quote;
    if (isNum(pe) && q) out.push(`At ${usd(q.price)} the stock trades at <b>${pe.toFixed(1)}×</b> trailing earnings (P/E).`);
    $('#snapshot-list').innerHTML = out.map(s => `<li>${s}</li>`).join('');
    $('#snapshot-sub').textContent = 'Generated automatically from the reported numbers.';
  }

  // ------------------------------------------------------------ render: ratios
  function renderRatios() {
    const R = state.company.ratios;
    const fmt = (v, f) => (f === 'pct' ? pct(v) : times(v));
    const mark = (row, i) => {
      const r = row.ratings[i];
      if (r !== 'good' && r !== 'bad') return '';
      const head = r === 'good' ? 'Healthy' : 'Worth a closer look';
      const text = (row.hints?.[r] || '').replace('{v}', fmt(row.values[i], row.fmt));
      return `<span class="mark ${r}" tabindex="0" role="img" aria-label="${esc(head + '. ' + text)}" data-tip-head="${esc(head)}" data-tip="${esc(text)}">${r === 'good' ? '✓' : '!'}</span>`;
    };
    let html = `<thead><tr><th>Ratio</th>${R.columns.map((c, i) => `<th class="${i === 0 ? 'latest' : ''}">${esc(c.label)}<small>${esc(c.sub)}</small></th>`).join('')}</tr></thead><tbody>`;
    for (const g of R.groups) {
      if (g.rows.every(r => r.values.every(v => !isNum(v)))) continue;
      html += `<tr class="group"><td colspan="${R.columns.length + 1}">${esc(g.name)}${g.name === 'Valuation' ? ' <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">· at today\'s price</span>' : ''}</td></tr>`;
      for (const r of g.rows) {
        if (r.values.every(v => !isNum(v))) continue;
        html += `<tr><td title="${esc(r.note)}"><div class="row-label">${esc(r.label)}</div><div class="note">${esc(r.note)}</div></td>` +
          r.values.map((v, i) => `<td class="${i === 0 ? 'latest' : ''}">${r.ttmOnly && i > 0 ? '' : `<span class="val${isNum(v) ? '' : ' muted'}">${fmt(v, r.fmt)}</span>${mark(r, i)}`}</td>`).join('') + '</tr>';
      }
    }
    $('#ratios').innerHTML = html + '</tbody>';
  }

  // ------------------------------------------------------------ render: trend charts
  function periodSlice() {
    const S = state.company[state.period];
    const n = state.period === 'annual' ? 8 : 12;
    const count = Math.min(n, S.periods.length);
    const labels = S.periods.slice(0, count).map(p => p.label).reverse();
    const col = key => (S.data[key] || []).slice(0, count).reverse();
    const full = key => S.data[key] || [];
    return { labels, col, full, count, lag: state.period === 'annual' ? 1 : 4 };
  }

  function renderHighlights() {
    if (!state.company) return;
    const { labels, col, full, count, lag } = periodSlice();
    const yoyExtra = key => i => {
      const k = count - 1 - i, f = full(key), ch = yoy(f[k], f[k + lag]);
      return isNum(ch) ? `<br><span class="${ch >= 0 ? 'delta up' : 'delta down'}">${signedPct(ch)}</span> vs ${state.period === 'annual' ? 'prior year' : 'year-ago quarter'}` : '';
    };
    Viz.barChart($('#viz-revenue'), { labels, values: col('revenue'), fmt: money, extra: yoyExtra('revenue') });
    Viz.barChart($('#viz-netIncome'), { labels, values: col('netIncome'), fmt: money, extra: yoyExtra('netIncome') });
    Viz.barChart($('#viz-fcf'), { labels, values: col('fcf'), fmt: money, extra: yoyExtra('fcf') });
    Viz.barChart($('#viz-eps'), { labels, values: col('epsDiluted'), fmt: usd, extra: yoyExtra('epsDiluted') });
    const rev = col('revenue');
    const ratio = key => col(key).map((v, i) => (isNum(v) && isNum(rev[i]) && rev[i] !== 0 ? v / rev[i] : null));
    Viz.lineChart($('#viz-margins'), {
      labels,
      fmt: v => pct(v),
      series: [
        { name: 'Gross margin', short: 'Gross', values: ratio('grossProfit'), color: '--series-1' },
        { name: 'Operating margin', short: 'Oper.', values: ratio('operatingIncome'), color: '--series-2' },
        { name: 'Net margin', short: 'Net', values: ratio('netIncome'), color: '--series-3' },
      ].filter(s => s.values.some(isNum)),
    });
  }

  // ------------------------------------------------------------ render: statements
  function renderStatement() {
    const S = state.company[state.period], L = LAYOUT[state.stmt];
    const n = Math.min(state.period === 'annual' ? 6 : 8, S.periods.length);
    const lag = state.period === 'annual' ? 1 : 4;
    $('#stmt-intro').textContent = L.intro;
    let html = `<thead><tr><th>${state.period === 'annual' ? 'Fiscal year' : 'Quarter ending'}</th>` +
      S.periods.slice(0, n).map((p, i) => `<th class="${i === 0 ? 'latest' : ''}" title="Period ending ${p.end}">${esc(p.label)}<small>${new Date(p.end + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</small></th>`).join('') +
      '<th>Trend</th></tr></thead><tbody>';
    for (const [key, label, note, o] of L.rows) {
      const vals = S.data[key] || [];
      if (!vals.slice(0, n).some(isNum)) continue;
      html += `<tr class="${o.bold ? 'bold' : ''}"><td title="${esc(note)}"><div class="row-label">${esc(label)}</div><div class="note">${esc(note)}</div></td>`;
      for (let i = 0; i < n; i++) {
        const v = vals[i], ch = yoy(v, vals[i + lag]);
        let cls = '';
        if (isNum(ch) && !o.neutral && Math.abs(ch) >= 0.005) cls = (ch > 0) !== !!o.inverse ? 'good' : 'bad';
        html += `<td class="${i === 0 ? 'latest' : ''}"><span class="val${isNum(v) ? '' : ' muted'}">${fmtUnit(v, o.unit)}</span>` +
          (isNum(ch) ? `<span class="chg ${cls}">${ch > 0 ? '▲' : ch < 0 ? '▼' : ''} ${signedPct(ch).replace(/^[+−]/, '')}</span>` : '') + '</td>';
      }
      html += `<td class="trend">${Viz.sparkline(vals.slice(0, n).reverse())}</td></tr>`;
    }
    $('#stmt-table').innerHTML = html + '</tbody>';
  }

  // ------------------------------------------------------------ rating tooltips
  // One fixed-position bubble, so it is never clipped by the scrolling table.
  function bindRatingTips() {
    const tip = document.createElement('div');
    tip.className = 'rating-tip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    document.body.appendChild(tip);
    let current = null;
    const open = el => {
      current = el;
      const good = el.classList.contains('good');
      tip.innerHTML = `<div class="rt-head ${good ? 'good' : 'bad'}"><span class="mark ${good ? 'good' : 'bad'}" aria-hidden="true">${good ? '✓' : '!'}</span>${esc(el.dataset.tipHead)}</div>` +
        (el.dataset.tip ? `<p>${esc(el.dataset.tip)}</p>` : '') +
        '<p class="rt-foot">Rule of thumb only; what is normal varies by industry.</p>';
      tip.hidden = false;
      const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
      const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
      const above = r.top - h - 8 >= 8;
      tip.style.left = left + 'px';
      tip.style.top = (above ? r.top - h - 8 : r.bottom + 8) + 'px';
    };
    const close = () => { current = null; tip.hidden = true; };
    const target = e => e.target.closest?.('.mark[data-tip-head]');
    document.addEventListener('mouseover', e => { const m = target(e); if (m && m !== current) open(m); else if (!m && current) close(); });
    document.addEventListener('focusin', e => { const m = target(e); if (m) open(m); });
    document.addEventListener('focusout', e => { if (target(e)) close(); });
    document.addEventListener('click', e => { const m = target(e); if (m) open(m); }); // tap on touch screens
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    window.addEventListener('scroll', close, { passive: true, capture: true });
  }

  // ------------------------------------------------------------ controls
  function syncControls() {
    $$('#ranges button').forEach(b => b.classList.toggle('is-on', b.dataset.range === state.range));
    $$('.period-seg button').forEach(b => b.classList.toggle('is-on', b.dataset.period === state.period));
    $$('.tabs button').forEach(b => { const on = b.dataset.stmt === state.stmt; b.classList.toggle('is-on', on); b.setAttribute('aria-selected', on); });
    $$('#chart-toggles input[data-show]').forEach(i => (i.checked = !!state.show[i.dataset.show]));
    $('#sens').value = state.sens;
    $('#tsens').value = state.tsens;
    $('#explain').checked = state.explain;
    document.body.classList.toggle('explain', state.explain);
  }

  function bind() {
    // Plain words for raw materials map to their futures symbols ("gold" -> GC=F).
    const ALIASES = {
      gold: 'GC=F', silver: 'SI=F', oil: 'CL=F', crude: 'CL=F', 'crude oil': 'CL=F', wti: 'CL=F', 'oil wti': 'CL=F',
      brent: 'BZ=F', 'brent oil': 'BZ=F', 'natural gas': 'NG=F', natgas: 'NG=F', gas: 'NG=F', copper: 'HG=F',
      platinum: 'PL=F', palladium: 'PA=F', guld: 'GC=F', olja: 'CL=F', naturgas: 'NG=F', koppar: 'HG=F',
    };
    $('#search').addEventListener('submit', e => {
      e.preventDefault();
      const v = $('#q').value.trim();
      loadTicker(ALIASES[v.toLowerCase()] || v.split(/\s/)[0]);
    });
    let t;
    $('#q').addEventListener('input', () => {
      clearTimeout(t);
      const v = $('#q').value.trim();
      if (v.length < 1) return;
      t = setTimeout(async () => {
        try {
          const list = await api('/api/search?q=' + encodeURIComponent(v));
          $('#suggestions').innerHTML = list.map(x => `<option value="${esc(x.ticker)}">${esc(x.name)}</option>`).join('');
        } catch { /* suggestions are optional */ }
      }, 160);
    });
    $('#ranges').addEventListener('click', e => { const b = e.target.closest('button'); if (b) changeRange(b.dataset.range); });
    $$('.period-seg').forEach(seg => seg.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      state.period = b.dataset.period; save('period', state.period);
      syncControls(); renderHighlights(); renderStatement();
    }));
    $('.tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; state.stmt = b.dataset.stmt; syncControls(); renderStatement(); });
    $('#chart-toggles').addEventListener('change', e => {
      if (e.target.dataset.show) { state.show[e.target.dataset.show] = e.target.checked; save('show', JSON.stringify(state.show)); }
      if (e.target.id === 'sens') { state.sens = e.target.value; save('sens', state.sens); }
      if (e.target.id === 'tsens') { state.tsens = e.target.value; save('tsens', state.tsens); }
      renderChart();
    });
    $('#explain').addEventListener('change', e => { state.explain = e.target.checked; save('explain', state.explain ? '1' : '0'); syncControls(); });
    $('.brand').addEventListener('click', e => { e.preventDefault(); });
    window.addEventListener('hashchange', () => { const h = decodeURIComponent(location.hash.slice(1)); if (h && h !== state.ticker) loadTicker(h); });
    // Theme: follows the OS until the user picks one, then remembers it.
    const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
    const theme = () => document.documentElement.dataset.theme || (darkMq.matches ? 'dark' : 'light');
    const SUN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
    const MOON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
    const syncThemeBtn = () => {
      const dark = theme() === 'dark', label = dark ? 'Switch to light theme' : 'Switch to dark theme';
      const btn = $('#theme');
      btn.innerHTML = dark ? SUN : MOON;
      btn.title = label;
      btn.setAttribute('aria-label', label);
    };
    $('#theme').addEventListener('click', () => {
      const next = theme() === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      save('theme', next);
      syncThemeBtn();
      if (state.prices) renderChart(); // the chart library needs its colors re-applied
    });
    syncThemeBtn();
    darkMq.addEventListener('change', () => { syncThemeBtn(); if (state.prices) renderChart(); });
    let rt;
    new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(renderHighlights, 120); }).observe($('#highlights'));

    const chip = ([t, label]) => `<button type="button" data-t="${t}">${label || t}</button>`;
    $('#examples').innerHTML =
      `<div class="chip-row"><span class="chip-label">Stocks</span>${['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'TSLA', 'JPM', 'KO'].map(t => chip([t])).join('')}</div>` +
      `<div class="chip-row"><span class="chip-label">Raw materials</span>${[['GC=F', 'Gold'], ['SI=F', 'Silver'], ['CL=F', 'Oil (WTI)'], ['BZ=F', 'Oil (Brent)'], ['NG=F', 'Natural gas'], ['HG=F', 'Copper']].map(chip).join('')}</div>`;
    $('#examples').addEventListener('click', e => { const b = e.target.closest('button'); if (b) loadTicker(b.dataset.t); });
  }

  bind();
  bindRatingTips();
  syncControls();
  const initial = decodeURIComponent(location.hash.slice(1));
  if (initial) loadTicker(initial);
})();

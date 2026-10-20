// Technical analysis helpers: support/resistance detection, moving averages, RSI.
(function () {
  'use strict';

  function atr(bars, period = 14) {
    if (bars.length < 2) return 0;
    const trs = [];
    for (let i = 1; i < bars.length; i++) {
      const b = bars[i], pc = bars[i - 1].close;
      trs.push(Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)));
    }
    const recent = trs.slice(-Math.max(period, 60));
    return recent.reduce((s, x) => s + x, 0) / recent.length;
  }

  // Support & resistance:
  // 1. Find swing highs/lows (pivots): a bar whose high (low) is the highest (lowest) within +-k bars.
  // 2. Cluster pivots whose prices sit within a tolerance (based on average true range).
  // 3. Score each cluster by number of touches, how recent the last touch was, and whether the
  //    level has acted as both support and resistance ("role reversal").
  // 4. Levels above the last close are resistance, below are support.
  const SENSITIVITY = { low: { win: 1.4, perSide: 2 }, med: { win: 1, perSide: 3 }, high: { win: 0.65, perSide: 5 } };

  function findLevels(bars, sensitivity = 'med') {
    const n = bars.length;
    if (n < 30) return { support: [], resistance: [], tolerance: 0 };
    const cfg = SENSITIVITY[sensitivity] || SENSITIVITY.med;
    const k = Math.max(2, Math.round((n / 45) * cfg.win));
    const last = bars[n - 1].close;
    const tol = Math.max(atr(bars) * 0.8, last * 0.006);

    const pivots = [];
    for (let i = k; i < n - k; i++) {
      let hi = true, lo = true;
      for (let j = i - k; j <= i + k && (hi || lo); j++) {
        if (j === i) continue;
        if (bars[j].high > bars[i].high) hi = false;
        if (bars[j].low < bars[i].low) lo = false;
      }
      if (hi) pivots.push({ price: bars[i].high, i, type: 'H' });
      if (lo) pivots.push({ price: bars[i].low, i, type: 'L' });
    }
    // The range extremes always count, even near the right edge where full pivot windows don't fit.
    let hiIdx = 0, loIdx = 0;
    for (let i = 1; i < n; i++) {
      if (bars[i].high > bars[hiIdx].high) hiIdx = i;
      if (bars[i].low < bars[loIdx].low) loIdx = i;
    }
    if (!pivots.some(p => p.i === hiIdx && p.type === 'H')) pivots.push({ price: bars[hiIdx].high, i: hiIdx, type: 'H', extreme: true });
    if (!pivots.some(p => p.i === loIdx && p.type === 'L')) pivots.push({ price: bars[loIdx].low, i: loIdx, type: 'L', extreme: true });

    pivots.sort((a, b) => a.price - b.price);
    const clusters = [];
    for (const p of pivots) {
      const c = clusters[clusters.length - 1];
      if (c && p.price - c.mean <= tol) {
        c.pts.push(p);
        c.mean = c.pts.reduce((s, x) => s + x.price, 0) / c.pts.length;
      } else clusters.push({ pts: [p], mean: p.price });
    }

    const levels = clusters.map(c => {
      const touches = c.pts.length;
      const lastIdx = Math.max(...c.pts.map(p => p.i));
      const types = new Set(c.pts.map(p => p.type));
      const isExtreme = c.pts.some(p => p.i === hiIdx || p.i === loIdx);
      const recency = lastIdx / (n - 1);
      const score = touches + 1.5 * recency + (types.size > 1 ? 1 : 0) + (isExtreme ? 1 : 0);
      return { price: c.mean, touches, lastTime: bars[lastIdx].time, roleReversal: types.size > 1, isExtreme, score };
    }).filter(l => l.touches >= 2 || l.isExtreme);

    const maxScore = Math.max(1, ...levels.map(l => l.score));
    for (const l of levels) {
      const r = l.score / maxScore;
      l.strength = r > 0.7 ? 3 : r > 0.45 ? 2 : 1;
      l.distance = (l.price - last) / last;
    }
    const pick = arr => arr.sort((a, b) => b.score - a.score).slice(0, cfg.perSide).sort((a, b) => Math.abs(a.distance) - Math.abs(b.distance));
    return {
      resistance: pick(levels.filter(l => l.price > last)),
      support: pick(levels.filter(l => l.price <= last)),
      tolerance: tol,
    };
  }

  function sma(bars, period) {
    const out = [];
    let sum = 0;
    for (let i = 0; i < bars.length; i++) {
      sum += bars[i].close;
      if (i >= period) sum -= bars[i - period].close;
      if (i >= period - 1) out.push({ time: bars[i].time, value: sum / period });
    }
    return out;
  }

  // Wilder's RSI.
  function rsi(bars, period = 14) {
    const out = [];
    if (bars.length <= period) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
      const d = bars[i].close - bars[i - 1].close;
      if (d > 0) gain += d; else loss -= d;
    }
    gain /= period; loss /= period;
    const val = () => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
    out.push({ time: bars[period].time, value: val() });
    for (let i = period + 1; i < bars.length; i++) {
      const d = bars[i].close - bars[i - 1].close;
      gain = (gain * (period - 1) + Math.max(d, 0)) / period;
      loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
      out.push({ time: bars[i].time, value: val() });
    }
    return out;
  }

  // Wilder's average true range for every bar (null until enough history).
  function atrSeries(bars, period) {
    const out = new Array(bars.length).fill(null);
    let sum = 0, prev = null;
    for (let i = 1; i < bars.length; i++) {
      const b = bars[i], pc = bars[i - 1].close;
      const tr = Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
      if (i <= period) { sum += tr; if (i === period) out[i] = prev = sum / period; }
      else out[i] = prev = (prev * (period - 1) + tr) / period;
    }
    return out;
  }

  // Supertrend: a trailing band ATR x multiplier away from the price. The trend flips to "sell"
  // when price closes below the lower band, and back to "buy" when it closes above the upper band.
  function supertrend(bars, period, mult) {
    const atrs = atrSeries(bars, period);
    const out = new Array(bars.length).fill(null);
    let upper = null, lower = null, dir = 1;
    for (let i = period; i < bars.length; i++) {
      const b = bars[i], hl2 = (b.high + b.low) / 2;
      const bu = hl2 + mult * atrs[i], bl = hl2 - mult * atrs[i];
      if (upper === null) { upper = bu; lower = bl; dir = b.close >= hl2 ? 1 : -1; }
      else {
        const pc = bars[i - 1].close;
        upper = bu < upper || pc > upper ? bu : upper;
        lower = bl > lower || pc < lower ? bl : lower;
        if (dir === 1 && b.close < lower) dir = -1;
        else if (dir === -1 && b.close > upper) dir = 1;
      }
      out[i] = { dir, line: dir === 1 ? lower : upper };
    }
    return out;
  }

  // ADX: how strong the trend is (not its direction). Below ~20 = choppy, above ~25 = trending.
  function adx(bars, period = 14) {
    const n = bars.length, out = new Array(n).fill(null);
    if (n < period * 2 + 1) return out;
    let sTR = 0, sP = 0, sM = 0, adxVal = null, dxSum = 0, dxCount = 0;
    for (let i = 1; i < n; i++) {
      const b = bars[i], p = bars[i - 1];
      const up = b.high - p.high, down = p.low - b.low;
      const pdm = up > down && up > 0 ? up : 0, mdm = down > up && down > 0 ? down : 0;
      const tr = Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
      if (i <= period) { sTR += tr; sP += pdm; sM += mdm; if (i < period) continue; }
      else { sTR = sTR - sTR / period + tr; sP = sP - sP / period + pdm; sM = sM - sM / period + mdm; }
      const pdi = sTR ? (100 * sP) / sTR : 0, mdi = sTR ? (100 * sM) / sTR : 0;
      const dx = pdi + mdi ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
      if (adxVal === null) {
        dxSum += dx; dxCount++;
        if (dxCount === period) out[i] = adxVal = dxSum / period;
      } else out[i] = adxVal = (adxVal * (period - 1) + dx) / period;
    }
    return out;
  }

  // Trendline for one trend segment: from the segment's extreme low (high), the flattest line that
  // no later low (high) in the segment breaks - i.e. the line connecting the rising lows / falling highs.
  function segmentTrendline(bars, seg, isLast) {
    const len = seg.end - seg.start + 1;
    if (len < 8) return null;
    const up = seg.dir === 1;
    const from = Math.max(0, seg.start - Math.min(20, Math.round(len / 2)));
    const to = seg.start + Math.floor(len / 2);
    let a = from;
    for (let i = from; i <= to; i++) if (up ? bars[i].low < bars[a].low : bars[i].high > bars[a].high) a = i;
    const pa = up ? bars[a].low : bars[a].high;
    let slope = null, touch = null;
    for (let j = a + 3; j <= seg.end; j++) {
      const s = ((up ? bars[j].low : bars[j].high) - pa) / (j - a);
      if (slope === null || (up ? s < slope : s > slope)) { slope = s; touch = j; }
    }
    if (slope === null || (up ? slope <= 0 : slope >= 0)) return null;
    const end = isLast ? bars.length - 1 : seg.end;
    return { dir: seg.dir, from: a, to: end, touch, p1: pa, p2: pa + slope * (end - a), current: isLast };
  }

  const TREND_SENS = { fast: 2, med: 3, slow: 4 };

  function trendAnalysis(bars, sensitivity = 'med') {
    const period = 10;
    const n = bars.length;
    if (n < period + 5) return null;
    const st = supertrend(bars, period, TREND_SENS[sensitivity] || 3);
    const adxs = adx(bars);
    const segments = [];
    for (let i = period; i < n; i++) {
      const last = segments[segments.length - 1];
      if (!last || last.dir !== st[i].dir) segments.push({ dir: st[i].dir, start: i, end: i });
      else last.end = i;
    }
    // A signal is a flip of the trend. The first segment is just where the data starts, not a flip.
    const signals = segments.slice(1).map((s, k) => {
      const next = segments[k + 2];
      const entry = bars[s.start].close;
      const exit = next ? bars[next.start].close : bars[n - 1].close;
      const move = (exit - entry) / entry;
      return {
        type: s.dir === 1 ? 'buy' : 'sell', time: bars[s.start].time, price: entry, move, open: !next,
        worked: s.dir === 1 ? move > 0 : move < 0, bars: (next ? next.start : n - 1) - s.start,
      };
    });
    const trendlines = segments.slice(-4).map((s, k, arr) => segmentTrendline(bars, s, k === arr.length - 1)).filter(Boolean)
      .map(t => ({ ...t, t1: bars[t.from].time, t2: bars[t.to].time }));
    const cur = segments[segments.length - 1];
    const startPrice = bars[cur.start].close, last = bars[n - 1].close;
    return {
      points: st.map((p, i) => (p ? { time: bars[i].time, dir: p.dir, line: p.line } : null)).filter(Boolean),
      signals,
      trendlines,
      current: {
        dir: cur.dir, since: bars[cur.start].time, startPrice, change: (last - startPrice) / startPrice,
        bars: n - 1 - cur.start, flipLevel: st[n - 1].line, adx: adxs[n - 1], fromStart: segments.length === 1,
      },
    };
  }

  window.TA = { findLevels, sma, rsi, atr, trendAnalysis };
})();

// Small dependency-free SVG charts for the financial highlights (bar + multi-line), with hover tooltips.
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs = {}) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  };

  function tooltip(host) {
    let tip = host.querySelector('.viz-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'viz-tip';
      host.appendChild(tip);
    }
    return {
      show(html, x, y) {
        tip.innerHTML = html;
        tip.style.display = 'block';
        const w = tip.offsetWidth, hw = host.clientWidth;
        tip.style.left = Math.min(Math.max(0, x - w / 2), hw - w) + 'px';
        tip.style.top = Math.max(0, y - tip.offsetHeight - 10) + 'px';
      },
      hide() { tip.style.display = 'none'; },
    };
  }

  function thinLabels(n, width) {
    const maxLabels = Math.max(2, Math.floor(width / 52));
    const step = Math.ceil(n / maxLabels);
    return i => (n - 1 - i) % step === 0;
  }

  // Bars anchored to a zero baseline; 4px rounded corners on the data end only.
  function barPath(x, w, y0, y1) {
    const dir = y1 < y0 ? 1 : -1;
    const r = Math.min(4, w / 2, Math.abs(y0 - y1));
    return `M${x},${y0}V${y1 + dir * r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + dir * r}V${y0}Z`;
  }

  function barChart(host, { labels, values, fmt, extra }) {
    host.querySelector('svg')?.remove();
    const W = Math.max(220, host.clientWidth), H = 170, pl = 6, pr = 6, pt = 22, pb = 22;
    const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img' });
    const finite = values.filter(v => v !== null && Number.isFinite(v));
    if (!finite.length) {
      const t = svgEl('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'viz-muted' });
      t.textContent = 'No data reported';
      svg.appendChild(t);
      host.prepend(svg);
      return;
    }
    const max = Math.max(0, ...finite), min = Math.min(0, ...finite);
    const span = max - min || 1;
    const y = v => pt + ((max - v) / span) * (H - pt - pb);
    const n = values.length, band = (W - pl - pr) / n, bw = Math.min(42, band - 2 - band * 0.25);
    const showLabel = thinLabels(n, W);
    const tip = tooltip(host);
    svg.setAttribute('aria-label', labels.map((l, i) => `${l}: ${fmt(values[i])}`).join(', '));

    values.forEach((v, i) => {
      const cx = pl + band * i + band / 2;
      if (v !== null && Number.isFinite(v)) {
        svg.appendChild(svgEl('path', { d: barPath(cx - bw / 2, bw, y(0), y(v)), class: 'viz-bar' + (i === n - 1 ? ' is-latest' : '') }));
      }
      if (showLabel(i)) {
        const t = svgEl('text', { x: cx, y: H - 6, 'text-anchor': 'middle', class: 'viz-axis' });
        t.textContent = labels[i];
        svg.appendChild(t);
      }
    });
    svg.appendChild(svgEl('line', { x1: pl, x2: W - pr, y1: y(0), y2: y(0), class: 'viz-baseline' }));
    // Direct label on the latest value only.
    const lv = values[n - 1];
    if (lv !== null && Number.isFinite(lv)) {
      const t = svgEl('text', { x: pl + band * (n - 1) + band / 2, y: lv >= 0 ? y(lv) - 6 : y(lv) + 14, 'text-anchor': 'middle', class: 'viz-value' });
      t.textContent = fmt(lv);
      svg.appendChild(t);
    }
    // Hover targets: the whole column, wider than the bar.
    values.forEach((v, i) => {
      const hit = svgEl('rect', { x: pl + band * i, y: 0, width: band, height: H, fill: 'transparent' });
      hit.addEventListener('mouseenter', () => {
        svg.querySelectorAll('.viz-bar').forEach((b, j) => b.classList.toggle('is-dim', j !== i));
        tip.show(`<b>${labels[i]}</b><br>${fmt(v)}${extra ? extra(i) : ''}`, pl + band * i + band / 2, Math.min(y(Math.max(v || 0, 0)), y(0)));
      });
      hit.addEventListener('mouseleave', () => {
        svg.querySelectorAll('.viz-bar').forEach(b => b.classList.remove('is-dim'));
        tip.hide();
      });
      svg.appendChild(hit);
    });
    host.prepend(svg);
  }

  function lineChart(host, { labels, series, fmt }) {
    host.querySelector('svg')?.remove();
    const W = Math.max(220, host.clientWidth), H = 170, pl = 6, pr = 74, pt = 14, pb = 22;
    const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img' });
    const all = series.flatMap(s => s.values).filter(v => v !== null && Number.isFinite(v));
    if (!all.length) { host.prepend(svg); return; }
    const max = Math.max(0, ...all), min = Math.min(0, ...all), span = max - min || 1;
    const n = labels.length;
    const x = i => pl + (n === 1 ? (W - pl - pr) / 2 : ((W - pl - pr) * i) / (n - 1));
    const y = v => pt + ((max - v) / span) * (H - pt - pb);
    const showLabel = thinLabels(n, W - pr);
    const tip = tooltip(host);

    svg.appendChild(svgEl('line', { x1: pl, x2: W - pr, y1: y(0), y2: y(0), class: 'viz-baseline' }));
    labels.forEach((l, i) => {
      if (!showLabel(i)) return;
      const t = svgEl('text', { x: x(i), y: H - 6, 'text-anchor': 'middle', class: 'viz-axis' });
      t.textContent = l;
      svg.appendChild(t);
    });
    const ends = [];
    series.forEach(s => {
      let d = '', pen = false;
      s.values.forEach((v, i) => {
        if (v === null || !Number.isFinite(v)) { pen = false; return; }
        d += (pen ? 'L' : 'M') + x(i) + ',' + y(v);
        pen = true;
      });
      svg.appendChild(svgEl('path', { d, class: 'viz-line', style: `stroke:var(${s.color})` }));
      const li = s.values.map((v, i) => (v !== null && Number.isFinite(v) ? i : -1)).filter(i => i >= 0).pop();
      if (li !== undefined) ends.push({ s, y: y(s.values[li]), x: x(li), v: s.values[li] });
    });
    // Direct labels at the line ends, nudged apart so they never overlap.
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
    ends.forEach(e => {
      const t = svgEl('text', { x: W - pr + 8, y: e.y + 4, class: 'viz-endlabel' });
      t.textContent = `${e.s.short || e.s.name} ${fmt(e.v)}`;
      svg.appendChild(t);
    });
    const cross = svgEl('line', { y1: pt, y2: H - pb, class: 'viz-cross', style: 'display:none' });
    svg.appendChild(cross);
    const dots = series.map(s => {
      const c = svgEl('circle', { r: 4, class: 'viz-dot', style: `fill:var(${s.color});display:none` });
      svg.appendChild(c);
      return c;
    });
    const hit = svgEl('rect', { x: 0, y: 0, width: W - pr + 6, height: H, fill: 'transparent' });
    hit.addEventListener('mousemove', ev => {
      const r = svg.getBoundingClientRect();
      const px = ev.clientX - r.left;
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - pl) / (W - pl - pr)) * (n - 1))));
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.style.display = '';
      series.forEach((s, k) => {
        const v = s.values[i];
        if (v === null || !Number.isFinite(v)) { dots[k].style.display = 'none'; return; }
        dots[k].setAttribute('cx', x(i)); dots[k].setAttribute('cy', y(v)); dots[k].style.display = '';
      });
      tip.show(`<b>${labels[i]}</b>` + series.map(s => `<div class="viz-tip-row"><span class="swatch" style="background:var(${s.color})"></span>${s.name}<span class="viz-tip-val">${fmt(s.values[i])}</span></div>`).join(''), x(i), pt + 10);
    });
    hit.addEventListener('mouseleave', () => {
      cross.style.display = 'none';
      dots.forEach(d => (d.style.display = 'none'));
      tip.hide();
    });
    svg.appendChild(hit);
    host.prepend(svg);
  }

  function sparkline(values) {
    const pts = values.map((v, i) => [i, v]).filter(p => p[1] !== null && Number.isFinite(p[1]));
    if (pts.length < 2) return '';
    const W = 72, H = 22, vs = pts.map(p => p[1]);
    const max = Math.max(...vs), min = Math.min(...vs), span = max - min || 1, n = values.length;
    const xy = ([i, v]) => [2 + ((W - 4) * i) / (n - 1), 3 + ((max - v) / span) * (H - 6)];
    const d = pts.map((p, k) => (k ? 'L' : 'M') + xy(p).map(c => c.toFixed(1)).join(',')).join('');
    const [lx, ly] = xy(pts[pts.length - 1]);
    return `<svg class="spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true"><path d="${d}"/><circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="2.5"/></svg>`;
  }

  window.Viz = { barChart, lineChart, sparkline };
})();

'use strict';
// Load test for swe_fisk analysis. Run the server first, then:
//   node scripts/stress-test.js [baseUrl]        (default http://localhost:3000)
// Phases: (1) many different companies (cold - fetches SEC + Yahoo), (2) many users hitting
// already-loaded pages (hot), (3) a burst of watchlist page loads. Reports latency, errors and
// server memory (from /api/health). Keeps external traffic polite: at most 4 cold loads at once.

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');

const COLD = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'JPM', 'V', 'MA', 'KO', 'PEP', 'WMT', 'COST', 'DIS',
  'NFLX', 'INTC', 'AMD', 'ORCL', 'CRM', 'ADBE', 'PFE', 'JNJ', 'MRK', 'XOM', 'CVX', 'BA', 'CAT', 'NKE', 'MCD'];
const COMMODITIES = ['GC=F', 'SI=F', 'CL=F', 'BZ=F', 'NG=F', 'HG=F'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

function newStats() { return { times: [], errors: {}, count: 0 }; }
async function hit(stats, path) {
  const t0 = performance.now();
  try {
    const res = await fetch(BASE + path);
    await res.arrayBuffer();
    if (!res.ok) stats.errors[res.status] = (stats.errors[res.status] || 0) + 1;
  } catch (e) {
    const k = e.cause?.code || e.name;
    stats.errors[k] = (stats.errors[k] || 0) + 1;
  }
  stats.times.push(performance.now() - t0);
  stats.count++;
}
function report(name, stats, seconds) {
  const errs = Object.entries(stats.errors).map(([k, v]) => `${k}×${v}`).join(', ') || 'none';
  console.log(`  ${name}: ${stats.count} requests${seconds ? ` in ${seconds.toFixed(1)}s (${(stats.count / seconds).toFixed(0)}/s)` : ''}` +
    ` · p50 ${pct(stats.times, 50).toFixed(0)}ms · p95 ${pct(stats.times, 95).toFixed(0)}ms · max ${Math.max(0, ...stats.times).toFixed(0)}ms · errors: ${errs}`);
  return stats;
}

let peak = { rssMB: 0, heapUsedMB: 0 };
async function health(label) {
  try {
    const h = await (await fetch(BASE + '/api/health')).json();
    peak = { rssMB: Math.max(peak.rssMB, h.rssMB), heapUsedMB: Math.max(peak.heapUsedMB, h.heapUsedMB) };
    console.log(`  [memory ${label}] rss ${h.rssMB} MB · heap ${h.heapUsedMB} MB · cache entries ${h.cacheEntries} · uptime ${h.uptimeS}s`);
    return h;
  } catch (e) {
    console.log(`  [memory ${label}] SERVER NOT RESPONDING (${e.cause?.code || e.message})`);
    return null;
  }
}

async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: size }, async () => { while (queue.length) await fn(queue.shift()); }));
}

(async () => {
  console.log(`Stress test against ${BASE}\n`);
  const start = await health('start');
  if (!start) process.exit(1);

  console.log('\nPhase 1 - cold: 30 different companies + 6 commodities (SEC + Yahoo fetches, 4 at a time)');
  const cold = newStats();
  let t0 = performance.now();
  let i = 0;
  await pool([...COLD, ...COMMODITIES], 4, async t => {
    if (!t.includes('=')) await hit(cold, `/api/company/${encodeURIComponent(t)}`);
    await hit(cold, `/api/prices/${encodeURIComponent(t)}?range=1y`);
    if (++i % 10 === 0) await health(`after ${i} tickers`);
  });
  report('cold loads', cold, (performance.now() - t0) / 1000);
  await health('after phase 1');

  console.log('\nPhase 2 - hot: 50 simultaneous users browsing already-loaded tickers for 30 s');
  const hot = newStats();
  const hotPaths = [
    '/', '/app.js', '/styles.css', '/sr.js', '/img/cat.webp',
    ...COLD.slice(0, 10).map(t => `/api/company/${t}`),
    ...COLD.slice(0, 10).map(t => `/api/prices/${t}?range=1y`),
    '/api/quote/AAPL', '/api/quote/NVDA', '/api/quote/GC%3DF', '/api/quote/CL%3DF',
    '/api/search?q=app', '/api/search?q=gold',
  ];
  t0 = performance.now();
  const until = Date.now() + 30000;
  const memTimer = setInterval(() => health('during phase 2'), 10000);
  await Promise.all(Array.from({ length: 50 }, async () => {
    while (Date.now() < until) {
      await hit(hot, hotPaths[Math.floor(Math.random() * hotPaths.length)]);
      await sleep(Math.random() * 200); // think time between clicks
    }
  }));
  clearInterval(memTimer);
  report('hot browsing', hot, (performance.now() - t0) / 1000);
  await health('after phase 2');

  console.log('\nPhase 3 - burst: 25 people open the start page at once, each with an 8-ticker watchlist');
  const burst = newStats();
  t0 = performance.now();
  const wl = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'GC=F', 'CL=F', 'KO', 'JPM'];
  await Promise.all(Array.from({ length: 25 }, async () => {
    await hit(burst, '/');
    await Promise.all(wl.map(t => hit(burst, `/api/prices/${encodeURIComponent(t)}?range=6mo`)));
    await Promise.all(wl.map(t => hit(burst, `/api/quote/${encodeURIComponent(t)}`)));
  }));
  report('watchlist burst', burst, (performance.now() - t0) / 1000);
  const end = await health('end');

  const totalErrors = [cold, hot, burst].reduce((s, st) => s + Object.values(st.errors).reduce((a, b) => a + b, 0), 0);
  console.log(`\nSummary: peak rss ${peak.rssMB} MB (Render free limit 512 MB) · peak heap ${peak.heapUsedMB} MB · total errors ${totalErrors}` +
    (end ? '' : ' · SERVER DIED'));
  process.exit(end && totalErrors === 0 ? 0 : 2);
})();

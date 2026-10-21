'use strict';
// swe_fisk analysis: a small local server that pulls US company financials from SEC EDGAR
// and price history from Yahoo Finance, then serves the web UI in ./public.
// No dependencies - needs Node 18+ (built-in fetch).

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
// The SEC asks API users to identify themselves. Set SEC_USER_AGENT to "Your Name your@email.com".
const SEC_UA = process.env.SEC_USER_AGENT || 'SweFiskAnalysis/1.0 (personal research tool) admin@swefisk.local';
const YAHOO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PUBLIC = path.join(__dirname, 'public');
const DAY = 86400000;

// ---------------------------------------------------------------- helpers
// In-memory cache. Stores the promise, so simultaneous requests for the same thing share one fetch.
const cache = new Map();
async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < hit.ttl) return hit.p;
  const entry = { t: Date.now(), ttl, p: fn() };
  cache.set(key, entry);
  try {
    return await entry.p;
  } catch (e) {
    if (cache.get(key) === entry) cache.delete(key); // never cache failures
    throw e;
  }
}
// Drop expired entries every 10 minutes so memory doesn't creep up.
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of cache) if (now - e.t >= e.ttl) cache.delete(k);
}, 10 * 60000).unref();

function userError(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  e.expose = true;
  return e;
}

async function getJSON(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const has = x => x !== null && x !== undefined && Number.isFinite(x);
const normTicker = t => String(t || '').trim().toUpperCase().replace(/\./g, '-');

// ---------------------------------------------------------------- SEC: tickers
async function tickerMap() {
  return cached('tickers', DAY, async () => {
    const j = await getJSON('https://www.sec.gov/files/company_tickers.json', { 'User-Agent': SEC_UA });
    const map = new Map();
    for (const k of Object.keys(j)) {
      const e = j[k];
      const t = e.ticker.toUpperCase();
      if (!map.has(t)) map.set(t, { ticker: t, cik: e.cik_str, name: e.title });
    }
    return map;
  });
}

async function resolveTicker(raw) {
  const t = normTicker(raw);
  if (!/^[A-Z0-9-]{1,10}$/.test(t)) throw userError('That does not look like a ticker symbol.');
  const hit = (await tickerMap()).get(t);
  if (!hit) throw userError(`"${t}" was not found in the SEC company list. Only US-listed companies that file with the SEC are supported (ETFs and funds have no financial statements).`, 404);
  return hit;
}

// ---------------------------------------------------------------- SEC: XBRL facts
// Which XBRL concepts feed each line item. The first concept that has a value for a
// given period wins, because companies switch tags over the years.
const METRICS = {
  // income statement (flows)
  revenue: { kind: 'flow', concepts: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueNet', 'SalesRevenueGoodsNet', 'SalesRevenueServicesNet', 'RevenuesNetOfInterestExpense'] },
  costOfRevenue: { kind: 'flow', concepts: ['CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfGoodsSold', 'CostOfServices'] },
  grossProfit: { kind: 'flow', concepts: ['GrossProfit'] },
  rnd: { kind: 'flow', concepts: ['ResearchAndDevelopmentExpense', 'ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost'] },
  sga: { kind: 'flow', concepts: ['SellingGeneralAndAdministrativeExpense', 'GeneralAndAdministrativeExpense'] },
  operatingIncome: { kind: 'flow', concepts: ['OperatingIncomeLoss'] },
  interestExpense: { kind: 'flow', concepts: ['InterestExpense', 'InterestExpenseNonoperating', 'InterestExpenseDebt', 'InterestPaidNet'] },
  pretaxIncome: { kind: 'flow', concepts: ['IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest', 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments', 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesDomestic'] },
  incomeTax: { kind: 'flow', concepts: ['IncomeTaxExpenseBenefit'] },
  netIncome: { kind: 'flow', concepts: ['NetIncomeLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic', 'ProfitLoss'] },
  epsDiluted: { kind: 'flow', unit: 'USD/shares', concepts: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted', 'EarningsPerShareBasic'] },
  sharesDiluted: { kind: 'flow', unit: 'shares', avg: true, concepts: ['WeightedAverageNumberOfDilutedSharesOutstanding', 'WeightedAverageNumberOfShareOutstandingBasicAndDiluted', 'WeightedAverageNumberOfSharesOutstandingBasic'] },
  // balance sheet (point in time)
  cash: { kind: 'instant', concepts: ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents', 'Cash'] },
  shortTermInvestments: { kind: 'instant', concepts: ['MarketableSecuritiesCurrent', 'ShortTermInvestments', 'AvailableForSaleSecuritiesDebtSecuritiesCurrent'] },
  receivables: { kind: 'instant', concepts: ['AccountsReceivableNetCurrent', 'ReceivablesNetCurrent'] },
  inventory: { kind: 'instant', concepts: ['InventoryNet'] },
  currentAssets: { kind: 'instant', concepts: ['AssetsCurrent'] },
  totalAssets: { kind: 'instant', concepts: ['Assets'] },
  accountsPayable: { kind: 'instant', concepts: ['AccountsPayableCurrent'] },
  currentLiabilities: { kind: 'instant', concepts: ['LiabilitiesCurrent'] },
  shortTermDebt: { kind: 'instant', concepts: ['LongTermDebtCurrent', 'LongTermDebtAndCapitalLeaseObligationsCurrent', 'DebtCurrent'] },
  commercialPaper: { kind: 'instant', concepts: ['CommercialPaper', 'ShortTermBorrowings'] },
  longTermDebt: { kind: 'instant', concepts: ['LongTermDebtNoncurrent', 'LongTermDebtAndCapitalLeaseObligations', 'LongTermNotesPayable'] },
  totalLiabilities: { kind: 'instant', concepts: ['Liabilities'] },
  equity: { kind: 'instant', concepts: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'] },
  // cash flow statement (flows)
  operatingCF: { kind: 'flow', concepts: ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'] },
  capex: { kind: 'flow', concepts: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets', 'PaymentsForCapitalImprovements'] },
  investingCF: { kind: 'flow', concepts: ['NetCashProvidedByUsedInInvestingActivities', 'NetCashProvidedByUsedInInvestingActivitiesContinuingOperations'] },
  financingCF: { kind: 'flow', concepts: ['NetCashProvidedByUsedInFinancingActivities', 'NetCashProvidedByUsedInFinancingActivitiesContinuingOperations'] },
  dividendsPaid: { kind: 'flow', concepts: ['PaymentsOfDividends', 'PaymentsOfDividendsCommonStock', 'PaymentsOfOrdinaryDividends'] },
  buybacks: { kind: 'flow', concepts: ['PaymentsForRepurchaseOfCommonStock'] },
  sbc: { kind: 'flow', concepts: ['ShareBasedCompensation', 'AllocatedShareBasedCompensationExpense'] },
  da: { kind: 'flow', concepts: ['DepreciationDepletionAndAmortization', 'DepreciationAmortizationAndAccretionNet', 'DepreciationAndAmortization', 'Depreciation'] },
};

// Turns one concept's raw facts into { annual, quarterly, instant } maps keyed by period end date.
// 10-Q cash flows are reported year-to-date (3, 6, 9 months), so single quarters are
// derived by differencing cumulative periods that share a start date - this also yields Q4.
function processConcept(entries, derive) {
  const latest = new Map();
  for (const e of entries) {
    if (!/^10-[KQ]/.test(e.form || '')) continue;
    const k = (e.start || '') + '|' + e.end;
    const prev = latest.get(k);
    if (!prev || e.filed > prev.filed) latest.set(k, e);
  }
  const annual = new Map(), quarterly = new Map(), instant = new Map();
  const groups = new Map();
  for (const e of latest.values()) {
    if (!e.start) { instant.set(e.end, e.val); continue; }
    const d = daysBetween(e.start, e.end);
    if (d >= 350 && d <= 380 && e.form.startsWith('10-K')) annual.set(e.end, e.val);
    if (d >= 80 && d <= 100) quarterly.set(e.end, e.val);
    if (!groups.has(e.start)) groups.set(e.start, []);
    groups.get(e.start).push(e);
  }
  if (derive) {
    for (const g of groups.values()) {
      g.sort((a, b) => (a.end < b.end ? -1 : 1));
      for (let i = 1; i < g.length; i++) {
        const gap = daysBetween(g[i - 1].end, g[i].end);
        if (gap >= 80 && gap <= 100 && !quarterly.has(g[i].end)) quarterly.set(g[i].end, g[i].val - g[i - 1].val);
      }
    }
  }
  return { annual, quarterly, instant };
}

function lookup(map, end) {
  if (map.has(end)) return map.get(end);
  for (const [k, v] of map) if (Math.abs(daysBetween(k, end)) <= 4) return v;
  return undefined;
}

function dedupeDatesDesc(dates) {
  const out = [];
  for (const d of dates.sort().reverse()) if (!out.length || daysBetween(d, out[out.length - 1]) > 10) out.push(d);
  return out;
}

// Line items computed from the reported ones.
function derive(v) {
  if (!has(v.grossProfit) && has(v.revenue) && has(v.costOfRevenue)) v.grossProfit = v.revenue - v.costOfRevenue;
  v.ebitda = has(v.operatingIncome) && has(v.da) ? v.operatingIncome + v.da : null;
  v.fcf = has(v.operatingCF) && has(v.capex) ? v.operatingCF - v.capex : null;
  const debtParts = [v.shortTermDebt, v.commercialPaper, v.longTermDebt];
  v.totalDebt = debtParts.some(has) ? debtParts.reduce((s, x) => s + (has(x) ? x : 0), 0) : null;
  v.netDebt = has(v.totalDebt) && has(v.cash) ? v.totalDebt - v.cash - (has(v.shortTermInvestments) ? v.shortTermInvestments : 0) : null;
  return v;
}

function latestSharesOutstanding(facts) {
  const arr = facts.facts?.dei?.EntityCommonStockSharesOutstanding?.units?.shares;
  if (!arr || !arr.length) return null;
  const lastFiled = arr.reduce((m, e) => (e.filed > m ? e.filed : m), '');
  const inFiling = arr.filter(e => e.filed === lastFiled);
  const lastEnd = inFiling.reduce((m, e) => (e.end > m ? e.end : m), '');
  // Multi-class companies (e.g. GOOGL) report one value per share class - add them up.
  return { shares: inFiling.filter(e => e.end === lastEnd).reduce((s, e) => s + e.val, 0), asOf: lastEnd };
}

function latestFiling(gaap) {
  let best = null;
  for (const c of [...METRICS.netIncome.concepts, ...METRICS.revenue.concepts]) {
    for (const e of gaap[c]?.units?.USD || []) {
      if (/^10-[KQ]/.test(e.form) && (!best || e.filed > best.filed)) best = { form: e.form, filed: e.filed, periodEnd: e.end };
    }
  }
  return best;
}

function buildFinancials(facts) {
  const gaap = facts.facts?.['us-gaap'];
  if (!gaap) throw userError('No US-GAAP financial data found. The company may file under IFRS as a foreign issuer, which this app does not cover.', 404);

  const series = {};
  for (const [key, m] of Object.entries(METRICS)) {
    const unit = m.unit || 'USD';
    series[key] = m.concepts.map(c => gaap[c]?.units?.[unit]).filter(Boolean).map(e => processConcept(e, !m.avg));
  }
  const pick = (key, field, end) => {
    for (const s of series[key]) {
      const v = lookup(s[field], end);
      if (v !== undefined) return v;
    }
    return null;
  };
  const collectEnds = field => {
    const set = new Set();
    for (const k of ['revenue', 'netIncome', 'operatingCF']) for (const s of series[k]) for (const d of s[field].keys()) set.add(d);
    return dedupeDatesDesc([...set]);
  };
  const valuesAt = (end, mode) => {
    const v = {};
    for (const [key, m] of Object.entries(METRICS)) {
      if (m.kind === 'instant') v[key] = pick(key, 'instant', end);
      else if (mode === 'annual') v[key] = pick(key, 'annual', end);
      else {
        v[key] = pick(key, 'quarterly', end);
        if (v[key] === null && m.avg) v[key] = pick(key, 'annual', end);
      }
    }
    return derive(v);
  };

  const annualEnds = collectEnds('annual').slice(0, 9);
  const quarterEnds = collectEnds('quarterly').slice(0, 13);
  if (!annualEnds.length && !quarterEnds.length) throw userError('The SEC has no usable financial statement data for this company.', 404);

  const annualVals = annualEnds.map(e => valuesAt(e, 'annual'));
  const quarterVals = quarterEnds.map(e => valuesAt(e, 'quarterly'));

  // Trailing twelve months = sum of the 4 latest consecutive quarters (balance items: latest quarter).
  const consecutive = from => {
    if (quarterEnds.length < from + 4) return false;
    for (let i = from; i < from + 3; i++) {
      const g = daysBetween(quarterEnds[i + 1], quarterEnds[i]);
      if (g < 80 || g > 100) return false;
    }
    return true;
  };
  const ttmAt = from => {
    if (!consecutive(from)) return null;
    const v = {};
    for (const [key, m] of Object.entries(METRICS)) {
      if (m.kind === 'instant' || m.avg) { v[key] = quarterVals[from][key]; continue; }
      let s = 0;
      for (let i = from; i < from + 4; i++) {
        const x = quarterVals[i][key];
        if (!has(x)) { s = null; break; }
        s += x;
      }
      v[key] = s;
    }
    return derive(v);
  };

  const toPeriods = (ends, mode) => ends.map(end => ({
    end,
    label: mode === 'annual' ? 'FY' + end.slice(0, 4) : new Date(end + 'T12:00:00Z').toLocaleString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }).replace(' ', " '"),
  }));
  const columnize = vals => {
    const out = {};
    for (const key of Object.keys(vals[0] || {})) out[key] = vals.map(v => v[key]);
    return out;
  };

  return {
    annual: { periods: toPeriods(annualEnds, 'annual'), data: columnize(annualVals), rows: annualVals },
    quarterly: { periods: toPeriods(quarterEnds, 'quarterly'), data: columnize(quarterVals), rows: quarterVals },
    ttm: ttmAt(0),
    ttmPrior: ttmAt(4),
    ttmEnd: consecutive(0) ? quarterEnds[0] : null,
    shares: latestSharesOutstanding(facts),
    filing: latestFiling(gaap),
  };
}

// ---------------------------------------------------------------- ratios
const div = (a, b) => (has(a) && has(b) && b !== 0 ? a / b : null);
const growth = (cur, prev) => (has(cur) && has(prev) && prev > 0 ? (cur - prev) / prev : null);

const RATIOS = [
  { group: 'Valuation', key: 'pe', label: 'P/E (price / earnings)', fmt: 'x', ttmOnly: true, good: v => v < 15, bad: v => v > 35,
    note: 'How many dollars investors pay for $1 of yearly profit. Lower = cheaper, but fast growers usually trade higher.',
    f: c => (c.v.netIncome > 0 ? div(c.mcap, c.v.netIncome) : null) },
  { group: 'Valuation', key: 'ps', label: 'P/S (price / sales)', fmt: 'x', ttmOnly: true, good: v => v < 2, bad: v => v > 10,
    note: 'Market value divided by yearly revenue. Useful when a company is not yet profitable.',
    f: c => div(c.mcap, c.v.revenue) },
  { group: 'Valuation', key: 'pb', label: 'P/B (price / book)', fmt: 'x', ttmOnly: true, good: v => v < 3, bad: v => v > 10,
    note: 'Market value compared with the accounting value of equity (assets minus liabilities).',
    f: c => (c.v.equity > 0 ? div(c.mcap, c.v.equity) : null) },
  { group: 'Valuation', key: 'evEbitda', label: 'EV / EBITDA', fmt: 'x', ttmOnly: true, good: v => v < 10, bad: v => v > 25,
    note: 'Price of the whole business (including debt, minus cash) versus its operating cash earnings. Good for comparing companies with different debt levels.',
    f: c => (c.v.ebitda > 0 ? div(c.ev, c.v.ebitda) : null) },
  { group: 'Valuation', key: 'pfcf', label: 'P / FCF', fmt: 'x', ttmOnly: true, good: v => v < 15, bad: v => v > 40,
    note: 'Market value divided by free cash flow - the cash left after running and investing in the business.',
    f: c => (c.v.fcf > 0 ? div(c.mcap, c.v.fcf) : null) },
  { group: 'Valuation', key: 'fcfYield', label: 'FCF yield', fmt: 'pct', ttmOnly: true, good: v => v > 0.05, bad: v => v < 0.02,
    note: 'Free cash flow as a % of market value. Like an "interest rate" the business earns for owners.',
    f: c => div(c.v.fcf, c.mcap) },
  { group: 'Valuation', key: 'divYield', label: 'Dividend yield', fmt: 'pct', ttmOnly: true,
    note: 'Cash dividends paid in the last year as a % of market value.',
    f: c => (!has(c.mcap) ? null : has(c.v.dividendsPaid) ? c.v.dividendsPaid / c.mcap : c.paysDividends ? null : 0) },

  { group: 'Profitability', key: 'grossMargin', label: 'Gross margin', fmt: 'pct', good: v => v > 0.4, bad: v => v < 0.2,
    note: 'Share of each sales dollar left after the direct cost of making the product.',
    f: c => div(c.v.grossProfit, c.v.revenue) },
  { group: 'Profitability', key: 'opMargin', label: 'Operating margin', fmt: 'pct', good: v => v > 0.15, bad: v => v < 0.05,
    note: 'Share of sales left after all normal running costs (production, R&D, sales, admin).',
    f: c => div(c.v.operatingIncome, c.v.revenue) },
  { group: 'Profitability', key: 'netMargin', label: 'Net margin', fmt: 'pct', good: v => v > 0.1, bad: v => v < 0.03,
    note: 'Share of sales that ends up as final profit after interest and taxes.',
    f: c => div(c.v.netIncome, c.v.revenue) },
  { group: 'Profitability', key: 'roe', label: 'Return on equity (ROE)', fmt: 'pct', good: v => v > 0.15, bad: v => v < 0.05,
    note: 'Profit generated per dollar of shareholders\' money in the business.',
    f: c => (c.v.equity > 0 ? div(c.v.netIncome, c.v.equity) : null) },
  { group: 'Profitability', key: 'roa', label: 'Return on assets (ROA)', fmt: 'pct', good: v => v > 0.07, bad: v => v < 0.02,
    note: 'Profit generated per dollar of everything the company owns.',
    f: c => div(c.v.netIncome, c.v.totalAssets) },
  { group: 'Profitability', key: 'roic', label: 'Return on invested capital', fmt: 'pct', good: v => v > 0.12, bad: v => v < 0.05,
    note: 'After-tax operating profit per dollar invested by owners and lenders (approximate). Above ~10% usually means a strong business.',
    f: c => {
      const taxRate = Math.min(0.5, Math.max(0, div(c.v.incomeTax, c.v.pretaxIncome) ?? 0.21));
      const invested = (c.v.equity || 0) + (c.v.totalDebt || 0) - (c.v.cash || 0) - (c.v.shortTermInvestments || 0);
      return has(c.v.operatingIncome) && invested > 0 ? (c.v.operatingIncome * (1 - taxRate)) / invested : null;
    } },

  { group: 'Financial health', key: 'currentRatio', label: 'Current ratio', fmt: 'x', good: v => v > 1.5, bad: v => v < 1,
    note: 'Short-term assets divided by bills due within a year. Above 1 = can cover near-term obligations.',
    f: c => div(c.v.currentAssets, c.v.currentLiabilities) },
  { group: 'Financial health', key: 'quickRatio', label: 'Quick ratio', fmt: 'x', good: v => v > 1, bad: v => v < 0.7,
    note: 'Like the current ratio but excludes inventory, which can be slow to turn into cash.',
    f: c => (has(c.v.currentAssets) ? div(c.v.currentAssets - (c.v.inventory || 0), c.v.currentLiabilities) : null) },
  { group: 'Financial health', key: 'debtToEquity', label: 'Debt / equity', fmt: 'x', good: v => v < 0.5, bad: v => v > 2,
    note: 'Borrowed money compared with owners\' money. Higher = more leverage and more risk in bad times.',
    f: c => (c.v.equity > 0 ? div(c.v.totalDebt, c.v.equity) : null) },
  { group: 'Financial health', key: 'netDebtEbitda', label: 'Net debt / EBITDA', fmt: 'x', good: v => v < 1, bad: v => v > 3,
    note: 'Years of operating cash earnings needed to pay off debt (after using cash). Negative = more cash than debt.',
    f: c => (c.v.ebitda > 0 ? div(c.v.netDebt, c.v.ebitda) : null) },
  { group: 'Financial health', key: 'interestCoverage', label: 'Interest coverage', fmt: 'x', good: v => v > 8, bad: v => v < 3,
    note: 'How many times operating profit covers the interest bill.',
    f: c => (c.v.interestExpense > 0 ? div(c.v.operatingIncome, c.v.interestExpense) : null) },

  { group: 'Cash flow & shareholders', key: 'fcfMargin', label: 'FCF margin', fmt: 'pct', good: v => v > 0.1, bad: v => v < 0.03,
    note: 'Share of sales that becomes free cash flow.',
    f: c => div(c.v.fcf, c.v.revenue) },
  { group: 'Cash flow & shareholders', key: 'payoutRatio', label: 'Dividend payout ratio', fmt: 'pct', good: v => v < 0.6, bad: v => v > 1,
    note: 'Share of profit paid out as dividends. Over 100% means paying more than it earns.',
    f: c => (c.v.netIncome > 0 && has(c.v.dividendsPaid) ? c.v.dividendsPaid / c.v.netIncome : null) },
  { group: 'Cash flow & shareholders', key: 'sbcPct', label: 'Stock compensation / sales', fmt: 'pct', good: v => v < 0.03, bad: v => v > 0.1,
    note: 'Employee pay given as shares, as a % of sales. High values dilute existing owners.',
    f: c => div(c.v.sbc, c.v.revenue) },
  { group: 'Cash flow & shareholders', key: 'capexPct', label: 'Capex / sales', fmt: 'pct',
    note: 'Spending on buildings, equipment and data centers as a % of sales.',
    f: c => div(c.v.capex, c.v.revenue) },

  { group: 'Growth', key: 'revGrowth', label: 'Revenue growth (YoY)', fmt: 'pct', good: v => v > 0.1, bad: v => v < 0,
    note: 'Change in sales versus the year before.',
    f: c => growth(c.v.revenue, c.prev?.revenue) },
  { group: 'Growth', key: 'niGrowth', label: 'Net income growth (YoY)', fmt: 'pct', good: v => v > 0.1, bad: v => v < 0,
    note: 'Change in profit versus the year before.',
    f: c => growth(c.v.netIncome, c.prev?.netIncome) },
  { group: 'Growth', key: 'epsGrowth', label: 'EPS growth (YoY)', fmt: 'pct', good: v => v > 0.1, bad: v => v < 0,
    note: 'Change in profit per share - includes the effect of buybacks or new shares.',
    f: c => growth(c.v.epsDiluted, c.prev?.epsDiluted) },
  { group: 'Growth', key: 'revCagr3', label: 'Revenue growth, 3-yr avg', fmt: 'pct', good: v => v > 0.1, bad: v => v < 0,
    note: 'Average yearly sales growth over the last three years (CAGR).',
    f: c => (c.v.revenue > 0 && c.prev3?.revenue > 0 ? Math.pow(c.v.revenue / c.prev3.revenue, 1 / 3) - 1 : null) },
];

// Short explanations shown when hovering the ✓ / ! marks. {v} is replaced with the formatted value.
const HINTS = {
  pe: { good: 'A P/E of {v} is below 15: you pay relatively little for each dollar of profit. It can mean the stock is cheap, or that the market expects profits to shrink.',
        bad: 'A P/E of {v} is above 35: investors pay a lot for each dollar of profit, so the price assumes strong growth ahead. That is common for fast growers, but the stock is vulnerable if growth slows.' },
  ps: { good: 'At {v} sales, the market values the company at under 2 years of revenue, which is modest.',
        bad: 'At {v} sales, the price is more than 10 years of revenue. It only makes sense with high margins and fast growth.' },
  pb: { good: 'At {v} book value, the price is close to the accounting value of what the company owns.',
        bad: 'At {v} book value, the price is far above the accounting value. That is common for brand- or software-heavy firms, or when buybacks have shrunk equity.' },
  evEbitda: { good: 'At {v} EBITDA, the whole business (including debt) is priced at under 10 years of operating cash earnings, which is usually considered inexpensive.',
              bad: 'At {v} EBITDA, the business is priced at more than 25 years of operating cash earnings, a rich valuation that needs strong growth to justify.' },
  pfcf: { good: 'At {v} free cash flow, you pay under 15 years of the cash the business produces, which is attractive.',
          bad: 'At {v} free cash flow, you pay more than 40 years of current free cash flow. Either cash flow is temporarily low (e.g. heavy investment) or the stock is expensive.' },
  fcfYield: { good: 'A free cash flow yield of {v} (above 5%): the business produces a lot of cash relative to its price.',
              bad: 'A free cash flow yield of {v} (below 2%): little cash is produced relative to the price, so you depend on future growth.' },
  grossMargin: { good: 'A gross margin of {v} (above 40%): the company keeps a large share of each sale, a sign of pricing power or a strong brand.',
                 bad: 'A gross margin of {v} (below 20%): products are costly to make or sell at thin prices, leaving little room for other costs. That is typical of retailers and manufacturers.' },
  opMargin: { good: 'An operating margin of {v} (above 15%): the core business is very profitable after all running costs.',
              bad: 'An operating margin of {v} (below 5%): little profit remains after running costs, so a small drop in sales can wipe it out.' },
  netMargin: { good: 'A net margin of {v} (above 10%): a healthy share of sales ends up as final profit.',
               bad: 'A net margin of {v} (below 3%): very little of each sale becomes profit, or the company is losing money.' },
  roe: { good: 'An ROE of {v} (above 15%): the company earns a strong return on shareholders\' money. Very high values can be inflated by debt or buybacks.',
         bad: 'An ROE of {v} (below 5%): the money owners have in the business earns a weak return.' },
  roa: { good: 'An ROA of {v} (above 7%): the company squeezes good profit out of what it owns.',
         bad: 'An ROA of {v} (below 2%): low profit relative to assets. That is normal for banks and asset-heavy businesses, weak for others.' },
  roic: { good: 'An ROIC of {v} (above 12%): each dollar invested earns well above the typical cost of capital, a hallmark of a high-quality business.',
          bad: 'An ROIC of {v} (below 5%): returns on invested money are below what investors typically demand, so growth may not create much value.' },
  currentRatio: { good: 'A current ratio of {v} (above 1.5): short-term assets comfortably cover bills due within a year.',
                  bad: 'A current ratio of {v} (below 1): bills due within a year exceed short-term assets. That is fine for cash-rich giants with steady income, but a risk for weaker companies.' },
  quickRatio: { good: 'A quick ratio of {v} (above 1): the company can pay near-term bills without selling inventory.',
                bad: 'A quick ratio of {v} (below 0.7): without selling inventory, the company could struggle to meet short-term bills.' },
  debtToEquity: { good: 'Debt/equity of {v} (below 0.5): the company relies mostly on owners\' money, not borrowing.',
                  bad: 'Debt/equity of {v} (above 2): heavy borrowing compared with equity. Profits are amplified in good times, but there is more risk in bad times.' },
  netDebtEbitda: { good: 'Net debt/EBITDA of {v} (below 1): debt could be repaid with about a year of operating earnings, or there is more cash than debt.',
                   bad: 'Net debt/EBITDA of {v} (above 3): repaying debt would take more than 3 years of operating earnings, a level lenders watch closely.' },
  interestCoverage: { good: 'Interest coverage of {v} (above 8): operating profit easily covers interest payments.',
                      bad: 'Interest coverage of {v} (below 3): a big share of operating profit goes to interest, leaving little cushion if earnings fall.' },
  fcfMargin: { good: 'A free cash flow margin of {v} (above 10%): a large share of sales turns into spendable cash.',
               bad: 'A free cash flow margin of {v} (below 3%): little cash is left after running and investing in the business.' },
  payoutRatio: { good: 'A payout ratio of {v} (below 60%): the dividend is well covered by profit, leaving room to grow it.',
                 bad: 'A payout ratio of {v} (above 100%): the company pays out more than it earns, which is not sustainable for long unless profits recover.' },
  sbcPct: { good: 'Stock pay at {v} of sales (below 3%): modest dilution of existing shareholders.',
            bad: 'Stock pay at {v} of sales (above 10%): heavy share-based pay, which steadily dilutes shareholders and flatters cash flow.' },
  revGrowth: { good: 'Revenue grew {v} (above 10%): strong demand for what the company sells.',
               bad: 'Revenue changed {v} (shrinking): sales are falling compared with a year ago.' },
  niGrowth: { good: 'Profit grew {v} (above 10%).',
              bad: 'Profit changed {v} (shrinking): the company earned less than a year ago.' },
  epsGrowth: { good: 'Earnings per share grew {v} (above 10%): each share\'s slice of profit is rising.',
               bad: 'Earnings per share changed {v} (shrinking): each share\'s slice of profit fell.' },
  revCagr3: { good: 'Revenue grew {v} per year on average over 3 years: steady, strong growth.',
              bad: 'Revenue changed {v} per year on average over 3 years: sales are lower than they were 3 years ago.' },
};

function buildRatios(fin, mcap, ev) {
  const A = fin.annual.rows;
  const paysDividends = [...A, ...fin.quarterly.rows].some(r => r.dividendsPaid > 0);
  const columns = [];
  if (fin.ttm) columns.push({ label: 'TTM', sub: 'last 4 quarters', ctx: { v: fin.ttm, prev: fin.ttmPrior, prev3: null, mcap, ev, paysDividends } });
  else if (A[0]) columns.push({ label: fin.annual.periods[0].label, sub: 'latest year', ctx: { v: A[0], prev: A[1], prev3: A[3], mcap, ev, paysDividends } });
  for (let i = 0; i < Math.min(5, A.length); i++) {
    columns.push({ label: fin.annual.periods[i].label, sub: 'fiscal year', ctx: { v: A[i], prev: A[i + 1], prev3: A[i + 3] } });
  }
  const groups = [];
  for (const r of RATIOS) {
    let g = groups.find(x => x.name === r.group);
    if (!g) groups.push((g = { name: r.group, rows: [] }));
    const values = columns.map((col, i) => {
      if (r.ttmOnly && i > 0) return null;
      const v = r.f(col.ctx);
      return has(v) ? v : null;
    });
    const ratings = values.map(v => (!has(v) ? null : r.good?.(v) ? 'good' : r.bad?.(v) ? 'bad' : r.good ? 'ok' : null));
    g.rows.push({ key: r.key, label: r.label, note: r.note, fmt: r.fmt, ttmOnly: !!r.ttmOnly, values, ratings, hints: HINTS[r.key] || null });
  }
  return { columns: columns.map(c => ({ label: c.label, sub: c.sub })), groups };
}

// ---------------------------------------------------------------- Yahoo: prices
// Raw materials trade as futures; Yahoo uses "=F" symbols for the front-month contract.
const COMMODITIES = [
  { ticker: 'GC=F', name: 'Gold', unit: 'per troy ounce' },
  { ticker: 'SI=F', name: 'Silver', unit: 'per troy ounce' },
  { ticker: 'CL=F', name: 'Crude oil (WTI)', unit: 'per barrel' },
  { ticker: 'BZ=F', name: 'Crude oil (Brent)', unit: 'per barrel' },
  { ticker: 'NG=F', name: 'Natural gas', unit: 'per MMBtu' },
  { ticker: 'HG=F', name: 'Copper', unit: 'per pound' },
  { ticker: 'PL=F', name: 'Platinum', unit: 'per troy ounce' },
  { ticker: 'PA=F', name: 'Palladium', unit: 'per troy ounce' },
];
const RANGES = { '1d': '1m', '5d': '5m', '3mo': '1d', '6mo': '1d', '1y': '1d', '2y': '1d', '5y': '1d', '10y': '1wk', max: '1mo' };

async function getPrices(ticker, range) {
  const interval = RANGES[range] || '1d';
  const r = RANGES[range] ? range : '1y';
  const intraday = /m$/.test(interval);
  // Intraday data feeds the live chart, so it is only cached briefly.
  return cached(`px:${ticker}:${r}`, intraday ? 15000 : 5 * 60000, async () => {
    let j;
    try {
      j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${r}&interval=${interval}&includePrePost=false`, { 'User-Agent': YAHOO_UA });
    } catch (e) {
      if (e.status === 404) throw userError(`No price data found for "${ticker}".`, 404);
      throw e;
    }
    const res = j.chart?.result?.[0];
    if (!res || !res.timestamp) throw userError(`No price data found for "${ticker}".`, 404);
    const q = res.indicators.quote[0];
    const bars = [];
    for (let i = 0; i < res.timestamp.length; i++) {
      if ([q.open[i], q.high[i], q.low[i], q.close[i]].some(x => x === null || x === undefined)) continue;
      bars.push({ time: res.timestamp[i], open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 });
    }
    const m = res.meta;
    const commodity = COMMODITIES.find(c => c.ticker === ticker);
    return {
      meta: {
        symbol: m.symbol, name: commodity ? commodity.name : m.longName || m.shortName || m.symbol,
        contract: commodity ? m.shortName || m.longName : null, unit: commodity?.unit || null,
        assetType: commodity ? 'commodity' : m.instrumentType === 'FUTURE' ? 'future' : m.instrumentType === 'INDEX' ? 'index' : 'equity', exchange: m.fullExchangeName || m.exchangeName,
        currency: m.currency, price: m.regularMarketPrice,
        // Daily bars: the bar before the latest one is the previous session's close.
        previousClose: interval === '1d' && bars.length > 1 ? bars[bars.length - 2].close : r === '1d' ? m.chartPreviousClose ?? null : m.previousClose ?? null,
        dayHigh: m.regularMarketDayHigh, dayLow: m.regularMarketDayLow,
        high52: m.fiftyTwoWeekHigh, low52: m.fiftyTwoWeekLow, marketTime: m.regularMarketTime, interval, gmtoffset: m.gmtoffset || 0,
      },
      bars,
    };
  });
}

// Latest price for live updates. Cached for 10 s, so many viewers of one ticker share one Yahoo request.
async function getQuote(ticker) {
  return cached(`q:${ticker}`, 10000, async () => {
    let j;
    try {
      j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1m&includePrePost=false`, { 'User-Agent': YAHOO_UA });
    } catch (e) {
      if (e.status === 404) throw userError(`No price data found for "${ticker}".`, 404);
      throw e;
    }
    const res = j.chart?.result?.[0];
    if (!res) throw userError(`No price data found for "${ticker}".`, 404);
    const m = res.meta, q = res.indicators?.quote?.[0] || {}, ts = res.timestamp || [];
    let hi = -Infinity, lo = Infinity, vol = 0, open = null;
    for (let i = 0; i < ts.length; i++) {
      if (has(q.high?.[i])) hi = Math.max(hi, q.high[i]);
      if (has(q.low?.[i])) lo = Math.min(lo, q.low[i]);
      vol += q.volume?.[i] || 0;
      if (open === null && has(q.open?.[i])) open = q.open[i];
    }
    const reg = m.currentTradingPeriod?.regular;
    const now = Date.now() / 1000;
    return {
      price: m.regularMarketPrice,
      previousClose: m.chartPreviousClose ?? m.previousClose ?? null,
      open,
      dayHigh: m.regularMarketDayHigh ?? (Number.isFinite(hi) ? hi : null),
      dayLow: m.regularMarketDayLow ?? (Number.isFinite(lo) ? lo : null),
      volume: m.regularMarketVolume ?? vol,
      time: m.regularMarketTime,
      sessionStart: reg?.start ?? null,
      marketOpen: !!reg && now >= reg.start && now < reg.end,
      gmtoffset: m.gmtoffset || 0,
    };
  });
}

// ---------------------------------------------------------------- company endpoint
async function getCompany(raw) {
  const t = await resolveTicker(raw);
  return cached(`co:${t.ticker}`, 10 * 60000, async () => {
    const cik = String(t.cik).padStart(10, '0');
    // The raw SEC file is ~4 MB (tens of MB once parsed), so only the small processed result is
    // kept; the raw file is released as soon as it has been processed.
    const [built, px] = await Promise.all([
      cached(`fin:${cik}`, 6 * 3600000, async () => {
        const facts = await getJSON(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { 'User-Agent': SEC_UA }).catch(e => {
          if (e.status === 404) throw userError(`The SEC has no financial statements on file for ${t.ticker}. ETFs, funds and trusts do not publish income statements or balance sheets.`, 404);
          throw e;
        });
        return { fin: buildFinancials(facts), entityName: facts.entityName };
      }),
      getPrices(t.ticker, '3mo').catch(() => null),
    ]);
    const fin = built.fin;
    const price = px?.meta?.price ?? null;
    const latestQuarter = fin.quarterly.rows[0] || fin.annual.rows[0] || {};
    const shares = fin.shares?.shares || latestQuarter.sharesDiluted || null;
    const mcap = has(price) && has(shares) ? price * shares : null;
    const bal = fin.ttm || latestQuarter;
    const ev = has(mcap) ? mcap + (bal.totalDebt || 0) - (bal.cash || 0) - (bal.shortTermInvestments || 0) : null;
    return {
      ticker: t.ticker, name: built.entityName || t.name, cik,
      secUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=10-&dateb=&owner=include&count=40`,
      quote: px?.meta || null,
      shares, sharesAsOf: fin.shares?.asOf || null, marketCap: mcap, enterpriseValue: ev,
      filing: fin.filing, ttmEnd: fin.ttmEnd,
      annual: { periods: fin.annual.periods, data: fin.annual.data },
      quarterly: { periods: fin.quarterly.periods, data: fin.quarterly.data },
      ttm: fin.ttm,
      ratios: buildRatios(fin, mcap, ev),
    };
  });
}

// ---------------------------------------------------------------- http
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json' };

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function handleApi(url, res) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', name, arg]
  try {
    if (parts[1] === 'search') {
      const q = (url.searchParams.get('q') || '').trim().toUpperCase();
      if (!q) return send(res, 200, []);
      const out = COMMODITIES
        .filter(c => c.ticker.startsWith(q) || c.name.toUpperCase().includes(q) || (q.length >= 3 && 'COMMODITY'.startsWith(q)))
        .map(c => ({ score: -1, ticker: c.ticker, name: `${c.name} (commodity futures)` }));
      for (const e of (await tickerMap()).values()) {
        const score = e.ticker === q ? 0 : e.ticker.startsWith(q) ? 1 : e.name.toUpperCase().includes(q) ? 2 : -1;
        if (score >= 0) out.push({ score, ticker: e.ticker, name: e.name });
      }
      out.sort((a, b) => a.score - b.score || a.ticker.length - b.ticker.length);
      return send(res, 200, out.slice(0, 8).map(({ ticker, name }) => ({ ticker, name })));
    }
    if (parts[1] === 'company' && parts[2]) return send(res, 200, await getCompany(decodeURIComponent(parts[2])));
    if (parts[1] === 'prices' && parts[2]) {
      const sym = normTicker(decodeURIComponent(parts[2]));
      if (!/^\^?[A-Z0-9=-]{1,15}$/.test(sym)) throw userError('That does not look like a ticker symbol.');
      return send(res, 200, await getPrices(sym, url.searchParams.get('range') || '1y'));
    }
    if (parts[1] === 'quote' && parts[2]) {
      const sym = normTicker(decodeURIComponent(parts[2]));
      if (!/^\^?[A-Z0-9=-]{1,15}$/.test(sym)) throw userError('That does not look like a ticker symbol.');
      return send(res, 200, await getQuote(sym));
    }
    if (parts[1] === 'health') {
      const m = process.memoryUsage();
      const mb = x => Math.round((x / 1048576) * 10) / 10;
      return send(res, 200, { ok: true, uptimeS: Math.round(process.uptime()), rssMB: mb(m.rss), heapUsedMB: mb(m.heapUsed), cacheEntries: cache.size });
    }
    if (parts[1] === 'commodities') return send(res, 200, COMMODITIES);
    return send(res, 404, { error: 'Unknown API route' });
  } catch (e) {
    if (!e.expose) console.error(e);
    return send(res, e.expose ? e.status : 502, { error: e.expose ? e.message : `Could not load data (${e.message}). Try again in a moment.` });
  }
}

function handleStatic(url, res) {
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) handleApi(url, res);
  else handleStatic(url, res);
}).listen(PORT, () => console.log(`swe_fisk analysis running at http://localhost:${PORT}`));

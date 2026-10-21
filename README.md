# swe_fisk analysis

Type a US ticker and get:

- **Financial statements** (income statement, balance sheet, cash flow), annual or quarterly, straight from the company's SEC 10-K/10-Q filings. Each line has a plain-English explanation, a year-over-year change and a trend sparkline.
- **Key ratios**: valuation (P/E, P/S, P/B, EV/EBITDA, FCF yield, dividend yield), profitability (margins, ROE, ROA, ROIC), financial health (current/quick ratio, debt/equity, net debt/EBITDA, interest coverage), cash flow and growth. Each ratio is flagged ✓ (healthy) or ! (worth a closer look) using general rules of thumb.
- **Trend charts**: revenue, net income, free cash flow, EPS and margins.
- **Price chart**: candlesticks, volume, SMA 50/200, RSI, and automatically detected **support (stöd) and resistance (motstånd)** levels, with strength, number of touches and distance from the current price.

## Run it

Requires Node.js 18 or newer. There are no packages to install.

```bash
npm start
```

Then open http://localhost:3000. You can link straight to a ticker, e.g. http://localhost:3000/#NVDA.

Optional: the SEC asks API users to identify themselves. Set your own contact before starting:

```bash
set SEC_USER_AGENT=Your Name you@example.com
```

(Use `$env:SEC_USER_AGENT="Your Name you@example.com"` in PowerShell, or `export` on macOS/Linux.)

## Data sources

- Financials: SEC EDGAR XBRL "company facts" API (free, official). Quarterly values that companies only report year-to-date (most cash-flow items, and Q4) are derived by subtraction.
- Prices: Yahoo Finance chart endpoint (free, unofficial, may be delayed).

## Buy / sell trends (stocks and raw materials)

Works for any stock and for commodities: gold `GC=F`, silver `SI=F`, oil `CL=F` (WTI) / `BZ=F` (Brent), natural gas `NG=F`, copper `HG=F`, platinum `PL=F`, palladium `PA=F`. You can also just type "gold", "oil", "copper" etc.

- **Trend regimes**: Supertrend (ATR 10 × 2/3/4 for Fast/Balanced/Slow). The chart is shaded green in a buy trend and red in a sell trend. The solid trailing line is the level whose break would flip the trend.
- **Signals**: a Buy/Sell arrow marks every flip. The side panel lists recent signals and how each one played out until the next flip, plus a hit-rate for the visible range.
- **Strength**: ADX 14 (below 20 = choppy, so signals are less reliable).
- **Trendlines** (dashed): for each of the latest trend stretches, a line from the extreme low (high) through the rising lows (falling highs), never broken within that stretch.

## How support & resistance are found

1. Swing highs/lows are bars whose high or low is the extreme within a surrounding window. The window size depends on the chart range and the "Levels" setting.
2. Turning points within about 0.8 × ATR of each other are grouped into one level.
3. Levels are scored by number of touches, how recent they are, and role reversal (a level that has been both support and resistance). The range high and low always count.
4. Levels above the last price are resistance and levels below are support. Line thickness shows strength.

For information and education only, not investment advice.

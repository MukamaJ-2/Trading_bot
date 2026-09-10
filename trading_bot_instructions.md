# Trading Bot Instructions

## 1. Project Goal

Build a paper-trading bot that trades **BTC-USD** on the **5-minute** timeframe using a simple,
transparent moving-average crossover strategy. The bot never touches real money or a real
brokerage/exchange account — this repository has no broker/exchange MCP or API connection at
all. It fetches real public market data from Coinbase Exchange's public candles endpoint and
simulates every order locally. (Binance's public API was tried first, per the default in the
Miles High Club prompts, but it returns HTTP 451 and refuses all cloud/datacenter IPs under its
own terms of service — that blocks GitHub Actions, Vercel, and every standard hosting platform
equally, not just one sandbox. Coinbase Exchange's public endpoint has no such restriction and
still needs no API key, so it replaced Binance as the data source.) Paper/test mode comes first
(and only) because the goal right now is to prove the strategy and the bot's decision-making
logic are honest and correct before anything resembling real capital is ever considered.

## 2. Safety Rules

- Paper trading only. By default, no code path places any order at all (local simulation
  only). The one opt-in exception, the Alpaca broker adapter, can only ever submit to
  Alpaca's paper endpoint — that endpoint is a hardcoded constant, not a setting.
- No LIVE trading path exists, and none should be added without a separate, explicit decision.
- No secrets, API keys, or credentials are stored in source code, ever.
- No credentials are exposed to any frontend — this is a backend/CLI-only project.
- No trade is ever simulated unless it has passed the risk module's checks.

## 3. Strategy Rules

Five independent, confirmed strategies are evaluated on every scan, in order. The first one
that produces a real BUY/SELL wins; if all five come back HOLD, the log reports the specific
reason from each one. This keeps every individual trade "fewer, higher-conviction" while giving
the bot more real ways to find a signal than waiting on one specific setup.

1. **MA crossover** — 9-period fast SMA crossing the 21-period slow SMA on the most recent
   completed candle. A raw crossover only becomes a real trade if it also passes:
   - **Trend alignment**: a bullish crossover only counts as BUY if price is **above** the
     50-period trend SMA; a bearish crossover only counts as SELL if price is **below** it.
   - **Volume confirmation**: the signal candle's volume must be at least **1.5x** the average
     volume of the prior 20 candles — a real move, not noise.
2. **MACD crossover** — the MACD line (12-period EMA minus 26-period EMA) crossing its own
   9-period EMA signal line. Confirmed by the same trend + volume rules as the MA crossover.
   Catches trend shifts the slower 9/21 MA crossover is too strict to see.
3. **RSI mean-reversion** — a real reversal out of oversold (RSI crosses back above 30 from
   below) or overbought (RSI crosses back below 70 from above) territory, using Wilder's
   14-period RSI. Confirmed by volume only — **no trend filter**, since a reversal signal is,
   by definition, expected to go against the recent trend.
4. **Fibonacci retracement** — finds the swing high/low over the last 50 candles (excluding the
   current one, so there's no lookahead), and watches for price touching the classic **61.8%**
   golden-ratio retracement level and closing back on the trend side — the standard "buy the
   dip / sell the rally" continuation setup. Confirmed by volume only.
5. **Bollinger Bands** — price touching the upper or lower band (20-period mean ± 2 standard
   deviations) on the prior candle and closing back inside the band on this one — a real
   reversion, not a break. Confirmed by volume only.
- Hold: none of the five strategies produced a fresh, confirmed signal on the most recent
  candle. The log states each strategy's specific reason (no crossover/reversal, wrong side of
  the trend, or volume too low), so it's always honest about why nothing was traded.
- Configurable via `.env`: `TREND_MA_PERIOD` (default 50), `VOLUME_LOOKBACK` (default 20),
  `VOLUME_MULTIPLIER` (default 1.5), `MACD_FAST_PERIOD`/`MACD_SLOW_PERIOD`/`MACD_SIGNAL_PERIOD`
  (default 12/26/9), `RSI_PERIOD` (default 14), `RSI_OVERSOLD`/`RSI_OVERBOUGHT` (default 30/70),
  `FIB_LOOKBACK`/`FIB_LEVEL` (default 50/0.618), `BOLLINGER_PERIOD`/`BOLLINGER_STDDEV`
  (default 20/2).
- Backtest notes: no live TradingView/backtest MCP was available in this environment, so these
  strategies were not pre-validated in TradingView. Instead, the bot's own `replay:raw` command
  performs an honest historical replay against real Coinbase candles and reports real win/loss
  metrics for this exact combined rule set — treat that as the real validation of the strategy.

## 4. Risk Rules

- Quantity per trade: **0.01 BTC** (configurable via `TRADE_QUANTITY` in `.env`).
- Max position: **0.05 BTC** (configurable via `MAX_POSITION` in `.env`). If a proposed trade
  would push the position beyond this, the final action becomes **SKIP**.
- Stop loss: **2%** adverse move from entry (configurable via `STOP_LOSS_PCT`).
- Take profit: **4%** favorable move from entry (configurable via `TAKE_PROFIT_PCT`).
- Max daily loss: **5%** of a notional daily baseline (configurable via `MAX_DAILY_LOSS_PCT`).
  Once today's realized paper P&L (from `data/ledger.csv`) breaches this limit, every further
  BUY/SELL for the rest of the day becomes **SKIP** with that reason stated explicitly.
- Every decision (BUY, SELL, HOLD, or SKIP) must be logged with a plain-English reason.

## 5. Broker/MCP Rules

- No broker/exchange connection is active by default. There is no account status, balance,
  or order-placement integration unless explicitly enabled (below).
- Market data comes from Coinbase Exchange's **public**, unauthenticated candles REST
  endpoint (`GET /products/{symbol}/candles`) by default, which requires no API key.
  Optionally, `MARKET_DATA_PROVIDER=alpaca` switches to Alpaca's market data API instead
  (e.g. for stock symbols) — market-data-only, no order path, on its own.
- Optionally, `BROKER=alpaca` (a separate opt-in from the market-data setting above) routes
  approved BUY/SELL decisions to Alpaca's **paper** trading API instead of the local
  simulation. Verified per the Miles High Club "Connect MCP To Claude Before Build" prompt's
  own checklist: `npm run broker:check` reads account status/positions/orders/market data
  and stops immediately if anything looks live, unknown, or unsafe; `npm run broker:preview`
  shows exactly what would be submitted, without submitting it. Only after both are clean
  should `BROKER=alpaca` be set to let `scan` actually place paper orders.
- Alpaca's paper endpoint (`https://paper-api.alpaca.markets`) is hardcoded in
  `src/brokerAlpaca.ts`, not read from an environment variable — there is no setting that
  can point this adapter at Alpaca's live trading host.
- Alpaca API keys (used for market data, the broker, or both) live only in `.env`
  (gitignored) or GitHub Actions secrets, never in source code and never pasted into chat.

## 6. Memory Rules

- Memory is two local files: `data/ledger.csv` (every trade and skip decision, with outcome and
  P&L) and `data/learnings.md` (plain-English lessons distilled from real closed trades/replays).
- Both files are read before every future BUY or SELL decision.
- If a setup matches a real, previously-recorded losing pattern for that symbol, the action is
  changed to **SKIP** and no paper order is created.
- Nothing is ever seeded or invented — lessons and ledger rows are only ever written from real
  paper-trade or replay outcomes.

## 7. Definition of Done

- `npm install`, `npm run scan`, `npm run replay:raw`, `npm run replay:memory`,
  `npm run memory:reset`, `npm run broker:check`, and `npm run broker:preview` all work.
- The bot uses real public market data, or fails with a clear, honest error if that data is
  unavailable — it never falls back to generated or fixture candles.
- Every run prints timestamped logs for market data fetch, computed signal, risk check, memory
  check (once memory exists), and final decision.
- No LIVE trade of any kind is ever placed — confirmed by there being no code path that calls
  a live exchange order-placement endpoint anywhere in this repository. The one real
  order-placement path that exists (`src/brokerAlpaca.ts`) is opt-in (`BROKER=alpaca`) and
  hardcoded to Alpaca's paper endpoint.

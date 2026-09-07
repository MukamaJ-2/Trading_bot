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

- Paper trading only. There is no code path that can place a real order.
- No live trading path exists, and none should be added without a separate, explicit decision.
- No secrets, API keys, or credentials are stored in source code, ever.
- No credentials are exposed to any frontend — this is a backend/CLI-only project.
- No trade is ever simulated unless it has passed the risk module's checks.

## 3. Strategy Rules

- Indicators: 9-period fast simple moving average (SMA), 21-period slow SMA, computed on close
  prices.
- Entry (BUY): the fast SMA crosses **above** the slow SMA on the most recent completed candle
  (a "bullish crossover").
- Exit (SELL): the fast SMA crosses **below** the slow SMA on the most recent completed candle
  (a "bearish crossover").
- Hold: no fresh crossover on the most recent candle.
- Backtest notes: no live TradingView/backtest MCP was available in this environment, so this
  strategy was not pre-validated in TradingView. Instead, the bot's own `replay:raw` command
  performs an honest historical replay against real Coinbase candles and reports real win/loss
  metrics for this exact rule set — treat that as the first real validation of the strategy.

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

- No broker or exchange MCP/API is connected in this project. There is no account status,
  balance, or order-placement integration of any kind.
- Market data comes from Coinbase Exchange's **public**, unauthenticated candles REST
  endpoint (`GET /products/{symbol}/candles`) by default, which requires no API key.
- Optionally, `MARKET_DATA_PROVIDER=alpaca` switches to Alpaca's market data API instead
  (e.g. for stock symbols). This is still **market-data-only** — Alpaca requires an API
  key/secret even for read-only data, but nothing in this codebase calls any provider's
  order-placement endpoint. Keys live only in `.env` (gitignored) or GitHub Actions
  secrets, never in source code and never pasted into chat.
- If a broker/MCP connection is verified and added later, it must be wired in as a separate,
  clearly-isolated adapter that defaults to paper/test mode, and it must go through the same
  connection-verification checklist described in the Miles High Club "Connect MCP To Claude
  Before Build" prompt before it is trusted.

## 6. Memory Rules

- Memory is two local files: `data/ledger.csv` (every trade and skip decision, with outcome and
  P&L) and `data/learnings.md` (plain-English lessons distilled from real closed trades/replays).
- Both files are read before every future BUY or SELL decision.
- If a setup matches a real, previously-recorded losing pattern for that symbol, the action is
  changed to **SKIP** and no paper order is created.
- Nothing is ever seeded or invented — lessons and ledger rows are only ever written from real
  paper-trade or replay outcomes.

## 7. Definition of Done

- `npm install`, `npm run scan`, `npm run replay:raw`, `npm run replay:memory`, and
  `npm run memory:reset` all work.
- The bot uses real public Coinbase Exchange market data, or fails with a clear, honest error if
  that data is unavailable — it never falls back to generated or fixture candles.
- Every run prints timestamped logs for market data fetch, computed signal, risk check, memory
  check (once memory exists), and final decision.
- No real trade of any kind is ever placed — confirmed by there being no code path that calls a
  real exchange order-placement endpoint anywhere in this repository.

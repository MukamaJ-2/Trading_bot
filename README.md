# Trading Bot (Paper Trading Only)

> **New:** a daily-timeframe Backtest Lab and daily paper bot built from *The Backtest
> Machine*. See [the section below](#the-backtest-machine-daily-lab--daily-paper-bot).

A TypeScript/Node.js paper-trading bot built from the Miles High Club "Paper Trading Bot"
Claude prompts (`TradingBotV2-1.pdf`). It trades **BTC-USD** on the **5-minute** timeframe
using three independent, confirmed strategies — a 9/21 MA crossover, a MACD crossover, and an
RSI mean-reversion reversal — each requiring its own trend and/or volume confirmation before a
signal is trusted as a real trade (fewer, higher-conviction trades — see
[`trading_bot_instructions.md`](trading_bot_instructions.md) section 3), using only real public
market data from Coinbase Exchange by default. **By default, there is no code path that places
any order at all — every "trade" is a local simulation.** An optional, opt-in adapter can
submit real orders to Alpaca's **paper** trading simulator (see "Optional: Alpaca paper
trading" below) — there is still no path to live trading anywhere in this repository.

> **Why Coinbase and not Binance?** The PDF's default data source is Binance's public klines
> endpoint. It works fine from a home connection, but Binance returns HTTP 451 and refuses
> every cloud/datacenter IP under its own terms of service — that blocks GitHub Actions,
> Vercel, AWS, and effectively all standard hosting equally. Coinbase Exchange's public
> candles endpoint has no such restriction and still needs no API key, so it's the data
> source here. `SYMBOL`/`INTERVAL` in `.env` still work the same way either way.

## The Backtest Machine: daily lab + daily paper bot

Built from Miles Deutscher Finance's *The Backtest Machine* cheat sheet. It sits alongside the
original 5-minute bot below and shares its data providers and paper-only rules. The idea:
**prove a strategy on your asset and your timeframe, check it isn't luck or curve-fitting,
then forward-test it on paper.** The default is the cheat sheet's winner, the **EMA 9/21
cross on BTC daily**, which is long-only, all-in and has no leverage.

### The interface: `npm run ui`

```bash
npm install
npm run ui        # then open http://localhost:3000
```

This is a local web app that does everything below with clicks instead of commands. It
uses no extra dependencies and stays paper-only. It listens on `127.0.0.1` only, so nothing
outside your machine can reach it. Set `UI_PORT` to change the port.

- **Bot tab.** Shows the daily paper bot's position, paper equity, closed trades and the
  signal right now. A chart shows the last 180 days of price with the strategy's EMAs,
  shading where the strategy wants to be long, and the bot's own fills. Below it is the full
  paper ledger. It also has buttons to *run today's check* (the same idempotent
  `npm run daily`) and to reset the paper account.
- **Lab tab.** Pick a market, timeframe, start date, strategy and settings, or upload a
  TradingView CSV. Then run:
  - **Backtest:** gives a verdict, return / drawdown / profit factor against buy-and-hold, the
    equity curve against buy-and-hold (with a log-scale toggle), trades marked on the price
    chart, and the full trade list.
  - **Tournament:** ranks every strategy. Click a row to open its backtest.
  - **Plateau check:** a heatmap of the neighbouring settings, with your setting outlined.
  - **Walk-forward:** compares in-sample and out-of-sample results and shows whether the
    in-sample winner held up on data it hadn't seen.
- Light and dark mode, and works on a phone-width screen.

### The interface online: GitHub Pages

A browser-only copy of the same interface lives in `docs/`, so GitHub Pages can host it at
**https://mukamaj-2.github.io/Trading_bot/**. It's public, and you can open it from any
device.

- **Lab tab:** works the same as the local version. The backtest engine runs in your browser,
  using daily candles that the Daily Bot workflow publishes to `docs/data/candles/` once a day.
  Use the **Market** box to pick one of the published markets (BTC-USD, ETH-USD, SOL-USD by
  default; set the `PAGES_SYMBOLS` repository variable to change them). For any other market
  the page tries Coinbase directly from your browser, and you can always upload a CSV.
- **Bot tab:** a read-only view of the paper bot's last published state (`docs/data/bot.json`).
  The bot itself runs on schedule in GitHub Actions, so the page has no "run" or "reset"
  buttons.

**To switch it on, once:**
1. Merge this branch into `main`. Scheduled workflows only run from the default branch.
2. In the repo, go to **Settings → Pages**. Under *Build and deployment*, set *Source* to
   **Deploy from a branch**, then choose **`main`** and **`/docs`**, and click **Save**.
3. Go to **Actions → Daily Bot (paper) → Run workflow**. This publishes the first data
   snapshot. After that it refreshes itself every day at 00:07 UTC.
4. Open the address shown at the top of the Settings → Pages screen. It takes a minute or two
   after each change. The repo name in the address is case-sensitive: `/Trading_bot/`.

Never edit `docs/index.html` or `docs/engine.js` by hand. They're built from `ui/index.html`
and `src/` by `npm run build:pages`, and CI fails if they're out of date. The old 5-minute bot
dashboard is still there at `docs/5m.html`.

### 1. Test: `npm run lab:*`

All four commands run on real closed candles from the market API, or on a CSV you export
from TradingView with `--csv file.csv`. The test conditions match the cheat sheet: signals on
the candle close, fills on the next open, 0.1% commission per side, 100% of equity, and
$100,000 starting capital.

| Command | What it answers |
|---|---|
| `npm run lab:tournament` | Runs all 8 strategies on the same asset, timeframe and window. Ranks them on return/drawdown against buy-and-hold and gives each a verdict. |
| `npm run lab:backtest` | Prints the full trade list for one strategy: the `--backfill` you check against TradingView's Strategy Tester. |
| `npm run lab:plateau` | **Overfitting check.** Runs the neighbouring settings (for example 7–11 × 19–23 around 9/21). A real edge is a plateau, not a spike. |
| `npm run lab:walkforward` | **Selection-bias check.** Picks the best of ~180 configurations on the first 60% of the window, then judges it on the unseen 40%. |

Flags (they also work as env vars, see `.env.example`): `--symbol BTC-USD`, `--tf 1d|1w`
(weekly is resampled from daily, because timeframe changes results),
`--start 2023-07-01` or `--days 1095`, `--strategy ema_cross`, `--params fast=9,slow=21`,
`--commission 0.1`, `--slippage 0.05`, `--csv path`.

```bash
npm run lab:tournament -- --symbol BTC-USD --start 2023-07-01
npm run lab:backtest   -- --strategy ema_cross --start 2023-07-01
npm run lab:plateau    -- --strategy ema_cross
npm run lab:walkforward
npm run lab:tournament -- --symbol ETH-USD --tf 1w   # never borrow a backtest from another market
```

Verdicts follow the cheat sheet's "read the verdict" step:
- **ANECDOTE**: fewer than 20 closed trades. This is not evidence either way.
- **BIN**: profit factor below 1. The strategy loses money after fees.
- **FIX**: the strategy is profitable but doesn't beat holding on return/drawdown.
- **CANDIDATE**: profit factor of at least 1.5 and a better return/drawdown than buy-and-hold. A
  candidate still has to pass `lab:plateau` and a paper forward test.

Strategies: `ema_cross` (9/21), `ema_cross_regime` (9/21, only above the 200 SMA), `sma_cross`
(50/200 golden cross), `supertrend` (10, 3), `donchian` (20/10 turtle breakout), `macd`
(12/26/9), `price_sma` (200), `rsi_reversion` (14, 30/70).

**Run it on GitHub:** go to Actions, open **Backtest Lab** and click *Run workflow*. It runs
all four lab commands on real data and posts the report to the run's summary page. Use this
when your own network blocks the data API.

**Verify against TradingView:** paste [`pine/ema_cross_9_21.pine`](pine/ema_cross_9_21.pine)
into the Pine Editor on BTCUSD 1D. Then compare its trade list with
`npm run lab:backtest -- --start 2023-07-01`. The entry and exit dates should match. Prices
differ slightly between data feeds. If the dates disagree, stop and fix it before going further.

### 2. Forward-test: `npm run daily` (paper only)

This is the cheat sheet's daily loop. Once per day after the 00:00 UTC close, the bot:
1. fetches daily candles,
2. evaluates the strategy on the **closed** candle,
3. if it crossed, paper-buys or paper-sells at the new candle's open,
4. logs to `data/daily_ledger.csv` and alerts.

On days with no cross it does nothing, and that discipline is the strategy.

- **No double entries.** State lives in `data/daily_state.json` and is written atomically.
  Every closed candle is processed exactly once, so re-running the same day is a no-op. Missed
  days are caught up in order. The first run never chases a trend that is already in progress.
- **Halt on anything unexpected.** Missing or stale candles, broken OHLC, or a state file
  that belongs to a different symbol or strategy all cause the bot to log, alert, and exit
  non-zero. It never guesses.
- **The bot matches the backtest.** A unit test steps the daily bot day by day over a series
  and asserts it makes exactly the same fills, and ends with exactly the same equity, as the
  backtest engine.
- **Alerts:** optional Telegram (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` as secrets) for every
  signal plus a daily heartbeat.
- **Scheduled:** `.github/workflows/daily-bot.yml` runs at 00:07 UTC and commits the paper state.
- `npm run daily:reset` starts a fresh paper account.

### 3. The ladder: never skip a rung

**validate (lab) → paper forward test for several weeks (`daily`) → only then consider more.**
This repository stops at paper. It has no live-trading path. Adding one would be a separate,
explicit decision, and it must follow the cheat sheet's non-negotiables:
- trade-only API keys (withdrawals disabled, IP-whitelisted),
- a hard capital cap,
- start smaller than feels necessary.

Anyone who asks you to deposit funds into a bot or contract address to "activate" it is
running a scam.

> No strategy is good or bad in general. It is matched or mismatched to an asset, a
> timeframe and a market regime. A backtest is a verdict on the past, not a promise about the
> future. This is education, not financial advice.

## What the bot does

1. `npm run scan` fetches recent real candles, computes the MA-crossover signal, runs it
   through the risk module, checks it against memory, and simulates a paper order — printing
   a timestamped log at every step.
2. `npm run replay:raw` replays real historical candles, finds every real crossover event,
   scores its real forward outcome, and prints a trade-by-trade table plus summary metrics.
   This is the **honest baseline** — it never consults memory.
3. `npm run replay:memory` replays the same historical crossover events, but this time checks
   `data/ledger.csv` and `data/learnings.md` first and **skips** any setup that has a real
   recorded loss.
4. `npm run memory:reset` wipes `data/ledger.csv` and `data/learnings.md` back to empty.

## Install and run

```bash
npm install
npm run scan
npm run replay:raw
npm run replay:memory
npm run memory:reset
```

No API key, account, or `.env` file is required to run any of these — they all default to
safe values. Copy `.env.example` to `.env` only if you want to change a setting.

## How memory works

- `data/ledger.csv` logs every trade and skip decision: timestamp, symbol, action, price,
  quantity, reason, mode, outcome, and PnL.
- `data/learnings.md` stores a plain-English lesson for every real losing crossover setup
  `replay:raw` finds.
- Before any future BUY/SELL, the bot asks: has this symbol lost on this exact crossover
  direction before (per the ledger), or does `learnings.md` warn about it? If so, the final
  action becomes **SKIP** and no paper order is created.
- Nothing is ever seeded or invented. If you run `replay:memory` before any real loss has ever
  been recorded, it tells you to run `replay:raw` first.
- `npm run memory:reset` clears both files back to their empty starting state.

## Paper/local execution — and why there's no live mode

By default this project has **no broker or exchange connection at all**. All market data
comes from Coinbase Exchange's public, unauthenticated candles endpoint
(`GET https://api.exchange.coinbase.com/products/{symbol}/candles`) — no API key needed, no
account touched. Every "order" is a local, in-memory record produced by `src/execution.ts`,
which has no function that calls any real exchange order-placement endpoint. This stays true
unless you explicitly opt into the Alpaca paper-trading broker described below.

As a guardrail against copy-pasting a `.env` from a different project, the bot refuses to
start at all if `LIVE_TRADING=true` (or `1`) is set — even though that flag is not connected
to any real functionality.

## Optional: Alpaca as the market data source

Coinbase stays the default because it needs no API key. If you'd rather use Alpaca instead
(e.g. for stock symbols like `AAPL`, or its own crypto pair format like `BTC/USD`), that's
supported via `src/marketAlpaca.ts` — still **market-data-only** by itself; see the next
section if you also want real (paper) order execution.

Unlike Coinbase, Alpaca requires an API key/secret even for read-only data. **Get your own
key from [alpaca.markets](https://alpaca.markets) — never share it in chat with an AI
assistant, including this one.** Then:

**Running locally:** copy `.env.example` to `.env` and uncomment/fill the four Alpaca lines
(`MARKET_DATA_PROVIDER=alpaca`, `SYMBOL`, `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY`). `.env`
is gitignored, so this never gets committed.

**Running in GitHub Actions:** the workflows already pass these through as optional
environment variables that are empty unless you set them, so nothing breaks if you skip this.
To enable Alpaca there:
1. Repo → **Settings → Secrets and variables → Actions → Secrets** tab → add
   `ALPACA_API_KEY_ID` and `ALPACA_API_SECRET_KEY` as repository secrets.
2. Same page → **Variables** tab → add `MARKET_DATA_PROVIDER` = `alpaca` (and optionally
   `SYMBOL` if you're not using the crypto default).

Symbol format decides which Alpaca endpoint gets used automatically: anything containing
`/` (like `BTC/USD`) uses the crypto bars endpoint; anything else (like `AAPL`) uses the
stock bars endpoint.

## Optional: Alpaca paper trading (real order execution, never live)

This is a bigger step than the market-data adapter above: `src/brokerAlpaca.ts` can submit
real orders — but only ever to Alpaca's **paper** trading simulator
(`https://paper-api.alpaca.markets`), which is hardcoded as a constant in that file, not an
environment variable. There is no setting, secret, or code path anywhere in this repository
that can point it at Alpaca's live trading host. By default (`BROKER` unset) `npm run scan`
still only produces the local in-memory simulation described above — this broker is a
separate, explicit opt-in on top of it, same as the Miles High Club "Connect MCP To Claude
Before Build" prompt's own paper-first, verify-before-trusting approach.

**Follow this order — don't skip to step 3:**

1. **`npm run broker:check`** — read-only connection report. Confirms your keys work, prints
   account status/cash/buying power, open positions, open orders, and a market data check.
   Places, previews, or cancels nothing. Stops immediately and tells you exactly what's wrong
   if the account status isn't `ACTIVE` or anything else looks off.
2. **`npm run broker:preview`** — shows exactly what the current signal/risk/memory decision
   would do against your real (paper) Alpaca position, without submitting anything.
3. **Only once both of those look right**, set `BROKER=alpaca` (`.env` locally, or the
   `BROKER` repository **variable** for GitHub Actions) to let `npm run scan` actually submit
   paper orders through Alpaca instead of simulating locally.

**A real consequence to understand before flipping that switch in GitHub Actions
specifically:** `Bot Scan` runs on a 15-minute schedule. Once `BROKER=alpaca` is set as a
repo variable, every one of those scheduled runs can submit a real (paper) order the moment
the strategy signals a trade — not just when you're watching. That's the intended behavior
of an automated bot, but it's meaningfully different from everything else in this project,
which only ever *simulates*. Consider running with `BROKER` set only locally for a while
first.

Requires `ALPACA_API_KEY_ID`/`ALPACA_API_SECRET_KEY` (same keys as the market-data adapter —
Alpaca uses one key pair for both). Get them from your own Alpaca dashboard; never paste them
into chat with any AI assistant, including this one.

## Configuration

All settings live in `.env` (see `.env.example` for the full list and defaults):

| Variable | Default | Meaning |
|---|---|---|
| `SYMBOL` | `BTC-USD` | Market to trade (Coinbase product id, or `BTC/USD`/`AAPL`-style if using Alpaca) |
| `MARKET_DATA_PROVIDER` | `coinbase` | `coinbase` (default, no key needed) or `alpaca` (see below) |
| `BROKER` | unset | unset (default, local simulation only) or `alpaca` (real paper order execution — see below) |
| `INTERVAL` | `5m` | Candle interval |
| `FAST_MA_PERIOD` / `SLOW_MA_PERIOD` | `9` / `21` | Crossover periods |
| `TREND_MA_PERIOD` | `50` | Trend filter period — a MA/MACD crossover only counts if price is on the right side of this MA |
| `VOLUME_LOOKBACK` | `20` | Candles averaged for the volume filter |
| `VOLUME_MULTIPLIER` | `1.5` | Signal candle's volume must be at least this many times the recent average |
| `MACD_FAST_PERIOD` / `MACD_SLOW_PERIOD` / `MACD_SIGNAL_PERIOD` | `12` / `26` / `9` | MACD strategy periods |
| `RSI_PERIOD` | `14` | RSI strategy lookback period |
| `RSI_OVERSOLD` / `RSI_OVERBOUGHT` | `30` / `70` | RSI reversal thresholds |
| `TRADE_QUANTITY` | `0.01` | Quantity per trade |
| `MAX_POSITION` | `0.05` | Max position size before risk SKIPs a trade |
| `STOP_LOSS_PCT` / `TAKE_PROFIT_PCT` | `2` / `4` | Documented risk bounds (see `trading_bot_instructions.md`) |
| `MAX_DAILY_LOSS_PCT` | `5` | Documented daily loss limit |
| `SCAN_CANDLE_LIMIT` | `100` | Candles fetched per `scan` |
| `REPLAY_CANDLE_LIMIT` | `1000` | Candles fetched per replay |
| `REPLAY_LOOKAHEAD_CANDLES` | `12` | Candles forward used to score each replay setup |

To experiment with a different market or timeframe, change `SYMBOL`/`INTERVAL` in `.env` —
everything else (strategy, risk, memory) works unchanged against the new series.

## Safety rules and limitations

- Paper trading only, by design — no live trading path exists in this codebase. The optional
  Alpaca broker adapter can only ever submit to Alpaca's paper endpoint, hardcoded as a
  constant, not configurable.
- No secrets or API keys are needed by default; they're only needed at all if you opt into
  Alpaca (market data or paper broker), and even then only via `.env`/GitHub Secrets.
- No credentials are ever exposed to frontend code (there is no frontend).
- No trade is ever simulated or submitted unless it passes the risk module, and no BUY/SELL
  survives if memory flags it as a repeat of a real prior loss.
- The bot never uses generated or fixture candle data — every command either uses real
  Coinbase Exchange data or fails with a clear, honest error.

## Deployment: scheduled GitHub Actions (not Vercel)

This is a CLI tool that needs to run repeatedly against live data and persist state to
`data/ledger.csv`/`data/learnings.md` — that's a scheduled-job shape, not a web-request
shape, so it runs on **GitHub Actions**, not Vercel:

- `.github/workflows/bot-scan.yml` runs `npm run scan` every 15 minutes.
- `.github/workflows/bot-replay.yml` runs `npm run replay:raw` once a day to refresh the
  honest baseline and record any newly-seen real losing setups as lessons.

Both workflows commit any changes to `data/` back to the repository (using the
auto-provided `GITHUB_TOKEN`) so memory persists between runs, and both can also be run
on demand from the Actions tab (`workflow_dispatch`).

**Two things to know:**
- GitHub only fires `schedule` triggers from the repository's **default branch**. These
  workflows start running once this branch is merged into `main` (or whichever branch is
  set as default) — pushing them to a feature branch alone won't activate the schedule.
- GitHub auto-disables scheduled workflows after 60 days with no repository activity;
  a commit, even a manual `workflow_dispatch` run, resets that clock.

Unlike this development sandbox, GitHub-hosted runners have normal outbound internet
access and are not geo/IP-blocked by Coinbase, so `api.exchange.coinbase.com` is reachable
there — these workflows produce real output once running.

## A known limitation in sandboxed environments

Some hosted/sandboxed execution environments restrict outbound network access to an
allowlist of hosts. If `api.exchange.coinbase.com` is not reachable from wherever you run
this bot, every command will fail with a clear network error rather than silently
substituting fake data — that is intentional (see the honesty rules above). Run the bot
somewhere with normal internet access (your own machine, a CI runner, or a Claude Code
environment with outbound HTTPS allowed) to see real output.

## Next three experiments to try in paper mode

1. Change `INTERVAL` to `15m` or `1h` in `.env` and compare `replay:raw` metrics against the
   `5m` baseline — does the crossover strategy hold up on a slower timeframe?
2. Point `SYMBOL` at a different pair (e.g. `ETH-USD`) and run `replay:raw` then
   `replay:memory` back to back to see how quickly memory starts blocking repeat losers on a
   different asset.
3. Tighten `MAX_POSITION` or `TRADE_QUANTITY` in `.env` and re-run `scan` to see the risk
   module SKIP a trade it previously allowed.

# Trading Bot (Paper Trading Only)

A TypeScript/Node.js paper-trading bot built from the Miles High Club "Paper Trading Bot"
Claude prompts (`TradingBotV2-1.pdf`). It trades **BTCUSDT** on the **5-minute** timeframe
using a 9/21 moving-average crossover strategy, using only real public market data from
Binance. **There is no code path anywhere in this repository that places a real order.**

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

This project intentionally has **no broker or exchange MCP/API connection**. All market data
comes from Binance's public, unauthenticated klines endpoint
(`GET https://api.binance.com/api/v3/klines`) — no API key needed, no account touched. Every
"order" is a local, in-memory record produced by `src/execution.ts`, which has no function
that calls any real exchange order-placement endpoint.

If you later verify a paper/test broker or exchange MCP connection (following the Miles High
Club "Connect MCP To Claude Before Build" prompt), wire it in as a separate, clearly-isolated
adapter — never let it replace the local paper simulation by default.

As a guardrail against copy-pasting a `.env` from a different project, the bot refuses to
start at all if `LIVE_TRADING=true` (or `1`) is set — even though that flag is not connected
to any real functionality.

## Configuration

All settings live in `.env` (see `.env.example` for the full list and defaults):

| Variable | Default | Meaning |
|---|---|---|
| `SYMBOL` | `BTCUSDT` | Market to trade |
| `INTERVAL` | `5m` | Candle interval |
| `FAST_MA_PERIOD` / `SLOW_MA_PERIOD` | `9` / `21` | Crossover periods |
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

- Paper trading only, by design — no live trading path exists in this codebase.
- No secrets or API keys are needed or stored anywhere in this project.
- No credentials are ever exposed to frontend code (there is no frontend).
- No trade is ever simulated unless it passes the risk module, and no BUY/SELL survives if
  memory flags it as a repeat of a real prior loss.
- The bot never uses generated or fixture candle data — every command either uses real Binance
  data or fails with a clear, honest error.

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
access, so `api.binance.com` is reachable there — these workflows will produce real
output once running.

## A known limitation in sandboxed environments

Some hosted/sandboxed execution environments restrict outbound network access to an
allowlist of hosts. If `api.binance.com` is not reachable from wherever you run this bot, every
command will fail with a clear network error rather than silently substituting fake data — that
is intentional (see the honesty rules above). Run the bot somewhere with normal internet
access (your own machine, a CI runner, or a Claude Code environment with outbound HTTPS
allowed) to see real output.

## Next three experiments to try in paper mode

1. Change `INTERVAL` to `15m` or `1h` in `.env` and compare `replay:raw` metrics against the
   `5m` baseline — does the crossover strategy hold up on a slower timeframe?
2. Point `SYMBOL` at a different pair (e.g. `ETHUSDT`) and run `replay:raw` then
   `replay:memory` back to back to see how quickly memory starts blocking repeat losers on a
   different asset.
3. Tighten `MAX_POSITION` or `TRADE_QUANTITY` in `.env` and re-run `scan` to see the risk
   module SKIP a trade it previously allowed.

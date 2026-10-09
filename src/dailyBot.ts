import * as fs from "fs";
import * as path from "path";
import { Candle } from "./types";
import { fetchCandles } from "./market";
import { closedOnly, countDailyGaps, validateDaily } from "./dailyData";
import { getStrategy, resolveParams, formatParams, Params } from "./strategies";
import { ema } from "./indicators";

/**
 * The daily loop from "The Backtest Machine", part 4 - PAPER ONLY:
 *   once per day after the 00:00 UTC close: fetch candles -> compute signal on the CLOSED
 *   candle -> crossed? -> paper buy/sell at the new candle's open -> alert + log.
 *   "No cross" days the bot does nothing. That discipline IS the strategy.
 *
 * State lives in data/daily_state.json so a restart (or a re-run of the same day) never
 * double-enters: every closed candle is processed exactly once. Any unexpected data ->
 * log, alert, halt (non-zero exit) - never guess.
 *
 * Sizing comes only from the paper account seeded with PAPER_CAPITAL (a cap you set), never
 * from a real account balance. Like the backtest, each entry uses 100% of that paper account.
 */

const DATA_DIR = path.join(__dirname, "..", "data");
export const DAILY_STATE_PATH = path.join(DATA_DIR, "daily_state.json");
export const DAILY_LEDGER_PATH = path.join(DATA_DIR, "daily_ledger.csv");
const LEDGER_HEADER = "timestamp,symbol,strategy,candle_date,action,price,quantity,cash,equity,reason";
const HISTORY_DAYS = 400;

export interface DailyState {
  symbol: string;
  strategy: string;
  params: Params;
  capital: number;
  cash: number;
  quantity: number;
  entryPrice: number | null;
  entryTime: string | null;
  lastProcessedOpenTime: number | null;
  closedTrades: number;
  wins: number;
  realizedPnl: number;
}

export interface DailyConfig {
  symbol: string;
  strategy: string;
  params?: string;
  capital: number;
  commissionPct: number;
  slippagePct: number;
  telegramToken: string;
  telegramChatId: string;
}

export function dailyConfigFromEnv(): DailyConfig {
  const n = (k: string, d: number) => {
    const v = process.env[k];
    return v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d;
  };
  return {
    symbol: process.env.DAILY_SYMBOL || "BTC-USD",
    strategy: process.env.DAILY_STRATEGY || "ema_cross",
    params: process.env.DAILY_PARAMS || undefined,
    capital: n("PAPER_CAPITAL", 100_000),
    commissionPct: n("COMMISSION_PCT", 0.1),
    slippagePct: n("SLIPPAGE_PCT", 0),
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
  };
}

function log(label: string, msg: string): void {
  console.log(`[${new Date().toISOString()}] [${label}] ${msg}`);
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

async function alert(cfg: DailyConfig, text: string): Promise<void> {
  if (!cfg.telegramToken || !cfg.telegramChatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.telegramChatId, text }),
    });
    if (!res.ok) log("ALERT", `Telegram returned HTTP ${res.status} - alert not delivered.`);
  } catch (err) {
    log("ALERT", `Telegram unreachable (${(err as Error).message}) - alert not delivered.`);
  }
}

export function readState(): DailyState | null {
  if (!fs.existsSync(DAILY_STATE_PATH)) return null;
  return JSON.parse(fs.readFileSync(DAILY_STATE_PATH, "utf8")) as DailyState;
}

function writeState(s: DailyState): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DAILY_STATE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, DAILY_STATE_PATH); // atomic: a crash never leaves half-written state
}

function appendLedger(cells: (string | number)[]): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DAILY_LEDGER_PATH)) fs.writeFileSync(DAILY_LEDGER_PATH, LEDGER_HEADER + "\n", "utf8");
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  fs.appendFileSync(DAILY_LEDGER_PATH, cells.map(esc).join(",") + "\n", "utf8");
}

export interface DailyDecision {
  action: "BUY" | "SELL" | "HOLD" | "ALREADY_PROCESSED";
  reason: string;
  state: DailyState;
}

/**
 * Pure decision step (no I/O) so it can be tested: walks every closed candle not yet
 * processed, applies only fresh target changes, and paper-fills at `fillPrice`.
 */
export function decide(
  candles: Candle[],
  fillPrice: number,
  state: DailyState,
  cfg: Pick<DailyConfig, "commissionPct" | "slippagePct">
): DailyDecision {
  const s = { ...state };
  const strat = getStrategy(s.strategy);
  const targets = strat.targets(candles, s.params);
  const last = candles.length - 1;

  if (s.lastProcessedOpenTime !== null && candles[last].openTime <= s.lastProcessedOpenTime) {
    return { action: "ALREADY_PROCESSED", reason: `candle ${iso(candles[last].openTime)} was already processed - nothing to do.`, state: s };
  }

  // First run: only the latest closed candle is evaluated (we never chase a trend already
  // in progress). Later runs: every candle missed since the last run, in order.
  let from = last;
  if (s.lastProcessedOpenTime !== null) {
    const idx = candles.findIndex((c) => c.openTime > (s.lastProcessedOpenTime as number));
    from = Math.max(1, idx);
  }
  let want: 0 | 1 = s.quantity > 0 ? 1 : 0;
  let why = "no fresh signal - doing nothing is the strategy.";
  for (let i = from; i <= last; i++) {
    if (targets[i] !== targets[i - 1]) {
      want = targets[i] === 1 ? 1 : 0;
      why = `${targets[i] === 1 ? "entry" : "exit"} signal on the ${iso(candles[i].openTime)} close (${strat.name} ${formatParams(s.params)}).`;
    }
  }
  s.lastProcessedOpenTime = candles[last].openTime;

  const fee = cfg.commissionPct / 100;
  const slip = cfg.slippagePct / 100;
  if (want === 1 && s.quantity === 0) {
    const px = fillPrice * (1 + slip);
    s.quantity = s.cash / (px * (1 + fee));
    s.cash -= s.quantity * px * (1 + fee);
    s.entryPrice = px;
    s.entryTime = new Date().toISOString();
    return { action: "BUY", reason: why, state: s };
  }
  if (want === 0 && s.quantity > 0) {
    const px = fillPrice * (1 - slip);
    const proceeds = s.quantity * px * (1 - fee);
    const cost = s.quantity * (s.entryPrice as number) * (1 + fee);
    const pnl = proceeds - cost;
    s.cash += proceeds;
    s.realizedPnl += pnl;
    s.closedTrades += 1;
    if (pnl > 0) s.wins += 1;
    s.quantity = 0;
    s.entryPrice = null;
    s.entryTime = null;
    return { action: "SELL", reason: `${why} Trade P&L ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}.`, state: s };
  }
  return { action: "HOLD", reason: why, state: s };
}

export async function runDaily(): Promise<void> {
  const cfg = dailyConfigFromEnv();
  const strat = getStrategy(cfg.strategy);
  const params = resolveParams(strat, cfg.params);
  log("CONFIG", `PAPER mode | ${cfg.symbol} daily | ${strat.name}(${formatParams(params)}) | capital cap $${cfg.capital.toLocaleString()} | ${cfg.commissionPct}% fee/side`);

  let state = readState();
  if (state && (state.symbol !== cfg.symbol || state.strategy !== strat.name || formatParams(state.params) !== formatParams(params))) {
    const msg = `State file is for ${state.symbol} ${state.strategy}(${formatParams(state.params)}) but config says ${cfg.symbol} ${strat.name}(${formatParams(params)}). Refusing to mix them - run "npm run daily:reset" to start a fresh paper account.`;
    log("HALT", msg);
    await alert(cfg, `HALT: ${msg}`);
    process.exitCode = 1;
    return;
  }
  if (!state) {
    state = {
      symbol: cfg.symbol, strategy: strat.name, params, capital: cfg.capital, cash: cfg.capital,
      quantity: 0, entryPrice: null, entryTime: null, lastProcessedOpenTime: null,
      closedTrades: 0, wins: 0, realizedPnl: 0,
    };
    log("STATE", "no state yet - starting a fresh paper account (flat).");
  }

  let all: Candle[];
  let candles: Candle[];
  try {
    all = await fetchCandles(cfg.symbol, "1d", HISTORY_DAYS);
    candles = closedOnly(all);
    validateDaily(candles);
    const gaps = countDailyGaps(candles.slice(-60));
    if (gaps > 0) throw new Error(`${gaps} missing daily candle(s) in the last 60 days - data feed problem.`);
    if (candles.length < 60) throw new Error(`only ${candles.length} closed daily candles - not enough history.`);
    const ageH = (Date.now() - candles[candles.length - 1].closeTime) / 3_600_000;
    if (ageH > 36) throw new Error(`latest closed candle is ${ageH.toFixed(0)}h old - data feed is stale.`);
  } catch (err) {
    const msg = `market data check failed: ${(err as Error).message}`;
    log("HALT", msg);
    await alert(cfg, `HALT (${cfg.symbol}): ${msg}`);
    process.exitCode = 1;
    return;
  }

  const lastClosed = candles[candles.length - 1];
  // Fill on the NEXT bar's open (the forming candle), exactly like the backtest.
  const forming = all.find((c) => c.openTime > lastClosed.openTime);
  const fillPrice = forming ? forming.open : lastClosed.close;
  log("DATA", `${candles.length} closed daily candles; last close ${iso(lastClosed.openTime)} = ${lastClosed.close.toFixed(2)}; fill price (next open) ${fillPrice.toFixed(2)}.`);

  if (strat.name === "ema_cross" || strat.name === "ema_cross_regime") {
    const cl = candles.map((c) => c.close);
    const f = ema(cl, params.fast)[cl.length - 1] as number;
    const s = ema(cl, params.slow)[cl.length - 1] as number;
    log("SIGNAL", `EMA${params.fast} ${f.toFixed(2)} vs EMA${params.slow} ${s.toFixed(2)} (${f > s ? "fast above slow - uptrend" : "fast below slow - downtrend"}, gap ${(((f - s) / s) * 100).toFixed(2)}%).`);
  }

  const d = decide(candles, fillPrice, state, cfg);
  const equity = d.state.cash + d.state.quantity * lastClosed.close;
  log("DECISION", `${d.action}: ${d.reason}`);

  if (d.action === "ALREADY_PROCESSED") return;

  writeState(d.state);
  appendLedger([
    new Date().toISOString(), cfg.symbol, `${strat.name}(${formatParams(params)})`, iso(lastClosed.openTime),
    d.action, d.action === "HOLD" ? "" : fillPrice.toFixed(2), d.state.quantity.toFixed(8),
    d.state.cash.toFixed(2), equity.toFixed(2), d.reason,
  ]);

  const pos = d.state.quantity > 0 ? `LONG ${d.state.quantity.toFixed(6)} @ ${(d.state.entryPrice as number).toFixed(2)}` : "FLAT";
  const summary = `${cfg.symbol} paper | ${pos} | equity $${equity.toFixed(0)} (${(((equity / d.state.capital) - 1) * 100).toFixed(1)}%) | ${d.state.closedTrades} closed trades, ${d.state.wins} wins`;
  log("STATUS", summary);
  if (d.action === "BUY" || d.action === "SELL") await alert(cfg, `SIGNAL ${d.action} ${cfg.symbol} @ ${fillPrice.toFixed(2)} (paper)\n${d.reason}\n${summary}`);
  else await alert(cfg, `Heartbeat: ${summary}`);
}

export function resetDaily(): void {
  for (const p of [DAILY_STATE_PATH, DAILY_LEDGER_PATH]) if (fs.existsSync(p)) fs.unlinkSync(p);
}

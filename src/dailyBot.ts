import * as fs from "fs";
import * as path from "path";
import { Candle } from "./types";
import { fetchCandles } from "./market";
import { closedOnly, countDailyGaps, loadCandles, validateDaily } from "./dailyData";
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

export interface DailyRunResult {
  ok: boolean;
  action: DailyDecision["action"] | "HALT";
  lines: string[];
}

export async function runDaily(): Promise<DailyRunResult> {
  const lines: string[] = [];
  const log = (label: string, msg: string) => {
    const line = `[${new Date().toISOString()}] [${label}] ${msg}`;
    lines.push(line);
    console.log(line);
  };
  const cfg = dailyConfigFromEnv();
  const strat = getStrategy(cfg.strategy);
  const params = resolveParams(strat, cfg.params);
  log("CONFIG", `PAPER mode | ${cfg.symbol} daily | ${strat.name}(${formatParams(params)}) | capital cap $${cfg.capital.toLocaleString()} | ${cfg.commissionPct}% fee/side`);

  let state = readState();
  if (state && (state.symbol !== cfg.symbol || state.strategy !== strat.name || formatParams(state.params) !== formatParams(params))) {
    const msg = `State file is for ${state.symbol} ${state.strategy}(${formatParams(state.params)}) but config says ${cfg.symbol} ${strat.name}(${formatParams(params)}). Refusing to mix them - run "npm run daily:reset" to start a fresh paper account.`;
    log("HALT", msg);
    await alert(cfg, `HALT: ${msg}`);
    return { ok: false, action: "HALT", lines };
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
    return { ok: false, action: "HALT", lines };
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

  if (d.action === "ALREADY_PROCESSED") return { ok: true, action: d.action, lines };

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
  return { ok: true, action: d.action, lines };
}

export function resetDaily(): void {
  for (const p of [DAILY_STATE_PATH, DAILY_LEDGER_PATH]) if (fs.existsSync(p)) fs.unlinkSync(p);
}

export interface LedgerEntry {
  timestamp: string;
  symbol: string;
  strategy: string;
  candleDate: string;
  action: string;
  price: number | null;
  quantity: number;
  cash: number;
  equity: number;
  reason: string;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export function readDailyLedger(): LedgerEntry[] {
  if (!fs.existsSync(DAILY_LEDGER_PATH)) return [];
  return fs.readFileSync(DAILY_LEDGER_PATH, "utf8").split(/\r?\n/).slice(1).filter((l) => l.trim()).map((l) => {
    const f = splitCsvLine(l);
    return {
      timestamp: f[0], symbol: f[1], strategy: f[2], candleDate: f[3], action: f[4],
      price: f[5] === "" ? null : Number(f[5]), quantity: Number(f[6]), cash: Number(f[7]),
      equity: Number(f[8]), reason: f[9] ?? "",
    };
  });
}

/** Everything the UI's Bot tab shows that doesn't need the network. */
export function dailyStatus() {
  const cfg = dailyConfigFromEnv();
  const strat = getStrategy(cfg.strategy);
  let params: Params | null = null;
  let configError: string | null = null;
  try {
    params = resolveParams(strat, cfg.params);
  } catch (err) {
    configError = (err as Error).message;
  }
  return {
    config: {
      symbol: cfg.symbol, strategy: strat.name, description: strat.description, params, capital: cfg.capital,
      commissionPct: cfg.commissionPct, slippagePct: cfg.slippagePct,
      telegram: Boolean(cfg.telegramToken && cfg.telegramChatId), configError,
    },
    state: readState(),
    ledger: readDailyLedger(),
  };
}

/** Live view of the configured strategy on recent daily candles (read-only - never trades). */
export async function dailySignal(bars = 180) {
  const cfg = dailyConfigFromEnv();
  const strat = getStrategy(cfg.strategy);
  const params = resolveParams(strat, cfg.params);
  const candles = await loadCandles({ symbol: cfg.symbol, days: HISTORY_DAYS, timeframe: "1d" });
  const targets = strat.targets(candles, params);
  const from = Math.max(0, candles.length - bars);
  const cl = candles.map((c) => c.close);
  const overlays: { name: string; values: (number | null)[] }[] = [];
  if (params.fast !== undefined && params.slow !== undefined && strat.name.startsWith("ema")) {
    overlays.push({ name: `EMA ${params.fast}`, values: ema(cl, params.fast).slice(from) });
    overlays.push({ name: `EMA ${params.slow}`, values: ema(cl, params.slow).slice(from) });
  }
  let lastChange: { time: number; to: number } | null = null;
  for (let i = candles.length - 1; i > 0; i--) {
    if (targets[i] !== targets[i - 1]) { lastChange = { time: candles[i].closeTime, to: targets[i] }; break; }
  }
  const last = candles[candles.length - 1];
  return {
    symbol: cfg.symbol,
    strategy: strat.name,
    params,
    lastClose: { time: last.closeTime, price: last.close },
    target: targets[targets.length - 1],
    lastChange,
    bars: candles.slice(from).map((c) => [c.closeTime, c.open, c.high, c.low, c.close]),
    targets: targets.slice(from),
    overlays,
  };
}

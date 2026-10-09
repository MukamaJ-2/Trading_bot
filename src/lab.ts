import { loadCandles } from "./dailyData";
import { Metrics, Verdict } from "./backtest";
import { formatParams } from "./strategies";
import * as core from "./labCore";
import { LabArgs, LabWindow, BacktestReport, PlateauCell, TournamentReport, PlateauReport, WalkForwardReport } from "./labCore";

export type { LabArgs } from "./labCore";

/**
 * The Backtest Machine, as commands. Every number comes from real candles (market API or a
 * CSV you exported) - nothing is generated.
 *
 *   lab:backtest    one strategy, full trade list (the "--backfill" to verify vs TradingView)
 *   lab:tournament  every strategy on the same asset/timeframe/window, ranked, with verdicts
 *   lab:plateau     overfitting check - do the neighbouring settings also work?
 *   lab:walkforward selection-bias check - pick the best on the past, judge it on unseen data
 *
 * The analyses themselves live in labCore.ts (pure, also used by the browser build). This file
 * loads the candles (market API or CSV), and prints the reports for the CLI.
 */

export function parseArgs(argv: string[]): LabArgs {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const [k, inline] = a.slice(2).split("=", 2);
    if (inline !== undefined) flags[k] = inline;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) flags[k] = argv[++i];
    else flags[k] = "true";
  }
  return normalizeArgs({
    symbol: flags.symbol,
    timeframe: flags.tf,
    days: flags.days,
    start: flags.start,
    csv: flags.csv,
    strategy: flags.strategy,
    params: flags.params,
    commissionPct: flags.commission,
    slippagePct: flags.slippage,
    minTrades: flags["min-trades"],
    split: flags.split,
  });
}

/** Fills defaults (flags/body first, then env, then the cheat-sheet defaults) and validates. */
export function normalizeArgs(raw: Record<string, unknown>): LabArgs {
  const env = process.env;
  const str = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v));
  const num = (v: unknown, d: number) => {
    const s = str(v);
    return s !== undefined && Number.isFinite(Number(s)) ? Number(s) : d;
  };
  const tf = (str(raw.timeframe) || env.LAB_TIMEFRAME || "1d").toLowerCase();
  if (tf !== "1d" && tf !== "1w") throw new Error(`timeframe must be 1d or 1w, got "${tf}".`);
  const split = num(raw.split, 0.6);
  if (!(split > 0.1 && split < 0.9)) throw new Error("split must be between 0.1 and 0.9.");
  return {
    symbol: str(raw.symbol) || env.DAILY_SYMBOL || "BTC-USD",
    timeframe: tf,
    days: num(raw.days ?? env.LAB_DAYS, 1095),
    start: str(raw.start) || env.LAB_START || undefined,
    csv: str(raw.csv),
    csvText: str(raw.csvText),
    strategy: str(raw.strategy) || env.DAILY_STRATEGY || "ema_cross",
    params: str(raw.params) ?? env.DAILY_PARAMS ?? undefined,
    commissionPct: num(raw.commissionPct ?? env.COMMISSION_PCT, 0.1),
    slippagePct: num(raw.slippagePct ?? env.SLIPPAGE_PCT, 0),
    minTrades: num(raw.minTrades, 20),
    split,
  };
}

async function loadWindow(a: LabArgs): Promise<LabWindow> {
  const candles = await loadCandles({ symbol: a.symbol, days: core.daysToLoad(a), timeframe: a.timeframe, csv: a.csv, csvText: a.csvText });
  const label = a.csvText !== undefined ? "uploaded CSV" : a.csv ? `CSV ${a.csv}` : `${a.symbol} ${a.timeframe}`;
  return core.makeWindow(candles, a, label);
}

export const computeBacktest = async (a: LabArgs): Promise<BacktestReport> => core.computeBacktest(await loadWindow(a), a);
export const computeTournament = async (a: LabArgs): Promise<TournamentReport> => core.computeTournament(await loadWindow(a), a);
export const computePlateau = async (a: LabArgs): Promise<PlateauReport> => core.computePlateau(await loadWindow(a), a);
export const computeWalkForward = async (a: LabArgs): Promise<WalkForwardReport> => core.computeWalkForward(await loadWindow(a), a);

// ---------- CLI printing ----------

function log(label: string, msg: string): void {
  console.log(`[${new Date().toISOString()}] [${label}] ${msg}`);
}
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const pct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;
const pf = (x: number) => (Number.isNaN(x) ? "n/a" : Number.isFinite(x) ? x.toFixed(2) : "inf");
const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const lpad = (s: string, n: number) => (s.length >= n ? s : " ".repeat(n - s.length) + s);

function table(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? pad(c, widths[i]) : lpad(c, widths[i]))).join("  ");
  console.log(line(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  rows.forEach((r) => console.log(line(r)));
}

function printMetrics(m: Metrics, v: Verdict): void {
  console.log("");
  table(
    ["", "Strategy", "Buy & hold"],
    [
      ["Net return", pct(m.netReturnPct), pct(m.buyHoldReturnPct)],
      ["CAGR", pct(m.cagrPct), ""],
      ["Max drawdown", `-${m.maxDrawdownPct.toFixed(1)}%`, `-${m.buyHoldMaxDrawdownPct.toFixed(1)}%`],
      ["Return / drawdown (Calmar)", m.calmar.toFixed(2), m.buyHoldCalmar.toFixed(2)],
      ["Closed trades", String(m.closedTrades), ""],
      ["Win rate", `${m.winRatePct.toFixed(1)}%`, ""],
      ["Profit factor", pf(m.profitFactor), ""],
      ["Avg win / avg loss", `${pct(m.avgWinPct)} / ${pct(m.avgLossPct)}`, ""],
      ["Time in market", `${m.exposurePct.toFixed(0)}%`, "100%"],
      ["Sharpe (annualised)", m.sharpe.toFixed(2), ""],
    ]
  );
  console.log("");
  log("VERDICT", `${v.label}: ${v.reason}.`);
}

export async function labBacktest(a: LabArgs): Promise<BacktestReport> {
  const r = await computeBacktest(a);
  r.notes.forEach((n) => log("DATA", n));
  log("STRATEGY", `${r.strategy}(${formatParams(r.params)}) - ${r.description}`);
  log("RULES", `signals on candle close, fills on next open, ${a.commissionPct}% commission per side, ${a.slippagePct}% slippage, 100% of equity, long-only, $100,000 start.`);
  console.log("");
  table(
    ["#", "Entry date", "Entry", "Exit date", "Exit", "Bars", "P&L %", "P&L $"],
    r.trades.map((t, i) => [
      String(i + 1),
      iso(t.entryTime),
      t.entryPrice.toFixed(2),
      t.open ? "(open)" : iso(t.exitTime as number),
      t.open ? "-" : (t.exitPrice as number).toFixed(2),
      String(t.bars),
      pct(t.pnlPct),
      t.pnl.toFixed(0),
    ])
  );
  printMetrics(r.metrics, r.verdict);
  if (r.pendingAction) log("PENDING", `the last closed candle signalled ${r.pendingAction} - it fills at the next candle's open.`);
  return r;
}

export async function labTournament(a: LabArgs): Promise<void> {
  const r = await computeTournament(a);
  r.notes.forEach((n) => log("DATA", n));
  console.log("");
  table(
    ["Strategy", "Return", "MaxDD", "Calmar", "Trades", "Win%", "PF", "Verdict"],
    [
      ...r.rows.map((x) => [
        `${x.strategy}(${formatParams(x.params)})`,
        pct(x.metrics.netReturnPct),
        `-${x.metrics.maxDrawdownPct.toFixed(1)}%`,
        x.metrics.calmar.toFixed(2),
        String(x.metrics.closedTrades),
        x.metrics.winRatePct.toFixed(0),
        pf(x.metrics.profitFactor),
        x.verdict.label,
      ]),
      ["buy & hold", pct(r.buyHold.returnPct), `-${r.buyHold.maxDrawdownPct.toFixed(1)}%`, r.buyHold.calmar.toFixed(2), "1", "", "", "benchmark"],
    ]
  );
  console.log("");
  log("CAVEAT", `The best of ${r.rows.length} is always partly luck (selection bias). Run lab:plateau and lab:walkforward on the winner, then paper forward-test it before trusting it.`);
}

export async function labPlateau(a: LabArgs): Promise<void> {
  const r = await computePlateau(a);
  r.notes.forEach((n) => log("DATA", n));
  const cellText = (c: PlateauCell) => {
    const t = `${pct(c.returnPct)} pf${pf(c.profitFactor)}`;
    return c.isCenter ? `[${t}]` : t;
  };
  console.log("");
  if (r.keys.length === 2) {
    const [rk, ck] = r.keys;
    const rVals = [...new Set(r.cells.map((c) => c.params[rk]))].sort((x, y) => x - y);
    const cVals = [...new Set(r.cells.map((c) => c.params[ck]))].sort((x, y) => x - y);
    log("PLATEAU", `net return by ${rk} (rows) x ${ck} (columns); [ ] marks your setting, B&H ${pct(r.buyHoldReturnPct)}`);
    table(
      [`${rk} \\ ${ck}`, ...cVals.map(String)],
      rVals.map((rv) => [
        String(rv),
        ...cVals.map((cv) => {
          const c = r.cells.find((x) => x.params[rk] === rv && x.params[ck] === cv);
          return c ? cellText(c) : "n/a";
        }),
      ])
    );
  } else {
    table(
      ["Params", "Return", "MaxDD", "Trades", "PF"],
      r.cells.map((c) => [
        (c.isCenter ? "* " : "  ") + formatParams(c.params),
        pct(c.returnPct),
        `-${c.maxDrawdownPct.toFixed(1)}%`,
        String(c.closedTrades),
        pf(c.profitFactor),
      ])
    );
  }
  console.log("");
  log("PLATEAU", `${r.profitableNeighbours}/${r.neighbours} neighbouring settings are profitable after fees; ${r.beatBuyHoldNeighbours}/${r.neighbours} beat buy-and-hold on return/drawdown.`);
  log("PLATEAU", `your setting returned ${r.centerReturnPct !== null ? pct(r.centerReturnPct) : "n/a"}; the median neighbour returned ${pct(r.medianNeighbourReturnPct)}.`);
  log("VERDICT", `${r.label === "CENTER_LOSES" ? "" : r.label + " - "}${r.conclusion}`);
}

export async function labWalkForward(a: LabArgs): Promise<void> {
  const r = await computeWalkForward(a);
  r.notes.forEach((n) => log("DATA", n));
  log("WALKFORWARD", `in-sample ${iso(r.inSample.from)} -> ${iso(r.inSample.to)}, out-of-sample ${iso(r.outOfSample.from)} -> ${iso(r.outOfSample.to)}.`);
  console.log("");
  table(
    ["Strategy", "IS return", "IS Calmar", "IS PF", "OOS return", "OOS Calmar", "OOS PF", "OOS B&H"],
    r.rows.map((x) => [
      `${x.strategy}(${formatParams(x.params)})`,
      pct(x.inSample.netReturnPct), x.inSample.calmar.toFixed(2), pf(x.inSample.profitFactor),
      pct(x.outOfSample.netReturnPct), x.outOfSample.calmar.toFixed(2), pf(x.outOfSample.profitFactor),
      pct(x.outOfSample.buyHoldReturnPct),
    ])
  );
  console.log("");
  if (r.best) {
    const b = r.best;
    log("WALKFORWARD", `best of ${r.tried} configurations in-sample: ${b.strategy}(${formatParams(b.params)}) - IS return ${pct(b.inSample.netReturnPct)}, Calmar ${b.inSample.calmar.toFixed(2)}.`);
    log("WALKFORWARD", `on unseen data it returned ${pct(b.outOfSample.netReturnPct)} (max DD -${b.outOfSample.maxDrawdownPct.toFixed(1)}%, PF ${pf(b.outOfSample.profitFactor)}, ${b.outOfSample.closedTrades} trades) vs buy-and-hold ${pct(b.outOfSample.buyHoldReturnPct)} (max DD -${b.outOfSample.buyHoldMaxDrawdownPct.toFixed(1)}%).`);
  }
  log("VERDICT", r.conclusion);
}

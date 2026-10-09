import { Candle } from "./types";
import { loadCandles } from "./dailyData";
import { runBacktest, verdict, BacktestResult, Metrics, Trade, Verdict } from "./backtest";
import { STRATEGIES, StrategyDef, Params, getStrategy, resolveParams, formatParams, neighbourhood, defaultParams } from "./strategies";

/**
 * The Backtest Machine, as commands. Every number comes from real candles (market API or a
 * CSV you exported) - nothing is generated.
 *
 *   lab:backtest    one strategy, full trade list (the "--backfill" to verify vs TradingView)
 *   lab:tournament  every strategy on the same asset/timeframe/window, ranked, with verdicts
 *   lab:plateau     overfitting check - do the neighbouring settings also work?
 *   lab:walkforward selection-bias check - pick the best on the past, judge it on unseen data
 *
 * Each command has a compute* function returning plain data (used by the web UI) and a lab*
 * function that prints it (used by the CLI).
 */

export interface LabArgs {
  symbol: string;
  timeframe: "1d" | "1w";
  days: number;
  start?: string;
  csv?: string;
  csvText?: string;
  strategy: string;
  params?: string;
  commissionPct: number;
  slippagePct: number;
  minTrades: number;
  split: number;
}

const WARMUP_BARS = 250;

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

interface Window {
  candles: Candle[];
  startIndex: number;
  notes: string[];
}

async function loadWindow(a: LabArgs): Promise<Window> {
  const barDays = a.timeframe === "1w" ? 7 : 1;
  let fetchDays = a.days + WARMUP_BARS * barDays;
  let startMs: number | null = null;
  if (a.start) {
    startMs = Date.parse(a.start);
    if (!Number.isFinite(startMs)) throw new Error(`start must be a date like 2023-07-01, got "${a.start}".`);
    fetchDays = Math.ceil((Date.now() - startMs) / 86_400_000) + WARMUP_BARS * barDays;
  }
  const candles = await loadCandles({ symbol: a.symbol, days: fetchDays, timeframe: a.timeframe, csv: a.csv, csvText: a.csvText });
  let startIndex: number;
  if (startMs !== null) {
    startIndex = candles.findIndex((c) => c.openTime >= (startMs as number));
    if (startIndex < 0) throw new Error(`No candles on or after ${a.start}.`);
  } else {
    startIndex = Math.max(0, candles.length - Math.round(a.days / barDays));
  }
  startIndex = Math.max(startIndex, 1);
  if (startIndex >= candles.length - 2) throw new Error("The test window has fewer than 2 candles - pick an earlier start.");
  const label = a.csvText !== undefined ? "uploaded CSV" : a.csv ? `CSV ${a.csv}` : `${a.symbol} ${a.timeframe}`;
  const notes = [
    `${label}: ${candles.length} closed candles, testing ${iso(candles[startIndex].openTime)} -> ${iso(candles[candles.length - 1].closeTime)} (${candles.length - startIndex} bars; earlier bars are indicator warm-up only).`,
  ];
  if (startIndex < 30) notes.push(`WARNING: only ${startIndex} warm-up bars before the test window - long-period indicators may not be ready at the start.`);
  return { candles, startIndex, notes };
}

function run(w: Window, s: StrategyDef, p: Params, a: LabArgs, startIndex = w.startIndex, candles = w.candles): BacktestResult {
  return runBacktest(candles, s.targets(candles, p), {
    startIndex,
    commissionPct: a.commissionPct,
    slippagePct: a.slippagePct,
  });
}

// ---------- compute (plain data) ----------

export interface BacktestReport {
  strategy: string;
  description: string;
  params: Params;
  notes: string[];
  metrics: Metrics;
  verdict: Verdict;
  trades: Trade[];
  pendingAction: "BUY" | "SELL" | null;
  /** Bars of the test window: [closeTime, open, high, low, close]. */
  bars: [number, number, number, number, number][];
  equity: number[];
  buyHoldEquity: number[];
}

export async function computeBacktest(a: LabArgs): Promise<BacktestReport> {
  const s = getStrategy(a.strategy);
  const p = resolveParams(s, a.params);
  const w = await loadWindow(a);
  const r = run(w, s, p, a);
  return {
    strategy: s.name,
    description: s.description,
    params: p,
    notes: w.notes,
    metrics: r.metrics,
    verdict: verdict(r.metrics, a.minTrades),
    trades: r.trades,
    pendingAction: r.pendingAction,
    bars: w.candles.slice(r.startIndex).map((c) => [c.closeTime, c.open, c.high, c.low, c.close]),
    equity: r.equity,
    buyHoldEquity: r.buyHoldEquity,
  };
}

export interface TournamentRow {
  strategy: string;
  params: Params;
  metrics: Metrics;
  verdict: Verdict;
}

export interface TournamentReport {
  notes: string[];
  rows: TournamentRow[];
  buyHold: { returnPct: number; maxDrawdownPct: number; calmar: number };
}

export async function computeTournament(a: LabArgs): Promise<TournamentReport> {
  const w = await loadWindow(a);
  const rows = STRATEGIES.map((s) => {
    const p = defaultParams(s);
    const m = run(w, s, p, a).metrics;
    return { strategy: s.name, params: p, metrics: m, verdict: verdict(m, a.minTrades) };
  }).sort((x, y) => {
    // Evidence first: strategies with enough trades rank above anecdotes, then by return/drawdown.
    const ex = Number(x.metrics.closedTrades >= a.minTrades), ey = Number(y.metrics.closedTrades >= a.minTrades);
    return ey - ex || y.metrics.calmar - x.metrics.calmar;
  });
  const m = rows[0].metrics;
  return {
    notes: w.notes,
    rows,
    buyHold: { returnPct: m.buyHoldReturnPct, maxDrawdownPct: m.buyHoldMaxDrawdownPct, calmar: m.buyHoldCalmar },
  };
}

export interface PlateauCell {
  params: Params;
  isCenter: boolean;
  returnPct: number;
  maxDrawdownPct: number;
  profitFactor: number;
  closedTrades: number;
  calmar: number;
  buyHoldCalmar: number;
}

export interface PlateauReport {
  strategy: string;
  center: Params;
  keys: string[];
  notes: string[];
  cells: PlateauCell[];
  buyHoldReturnPct: number;
  profitableNeighbours: number;
  beatBuyHoldNeighbours: number;
  neighbours: number;
  centerReturnPct: number | null;
  medianNeighbourReturnPct: number;
  label: "PLATEAU" | "SPIKE" | "CENTER_LOSES";
  conclusion: string;
}

export async function computePlateau(a: LabArgs): Promise<PlateauReport> {
  const s = getStrategy(a.strategy);
  const center = resolveParams(s, a.params);
  const w = await loadWindow(a);
  const isCenter = (p: Params) => Object.keys(center).every((k) => p[k] === center[k]);
  const cells: PlateauCell[] = neighbourhood(s, center).map((p) => {
    const m = run(w, s, p, a).metrics;
    return {
      params: p, isCenter: isCenter(p), returnPct: m.netReturnPct, maxDrawdownPct: m.maxDrawdownPct,
      profitFactor: m.profitFactor, closedTrades: m.closedTrades, calmar: m.calmar, buyHoldCalmar: m.buyHoldCalmar,
    };
  });
  const bh = run(w, s, center, a).metrics.buyHoldReturnPct;
  const c = cells.find((x) => x.isCenter);
  const others = cells.filter((x) => !x.isCenter);
  const profitable = others.filter((r) => r.profitFactor > 1).length;
  const beat = others.filter((r) => r.calmar > r.buyHoldCalmar).length;
  const sorted = others.map((r) => r.returnPct).sort((x, y) => x - y);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const share = others.length ? profitable / others.length : 0;
  let label: PlateauReport["label"];
  let conclusion: string;
  if (!c || !(c.profitFactor > 1)) {
    label = "CENTER_LOSES";
    conclusion = "Your own setting loses money - nothing to protect from overfitting here.";
  } else if (share >= 0.7 && median >= 0.5 * c.returnPct) {
    label = "PLATEAU";
    conclusion = "The edge survives nearby settings. That's what a real edge looks like.";
  } else {
    label = "SPIKE";
    conclusion = "The result depends on this exact setting. Treat it as curve-fit to the past.";
  }
  return {
    strategy: s.name, center, keys: Object.keys(s.params), notes: w.notes, cells, buyHoldReturnPct: bh,
    profitableNeighbours: profitable, beatBuyHoldNeighbours: beat, neighbours: others.length,
    centerReturnPct: c ? c.returnPct : null, medianNeighbourReturnPct: median, label, conclusion,
  };
}

export interface WalkForwardReport {
  notes: string[];
  inSample: { from: number; to: number };
  outOfSample: { from: number; to: number };
  rows: { strategy: string; params: Params; inSample: Metrics; outOfSample: Metrics }[];
  tried: number;
  best: { strategy: string; params: Params; inSample: Metrics; outOfSample: Metrics } | null;
  held: boolean | null;
  conclusion: string;
}

export async function computeWalkForward(a: LabArgs): Promise<WalkForwardReport> {
  const w = await loadWindow(a);
  const n = w.candles.length;
  const splitIndex = w.startIndex + Math.floor((n - w.startIndex) * a.split);
  if (splitIndex - w.startIndex < 2 || n - splitIndex < 2) throw new Error("The test window is too short to split.");
  const inSample = w.candles.slice(0, splitIndex);
  const isMin = Math.max(5, Math.round(a.minTrades * a.split));

  const rows = STRATEGIES.map((s) => {
    const p = defaultParams(s);
    return {
      strategy: s.name,
      params: p,
      inSample: run(w, s, p, a, w.startIndex, inSample).metrics,
      outOfSample: run(w, s, p, a, splitIndex).metrics,
    };
  });

  // Full optimisation on the in-sample only: every strategy x its neighbourhood of settings.
  let best: { s: StrategyDef; p: Params; m: Metrics } | null = null;
  let tried = 0;
  for (const s of STRATEGIES) {
    for (const p of neighbourhood(s, defaultParams(s))) {
      tried++;
      const m = run(w, s, p, a, w.startIndex, inSample).metrics;
      if (m.closedTrades < isMin) continue;
      if (!best || m.calmar > best.m.calmar) best = { s, p, m };
    }
  }
  const report: WalkForwardReport = {
    notes: w.notes,
    inSample: { from: w.candles[w.startIndex].openTime, to: w.candles[splitIndex - 1].closeTime },
    outOfSample: { from: w.candles[splitIndex].openTime, to: w.candles[n - 1].closeTime },
    rows,
    tried,
    best: null,
    held: null,
    conclusion: `No configuration made ${isMin}+ trades in-sample - the window is too short to judge.`,
  };
  if (best) {
    const oos = run(w, best.s, best.p, a, splitIndex).metrics;
    report.best = { strategy: best.s.name, params: best.p, inSample: best.m, outOfSample: oos };
    report.held = oos.profitFactor > 1 && oos.calmar > oos.buyHoldCalmar;
    report.conclusion = report.held
      ? "The in-sample winner kept its edge out-of-sample. Next step: a paper forward test (npm run daily)."
      : "The in-sample winner did NOT keep its edge out-of-sample - its backtest was mostly selection luck.";
  }
  return report;
}

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

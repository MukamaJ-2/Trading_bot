import { Candle } from "./types";
import { runBacktest, verdict, BacktestResult, Metrics, Trade, Verdict } from "./backtest";
import { STRATEGIES, StrategyDef, Params, getStrategy, resolveParams, neighbourhood, defaultParams } from "./strategies";

/**
 * The Backtest Machine's analyses as pure functions over candles that are already loaded - no
 * filesystem, network or environment access - so the same code runs in Node (CLI, local UI)
 * and in the browser (the GitHub Pages build, docs/engine.js).
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

export const WARMUP_BARS = 250;

export interface LabWindow {
  candles: Candle[];
  startIndex: number;
  notes: string[];
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** How many daily candles to load so the test window plus indicator warm-up is covered. */
export function daysToLoad(a: LabArgs, nowMs = Date.now()): number {
  const barDays = a.timeframe === "1w" ? 7 : 1;
  if (a.start) {
    const startMs = Date.parse(a.start);
    if (!Number.isFinite(startMs)) throw new Error(`start must be a date like 2023-07-01, got "${a.start}".`);
    return Math.ceil((nowMs - startMs) / 86_400_000) + WARMUP_BARS * barDays;
  }
  return a.days + WARMUP_BARS * barDays;
}

/** Picks the test window's first bar; everything before it is indicator warm-up only. */
export function makeWindow(candles: Candle[], a: LabArgs, label: string): LabWindow {
  const barDays = a.timeframe === "1w" ? 7 : 1;
  let startIndex: number;
  if (a.start) {
    const startMs = Date.parse(a.start);
    if (!Number.isFinite(startMs)) throw new Error(`start must be a date like 2023-07-01, got "${a.start}".`);
    startIndex = candles.findIndex((c) => c.openTime >= startMs);
    if (startIndex < 0) throw new Error(`No candles on or after ${a.start}.`);
  } else {
    startIndex = Math.max(0, candles.length - Math.round(a.days / barDays));
  }
  startIndex = Math.max(startIndex, 1);
  if (startIndex >= candles.length - 2) throw new Error("The test window has fewer than 2 candles - pick an earlier start.");
  const notes = [
    `${label}: ${candles.length} closed candles, testing ${iso(candles[startIndex].openTime)} -> ${iso(candles[candles.length - 1].closeTime)} (${candles.length - startIndex} bars; earlier bars are indicator warm-up only).`,
  ];
  if (startIndex < 30) notes.push(`WARNING: only ${startIndex} warm-up bars before the test window - long-period indicators may not be ready at the start.`);
  return { candles, startIndex, notes };
}

function run(w: LabWindow, s: StrategyDef, p: Params, a: LabArgs, startIndex = w.startIndex, candles = w.candles): BacktestResult {
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

export function computeBacktest(w: LabWindow, a: LabArgs): BacktestReport {
  const s = getStrategy(a.strategy);
  const p = resolveParams(s, a.params);
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

export function computeTournament(w: LabWindow, a: LabArgs): TournamentReport {
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

export function computePlateau(w: LabWindow, a: LabArgs): PlateauReport {
  const s = getStrategy(a.strategy);
  const center = resolveParams(s, a.params);
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

export function computeWalkForward(w: LabWindow, a: LabArgs): WalkForwardReport {
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

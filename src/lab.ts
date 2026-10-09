import { Candle } from "./types";
import { loadCandles } from "./dailyData";
import { runBacktest, verdict, BacktestResult, Metrics } from "./backtest";
import { STRATEGIES, StrategyDef, Params, getStrategy, resolveParams, formatParams, neighbourhood, defaultParams } from "./strategies";

/**
 * The Backtest Machine, as commands. Every number comes from real candles (market API or a
 * CSV you exported) - nothing is generated.
 *
 *   lab:backtest    one strategy, full trade list (the "--backfill" to verify vs TradingView)
 *   lab:tournament  every strategy on the same asset/timeframe/window, ranked, with verdicts
 *   lab:plateau     overfitting check - do the neighbouring settings also work?
 *   lab:walkforward selection-bias check - pick the best on the past, judge it on unseen data
 */

export interface LabArgs {
  symbol: string;
  timeframe: "1d" | "1w";
  days: number;
  start?: string;
  csv?: string;
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
  const env = process.env;
  const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
  const tf = (flags.tf || env.LAB_TIMEFRAME || "1d").toLowerCase();
  if (tf !== "1d" && tf !== "1w") throw new Error(`--tf must be 1d or 1w, got "${tf}".`);
  return {
    symbol: flags.symbol || env.DAILY_SYMBOL || "BTC-USD",
    timeframe: tf,
    days: num(flags.days ?? env.LAB_DAYS, 1095),
    start: flags.start || env.LAB_START || undefined,
    csv: flags.csv || undefined,
    strategy: flags.strategy || env.DAILY_STRATEGY || "ema_cross",
    params: flags.params ?? env.DAILY_PARAMS ?? undefined,
    commissionPct: num(flags.commission ?? env.COMMISSION_PCT, 0.1),
    slippagePct: num(flags.slippage ?? env.SLIPPAGE_PCT, 0),
    minTrades: num(flags["min-trades"], 20),
    split: num(flags.split, 0.6),
  };
}

interface Window {
  candles: Candle[];
  startIndex: number;
}

async function loadWindow(a: LabArgs): Promise<Window> {
  const barDays = a.timeframe === "1w" ? 7 : 1;
  let fetchDays = a.days + WARMUP_BARS * barDays;
  if (a.start) {
    const startMs = Date.parse(a.start);
    if (!Number.isFinite(startMs)) throw new Error(`--start must be a date like 2023-07-01, got "${a.start}".`);
    fetchDays = Math.ceil((Date.now() - startMs) / 86_400_000) + WARMUP_BARS * barDays;
  }
  const candles = await loadCandles({ symbol: a.symbol, days: fetchDays, timeframe: a.timeframe, csv: a.csv });
  let startIndex: number;
  if (a.start) {
    const startMs = Date.parse(a.start);
    startIndex = candles.findIndex((c) => c.openTime >= startMs);
    if (startIndex < 0) throw new Error(`No candles on or after ${a.start}.`);
  } else {
    startIndex = Math.max(0, candles.length - Math.round(a.days / barDays));
  }
  startIndex = Math.max(startIndex, 1);
  const label = a.csv ? `CSV ${a.csv}` : `${a.symbol} ${a.timeframe}`;
  log("DATA", `${label}: ${candles.length} closed candles, testing ${iso(candles[startIndex].openTime)} -> ${iso(candles[candles.length - 1].closeTime)} (${candles.length - startIndex} bars, earlier bars are indicator warm-up only).`);
  if (startIndex < 30) log("DATA", `WARNING: only ${startIndex} warm-up bars before the test window - long-period indicators may not be ready at the start.`);
  return { candles, startIndex };
}

function run(w: Window, s: StrategyDef, p: Params, a: LabArgs, startIndex = w.startIndex, candles = w.candles): BacktestResult {
  return runBacktest(candles, s.targets(candles, p), {
    startIndex,
    commissionPct: a.commissionPct,
    slippagePct: a.slippagePct,
  });
}

// ---------- formatting ----------

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

function printMetrics(m: Metrics, minTrades: number): void {
  const v = verdict(m, minTrades);
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

// ---------- commands ----------

export async function labBacktest(a: LabArgs): Promise<BacktestResult> {
  const s = getStrategy(a.strategy);
  const p = resolveParams(s, a.params);
  const w = await loadWindow(a);
  log("STRATEGY", `${s.name}(${formatParams(p)}) - ${s.description}`);
  log("RULES", `signals on candle close, fills on next open, ${a.commissionPct}% commission per side, ${a.slippagePct}% slippage, 100% of equity, long-only, $100,000 start.`);
  const r = run(w, s, p, a);
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
  printMetrics(r.metrics, a.minTrades);
  if (r.pendingAction) log("PENDING", `the last closed candle signalled ${r.pendingAction} - it fills at the next candle's open.`);
  return r;
}

export async function labTournament(a: LabArgs): Promise<void> {
  const w = await loadWindow(a);
  const rows = STRATEGIES.map((s) => {
    const p = defaultParams(s);
    const m = run(w, s, p, a).metrics;
    return { s, p, m, v: verdict(m, a.minTrades) };
  }).sort((x, y) => {
    // Evidence first: strategies with enough trades rank above anecdotes, then by return/drawdown.
    const ex = Number(x.m.closedTrades >= a.minTrades), ey = Number(y.m.closedTrades >= a.minTrades);
    return ey - ex || y.m.calmar - x.m.calmar;
  });
  const bh = rows[0].m;
  console.log("");
  table(
    ["Strategy", "Return", "MaxDD", "Calmar", "Trades", "Win%", "PF", "Verdict"],
    [
      ...rows.map((r) => [
        `${r.s.name}(${formatParams(r.p)})`,
        pct(r.m.netReturnPct),
        `-${r.m.maxDrawdownPct.toFixed(1)}%`,
        r.m.calmar.toFixed(2),
        String(r.m.closedTrades),
        r.m.winRatePct.toFixed(0),
        pf(r.m.profitFactor),
        r.v.label,
      ]),
      ["buy & hold", pct(bh.buyHoldReturnPct), `-${bh.buyHoldMaxDrawdownPct.toFixed(1)}%`, bh.buyHoldCalmar.toFixed(2), "1", "", "", "benchmark"],
    ]
  );
  console.log("");
  log("CAVEAT", `The best of ${rows.length} is always partly luck (selection bias). Run lab:plateau and lab:walkforward on the winner, then paper forward-test it before trusting it.`);
}

export async function labPlateau(a: LabArgs): Promise<void> {
  const s = getStrategy(a.strategy);
  const center = resolveParams(s, a.params);
  const w = await loadWindow(a);
  const grid = neighbourhood(s, center);
  const results = grid.map((p) => ({ p, m: run(w, s, p, a).metrics }));
  const isCenter = (p: Params) => Object.keys(center).every((k) => p[k] === center[k]);
  const c = results.find((r) => isCenter(r.p));
  const others = results.filter((r) => !isCenter(r.p));
  const keys = Object.keys(s.params);

  console.log("");
  if (keys.length === 2) {
    const [rk, ck] = keys;
    const rVals = [...new Set(grid.map((p) => p[rk]))].sort((x, y) => x - y);
    const cVals = [...new Set(grid.map((p) => p[ck]))].sort((x, y) => x - y);
    log("PLATEAU", `net return by ${rk} (rows) x ${ck} (columns); [ ] marks your setting, B&H ${pct(results[0].m.buyHoldReturnPct)}`);
    table(
      [`${rk} \\ ${ck}`, ...cVals.map(String)],
      rVals.map((rv) => [
        String(rv),
        ...cVals.map((cv) => {
          const r = results.find((x) => x.p[rk] === rv && x.p[ck] === cv);
          if (!r) return "n/a";
          const t = `${pct(r.m.netReturnPct)} pf${pf(r.m.profitFactor)}`;
          return isCenter(r.p) ? `[${t}]` : t;
        }),
      ])
    );
  } else {
    table(
      ["Params", "Return", "MaxDD", "Trades", "PF"],
      results.map((r) => [
        (isCenter(r.p) ? "* " : "  ") + formatParams(r.p),
        pct(r.m.netReturnPct),
        `-${r.m.maxDrawdownPct.toFixed(1)}%`,
        String(r.m.closedTrades),
        pf(r.m.profitFactor),
      ])
    );
  }

  const profitable = others.filter((r) => r.m.profitFactor > 1).length;
  const beatBH = others.filter((r) => r.m.calmar > r.m.buyHoldCalmar).length;
  const sorted = others.map((r) => r.m.netReturnPct).sort((x, y) => x - y);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  console.log("");
  log("PLATEAU", `${profitable}/${others.length} neighbouring settings are profitable after fees; ${beatBH}/${others.length} beat buy-and-hold on return/drawdown.`);
  log("PLATEAU", `your setting returned ${c ? pct(c.m.netReturnPct) : "n/a"}; the median neighbour returned ${pct(median)}.`);
  const share = others.length ? profitable / others.length : 0;
  if (!c || c.m.profitFactor <= 1) {
    log("VERDICT", "your own setting loses money - nothing to protect from overfitting here.");
  } else if (share >= 0.7 && median >= 0.5 * c.m.netReturnPct) {
    log("VERDICT", "PLATEAU - the edge survives nearby settings. That's what a real edge looks like.");
  } else {
    log("VERDICT", "SPIKE - the result depends on this exact setting. Treat it as curve-fit to the past.");
  }
}

export async function labWalkForward(a: LabArgs): Promise<void> {
  const w = await loadWindow(a);
  const n = w.candles.length;
  const splitIndex = w.startIndex + Math.floor((n - w.startIndex) * a.split);
  const inSample = w.candles.slice(0, splitIndex);
  const isMin = Math.max(5, Math.round(a.minTrades * a.split));
  log("WALKFORWARD", `in-sample ${iso(w.candles[w.startIndex].openTime)} -> ${iso(w.candles[splitIndex - 1].closeTime)}, out-of-sample ${iso(w.candles[splitIndex].openTime)} -> ${iso(w.candles[n - 1].closeTime)}.`);

  const rows = STRATEGIES.map((s) => {
    const p = defaultParams(s);
    const ism = run(w, s, p, a, w.startIndex, inSample).metrics;
    const oos = run(w, s, p, a, splitIndex).metrics;
    return { name: `${s.name}(${formatParams(p)})`, ism, oos };
  });
  console.log("");
  table(
    ["Strategy", "IS return", "IS Calmar", "IS PF", "OOS return", "OOS Calmar", "OOS PF", "OOS B&H"],
    rows.map((r) => [r.name, pct(r.ism.netReturnPct), r.ism.calmar.toFixed(2), pf(r.ism.profitFactor), pct(r.oos.netReturnPct), r.oos.calmar.toFixed(2), pf(r.oos.profitFactor), pct(r.oos.buyHoldReturnPct)])
  );

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
  console.log("");
  if (!best) {
    log("WALKFORWARD", `no configuration made ${isMin}+ trades in-sample - the window is too short to judge.`);
    return;
  }
  const oos = run(w, best.s, best.p, a, splitIndex).metrics;
  log("WALKFORWARD", `best of ${tried} configurations in-sample: ${best.s.name}(${formatParams(best.p)}) - IS return ${pct(best.m.netReturnPct)}, Calmar ${best.m.calmar.toFixed(2)}.`);
  log("WALKFORWARD", `on unseen data it returned ${pct(oos.netReturnPct)} (max DD -${oos.maxDrawdownPct.toFixed(1)}%, PF ${pf(oos.profitFactor)}, ${oos.closedTrades} trades) vs buy-and-hold ${pct(oos.buyHoldReturnPct)} (max DD -${oos.buyHoldMaxDrawdownPct.toFixed(1)}%).`);
  const held = oos.profitFactor > 1 && oos.calmar > oos.buyHoldCalmar;
  log("VERDICT", held
    ? "the in-sample winner kept its edge out-of-sample. Next step: a paper forward test (npm run daily)."
    : "the in-sample winner did NOT keep its edge out-of-sample - its backtest was mostly selection luck.");
}

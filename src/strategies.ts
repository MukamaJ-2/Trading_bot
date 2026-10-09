import { Candle } from "./types";
import { ema, priorHighest, priorLowest, rsi, Series, sma, supertrendDirection } from "./indicators";

/**
 * Long-only strategy library for the daily backtest lab and the daily bot.
 *
 * Every strategy turns a candle series into a per-bar TARGET: 1 = be long after this bar
 * closes, 0 = be flat. Signals are evaluated on the bar's close only (never intra-candle);
 * the backtest engine and daily bot fill them on the NEXT bar's open, and both only act on a
 * target CHANGE (a fresh entry/exit event), the same way TradingView's strategy tester does.
 *
 * Rules are fully objective - no discretion - per "The Backtest Machine" step 1.
 */

export type Params = Record<string, number>;

export interface ParamSpec {
  default: number;
  /** Step used when probing neighbouring settings for the overfitting (plateau) check. */
  step: number;
  min: number;
}

export interface StrategyDef {
  name: string;
  description: string;
  params: Record<string, ParamSpec>;
  /** Optional consistency rule a parameter set must satisfy (e.g. fast < slow). */
  valid?: (p: Params) => boolean;
  targets: (candles: Candle[], p: Params) => number[];
}

function crossedAbove(a: Series, b: Series, i: number): boolean {
  const a0 = a[i], b0 = b[i], a1 = a[i - 1], b1 = b[i - 1];
  return a0 !== null && b0 !== null && a1 !== null && b1 !== null && a0 > b0 && a1 <= b1;
}

function crossedBelow(a: Series, b: Series, i: number): boolean {
  const a0 = a[i], b0 = b[i], a1 = a[i - 1], b1 = b[i - 1];
  return a0 !== null && b0 !== null && a1 !== null && b1 !== null && a0 < b0 && a1 >= b1;
}

/** Event-driven state machine: go long on `enter`, flat on `exit`, otherwise hold the state. */
function stateMachine(n: number, enter: (i: number) => boolean, exit: (i: number) => boolean): number[] {
  const out = new Array(n).fill(0);
  let state = 0;
  for (let i = 1; i < n; i++) {
    if (state === 0 && enter(i)) state = 1;
    else if (state === 1 && exit(i)) state = 0;
    out[i] = state;
  }
  return out;
}

const closes = (c: Candle[]) => c.map((x) => x.close);

export const STRATEGIES: StrategyDef[] = [
  {
    name: "ema_cross",
    description: "The Backtest Machine winner: long when EMA(fast) crosses above EMA(slow), flat on the cross back down.",
    params: { fast: { default: 9, step: 1, min: 2 }, slow: { default: 21, step: 1, min: 3 } },
    valid: (p) => p.fast < p.slow,
    targets: (c, p) => {
      const f = ema(closes(c), p.fast);
      const s = ema(closes(c), p.slow);
      return stateMachine(c.length, (i) => crossedAbove(f, s, i), (i) => crossedBelow(f, s, i));
    },
  },
  {
    name: "ema_cross_regime",
    description: "EMA cross, but only enters while close is above the SMA(regime) bull-market filter; exits on the cross down OR a close below that SMA.",
    params: {
      fast: { default: 9, step: 1, min: 2 },
      slow: { default: 21, step: 1, min: 3 },
      regime: { default: 200, step: 25, min: 50 },
    },
    valid: (p) => p.fast < p.slow && p.slow < p.regime,
    targets: (c, p) => {
      const cl = closes(c);
      const f = ema(cl, p.fast);
      const s = ema(cl, p.slow);
      const r = sma(cl, p.regime);
      const above = (i: number) => r[i] !== null && cl[i] > (r[i] as number);
      return stateMachine(
        c.length,
        (i) => above(i) && (f[i] ?? 0) > (s[i] ?? Infinity) && (crossedAbove(f, s, i) || !above(i - 1)),
        (i) => crossedBelow(f, s, i) || (r[i] !== null && !above(i))
      );
    },
  },
  {
    name: "sma_cross",
    description: "Golden cross: long when SMA(fast) crosses above SMA(slow), flat on the death cross.",
    params: { fast: { default: 50, step: 5, min: 5 }, slow: { default: 200, step: 20, min: 20 } },
    valid: (p) => p.fast < p.slow,
    targets: (c, p) => {
      const f = sma(closes(c), p.fast);
      const s = sma(closes(c), p.slow);
      return stateMachine(c.length, (i) => crossedAbove(f, s, i), (i) => crossedBelow(f, s, i));
    },
  },
  {
    name: "supertrend",
    description: "Long while Supertrend(ATR period, multiplier) is in an uptrend, flat when it flips down.",
    params: { period: { default: 10, step: 2, min: 3 }, mult: { default: 3, step: 0.5, min: 1 } },
    targets: (c, p) => {
      const d = supertrendDirection(c, p.period, p.mult);
      return stateMachine(c.length, (i) => d[i] === 1 && d[i - 1] === -1, (i) => d[i] === -1 && d[i - 1] === 1);
    },
  },
  {
    name: "donchian",
    description: "Turtle breakout: long on a close above the prior N-bar high, flat on a close below the prior M-bar low.",
    params: { entry: { default: 20, step: 5, min: 5 }, exit: { default: 10, step: 2, min: 2 } },
    valid: (p) => p.exit <= p.entry,
    targets: (c, p) => {
      const hi = priorHighest(c, p.entry);
      const lo = priorLowest(c, p.exit);
      return stateMachine(
        c.length,
        (i) => hi[i] !== null && c[i].close > (hi[i] as number),
        (i) => lo[i] !== null && c[i].close < (lo[i] as number)
      );
    },
  },
  {
    name: "macd",
    description: "Long when the MACD line crosses above its signal line, flat when it crosses back below.",
    params: {
      fast: { default: 12, step: 2, min: 2 },
      slow: { default: 26, step: 2, min: 4 },
      signal: { default: 9, step: 1, min: 2 },
    },
    valid: (p) => p.fast < p.slow,
    targets: (c, p) => {
      const cl = closes(c);
      const f = ema(cl, p.fast);
      const s = ema(cl, p.slow);
      const firstValid = s.findIndex((v) => v !== null);
      const line: Series = f.map((v, i) => (v !== null && s[i] !== null ? v - (s[i] as number) : null));
      const sig: Series = new Array(c.length).fill(null);
      if (firstValid >= 0) {
        const tail = ema(line.slice(firstValid) as number[], p.signal);
        tail.forEach((v, j) => (sig[firstValid + j] = v));
      }
      return stateMachine(c.length, (i) => crossedAbove(line, sig, i), (i) => crossedBelow(line, sig, i));
    },
  },
  {
    name: "price_sma",
    description: "Long when close crosses above SMA(period), flat when it closes back below.",
    params: { period: { default: 200, step: 20, min: 10 } },
    targets: (c, p) => {
      const cl = closes(c);
      const m = sma(cl, p.period);
      const px: Series = cl;
      return stateMachine(c.length, (i) => crossedAbove(px, m, i), (i) => crossedBelow(px, m, i));
    },
  },
  {
    name: "rsi_reversion",
    description: "Mean reversion: long when RSI crosses back above `low` from oversold, flat when RSI reaches `high`.",
    params: {
      period: { default: 14, step: 2, min: 2 },
      low: { default: 30, step: 5, min: 5 },
      high: { default: 70, step: 5, min: 50 },
    },
    valid: (p) => p.low < p.high,
    targets: (c, p) => {
      const r = rsi(closes(c), p.period);
      return stateMachine(
        c.length,
        (i) => r[i] !== null && r[i - 1] !== null && (r[i] as number) > p.low && (r[i - 1] as number) <= p.low,
        (i) => r[i] !== null && (r[i] as number) >= p.high
      );
    },
  },
];

export function getStrategy(name: string): StrategyDef {
  const s = STRATEGIES.find((x) => x.name === name);
  if (!s) {
    throw new Error(`Unknown strategy "${name}". Available: ${STRATEGIES.map((x) => x.name).join(", ")}.`);
  }
  return s;
}

export function defaultParams(s: StrategyDef): Params {
  const p: Params = {};
  for (const [k, spec] of Object.entries(s.params)) p[k] = spec.default;
  return p;
}

/** Merges user overrides (e.g. "fast=9,slow=21") onto the strategy defaults, rejecting unknown keys. */
export function resolveParams(s: StrategyDef, overrides: string | undefined): Params {
  const p = defaultParams(s);
  if (!overrides) return p;
  for (const pair of overrides.split(",").map((x) => x.trim()).filter(Boolean)) {
    const [k, v] = pair.split("=").map((x) => x.trim());
    if (!(k in s.params)) {
      throw new Error(`Strategy "${s.name}" has no parameter "${k}". Parameters: ${Object.keys(s.params).join(", ")}.`);
    }
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`Parameter ${k} must be a number, got "${v}".`);
    p[k] = n;
  }
  if (s.valid && !s.valid(p)) throw new Error(`Invalid parameters for ${s.name}: ${formatParams(p)}.`);
  return p;
}

export function formatParams(p: Params): string {
  return Object.entries(p).map(([k, v]) => `${k}=${v}`).join(",");
}

/**
 * The neighbouring settings around `center` for the overfitting check: +/-2 steps on every
 * parameter for 1-2 parameter strategies, +/-1 step for 3+ (keeps the grid small).
 */
export function neighbourhood(s: StrategyDef, center: Params): Params[] {
  const keys = Object.keys(s.params);
  const reach = keys.length <= 2 ? 2 : 1;
  let grid: Params[] = [{}];
  for (const k of keys) {
    const spec = s.params[k];
    const values: number[] = [];
    for (let d = -reach; d <= reach; d++) {
      const v = Math.round((center[k] + d * spec.step) * 1000) / 1000;
      if (v >= spec.min) values.push(v);
    }
    grid = grid.flatMap((g) => values.map((v) => ({ ...g, [k]: v })));
  }
  return grid.filter((p) => !s.valid || s.valid(p));
}

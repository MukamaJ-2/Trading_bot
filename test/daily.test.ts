import { test } from "node:test";
import * as assert from "node:assert/strict";
import { Candle } from "../src/types";
import { ema, sma } from "../src/indicators";
import { runBacktest, verdict } from "../src/backtest";
import { getStrategy, neighbourhood, resolveParams, STRATEGIES, defaultParams } from "../src/strategies";
import { decide, DailyState } from "../src/dailyBot";
import { toWeekly, countDailyGaps } from "../src/dailyData";

// Synthetic series are used ONLY to unit-test the arithmetic - the bot itself never trades on them.
const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1); // a Monday

function series(closes: number[]): Candle[] {
  return closes.map((c, i) => {
    const open = i === 0 ? c : closes[i - 1];
    return {
      openTime: T0 + i * DAY, open, high: Math.max(open, c) * 1.01, low: Math.min(open, c) * 0.99,
      close: c, volume: 1, closeTime: T0 + (i + 1) * DAY - 1,
    };
  });
}

/** Deterministic wavy trend: long up/down swings so crossovers happen several times. */
function waves(n: number): number[] {
  return Array.from({ length: n }, (_, i) => 100 * (1 + 0.3 * Math.sin(i / 15)) * (1 + i / 1000) + 3 * Math.sin(i * 1.7));
}

test("sma and ema match hand-computed values", () => {
  assert.deepEqual(sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
  const e = ema([1, 2, 3, 4], 3);
  assert.equal(e[1], null);
  assert.equal(e[2], 2); // seeded with SMA(1,2,3)
  assert.equal(e[3], 4 * 0.5 + 2 * 0.5); // k = 2/(3+1)
});

test("engine fills on next open, charges commission each side, and benchmarks buy-and-hold", () => {
  const c = series([10, 10, 10, 12, 15, 15, 9]);
  const targets = [0, 0, 1, 1, 1, 0, 0]; // enter on bar 2 close -> fill bar 3 open; exit bar 5 close -> fill bar 6 open
  const r = runBacktest(c, targets, { initialCapital: 1000, commissionPct: 0.1, startIndex: 1 });
  assert.equal(r.trades.length, 1);
  const t = r.trades[0];
  assert.equal(t.entryPrice, c[3].open); // 10
  assert.equal(t.exitPrice, c[6].open); // 15
  const qty = 1000 / (10 * 1.001);
  const expected = qty * 15 * 0.999;
  assert.ok(Math.abs(r.metrics.finalEquity - expected) < 1e-9);
  assert.equal(r.metrics.closedTrades, 1);
  assert.equal(r.metrics.winRatePct, 100);
  const bhQty = 1000 / (c[1].open * 1.001);
  assert.ok(Math.abs(r.metrics.buyHoldReturnPct - ((bhQty * 9 * 0.999) / 1000 - 1) * 100) < 1e-9);
});

test("engine never chases a trend already in progress at the start bar", () => {
  const c = series([10, 11, 12, 13, 14]);
  const r = runBacktest(c, [1, 1, 1, 1, 1], { startIndex: 1 });
  assert.equal(r.trades.length, 0);
});

test("a signal on the final bar is reported as pending, not filled", () => {
  const c = series([10, 10, 10, 10]);
  const r = runBacktest(c, [0, 0, 0, 1], { startIndex: 1 });
  assert.equal(r.trades.length, 0);
  assert.equal(r.pendingAction, "BUY");
});

test("ema_cross goes long on an up-cross and flat on the down-cross", () => {
  const closes = [...Array(30).fill(100), ...Array.from({ length: 20 }, (_, i) => 100 + (i + 1) * 3), ...Array.from({ length: 30 }, (_, i) => 160 - (i + 1) * 4)];
  const c = series(closes);
  const t = getStrategy("ema_cross").targets(c, { fast: 9, slow: 21 });
  const up = t.indexOf(1);
  assert.ok(up >= 30 && up < 35, `entry at ${up}`);
  const down = t.indexOf(0, up);
  assert.ok(down > 50, `exit at ${down}`);
});

test("every strategy produces a valid 0/1 target per bar and backtests cleanly", () => {
  const c = series(waves(900));
  for (const s of STRATEGIES) {
    const t = s.targets(c, defaultParams(s));
    assert.equal(t.length, c.length, s.name);
    assert.ok(t.every((x) => x === 0 || x === 1), s.name);
    const r = runBacktest(c, t, { startIndex: 250 });
    assert.ok(Number.isFinite(r.metrics.finalEquity), s.name);
  }
});

test("the daily bot, stepped one day at a time, reproduces the backtest's trades exactly", () => {
  const c = series(waves(600));
  const s = getStrategy("ema_cross");
  const p = resolveParams(s, "fast=9,slow=21");
  const start = 100;
  const bt = runBacktest(c, s.targets(c, p), { startIndex: start, initialCapital: 100_000, commissionPct: 0.1 });

  let state: DailyState = {
    symbol: "TEST", strategy: "ema_cross", params: p, capital: 100_000, cash: 100_000, quantity: 0,
    entryPrice: null, entryTime: null, lastProcessedOpenTime: c[start - 1].openTime,
    closedTrades: 0, wins: 0, realizedPnl: 0,
  };
  const fills: { action: string; price: number }[] = [];
  for (let day = start; day < c.length - 1; day++) {
    const closed = c.slice(0, day + 1);
    const d = decide(closed, c[day + 1].open, state, { commissionPct: 0.1, slippagePct: 0 });
    if (d.action === "BUY" || d.action === "SELL") fills.push({ action: d.action, price: c[day + 1].open });
    state = d.state;
    // Re-running the same day must be a no-op (restarts never double-enter).
    assert.equal(decide(closed, c[day + 1].open, state, { commissionPct: 0.1, slippagePct: 0 }).action, "ALREADY_PROCESSED");
  }
  const expected = bt.trades.flatMap((t) => [
    { action: "BUY", price: t.entryPrice },
    ...(t.open ? [] : [{ action: "SELL", price: t.exitPrice as number }]),
  ]);
  assert.ok(expected.length >= 4, "test series should produce several trades");
  assert.deepEqual(fills, expected);
  const equity = state.cash + state.quantity * c[c.length - 1].close;
  assert.ok(Math.abs(equity - bt.metrics.finalEquity) < 1e-6);
});

test("first run of the daily bot does not chase an existing trend", () => {
  const closes = Array.from({ length: 80 }, (_, i) => 100 + i);
  const c = series(closes);
  const state: DailyState = {
    symbol: "TEST", strategy: "ema_cross", params: { fast: 9, slow: 21 }, capital: 1000, cash: 1000, quantity: 0,
    entryPrice: null, entryTime: null, lastProcessedOpenTime: null, closedTrades: 0, wins: 0, realizedPnl: 0,
  };
  const d = decide(c, 200, state, { commissionPct: 0.1, slippagePct: 0 });
  assert.equal(d.action, "HOLD");
});

test("plateau neighbourhood around 9/21 is the 5x5 grid", () => {
  const g = neighbourhood(getStrategy("ema_cross"), { fast: 9, slow: 21 });
  assert.equal(g.length, 25);
});

test("verdict labels", () => {
  const base = {
    startTime: 0, endTime: 0, finalEquity: 0, netReturnPct: 50, cagrPct: 20, maxDrawdownPct: 20, closedTrades: 30,
    winRatePct: 35, profitFactor: 3, avgWinPct: 10, avgLossPct: -3, exposurePct: 50, sharpe: 1, calmar: 1,
    buyHoldReturnPct: 40, buyHoldMaxDrawdownPct: 40, buyHoldCalmar: 0.5,
  };
  assert.equal(verdict(base).label, "CANDIDATE");
  assert.equal(verdict({ ...base, closedTrades: 3 }).label, "ANECDOTE");
  assert.equal(verdict({ ...base, profitFactor: 0.8 }).label, "BIN");
  assert.equal(verdict({ ...base, calmar: 0.3 }).label, "FIX");
});

test("weekly resample groups Monday-Sunday and gap counter finds missing days", () => {
  const c = series(Array.from({ length: 14 }, (_, i) => 100 + i));
  const w = toWeekly(c);
  assert.equal(w.length, 2);
  assert.equal(w[0].open, c[0].open);
  assert.equal(w[0].close, c[6].close);
  assert.equal(countDailyGaps([c[0], c[1], c[4]]), 2);
});

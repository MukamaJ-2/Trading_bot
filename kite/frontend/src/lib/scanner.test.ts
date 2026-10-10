import { describe, expect, it } from "vitest";
import { normalizeCandles, runScanner, scanStock } from "./scanner";
import type { ScannerStock } from "./scanner";

const day = (i: number) => {
  const d = new Date(Date.UTC(2026, 0, 1 + i));
  return d.toISOString();
};

/** 30 flat candles, a 4x-volume breakout, a rally, then a retest near the midpoint. */
function setup(opts: { finalClose?: number; breakoutVolume?: number; rallyHigh?: number } = {}): ScannerStock {
  const candles = [];
  for (let i = 0; i < 30; i++) candles.push({ date: day(i), open: 100, high: 101, low: 99, close: 100, volume: 1000 });
  // breakout: close 105 > prev high 101, volume 4000 >= 3 x 1000, high 106, low 100 -> midpoint 103
  candles.push({ date: day(30), open: 101, high: 106, low: 100, close: 105, volume: opts.breakoutVolume ?? 4000 });
  candles.push({ date: day(31), open: 105, high: opts.rallyHigh ?? 110, low: 104, close: 108, volume: 1000 });
  candles.push({ date: day(32), open: 108, high: Math.min(108.5, opts.rallyHigh ?? 108.5), low: 104, close: 105, volume: 1000 });
  const fc = opts.finalClose ?? 103.5;
  candles.push({ date: day(33), open: 104, high: 104.5, low: 103, close: fc, volume: 1000 });
  // shuffled on purpose: the scanner must sort by date
  return { symbol: "TEST", company_name: "Test Ltd", instrument_token: 1, tick_size: 0.05, candles: candles.reverse() };
}

describe("scanner", () => {
  it("normalizes dates and numbers and sorts oldest first", () => {
    const c = normalizeCandles([
      { date: "2026-01-03T00:00:00+05:30", open: "1", high: "2", low: "0.5", close: "1.5", volume: "10" },
      { date: "2026-01-02", open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
    ]);
    expect(c.map((x) => x.date)).toEqual(["2026-01-02", "2026-01-03"]);
    expect(c[1].volume).toBe(10);
  });

  it("finds a breakout retest with the expected fields", () => {
    const r = scanStock(setup())!;
    expect(r).not.toBeNull();
    expect(r.breakoutDate).toBe("2026-01-31");
    expect(r.bIndex).toBe(30);
    expect(r.daysSince).toBe(3);
    expect(r.midpoint).toBe(103);
    expect(r.volMultiple).toBe(4);
    expect(r.prevHigh).toBe(101);
    expect(r.maxPriceAfter).toBe(110);
    expect(r.distanceFromMidpoint).toBeCloseTo(((103.5 - 103) / 103) * 100, 10);
    expect(r.returnFromCloseToSubHigh).toBeCloseTo(((110 - 105) / 105) * 100, 10);
    expect(r.retracementHigh).toBeCloseTo(((110 - 103.5) / 110) * 100, 10);
    expect(r.breakoutLow).toBe(100);
  });

  it("rejects when too far from midpoint, low volume, or no follow-through", () => {
    expect(scanStock(setup({ finalClose: 105 }))).toBeNull();
    expect(scanStock(setup({ breakoutVolume: 2900 }))).toBeNull();
    expect(scanStock(setup({ rallyHigh: 105.5 }))).toBeNull();
  });

  it("requires at least 25 candles", () => {
    const s = setup();
    s.candles = s.candles.slice(0, 24);
    expect(scanStock(s)).toBeNull();
  });

  it("counts every stock as scanned and sorts by age then distance", () => {
    const a = { ...setup(), symbol: "A" };
    const b = { ...setup({ finalClose: 103.1 }), symbol: "B" };
    const out = runScanner({ metadata: {}, stocks: [a, b, { ...setup({ finalClose: 120 }), symbol: "C" }] });
    expect(out.scanned).toBe(3);
    expect(out.results.map((r) => r.symbol)).toEqual(["B", "A"]);
  });
});

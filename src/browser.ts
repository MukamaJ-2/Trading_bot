import { Candle } from "./types";
import { STRATEGIES } from "./strategies";
import { closedOnly, parseCsvCandles, prepareCsvCandles, toWeekly, validateDaily, DAY_MS } from "./candles";
import { LabArgs, makeWindow, daysToLoad, computeBacktest, computeTournament, computePlateau, computeWalkForward } from "./labCore";

/**
 * Browser build of the Backtest Lab for the GitHub Pages site (bundled to docs/engine.js by
 * `npm run build:pages`, exposed as the global `BM`). Same engine as the CLI - only the
 * candle loading differs:
 *   1. an uploaded CSV, or
 *   2. the daily snapshot the "Daily Bot" workflow publishes to docs/data/candles/<SYMBOL>.json, or
 *   3. Coinbase's public candles endpoint, called straight from the browser.
 * Nothing here can place an order.
 */

export const strategies = STRATEGIES.map((s) => ({ name: s.name, description: s.description, params: s.params }));

export const defaults = {
  symbol: "BTC-USD",
  timeframe: "1d",
  start: "2023-07-01",
  strategy: "ema_cross",
  commissionPct: 0.1,
  slippagePct: 0,
};

interface Snapshot {
  symbol: string;
  generatedAt: string;
  /** [openTime seconds, open, high, low, close, volume] per closed daily candle. */
  candles: [number, number, number, number, number, number][];
}

function fromSnapshot(s: Snapshot): Candle[] {
  return s.candles.map(([t, o, h, l, c, v]) => ({
    openTime: t * 1000, open: o, high: h, low: l, close: c, volume: v, closeTime: t * 1000 + DAY_MS - 1,
  }));
}

async function fetchSnapshot(symbol: string): Promise<Candle[] | null> {
  try {
    // The date query string makes browsers pick up each day's new snapshot.
    const res = await fetch(`data/candles/${encodeURIComponent(symbol)}.json?d=${new Date().toISOString().slice(0, 10)}`);
    if (!res.ok) return null;
    return fromSnapshot((await res.json()) as Snapshot);
  } catch {
    return null;
  }
}

/** Coinbase Exchange public daily candles, paginated backwards (300 per request). */
export async function fetchCoinbaseDaily(symbol: string, days: number): Promise<Candle[]> {
  const rows: number[][] = [];
  let end = Date.now();
  for (let req = 0; req < 20 && rows.length < days; req++) {
    const batch = Math.min(300, days - rows.length);
    const start = end - batch * DAY_MS;
    const url = `https://api.exchange.coinbase.com/products/${encodeURIComponent(symbol)}/candles?granularity=86400&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Coinbase returned HTTP ${res.status} for ${symbol}.`);
    const data = (await res.json()) as number[][];
    if (!Array.isArray(data) || data.length === 0) break;
    rows.push(...data);
    end = start;
    if (data.length < batch) break;
  }
  const seen = new Set<number>();
  return rows
    .filter((r) => (seen.has(r[0]) ? false : (seen.add(r[0]), true)))
    .sort((a, b) => a[0] - b[0])
    .map((r) => ({ openTime: r[0] * 1000, low: r[1], high: r[2], open: r[3], close: r[4], volume: r[5], closeTime: (r[0] + 86400) * 1000 - 1 }));
}

function toArgs(raw: Record<string, unknown>): LabArgs {
  const str = (v: unknown, d: string) => (v === undefined || v === null || v === "" ? d : String(v));
  const num = (v: unknown, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
  const tf = str(raw.timeframe, "1d");
  if (tf !== "1d" && tf !== "1w") throw new Error(`timeframe must be 1d or 1w, got "${tf}".`);
  return {
    symbol: str(raw.symbol, defaults.symbol).toUpperCase(),
    timeframe: tf,
    days: num(raw.days, 1095),
    start: str(raw.start, "") || undefined,
    strategy: str(raw.strategy, defaults.strategy),
    params: str(raw.params, "") || undefined,
    commissionPct: num(raw.commissionPct, 0.1),
    slippagePct: num(raw.slippagePct, 0),
    minTrades: num(raw.minTrades, 20),
    split: num(raw.split, 0.6),
  };
}

async function loadCandles(a: LabArgs, csvText: string | undefined): Promise<{ candles: Candle[]; label: string }> {
  if (csvText) return { candles: prepareCsvCandles(parseCsvCandles(csvText), a.timeframe), label: "uploaded CSV" };
  let daily = await fetchSnapshot(a.symbol);
  let source = "daily snapshot";
  if (!daily) {
    try {
      daily = await fetchCoinbaseDaily(a.symbol, daysToLoad(a));
      source = "Coinbase, live";
    } catch (err) {
      throw new Error(
        `No market data for ${a.symbol}: no published snapshot, and the browser couldn't reach Coinbase (${(err as Error).message}). ` +
          `Run the "Daily Bot (paper)" workflow once to publish snapshots, or upload a TradingView CSV.`
      );
    }
  }
  daily = closedOnly(daily);
  validateDaily(daily);
  return { candles: a.timeframe === "1w" ? closedOnly(toWeekly(daily)) : daily, label: `${a.symbol} ${a.timeframe} (${source})` };
}

const COMPUTE = {
  backtest: computeBacktest,
  tournament: computeTournament,
  plateau: computePlateau,
  walkforward: computeWalkForward,
};

/**
 * Runs one lab analysis. The result goes through the same JSON encoding as the local server
 * (Infinity -> "inf", NaN -> null) so the page renders both identically.
 */
export async function runLab(mode: keyof typeof COMPUTE, raw: Record<string, unknown>): Promise<unknown> {
  const fn = COMPUTE[mode];
  if (!fn) throw new Error(`Unknown analysis "${mode}".`);
  const a = toArgs(raw);
  const { candles, label } = await loadCandles(a, typeof raw.csvText === "string" ? raw.csvText : undefined);
  const report = fn(makeWindow(candles, a, label), a);
  return JSON.parse(JSON.stringify(report, (_k, v) => (v === Infinity ? "inf" : typeof v === "number" && Number.isNaN(v) ? null : v)));
}

// High-volume breakout and retest scanner (Algo Signals).
// Runs in the browser on the /api/scanner-data response.

export const SCANNER_PARAMS = {
  volumeLookback: 20,
  volumeMultiplier: 3,
  priceLookback: 20,
  maxBreakoutAge: 20,
  midpointTolerancePct: 1,
  minCandles: 25,
} as const;

export interface Candle {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ScannerStock {
  symbol: string;
  company_name: string;
  instrument_token: number;
  tick_size?: number;
  is_nifty50?: boolean;
  is_nifty100?: boolean;
  candles: Array<Record<string, unknown>>;
}

export interface ScannerData {
  metadata: Record<string, unknown>;
  stocks: ScannerStock[];
}

export interface ScanResult {
  symbol: string;
  companyName: string;
  instrumentToken: number;
  tickSize: number | null;
  currentPrice: number;
  breakoutDate: string;
  bIndex: number;
  daysSince: number;
  breakoutLow: number;
  breakoutHigh: number;
  midpoint: number;
  distanceFromMidpoint: number;
  volMultiple: number;
  prevHigh: number;
  maxPriceAfter: number;
  returnFromCloseToSubHigh: number;
  retracementHigh: number;
  candles: Candle[];
}

export interface ScanOutput {
  results: ScanResult[];
  scanned: number;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function formatDate(value: unknown): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function normalizeCandles(raw: Array<Record<string, unknown>>): Candle[] {
  return raw
    .map((c) => ({
      date: formatDate(c.date),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume),
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce((s, v) => s + v, 0);
  const avg = sum / values.length;
  return Number.isFinite(avg) ? avg : null;
}

/** The most recent accepted breakout-retest setup for one stock, or null. */
export function scanStock(stock: ScannerStock, p = SCANNER_PARAMS): ScanResult | null {
  const candles = normalizeCandles(stock.candles ?? []);
  if (candles.length < p.minCandles) return null;

  const last = candles.length - 1;
  const lookback = Math.max(p.volumeLookback, p.priceLookback);
  // Earliest candidate: has `lookback` preceding candles and is at most maxBreakoutAge before the latest.
  const earliest = Math.max(lookback, last - p.maxBreakoutAge);

  for (let i = last - 1; i >= earliest; i--) {
    const c = candles[i];
    const volWindow = candles.slice(i - p.volumeLookback, i);
    const priceWindow = candles.slice(i - p.priceLookback, i);
    const avgVolume = volWindow.length === p.volumeLookback ? average(volWindow.map((x) => x.volume)) : null;
    const prevHigh = Math.max(...priceWindow.map((x) => x.high));

    if (avgVolume === null || avgVolume <= 0) continue;
    if (!(c.close > c.open)) continue;
    if (!(c.volume >= p.volumeMultiplier * avgVolume)) continue;
    if (!(c.close > prevHigh)) continue;

    const after = candles.slice(i + 1);
    const maxPriceAfter = Math.max(...after.map((x) => x.high));
    if (!(maxPriceAfter > c.high)) continue;

    const midpoint = (c.high + c.low) / 2;
    const currentPrice = candles[last].close;
    const distanceFromMidpoint = ((currentPrice - midpoint) / midpoint) * 100;
    const daysSince = last - i;

    if (Math.abs(distanceFromMidpoint) > p.midpointTolerancePct || daysSince > p.maxBreakoutAge) continue;

    return {
      symbol: stock.symbol,
      companyName: stock.company_name,
      instrumentToken: stock.instrument_token,
      tickSize: stock.tick_size ?? null,
      currentPrice,
      breakoutDate: c.date,
      bIndex: i,
      daysSince,
      breakoutLow: c.low,
      breakoutHigh: c.high,
      midpoint,
      distanceFromMidpoint,
      volMultiple: c.volume / avgVolume,
      prevHigh,
      maxPriceAfter,
      returnFromCloseToSubHigh: ((maxPriceAfter - c.close) / c.close) * 100,
      retracementHigh: ((maxPriceAfter - currentPrice) / maxPriceAfter) * 100,
      candles,
    };
  }
  return null;
}

export function runScanner(data: ScannerData, p = SCANNER_PARAMS): ScanOutput {
  let scanned = 0;
  const results: ScanResult[] = [];
  for (const stock of data.stocks ?? []) {
    scanned += 1;
    const r = scanStock(stock, p);
    if (r) results.push(r);
  }
  results.sort(
    (a, b) =>
      a.daysSince - b.daysSince || Math.abs(a.distanceFromMidpoint) - Math.abs(b.distanceFromMidpoint),
  );
  return { results, scanned };
}

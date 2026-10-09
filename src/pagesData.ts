import * as fs from "fs";
import * as path from "path";
import { fetchCandles } from "./market";
import { closedOnly, validateDaily } from "./candles";
import { dailyStatus, dailySignal } from "./dailyBot";

/**
 * `npm run pages:data` - publishes read-only data for the GitHub Pages interface:
 *   docs/data/candles/<SYMBOL>.json  closed daily candles for the browser Backtest Lab
 *   docs/data/bot.json               the daily paper bot's status, ledger and current signal
 *   docs/data/index.json             what's available and when it was generated
 * Run by the Daily Bot workflow on a GitHub runner, where the market API is reachable.
 */

const OUT = path.join(__dirname, "..", "docs", "data");
const SNAPSHOT_DAYS = 3000;

const round = (x: number) => Number(x.toPrecision(10));

export async function writePagesData(): Promise<boolean> {
  const symbols = (process.env.PAGES_SYMBOLS || "BTC-USD,ETH-USD,SOL-USD").split(",").map((s) => s.trim()).filter(Boolean);
  const generatedAt = new Date().toISOString();
  fs.mkdirSync(path.join(OUT, "candles"), { recursive: true });
  const published: string[] = [];
  let ok = true;

  for (const symbol of symbols) {
    try {
      const candles = closedOnly(await fetchCandles(symbol, "1d", SNAPSHOT_DAYS));
      validateDaily(candles);
      const body = {
        symbol,
        generatedAt,
        candles: candles.map((c) => [c.openTime / 1000, round(c.open), round(c.high), round(c.low), round(c.close), round(c.volume)]),
      };
      fs.writeFileSync(path.join(OUT, "candles", `${symbol}.json`), JSON.stringify(body));
      published.push(symbol);
      console.log(`[${generatedAt}] [PAGES] ${symbol}: ${candles.length} daily candles.`);
    } catch (err) {
      ok = false;
      console.error(`[${generatedAt}] [PAGES] ${symbol}: ${(err as Error).message}`);
    }
  }

  let signal: unknown = null;
  let signalError: string | null = null;
  try {
    signal = await dailySignal();
  } catch (err) {
    signalError = (err as Error).message;
  }
  const bot = { generatedAt, ...dailyStatus(), signal, signalError };
  fs.writeFileSync(path.join(OUT, "bot.json"), JSON.stringify(bot, (_k, v) => (v === Infinity ? "inf" : v)));
  fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify({ generatedAt, symbols: published }, null, 2) + "\n");
  console.log(`[${generatedAt}] [PAGES] wrote docs/data (${published.length}/${symbols.length} symbols).`);
  return ok;
}

import { config } from "./config";
import { fetchCandles } from "./market";
import { computeSignal } from "./strategy";
import { evaluateRisk } from "./risk";
import { applyMemoryFilter } from "./adaptiveFilter";
import { getAccount, getPositions, getOpenOrders, getPositionQty, PAPER_BASE_URL_FOR_DISPLAY } from "./brokerAlpaca";

function log(label: string, message: string): void {
  console.log(`[${new Date().toISOString()}] [${label}] ${message}`);
}

/**
 * Verifies the Alpaca paper connection - read-only, mirrors the Miles High Club
 * "Connect MCP To Claude Before Build" prompt's Step 2/3. Never places, previews, or
 * cancels an order. Stops and reports exactly what's wrong rather than proceeding
 * cautiously if anything looks off.
 */
export async function runBrokerCheck(): Promise<void> {
  log("BROKER", "Venue: Alpaca. Client: REST API (no MCP server used). Mode: PAPER (hardcoded endpoint).");
  log("BROKER", `Base URL: ${PAPER_BASE_URL_FOR_DISPLAY} - this is Alpaca's paper-trading host, not live.`);

  if (!config.alpacaKeyId || !config.alpacaSecretKey) {
    console.error(
      "[BROKER] STOP: ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY are not set. Fix: add them to " +
        ".env locally, or to GitHub Actions repository secrets - never paste keys into chat."
    );
    process.exitCode = 1;
    return;
  }
  log("BROKER", "Credentials found via environment variables (not committed to the repo, not logged).");

  let account;
  try {
    account = await getAccount();
  } catch (err) {
    console.error(`[BROKER] STOP: could not read account status - ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  log("BROKER", `Account status: ${account.status} | cash: ${account.cash} | buying power: ${account.buying_power} | portfolio value: ${account.portfolio_value}`);

  if (account.status !== "ACTIVE") {
    console.error(
      `[BROKER] STOP: account status is "${account.status}", not ACTIVE. This looks unsafe - ` +
        "fix it in your Alpaca dashboard before continuing. No further checks were run."
    );
    process.exitCode = 1;
    return;
  }

  const positions = await getPositions();
  log("BROKER", `Open positions: ${positions.length}${positions.length ? " - " + positions.map((p) => `${p.symbol} ${p.qty} (${p.side})`).join(", ") : ""}`);

  const orders = await getOpenOrders();
  log("BROKER", `Open orders: ${orders.length}${orders.length ? " - " + orders.map((o) => `${o.id} ${o.side} ${o.qty} ${o.symbol}`).join(", ") : ""}`);

  try {
    const candles = await fetchCandles(config.symbol, config.interval, 5);
    log("BROKER", `Market data check passed: fetched ${candles.length} real candles for ${config.symbol} via MARKET_DATA_PROVIDER=${config.marketDataProvider}.`);
  } catch (err) {
    console.error(`[BROKER] STOP: market data check failed - ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  log("BROKER", "No order was placed, previewed, or cancelled during this check.");
  console.log("\n--- Connection report ---");
  console.log(`Venue: Alpaca`);
  console.log(`Client: this CLI (no MCP server)`);
  console.log(`API status: reachable`);
  console.log(`Account mode: PAPER (confirmed by base URL: ${PAPER_BASE_URL_FOR_DISPLAY})`);
  console.log(`Tools verified: account, positions, orders, market data`);
  console.log(`Credentials kept out of codebase: yes (env vars only)`);
  console.log(
    `Next step: run "npm run broker:preview" to see what the current signal would do without ` +
      `submitting anything, then set BROKER=alpaca to let "npm run scan" actually submit paper orders.`
  );
}

/**
 * Shows exactly what the current signal/risk/memory decision would do against the real
 * Alpaca paper account, WITHOUT submitting, previewing, or cancelling any order. Safe to
 * run at any time, whether or not BROKER=alpaca is set.
 */
export async function runBrokerPreview(): Promise<void> {
  log("BROKER", `Fetching real candles for ${config.symbol} (${config.interval})...`);
  const candles = await fetchCandles(config.symbol, config.interval, config.scanCandleLimit);
  const signal = computeSignal(candles, config.fastPeriod, config.slowPeriod);
  log("SIGNAL", `${signal.action} - ${signal.reason}`);

  let currentPosition = 0;
  try {
    currentPosition = await getPositionQty(config.symbol);
    log("BROKER", `Real Alpaca position for ${config.symbol}: ${currentPosition}`);
  } catch (err) {
    console.error(`[BROKER] Could not read real position - ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const risk = evaluateRisk(signal.action, {
    quantity: config.tradeQuantity,
    maxPosition: config.maxPosition,
    currentPosition,
  });
  log("RISK", `${risk.action} - ${risk.reason}`);

  const memoryDecision = applyMemoryFilter(config.symbol, risk.action, risk.reason);
  log("MEMORY", `${memoryDecision.action} - ${memoryDecision.reason}`);

  if (memoryDecision.action === "BUY" || memoryDecision.action === "SELL") {
    console.log(
      `\nPREVIEW: would submit a PAPER ${memoryDecision.action} of ${config.tradeQuantity} ${config.symbol} to Alpaca.`
    );
  } else {
    console.log(`\nPREVIEW: final decision is ${memoryDecision.action} - no order would be submitted.`);
  }
  console.log("No order was placed, previewed-and-submitted, or cancelled by this command.");
}

import { config } from "./config";
import { fetchCandles } from "./market";
import { computeSignal } from "./strategy";
import { evaluateRisk } from "./risk";
import { simulatePaperOrder } from "./execution";
import { applyMemoryFilter } from "./adaptiveFilter";
import { appendLedgerRow, hasAnyMemory } from "./memory";
import { getPositionQty, submitOrder } from "./brokerAlpaca";

function log(label: string, message: string): void {
  console.log(`[${new Date().toISOString()}] [${label}] ${message}`);
}

export async function runScan(): Promise<void> {
  log("MARKET", `Fetching real candles for ${config.symbol} (${config.interval})...`);
  const candles = await fetchCandles(config.symbol, config.interval, config.scanCandleLimit);
  log("MARKET", `Loaded ${candles.length} real candles. Latest close: ${candles[candles.length - 1].close}`);

  const signal = computeSignal(candles, config.fastPeriod, config.slowPeriod, {
    trendPeriod: config.trendPeriod,
    volumeLookback: config.volumeLookback,
    volumeMultiplier: config.volumeMultiplier,
    macdFastPeriod: config.macdFastPeriod,
    macdSlowPeriod: config.macdSlowPeriod,
    macdSignalPeriod: config.macdSignalPeriod,
    rsiPeriod: config.rsiPeriod,
    rsiOversold: config.rsiOversold,
    rsiOverbought: config.rsiOverbought,
  });
  log("SIGNAL", `${signal.action} - ${signal.reason}`);

  let currentPosition = 0;
  if (config.brokerEnabled) {
    currentPosition = await getPositionQty(config.symbol);
    log("BROKER", `Real Alpaca paper position for ${config.symbol}: ${currentPosition}`);
  }

  const risk = evaluateRisk(signal.action, {
    quantity: config.tradeQuantity,
    maxPosition: config.maxPosition,
    currentPosition,
  });
  log("RISK", `${risk.action} - ${risk.reason}`);

  if (!hasAnyMemory()) {
    log("MEMORY", "No recorded memory yet (data/ledger.csv is empty). Run `npm run replay:raw` to start building real memory.");
  }
  const memoryDecision = applyMemoryFilter(config.symbol, risk.action, risk.reason);
  log("MEMORY", `${memoryDecision.action} - ${memoryDecision.reason}`);

  const isTrade = memoryDecision.action === "BUY" || memoryDecision.action === "SELL";

  if (isTrade && config.brokerEnabled) {
    const order = await submitOrder(config.symbol, memoryDecision.action === "BUY" ? "buy" : "sell", config.tradeQuantity);
    log(
      "EXECUTION",
      `Submitted REAL PAPER ${memoryDecision.action} order to Alpaca: id=${order.id} status=${order.status}. This is Alpaca's paper simulator, not live trading.`
    );
    appendLedgerRow({
      timestamp: new Date().toISOString(),
      symbol: config.symbol,
      action: memoryDecision.action,
      price: signal.price,
      quantity: config.tradeQuantity,
      reason: memoryDecision.reason,
      mode: "scan",
      outcome: "OPEN",
      pnl: "",
    });
  } else {
    const execution = simulatePaperOrder(memoryDecision.action, config.symbol, signal.price, config.tradeQuantity);
    if (execution.orderPlaced) {
      log(
        "EXECUTION",
        `Simulated PAPER ${execution.action} of ${execution.quantity} ${config.symbol} at ${execution.price}. No real order was sent.`
      );
      appendLedgerRow({
        timestamp: new Date().toISOString(),
        symbol: config.symbol,
        action: execution.action,
        price: signal.price,
        quantity: config.tradeQuantity,
        reason: memoryDecision.reason,
        mode: "scan",
        outcome: "OPEN",
        pnl: "",
      });
    } else {
      log("EXECUTION", `No paper order sent. Final decision: ${execution.action}.`);
    }
  }

  if (memoryDecision.memoryApplied) {
    appendLedgerRow({
      timestamp: new Date().toISOString(),
      symbol: config.symbol,
      action: "SKIP",
      price: signal.price,
      quantity: 0,
      reason: memoryDecision.reason,
      mode: "scan",
      outcome: "N/A",
      pnl: "",
    });
  }
}

import { Candle } from "./types";

/**
 * Long-only, all-in backtest engine matching "The Backtest Machine" test conditions:
 *   - signals evaluate on a bar's close; orders fill on the NEXT bar's open
 *   - commission per side (default 0.1%), optional slippage
 *   - 100% of equity per trade, $100,000 starting capital, no leverage
 *   - only a target CHANGE at/after the start bar opens or closes a trade (a trend already
 *     in progress at the start is not chased - same as a TradingView date-range test)
 * Indicators may warm up on bars before `startIndex`; no trade can happen before it.
 */

export interface BacktestOptions {
  initialCapital: number;
  commissionPct: number;
  slippagePct: number;
  startIndex: number;
}

export const DEFAULT_OPTIONS: BacktestOptions = {
  initialCapital: 100_000,
  commissionPct: 0.1,
  slippagePct: 0,
  startIndex: 0,
};

export interface Trade {
  entryTime: number;
  entryPrice: number;
  exitTime: number | null;
  exitPrice: number | null;
  quantity: number;
  pnl: number;
  pnlPct: number;
  bars: number;
  open: boolean;
}

export interface Metrics {
  startTime: number;
  endTime: number;
  finalEquity: number;
  netReturnPct: number;
  cagrPct: number;
  maxDrawdownPct: number;
  closedTrades: number;
  winRatePct: number;
  profitFactor: number;
  avgWinPct: number;
  avgLossPct: number;
  exposurePct: number;
  sharpe: number;
  calmar: number;
  buyHoldReturnPct: number;
  buyHoldMaxDrawdownPct: number;
  buyHoldCalmar: number;
}

export interface BacktestResult {
  trades: Trade[];
  equity: number[];
  metrics: Metrics;
  /** A signal on the final bar that would fill on the next (not yet existing) bar's open. */
  pendingAction: "BUY" | "SELL" | null;
}

function maxDrawdown(equity: number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const e of equity) {
    peak = Math.max(peak, e);
    if (peak > 0) worst = Math.max(worst, (peak - e) / peak);
  }
  return worst * 100;
}

function yearsBetween(startMs: number, endMs: number): number {
  return Math.max((endMs - startMs) / (365.25 * 24 * 3600 * 1000), 1e-9);
}

function cagr(totalReturn: number, years: number): number {
  const growth = 1 + totalReturn;
  return growth <= 0 ? -100 : (Math.pow(growth, 1 / years) - 1) * 100;
}

export function runBacktest(candles: Candle[], targets: number[], opts: Partial<BacktestOptions> = {}): BacktestResult {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  const n = candles.length;
  if (targets.length !== n) throw new Error("targets must have one entry per candle");
  const start = Math.max(1, o.startIndex);
  if (start >= n - 1) throw new Error(`Not enough candles after the start bar to backtest (have ${n}, start ${start}).`);

  const fee = o.commissionPct / 100;
  const slip = o.slippagePct / 100;
  let cash = o.initialCapital;
  let qty = 0;
  let entryCost = 0;
  let current: Trade | null = null;
  const trades: Trade[] = [];
  const equity: number[] = [];
  let barsInMarket = 0;
  let pending: "BUY" | "SELL" | null = null;

  for (let i = start; i < n; i++) {
    const bar = candles[i];
    // 1) Fill the order signalled on the previous bar's close at this bar's open.
    if (pending === "BUY" && qty === 0) {
      const px = bar.open * (1 + slip);
      qty = cash / (px * (1 + fee));
      entryCost = qty * px * (1 + fee);
      current = {
        entryTime: bar.openTime, entryPrice: px, exitTime: null, exitPrice: null,
        quantity: qty, pnl: 0, pnlPct: 0, bars: 0, open: true,
      };
      cash -= entryCost;
    } else if (pending === "SELL" && qty > 0 && current) {
      const px = bar.open * (1 - slip);
      const proceeds = qty * px * (1 - fee);
      cash += proceeds;
      Object.assign(current, {
        exitTime: bar.openTime, exitPrice: px, pnl: proceeds - entryCost,
        pnlPct: (proceeds / entryCost - 1) * 100, open: false,
      });
      trades.push(current);
      current = null;
      qty = 0;
    }
    pending = null;

    // 2) Mark to market on the close.
    if (qty > 0 && current) {
      barsInMarket++;
      current.bars++;
    }
    equity.push(cash + qty * bar.close);

    // 3) Evaluate the signal on this bar's close (only a fresh change counts).
    if (i >= start && targets[i] !== targets[i - 1]) {
      if (targets[i] === 1 && qty === 0) pending = "BUY";
      else if (targets[i] === 0 && qty > 0) pending = "SELL";
    }
  }

  const last = candles[n - 1];
  if (current) {
    const value = qty * last.close * (1 - fee);
    current.pnl = value - entryCost;
    current.pnlPct = (value / entryCost - 1) * 100;
    trades.push(current);
  }

  // Buy-and-hold benchmark over the same window: buy the start bar's open, mark to close.
  const bhQty = o.initialCapital / (candles[start].open * (1 + slip) * (1 + fee));
  const bhEquity = candles.slice(start).map((c) => bhQty * c.close);
  const bhFinal = bhQty * last.close * (1 - fee);

  const closed = trades.filter((t) => !t.open);
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
  const avg = (xs: Trade[]) => (xs.length ? xs.reduce((a, t) => a + t.pnlPct, 0) / xs.length : 0);

  const startTime = candles[start].openTime;
  const endTime = last.closeTime;
  const years = yearsBetween(startTime, endTime);
  const finalEquity = equity[equity.length - 1];
  const netReturn = finalEquity / o.initialCapital - 1;
  const bhReturn = bhFinal / o.initialCapital - 1;
  const maxDD = maxDrawdown([o.initialCapital, ...equity]);
  const bhMaxDD = maxDrawdown([o.initialCapital, ...bhEquity]);

  const rets: number[] = [];
  for (let i = 1; i < equity.length; i++) rets.push(equity[i] / equity[i - 1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / Math.max(rets.length, 1);
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(rets.length - 1, 1));
  const barsPerYear = equity.length / years;
  const cagrPct = cagr(netReturn, years);
  const bhCagr = cagr(bhReturn, years);

  return {
    trades,
    equity,
    pendingAction: pending,
    metrics: {
      startTime,
      endTime,
      finalEquity,
      netReturnPct: netReturn * 100,
      cagrPct,
      maxDrawdownPct: maxDD,
      closedTrades: closed.length,
      winRatePct: closed.length ? (wins.length / closed.length) * 100 : 0,
      profitFactor: closed.length === 0 ? NaN : grossLoss > 0 ? grossWin / grossLoss : Infinity,
      avgWinPct: avg(wins),
      avgLossPct: avg(losses),
      exposurePct: (barsInMarket / equity.length) * 100,
      sharpe: sd > 0 ? (mean / sd) * Math.sqrt(barsPerYear) : 0,
      calmar: maxDD > 0 ? cagrPct / maxDD : 0,
      buyHoldReturnPct: bhReturn * 100,
      buyHoldMaxDrawdownPct: bhMaxDD,
      buyHoldCalmar: bhMaxDD > 0 ? bhCagr / bhMaxDD : 0,
    },
  };
}

export type VerdictLabel = "ANECDOTE" | "BIN" | "FIX" | "CANDIDATE";

export interface Verdict {
  label: VerdictLabel;
  reason: string;
}

/**
 * The honest "read the verdict" step (Backtest Machine prompt 3), made mechanical:
 *   ANECDOTE  - fewer than `minTrades` closed trades: not evidence either way
 *   BIN       - profit factor below 1: it loses money after fees
 *   FIX       - makes money, but doesn't beat simply holding on a risk-adjusted basis
 *   CANDIDATE - PF >= 1.5 and a better return/drawdown ratio (Calmar) than buy-and-hold.
 *               Still only a candidate: it must survive the plateau check and a paper
 *               forward test before any real money.
 */
export function verdict(m: Metrics, minTrades = 20): Verdict {
  if (m.closedTrades < minTrades) {
    return { label: "ANECDOTE", reason: `only ${m.closedTrades} closed trades (< ${minTrades}) - an anecdote, not evidence` };
  }
  if (m.profitFactor < 1) {
    return { label: "BIN", reason: `profit factor ${m.profitFactor.toFixed(2)} < 1 - loses money after fees` };
  }
  if (m.profitFactor >= 1.5 && m.calmar > m.buyHoldCalmar) {
    return {
      label: "CANDIDATE",
      reason: `PF ${m.profitFactor.toFixed(2)}, return/drawdown ${m.calmar.toFixed(2)} vs buy-and-hold ${m.buyHoldCalmar.toFixed(2)}`,
    };
  }
  return {
    label: "FIX",
    reason: `profitable (PF ${m.profitFactor.toFixed(2)}) but return/drawdown ${m.calmar.toFixed(2)} doesn't clearly beat buy-and-hold ${m.buyHoldCalmar.toFixed(2)}`,
  };
}

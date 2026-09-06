export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export type StrategyAction = "BUY" | "SELL" | "HOLD";
export type FinalAction = StrategyAction | "SKIP";

export interface StrategySignal {
  action: StrategyAction;
  reason: string;
  fastMA: number | null;
  slowMA: number | null;
  price: number;
  candleTime: number;
}

export interface RiskDecision {
  action: FinalAction;
  reason: string;
}

export interface MemoryDecision {
  action: FinalAction;
  reason: string;
  memoryApplied: boolean;
}

export interface ExecutionResult {
  action: FinalAction;
  mode: "paper";
  symbol: string;
  price: number;
  quantity: number;
  timestamp: string;
  orderPlaced: boolean;
}

export interface LedgerRow {
  timestamp: string;
  symbol: string;
  action: FinalAction;
  price: number;
  quantity: number;
  reason: string;
  mode: "scan" | "replay:raw" | "replay:memory";
  outcome: "WIN" | "LOSS" | "OPEN" | "N/A";
  pnl: number | "";
}

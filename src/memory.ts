import * as fs from "fs";
import * as path from "path";
import { LedgerRow } from "./types";

const DATA_DIR = path.join(__dirname, "..", "data");
export const LEDGER_PATH = path.join(DATA_DIR, "ledger.csv");
export const LEARNINGS_PATH = path.join(DATA_DIR, "learnings.md");

const LEDGER_HEADER = "timestamp,symbol,action,price,quantity,reason,mode,outcome,pnl";

const LEARNINGS_TEMPLATE = `# Learnings

Plain-English lessons distilled from real paper-trade/replay outcomes. Nothing here is
invented or seeded — every line traces back to a real closed trade recorded in
\`data/ledger.csv\`. This file starts empty and only grows as the bot actually loses on a
real setup.
`;

function ensureDataFiles(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LEDGER_PATH)) fs.writeFileSync(LEDGER_PATH, LEDGER_HEADER + "\n", "utf8");
  if (!fs.existsSync(LEARNINGS_PATH)) fs.writeFileSync(LEARNINGS_PATH, LEARNINGS_TEMPLATE, "utf8");
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csvSplit(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

export function readLedgerRows(): LedgerRow[] {
  ensureDataFiles();
  const content = fs.readFileSync(LEDGER_PATH, "utf8").trim();
  const lines = content.split("\n").filter((l) => l.length > 0);
  if (lines.length <= 1) return [];

  return lines.slice(1).map((line) => {
    const [timestamp, symbol, action, price, quantity, reason, mode, outcome, pnl] = csvSplit(line);
    return {
      timestamp,
      symbol,
      action: action as LedgerRow["action"],
      price: Number(price),
      quantity: Number(quantity),
      reason,
      mode: mode as LedgerRow["mode"],
      outcome: outcome as LedgerRow["outcome"],
      pnl: pnl === "" ? "" : Number(pnl),
    };
  });
}

export function appendLedgerRow(row: LedgerRow): void {
  ensureDataFiles();
  const line = [
    row.timestamp,
    row.symbol,
    row.action,
    String(row.price),
    String(row.quantity),
    csvEscape(row.reason),
    row.mode,
    row.outcome,
    row.pnl === "" ? "" : String(row.pnl),
  ].join(",");
  fs.appendFileSync(LEDGER_PATH, line + "\n", "utf8");
}

export function readLearnings(): string {
  ensureDataFiles();
  return fs.readFileSync(LEARNINGS_PATH, "utf8");
}

/** Setup key used to match "similar setups": symbol + crossover direction. */
export function setupKey(symbol: string, action: "BUY" | "SELL"): string {
  return `${symbol}:${action}`;
}

/**
 * Appends a plain-English lesson for a real losing setup, unless an equivalent lesson
 * (same setup key) has already been recorded.
 */
export function appendLearning(symbol: string, action: "BUY" | "SELL", text: string): boolean {
  ensureDataFiles();
  const key = setupKey(symbol, action);
  const marker = `<!-- setup:${key} -->`;
  const existing = readLearnings();
  if (existing.includes(marker)) return false;

  const entry = `\n${marker}\n- **${new Date().toISOString()}** (${key}): ${text}\n`;
  fs.appendFileSync(LEARNINGS_PATH, entry, "utf8");
  return true;
}

/** Returns the most recent real ledger row recording a LOSS for this setup, if any. */
export function findPriorLoss(symbol: string, action: "BUY" | "SELL"): LedgerRow | null {
  const rows = readLedgerRows().filter(
    (r) => r.symbol === symbol && r.action === action && r.outcome === "LOSS"
  );
  if (rows.length === 0) return null;
  return rows[rows.length - 1];
}

export function hasMatchingLearning(symbol: string, action: "BUY" | "SELL"): boolean {
  const marker = `<!-- setup:${setupKey(symbol, action)} -->`;
  return readLearnings().includes(marker);
}

export function hasAnyMemory(): boolean {
  return readLedgerRows().length > 0;
}

export function resetMemory(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LEDGER_PATH, LEDGER_HEADER + "\n", "utf8");
  fs.writeFileSync(LEARNINGS_PATH, LEARNINGS_TEMPLATE, "utf8");
}

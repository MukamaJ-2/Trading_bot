import { runScan } from "./bot";
import { runReplayRaw, runReplayMemory } from "./replay";
import { resetMemory } from "./memory";

/**
 * Guardrail: this codebase has no live order-placement code path at all. This check exists
 * only to fail loudly if a LIVE_TRADING flag is ever copied in from another project's .env -
 * it is not wired to any real functionality either way.
 */
function assertPaperModeOnly(): void {
  if (process.env.LIVE_TRADING === "true" || process.env.LIVE_TRADING === "1") {
    console.error(
      "Refusing to start: LIVE_TRADING is set, but this bot has no live trading path and never will. Remove LIVE_TRADING from your .env."
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  assertPaperModeOnly();
  const command = process.argv[2];

  switch (command) {
    case "scan":
      await runScan();
      break;
    case "replay:raw":
      await runReplayRaw();
      break;
    case "replay:memory":
      await runReplayMemory();
      break;
    case "memory:reset":
      resetMemory();
      console.log(`[${new Date().toISOString()}] [MEMORY] data/ledger.csv and data/learnings.md reset to empty.`);
      break;
    default:
      console.error(`Unknown or missing command: "${command}".`);
      console.error("Usage: ts-node src/index.ts <scan|replay:raw|replay:memory|memory:reset>");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[${new Date().toISOString()}] [FATAL] ${(err as Error).message}`);
  process.exit(1);
});

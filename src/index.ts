import { runScan } from "./bot";
import { runReplayRaw, runReplayMemory } from "./replay";
import { resetMemory } from "./memory";
import { runBrokerCheck, runBrokerPreview } from "./brokerCheck";
import { parseArgs, labBacktest, labTournament, labPlateau, labWalkForward } from "./lab";
import { runDaily, resetDaily } from "./dailyBot";
import { startUi } from "./server";

/**
 * Guardrail: this codebase has no LIVE order-placement code path at all - the optional
 * Alpaca broker adapter (src/brokerAlpaca.ts) is hardcoded to Alpaca's paper endpoint and
 * cannot be pointed at live trading. This check exists only to fail loudly if a
 * LIVE_TRADING flag is ever copied in from another project's .env - it is not wired to
 * any real functionality either way.
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
    case "broker:check":
      await runBrokerCheck();
      break;
    case "broker:preview":
      await runBrokerPreview();
      break;
    case "daily":
      if (!(await runDaily()).ok) process.exitCode = 1;
      break;
    case "ui":
      await startUi();
      break;
    case "daily:reset":
      resetDaily();
      console.log(`[${new Date().toISOString()}] [DAILY] data/daily_state.json and data/daily_ledger.csv removed - next run starts a fresh paper account.`);
      break;
    case "lab:backtest":
      await labBacktest(parseArgs(process.argv.slice(3)));
      break;
    case "lab:tournament":
      await labTournament(parseArgs(process.argv.slice(3)));
      break;
    case "lab:plateau":
      await labPlateau(parseArgs(process.argv.slice(3)));
      break;
    case "lab:walkforward":
      await labWalkForward(parseArgs(process.argv.slice(3)));
      break;
    default:
      console.error(`Unknown or missing command: "${command}".`);
      console.error(
        "Usage: ts-node src/index.ts <scan|replay:raw|replay:memory|memory:reset|broker:check|broker:preview|daily|daily:reset|ui|lab:backtest|lab:tournament|lab:plateau|lab:walkforward> [--symbol BTC-USD] [--tf 1d|1w] [--days 1095] [--start 2023-07-01] [--strategy ema_cross] [--params fast=9,slow=21] [--csv file.csv]"
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[${new Date().toISOString()}] [FATAL] ${(err as Error).message}`);
  process.exit(1);
});

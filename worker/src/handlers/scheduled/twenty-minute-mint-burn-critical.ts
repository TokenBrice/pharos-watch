import { runMintBurnSlot } from "./mint-burn-slot";
import type { ScheduledRuntimeContext } from "./context";

export async function runTwentyMinuteMintBurnCriticalSlot(runtime: ScheduledRuntimeContext): Promise<void> {
  await runMintBurnSlot(runtime, {
    lane: "critical",
    jobName: "sync-mint-burn",
    skipMessage: "[cron] Alchemy circuit open - skipping mint/burn sync",
  });
}

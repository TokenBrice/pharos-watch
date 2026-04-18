import { runMintBurnSlot } from "./mint-burn-slot";
import type { ScheduledRuntimeContext } from "./context";

export async function runHalfHourlyMintBurnExtendedSlot(runtime: ScheduledRuntimeContext): Promise<void> {
  await runMintBurnSlot(runtime, {
    lane: "extended",
    jobName: "sync-mint-burn-extended",
    skipMessage: "[cron] Alchemy circuit open - skipping extended mint/burn sync",
  });
}

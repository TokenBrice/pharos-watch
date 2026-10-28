import { runMintBurnSlot } from "./mint-burn-slot";
import type { ScheduledRuntimeContext } from "./context";

export async function runHalfHourlyMintBurnExtendedSlot(runtime: ScheduledRuntimeContext) {
  return runMintBurnSlot(runtime, {
    lane: "extended",
    jobName: "sync-mint-burn-extended",
  });
}

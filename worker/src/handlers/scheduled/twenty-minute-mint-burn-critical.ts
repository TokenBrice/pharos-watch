import { refreshAggregateMintBurnFlowCache } from "../../api/mint-burn-flows";
import { MINT_BURN_AGGREGATE_PUBLISH_WINDOWS } from "../../api/mint-burn-flows-shared";
import type { CronResult } from "../../lib/cron-logger";
import { runMintBurnSlot } from "./mint-burn-slot";
import type { ScheduledRuntimeContext } from "./context";

async function publishHotAggregateCachesAfterLoggedRun(
  runtime: ScheduledRuntimeContext,
  result: CronResult | void,
): Promise<void> {
  const status = result?.status ?? "ok";
  if (status !== "ok" && status !== "degraded") return;

  try {
    await Promise.all(
      MINT_BURN_AGGREGATE_PUBLISH_WINDOWS.map((hours) =>
        refreshAggregateMintBurnFlowCache(runtime.db, hours)),
    );
  } catch (err) {
    console.warn("[sync-mint-burn] mint-burn-flows aggregate cache publish failed:", err);
  }
}

export async function runHalfHourlyMintBurnCriticalSlot(runtime: ScheduledRuntimeContext) {
  return runMintBurnSlot(runtime, {
    lane: "critical",
    jobName: "sync-mint-burn",
    skipMessage: "[cron] Alchemy circuit open - skipping mint/burn sync",
    onSettledSuccess: publishHotAggregateCachesAfterLoggedRun,
  });
}

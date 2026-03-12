import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import { syncMintBurn } from "../../cron/sync-mint-burn";
import type { ScheduledRuntimeContext } from "./context";

export async function runTwentyMinuteMintBurnExtendedSlot(runtime: ScheduledRuntimeContext): Promise<void> {
  const alchemyAllowed = await shouldAttemptFetch(runtime.db, CIRCUIT_SOURCE.ALCHEMY);
  if (!alchemyAllowed) {
    console.warn("[cron] Alchemy circuit open - skipping extended mint/burn sync");
    return;
  }

  const extendedJob = runtime.runLeasedCron("sync-mint-burn-extended", (signal, reportProgress) =>
    syncMintBurn(runtime.db, runtime.env.ALCHEMY_API_KEY ?? null, {
      signal,
      disabledConfigIds: runtime.mintBurnDisabledIds,
      disabledSymbols: runtime.mintBurnDisabledSymbols,
      lane: "extended",
      jobName: "sync-mint-burn-extended",
      onProgress: reportProgress,
    }),
  );
  runtime.ctx.waitUntil(extendedJob);
  runtime.ctx.waitUntil(extendedJob.then(
    (result) => recordOutcome(
      runtime.db,
      CIRCUIT_SOURCE.ALCHEMY,
      (result?.status ?? "ok") !== "error",
    ),
    () => recordOutcome(runtime.db, CIRCUIT_SOURCE.ALCHEMY, false),
  ));
}

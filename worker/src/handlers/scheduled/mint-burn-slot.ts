import { mapCronStatusToCircuitOutcome, recordOutcomeDecision, shouldAttemptFetch } from "../../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import { syncMintBurn, type MintBurnLane } from "../../cron/sync-mint-burn";
import type { ScheduledRuntimeContext } from "./context";

interface MintBurnSlotOptions {
  lane: MintBurnLane;
  jobName: string;
  skipMessage: string;
  onSettledSuccess?: (runtime: ScheduledRuntimeContext) => Promise<void>;
}

export async function runMintBurnSlot(
  runtime: ScheduledRuntimeContext,
  options: MintBurnSlotOptions,
): Promise<void> {
  const alchemyAllowed = await shouldAttemptFetch(runtime.db, CIRCUIT_SOURCE.ALCHEMY);
  if (!alchemyAllowed) {
    console.warn(options.skipMessage);
    return;
  }

  const job = runtime.runLeasedCron(options.jobName, (signal, reportProgress) =>
    syncMintBurn(runtime.db, runtime.env.ALCHEMY_API_KEY ?? null, {
      signal,
      disabledConfigIds: runtime.mintBurnDisabledIds,
      disabledSymbols: runtime.mintBurnDisabledSymbols,
      lane: options.lane,
      jobName: options.jobName,
      onProgress: reportProgress,
    }),
  );
  try {
    const result = await job;
    await recordOutcomeDecision(
      runtime.db,
      CIRCUIT_SOURCE.ALCHEMY,
      mapCronStatusToCircuitOutcome(result?.status),
    ).catch((err) => {
      console.error("[cron] Failed to record Alchemy success outcome:", err);
    });
    if (options.onSettledSuccess) {
      await options.onSettledSuccess(runtime).catch(() => {
        // Non-blocking alert/freshness path.
      });
    }
  } catch (err) {
    await recordOutcomeDecision(runtime.db, CIRCUIT_SOURCE.ALCHEMY, "failure").catch((outcomeErr) => {
      console.error("[cron] Failed to record Alchemy failure outcome:", outcomeErr);
    });
    throw err;
  }
}

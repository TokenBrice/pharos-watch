import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";
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

  runtime.ctx.waitUntil(job);
  runtime.ctx.waitUntil(job.then(
    (result) => recordOutcome(
      runtime.db,
      CIRCUIT_SOURCE.ALCHEMY,
      (result?.status ?? "ok") !== "error",
    ),
    () => recordOutcome(runtime.db, CIRCUIT_SOURCE.ALCHEMY, false),
  ));

  if (options.onSettledSuccess) {
    runtime.ctx.waitUntil(job.then(() => options.onSettledSuccess?.(runtime)));
  }
}

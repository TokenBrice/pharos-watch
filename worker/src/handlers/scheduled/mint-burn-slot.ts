import { CIRCUIT_SOURCE } from "../../lib/constants";
import { syncMintBurn, type MintBurnLane } from "../../cron/sync-mint-burn";
import type { ScheduledRuntimeContext } from "./context";
import { runCircuitGatedLeasedScheduledJob } from "./run-circuit-gated-job";

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
  await runCircuitGatedLeasedScheduledJob(runtime, {
    circuitSource: CIRCUIT_SOURCE.ALCHEMY,
    outcomeLabel: "Alchemy",
    skipMessage: options.skipMessage,
    job: options.jobName,
    fn: (signal, reportProgress) =>
      syncMintBurn(runtime.db, runtime.env.ALCHEMY_API_KEY ?? null, {
        signal,
        disabledConfigIds: runtime.mintBurnDisabledIds,
        disabledSymbols: runtime.mintBurnDisabledSymbols,
        lane: options.lane,
        jobName: options.jobName,
        onProgress: reportProgress,
      }),
    onSettledSuccess: options.onSettledSuccess
      ? async (settledRuntime) => options.onSettledSuccess?.(settledRuntime)
      : undefined,
  });
}

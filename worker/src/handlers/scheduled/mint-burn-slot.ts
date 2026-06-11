import { CIRCUIT_SOURCE } from "../../lib/constants";
import { syncMintBurn, type MintBurnLane } from "../../cron/sync-mint-burn";
import type { CronResult } from "../../lib/cron-logger";
import type { ScheduledRuntimeContext } from "./context";
import { runCircuitGatedLeasedScheduledJob } from "./run-circuit-gated-job";
import {
  buildScheduledSlotSummary,
  summarizeCronResult,
  summarizeSkippedScheduledJob,
} from "./slot-summary";

interface MintBurnSlotOptions {
  lane: MintBurnLane;
  jobName: string;
  skipMessage: string;
  onSettledSuccess?: (runtime: ScheduledRuntimeContext, result: CronResult | void) => Promise<void>;
}

export async function runMintBurnSlot(
  runtime: ScheduledRuntimeContext,
  options: MintBurnSlotOptions,
) {
  const result = await runCircuitGatedLeasedScheduledJob(runtime, {
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
      ? async (settledRuntime, result) => options.onSettledSuccess?.(settledRuntime, result)
      : undefined,
  });
  return buildScheduledSlotSummary([
    result === null
      ? summarizeSkippedScheduledJob(options.jobName, "circuit-open")
      : summarizeCronResult(options.jobName, result),
  ]);
}

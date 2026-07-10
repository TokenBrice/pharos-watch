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
import { parseJsonObject } from "../../lib/json-parse";

interface MintBurnSlotOptions {
  lane: MintBurnLane;
  jobName: string;
  skipMessage: string;
  runSidecar?: (runtime: ScheduledRuntimeContext, signal: AbortSignal) => Promise<MintBurnSidecarOutcome>;
}

export interface MintBurnSidecarOutcome {
  name: string;
  status: "ok" | "degraded" | "error";
  itemCount: number;
  error?: string | null;
  metadata?: Record<string, unknown>;
}

function appendSidecarOutcome(result: CronResult, sidecar: MintBurnSidecarOutcome): CronResult {
  let metadata: Record<string, unknown> = {};
  if (result.metadata) {
    const parsed = parseJsonObject(result.metadata);
    if (parsed) {
      metadata = parsed;
    } else {
      metadata.rawMetadata = result.metadata;
    }
  }
  const status = sidecar.status === "ok"
    ? result.status
    : result.status === "error"
      ? "error"
      : "degraded";
  return {
    ...result,
    status,
    metadata: JSON.stringify({
      ...metadata,
      sidecars: [{
        name: sidecar.name,
        status: sidecar.status,
        itemCount: sidecar.itemCount,
        error: sidecar.error ?? null,
        ...(sidecar.metadata ?? {}),
      }],
    }),
  };
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
    fn: async (signal, reportProgress) => {
      const primary = await syncMintBurn(runtime.db, runtime.env.ALCHEMY_API_KEY ?? null, {
        signal,
        disabledConfigIds: runtime.mintBurnDisabledIds,
        disabledSymbols: runtime.mintBurnDisabledSymbols,
        lane: options.lane,
        jobName: options.jobName,
        onProgress: reportProgress,
      });
      if (!options.runSidecar || (primary.status !== undefined && primary.status !== "ok" && primary.status !== "degraded")) {
        return primary;
      }
      const sidecar = await options.runSidecar(runtime, signal);
      return appendSidecarOutcome(primary, sidecar);
    },
  });
  return buildScheduledSlotSummary([
    result === null
      ? summarizeSkippedScheduledJob(options.jobName, "circuit-open")
      : summarizeCronResult(options.jobName, result),
  ]);
}

/**
 * Half-hourly trigger (0,30 * * * *):
 *   sync-cl-exit-depth (5)
 *
 * Isolated measured-execution lane. Three EVM chain lanes run alongside one
 * serialized Solana stream and one serialized Tron stream.
 */
import { syncDexMeasuredExecution } from "../../cron/measured-execution/sync";
import { syncSolanaDexMeasuredExecution } from "../../cron/measured-execution/solana-sync";
import { syncTronDexMeasuredExecution } from "../../cron/measured-execution/tron-sync";
import { throwIfAborted } from "../../lib/abort";
import type { CronResult } from "../../lib/cron-logger";
import { toErrorMessage } from "../../lib/error-utils";
import { tryParseJson } from "../../lib/json-parse";
import type { ScheduledRuntimeContext } from "./context";
import { runSingleScheduledJob } from "./slot-groups";

function parseMetadata(value: string | undefined): unknown {
  if (!value) return null;
  return tryParseJson(value, { onFailure: () => undefined }) ?? value;
}

async function settleMeasuredExecutionLane(name: string, run: Promise<CronResult>): Promise<CronResult> {
  try {
    return await run;
  } catch (error) {
    return {
      status: "error",
      itemCount: 0,
      metadata: JSON.stringify({ lane: name, error: toErrorMessage(error).slice(0, 500) }),
      productivity: { productive: false, reason: `${name}-measured-execution-failed` },
    };
  }
}

export function mergeMeasuredExecutionResults(evm: CronResult, solana: CronResult, tron: CronResult): CronResult {
  const evmStatus = evm.status ?? "ok";
  const solanaStatus = solana.status ?? "ok";
  const tronStatus = tron.status ?? "ok";
  // Native lanes are activation-gated shadows: retain their degraded diagnostics
  // without changing active EVM health, while invocation errors remain terminal.
  const status =
    evmStatus === "error" || solanaStatus === "error" || tronStatus === "error"
      ? "error"
      : evmStatus === "degraded"
        ? "degraded"
        : evmStatus === "skipped_neutral" && solanaStatus === "skipped_neutral" && tronStatus === "skipped_neutral"
          ? "skipped_neutral"
          : "ok";
  const productive =
    evm.productivity?.productive === true ||
    solana.productivity?.productive === true ||
    tron.productivity?.productive === true;
  return {
    status,
    itemCount: (evm.itemCount ?? 0) + (solana.itemCount ?? 0) + (tron.itemCount ?? 0),
    metadata: JSON.stringify({
      laneStatuses: { evm: evmStatus, solana: solanaStatus, tron: tronStatus },
      evm: parseMetadata(evm.metadata),
      solana: parseMetadata(solana.metadata),
      tron: parseMetadata(tron.metadata),
    }),
    productivity: {
      productive,
      reason: productive ? "published-measured-execution" : "no-measured-execution",
    },
  };
}

export async function runHalfHourlyMeasuredExecutionSlot(runtime: ScheduledRuntimeContext) {
  return runSingleScheduledJob(runtime, "half-hour measured execution slot", {
    job: "sync-cl-exit-depth",
    run: async (signal, reportProgress) => {
      const [evm, solana, tron] = await Promise.all([
        settleMeasuredExecutionLane(
          "evm",
          syncDexMeasuredExecution(runtime.db, runtime.chainRpcs, signal, reportProgress),
        ),
        settleMeasuredExecutionLane(
          "solana",
          syncSolanaDexMeasuredExecution(runtime.db, runtime.env.JUPITER_API_KEY, signal, reportProgress),
        ),
        settleMeasuredExecutionLane(
          "tron",
          syncTronDexMeasuredExecution(runtime.db, runtime.env.TRONGRID_API_KEY, signal, reportProgress),
        ),
      ]);
      // Wait for all lane writes to settle, then preserve lease-loss and timeout semantics.
      throwIfAborted(signal);
      return mergeMeasuredExecutionResults(evm, solana, tron);
    },
  });
}

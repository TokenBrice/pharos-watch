import type { D1Database } from "@shared/types/cloudflare-runtime";
import { toErrorMessage } from "@shared/lib/error-utils";
import { throwIfAborted } from "../../lib/abort";
import { recordOutcome } from "../../lib/circuit-breaker";
import { buildChainRpcs } from "../../lib/chain-registry";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import type { CronProgressReporter, CronResult } from "../../lib/cron-logger";
import { loadDwellirBudgetState, type DwellirBudgetEnv } from "../../lib/rpc-provider-budget";
import { logWorkerEvent } from "../../lib/structured-log";
import { probeRpcProviderParityRun, RPC_PARITY_RUN_BUDGET_MS } from "./probe";
import { recordRpcParityRun } from "../../lib/rpc-provider-parity/store";
import type { RpcParityErrorClass } from "../../lib/rpc-provider-parity/types";

/**
 * Hourly Dwellir observation lane.
 *
 * The lane measures Dwellir against each chain's current first operator and
 * stores one sample per chain per run. It is the health probe for the
 * `dwellir-evm` circuit, so it never consults the circuit's open state — an
 * open breaker is exactly what it is meant to re-test — but it does record the
 * run's verdict through the shared breaker helpers.
 *
 * It also never touches the runtime's `chainRpcs`: comparators are resolved
 * from a registry-only map, and Dwellir is reached only through its own pinned
 * endpoints built from `DWELLIR_CHAINS`, so a supplemental-endpoint change can
 * never move the baseline this lane measures against.
 */

const RPC_PARITY_JOB = "observe-rpc-provider-parity";

export type RpcParityJobEnv = DwellirBudgetEnv & {
  ALCHEMY_API_KEY?: string;
  DRPC_API_KEY?: string;
};

export interface RpcParityJobOptions {
  /** Test seam: the strictly serial probe runner. Defaults to the real probe. */
  probe?: typeof probeRpcProviderParityRun;
}

/**
 * Circuit verdict for one run: at least half of the attempted chains answering
 * a Dwellir head read is a working provider. A run that attempted nothing is
 * neutral — a skipped or budget-blocked run is not evidence about Dwellir.
 */
export function rpcParityCircuitOutcome(attempted: number, headOk: number): "success" | "failure" | "neutral" {
  if (attempted <= 0) return "neutral";
  return headOk * 2 >= attempted ? "success" : "failure";
}

export async function syncRpcProviderParity(
  db: D1Database,
  env: RpcParityJobEnv,
  signal: AbortSignal,
  reportProgress?: CronProgressReporter,
  options: RpcParityJobOptions = {},
): Promise<CronResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const budget = await loadDwellirBudgetState(db, env, nowSec);
  if (!budget.usable || !env.DWELLIR_API_KEY) {
    // The key is the kill switch: without a usable budget no Dwellir request
    // may be billed, so the run records why it did not observe anything.
    return {
      status: "skipped_neutral",
      itemCount: 0,
      metadata: JSON.stringify({
        skipped: true,
        reason: budget.reason,
        configured: budget.configured,
        window: budget.window,
      }),
    };
  }

  const deadlineMs = Date.now() + RPC_PARITY_RUN_BUDGET_MS;
  const chainRpcs = buildChainRpcs(env.ALCHEMY_API_KEY, env.DRPC_API_KEY);
  const probeRun = options.probe ?? probeRpcProviderParityRun;
  let probe;
  try {
    probe = await probeRun({
      chainRpcs,
      dwellirApiKey: env.DWELLIR_API_KEY,
      signal,
      deadlineMs,
      onChainProbed: async (chainId, probed) => {
        if (probed % 5 !== 0) return;
        await reportProgress?.({
          stage: "probe",
          itemsDone: probed,
          message: `parity probe: ${chainId}`,
        });
      },
    });
  } catch (error) {
    logWorkerEvent({
      scope: "lib",
      level: "error",
      event: "dwellir_parity_probe_failed",
      message: "Dwellir parity probe failed before producing samples",
      job: RPC_PARITY_JOB,
      provider: "dwellir",
      error,
    });
    throwIfAborted(signal);
    return {
      status: "error",
      itemCount: 0,
      error: toErrorMessage(error),
      metadata: JSON.stringify({ attempted: 0, deadlineMs }),
    };
  }

  // Evidence is written even for a truncated or abandoned run: the samples that
  // were collected are real observations, and the store merge is append-only.
  const write = await recordRpcParityRun(db, { atSec: nowSec, samples: probe.samples });

  const circuitOutcome = rpcParityCircuitOutcome(probe.attempted, probe.headOk);
  let circuitRecorded = false;
  if (circuitOutcome !== "neutral") {
    try {
      await recordOutcome(db, CIRCUIT_SOURCE.DWELLIR_EVM, circuitOutcome === "success");
      circuitRecorded = true;
    } catch (error) {
      logWorkerEvent({
        scope: "lib",
        level: "warn",
        event: "dwellir_parity_circuit_write_failed",
        message: "Dwellir parity run outcome could not be recorded on the circuit",
        job: RPC_PARITY_JOB,
        provider: "dwellir",
        source: CIRCUIT_SOURCE.DWELLIR_EVM,
        error,
      });
    }
  }

  const errorClasses: Partial<Record<RpcParityErrorClass, number>> = {};
  const headFailureChains: string[] = [];
  for (const sample of probe.samples) {
    if (sample.errorClass) {
      errorClasses[sample.errorClass] = (errorClasses[sample.errorClass] ?? 0) + 1;
    }
    if (!sample.headOk && headFailureChains.length < 10) headFailureChains.push(sample.chainId);
  }

  await reportProgress?.({
    stage: "stored",
    itemsDone: probe.attempted,
    itemsTotal: probe.attempted,
    message: `parity samples retained: ${write.runs} run(s)`,
  });

  const degraded = probe.deadlineHit || probe.aborted || !write.ok;
  throwIfAborted(signal);
  return {
    status: degraded ? "degraded" : "ok",
    itemCount: probe.samples.length,
    metadata: JSON.stringify({
      attempted: probe.attempted,
      headOk: probe.headOk,
      skipped: probe.skipped.length,
      deadlineHit: probe.deadlineHit,
      aborted: probe.aborted,
      runsRetained: write.runs,
      storeBytes: write.bytes,
      droppedOldest: write.droppedOldest,
      storeReset: write.reset,
      storeError: write.error,
      circuit: circuitOutcome,
      circuitRecorded,
      headFailureChains,
      errorClasses,
    }),
  };
}

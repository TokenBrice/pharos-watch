/**
 * Half-hourly physical trigger (5,35 * * * *), retaining logical :00/:30 slots:
 *   sync-cl-exit-depth (3)
 *
 * Isolated score-bearing measured-execution lane. Its flat metadata is
 * returned directly so producer history persists the lane diagnostics.
 */
import { syncDexMeasuredExecution } from "../../cron/measured-execution/sync";
import { collectWhirlpoolShadowQuotes, collectRaydiumShadowQuotes } from "../../cron/dex-liquidity/solana/whirlpool-shadow";
import { throwIfAborted } from "../../lib/abort";
import type { CronResult } from "../../lib/cron-logger";
import { toErrorMessage } from "@shared/lib/error-utils";
import type { ScheduledRuntimeContext } from "./context";
import { runSingleScheduledJob } from "./slot-groups";

export async function settleMeasuredExecutionLane(name: string, run: Promise<CronResult>): Promise<CronResult> {
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

export async function runHalfHourlyMeasuredExecutionSlot(runtime: ScheduledRuntimeContext) {
  return runSingleScheduledJob(runtime, "half-hour measured execution slot", {
    job: "sync-cl-exit-depth",
    run: async (signal, reportProgress) => {
      const evm = await settleMeasuredExecutionLane(
        "evm",
        syncDexMeasuredExecution(runtime.db, runtime.chainRpcs, signal, reportProgress),
      );
      throwIfAborted(signal);
      // No overlap with the EVM lane: native shadow adds one serialized connection.
      let orcaShadow: unknown;
      const orcaStartedAt = Date.now();
      try {
        orcaShadow = await collectWhirlpoolShadowQuotes({
          db: runtime.db, signal, ctx: { db: runtime.db, chainRpcs: runtime.chainRpcs },
        });
      } catch (error) {
        throwIfAborted(signal);
        orcaShadow = { error: toErrorMessage(error).slice(0, 240), scoreEligible: false, durationMs: Date.now() - orcaStartedAt };
      }
      throwIfAborted(signal);
      let raydiumShadow: unknown;
      const raydiumStartedAt = Date.now();
      try {
        raydiumShadow = await collectRaydiumShadowQuotes({
          db: runtime.db, signal, ctx: { db: runtime.db, chainRpcs: runtime.chainRpcs },
        });
      } catch (error) {
        throwIfAborted(signal);
        raydiumShadow = { error: toErrorMessage(error).slice(0, 240), scoreEligible: false, durationMs: Date.now() - raydiumStartedAt };
      }
      return { ...evm, metadata: JSON.stringify({ ...JSON.parse(evm.metadata ?? "{}"), orcaShadow, raydiumShadow }) };
    },
  });
}

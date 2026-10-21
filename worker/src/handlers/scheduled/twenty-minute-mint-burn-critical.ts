import { refreshAggregateMintBurnFlowCache } from "../../api/mint-burn-flows";
import { MINT_BURN_AGGREGATE_PUBLISH_WINDOWS } from "../../lib/mint-burn-flows-service";
import { toErrorMessage } from "@shared/lib/error-utils";
import { runMintBurnSlot, type MintBurnSidecarOutcome } from "./mint-burn-slot";
import type { ScheduledRuntimeContext } from "./context";

async function publishHotAggregateCaches(
  runtime: ScheduledRuntimeContext,
  signal: AbortSignal,
): Promise<MintBurnSidecarOutcome> {
  const windows: Array<{ hours: number; status: number; published: boolean; freshness: string | null; warning: string | null }> = [];
  for (const hours of MINT_BURN_AGGREGATE_PUBLISH_WINDOWS) {
    if (signal.aborted) throw signal.reason ?? new Error("mint aggregate publication aborted");
    try {
      const response = await refreshAggregateMintBurnFlowCache(runtime.db, hours);
      const warning = response.headers.get("Warning");
      windows.push({
        hours, status: response.status, published: response.ok,
        freshness: response.headers.get("X-Data-Freshness"), warning,
      });
      await response.arrayBuffer().catch(() => new ArrayBuffer(0));
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      windows.push({ hours, status: 0, published: false, freshness: null, warning: toErrorMessage(error) });
    }
  }
  const failed = windows.filter((window) => !window.published);
  // FTQ dependency advisories share Warning with flow freshness failures.
  // A published, fresh flow window completed its required work even when FTQ is unavailable.
  const degraded = windows.filter((window) => window.published && window.freshness !== "fresh");
  return {
    name: "mint-burn-aggregate-cache",
    status: failed.length > 0 ? "error" : degraded.length > 0 ? "degraded" : "ok",
    reason: failed.length > 0 ? "mint-burn-aggregate-publication-failed"
      : degraded.length > 0 ? "mint-burn-aggregate-freshness-unavailable" : null,
    itemCount: windows.length - failed.length,
    error: failed.length > 0
      ? failed.map((window) => `${window.hours}h:${window.status || window.warning || "failed"}`).join("; ")
      : null,
    metadata: { windows },
  };
}

export async function runHalfHourlyMintBurnCriticalSlot(runtime: ScheduledRuntimeContext) {
  return runMintBurnSlot(runtime, {
    lane: "critical",
    jobName: "sync-mint-burn",
    skipMessage: "[cron] Alchemy circuit open - skipping mint/burn sync",
    runSidecar: publishHotAggregateCaches,
  });
}

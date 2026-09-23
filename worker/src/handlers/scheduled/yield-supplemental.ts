import { syncYieldSupplemental } from "../../cron/sync-yield-supplemental";
import { resolveVaultsFyiConfig } from "../../lib/env";
import type { ScheduledRuntimeContext } from "./context";
import { runSingleScheduledJob } from "./slot-groups";

export async function runYieldSupplementalSlot(runtime: ScheduledRuntimeContext) {
  const vaultsFyi = resolveVaultsFyiConfig(runtime.env);
  return runSingleScheduledJob(runtime, "multi-hour yield slot", {
    job: "sync-yield-supplemental",
    errorMessage: "[cron] sync-yield-supplemental failed in multi-hour yield slot:",
    run: (signal, reportProgress) =>
      syncYieldSupplemental(runtime.db, signal, runtime.chainRpcs, reportProgress, vaultsFyi),
  });
}

import { recalcAffectedHours } from "../../lib/mint-burn-pipeline/persistence";
import type { MintBurnAffectedHour } from "../../lib/mint-burn-pipeline/types";
import { logWorkerEvent } from "../../lib/structured-log";
import { rethrowIfAborted } from "../../lib/abort";
import { toErrorMessage } from "@shared/lib/error-utils";

export async function recalcMintBurnAffectedHours(
  db: D1Database,
  affectedHours: Map<string, MintBurnAffectedHour>,
  signal?: AbortSignal,
): Promise<{ failed: boolean; error: string | null }> {
  if (affectedHours.size === 0) return { failed: false, error: null };

  try {
    await recalcAffectedHours(db, affectedHours, { signal });
    return { failed: false, error: null };
  } catch (error) {
    rethrowIfAborted(error, signal);
    logWorkerEvent({
      scope: "lib",
      level: "error",
      event: "sync-mint-burn.recalc-affected-hours-failed",
      job: "sync-mint-burn",
      message: "recalcAffectedHours failed in finally block",
      error,
    });
    return { failed: true, error: toErrorMessage(error) };
  }
}

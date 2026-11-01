import { loadCanaryStatus, type WorkerCanaryMode } from "../lib/canary-checks";
import type { OperatorWatchEvidenceCondition } from "./operator-watch-types";

export interface CanaryOperatorWatchEvidence {
  conditions: OperatorWatchEvidenceCondition[];
  /** The canary status could not be read this run: keep prior transition state. */
  unknown: boolean;
}

/**
 * Completed canary findings (`status: error`) and failed measurements stay
 * `ok` + `metadata.quality` in status mode. This converts them into operator
 * transitions without changing the canary run's own execution verdict.
 * Canary mode `off`/`shadow` is deliberate configuration, not a finding.
 */
export async function loadCanaryOperatorWatch(
  db: D1Database,
  now: number,
  mode: WorkerCanaryMode | undefined,
): Promise<CanaryOperatorWatchEvidence> {
  if (!mode || mode === "off" || mode === "shadow") return { conditions: [], unknown: false };
  try {
    const status = await loadCanaryStatus(db, now, mode);
    const conditions: OperatorWatchEvidenceCondition[] = [];
    const missing = status.missingCheckIds ?? [];
    if (missing.length > 0) {
      conditions.push({
        id: "cohort",
        label: `missing checks: ${missing.join(", ")}`,
        active: true,
      });
    }
    for (const check of Object.values(status.checks)) {
      if (check.status !== "error" && check.executionStatus !== "failed") continue;
      const reason = check.executionFailureReason ?? check.error ?? check.status;
      conditions.push({
        id: check.checkId,
        // R3/R4: name the producer, its observed generation clock and the reason code.
        label: `${check.checkId} (${reason}; observed ${check.observedAt})`,
        active: true,
      });
    }
    return { conditions, unknown: false };
  } catch {
    return { conditions: [], unknown: true };
  }
}

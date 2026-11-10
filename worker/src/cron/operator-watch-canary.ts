import { boundedText } from "../lib/canary-check-results";
import { loadCanaryStatus, type WorkerCanaryMode } from "../lib/canary-checks";
import type { OperatorWatchEvidenceCondition } from "./operator-watch-types";

export interface CanaryOperatorWatchEvidence {
  conditions: OperatorWatchEvidenceCondition[];
  /** The canary status could not be read this run: keep prior transition state. */
  unknown: boolean;
}

/**
 * Every operator section line is budgeted for the Telegram chunk cap, so the
 * free-form reason is truncated here: the check id must stay visible even when
 * the stored error is `MAX_CANARY_ERROR_CHARS` long.
 */
const OPERATOR_CANARY_LABEL_MAX_CHARS = 100;
/** A whole missing cohort lists every id; keep the bounded count visible. */
const OPERATOR_CANARY_COHORT_DETAIL_MAX_CHARS = 80;
/** `boundedText` appends a three-character ellipsis past its slice budget. */
const TRUNCATION_MARKER_CHARS = 3;

function canaryConditionLabel(check: { checkId: string; observedAt: number }, reason: string): string {
  const prefix = `${check.checkId} (`;
  const suffix = `; observed ${check.observedAt})`;
  const reasonBudget = OPERATOR_CANARY_LABEL_MAX_CHARS - prefix.length - suffix.length - TRUNCATION_MARKER_CHARS;
  return `${prefix}${boundedText(reason, Math.max(0, reasonBudget))}${suffix}`;
}

/**
 * Only a completed check that reports an `error` finding is a statement about
 * the producer. `failed` executions (a read error, a check exception) are
 * unmeasured evidence: they hold the check's prior state instead of paging or
 * reporting a recovery (R2). Completed findings stay `ok` + `metadata.quality`
 * in status mode, so this converts them into operator transitions without
 * changing the canary run's own execution verdict. Canary mode `off`/`shadow`
 * is deliberate configuration, not a finding, and not a recovery either.
 */
export async function loadCanaryOperatorWatch(
  db: D1Database,
  now: number,
  mode: WorkerCanaryMode | undefined,
): Promise<CanaryOperatorWatchEvidence> {
  if (!mode || mode === "off" || mode === "shadow") {
    // A disabled detector evaluated nothing this run: hold any prior canary
    // finding instead of reporting it as recovered (R2).
    return { conditions: [], unknown: true };
  }
  try {
    const status = await loadCanaryStatus(db, now, mode);
    const conditions: OperatorWatchEvidenceCondition[] = [];
    const missing = status.missingCheckIds ?? [];
    if (missing.length > 0) {
      conditions.push({
        id: "cohort",
        label: boundedText(`missing checks: ${missing.join(", ")}`, OPERATOR_CANARY_COHORT_DETAIL_MAX_CHARS),
        active: true,
      });
    }
    for (const check of Object.values(status.checks)) {
      if (check.executionStatus !== "completed") {
        conditions.push({ id: check.checkId, active: false, unknown: true });
        continue;
      }
      if (check.status !== "error") continue;
      conditions.push({
        id: check.checkId,
        // R3/R4: name the producer, its observed generation clock and the reason code.
        label: canaryConditionLabel(check, check.executionFailureReason ?? check.error ?? check.status),
        active: true,
      });
    }
    return { conditions, unknown: false };
  } catch {
    return { conditions: [], unknown: true };
  }
}

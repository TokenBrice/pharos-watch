import type { CronResult } from "../lib/cron-logger";
import { createCronResult } from "../lib/cron-result";
import {
  ACTIVE_CANARY_CHECK_IDS,
  normalizeWorkerCanaryMode,
  runAndPersistCanaryChecks,
  type WorkerCanaryMode,
} from "../lib/canary-checks";
import { throwIfAborted } from "../lib/abort";
import { toErrorMessage } from "@shared/lib/error-utils";

export interface DataInvariantCanaryOptions {
  mode?: string;
  observedAt?: number;
  signal?: AbortSignal;
}

function resolveDataInvariantCanaryMode(value: string | undefined): WorkerCanaryMode {
  return normalizeWorkerCanaryMode(value);
}

export async function runDataInvariantCanary(
  db: D1Database,
  options: DataInvariantCanaryOptions = {},
): Promise<CronResult> {
  throwIfAborted(options.signal);
  const mode = resolveDataInvariantCanaryMode(options.mode);
  if (mode === "off") {
    return createCronResult({
      status: "skipped_neutral",
      itemCount: 0,
      metadata: { mode, skipped: true, reason: "worker-canary-mode-off" },
    });
  }

  const observedAt = options.observedAt ?? Math.floor(Date.now() / 1000);
  let persistError: string | null = null;
  const summary = await runAndPersistCanaryChecks(db, {
    observedAt,
    signal: options.signal,
    mode,
  }).catch((error: unknown) => {
    throwIfAborted(options.signal);
    persistError = toErrorMessage(error);
    return null;
  });
  throwIfAborted(options.signal);

  if (!summary) {
    return createCronResult({
      status: mode === "shadow" ? "ok" : mode === "alert" ? "error" : "degraded",
      itemCount: 0,
      metadata: {
        mode,
        observedAt,
        persistFailed: true,
        persistError,
        reason: "canary-persist-failed",
      },
    });
  }

  const presentCheckIds = new Set(summary.results.map(({ checkId }) => checkId));
  const missingCheckIds = ACTIVE_CANARY_CHECK_IDS.filter((checkId) => !presentCheckIds.has(checkId));
  const duplicateCheckIds = summary.results
    .filter((result, index, results) => results.findIndex((other) => other.checkId === result.checkId) !== index)
    .map((result) => result.checkId);
  const unexpectedCheckIds = [...presentCheckIds].filter((checkId) => !ACTIVE_CANARY_CHECK_IDS.includes(checkId));
  const incomplete = missingCheckIds.length > 0 || duplicateCheckIds.length > 0 || unexpectedCheckIds.length > 0
    || summary.totalChecks !== ACTIVE_CANARY_CHECK_IDS.length || summary.results.length !== ACTIVE_CANARY_CHECK_IDS.length;
  const executionFailed = summary.results.some((result) => result.executionStatus !== "completed");
  const findingReason = incomplete ? "canary-cohort-incomplete"
    : executionFailed ? "canary-measurement-failed" : `canary-${summary.worstStatus}`;
  // Completed corruption findings stay severe in the ledger, but are not failed observer work.
  // Completed informational skips are non-measurements, not quality findings.
  const observedStatus = incomplete || executionFailed || summary.errorCount > 0 || summary.degradedCount > 0 ? "degraded" : "ok";
  const operationalStatus = mode === "shadow"
    ? "ok"
    : mode === "alert" && (incomplete || summary.errorCount > 0 || summary.worstSeverity === "critical")
      ? "error"
      : incomplete || executionFailed
        ? "degraded"
        : "ok";

  return createCronResult({
    status: operationalStatus,
    itemCount: summary.totalChecks,
    metadata: {
      outputPublishedAt: !incomplete && !executionFailed ? summary.observedAt : null,
      mode,
      observedStatus,
      observedAt: summary.observedAt,
      totalChecks: summary.totalChecks,
      expectedCheckIds: ACTIVE_CANARY_CHECK_IDS,
      presentCheckIds: [...presentCheckIds],
      missingCheckIds,
      duplicateCheckIds,
      unexpectedCheckIds,
      completedCount: summary.completedCount,
      failedCount: summary.failedCount,
      okCount: summary.okCount,
      degradedCount: summary.degradedCount,
      errorCount: summary.errorCount,
      skippedCount: summary.skippedCount,
      worstStatus: summary.worstStatus,
      worstSeverity: summary.worstSeverity,
      reason: incomplete || executionFailed ? findingReason : "canary-checks-completed",
      ...(operationalStatus === "ok" && observedStatus !== "ok"
        ? {
            quality: {
              reason: findingReason,
              degradedCount: summary.degradedCount,
              errorCount: summary.errorCount,
            },
          }
        : {}),
      checks: summary.results.map((result) => ({
        checkId: result.checkId,
        status: result.status,
        severity: result.severity,
        executionStatus: result.executionStatus,
        executionFailureReason: result.executionFailureReason,
        durationMs: result.durationMs,
        ...(result.error ? { error: result.error } : {}),
      })),
    },
  });
}

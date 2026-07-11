import type { CronResult } from "../lib/cron-logger";
import {
  normalizeWorkerCanaryMode,
  runAndPersistCanaryChecks,
  type WorkerCanaryMode,
} from "../lib/canary-checks";
import { throwIfAborted } from "../lib/abort";
import { toErrorMessage } from "../lib/error-utils";

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
    return {
      status: "skipped_neutral",
      itemCount: 0,
      metadata: JSON.stringify({
        mode,
        skipped: true,
        reason: "worker-canary-mode-off",
      }),
    };
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
    return {
      status: mode === "shadow" ? "ok" : mode === "alert" ? "error" : "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        mode,
        observedAt,
        persistFailed: true,
        persistError,
      }),
    };
  }

  const observedStatus = summary.errorCount > 0 || summary.degradedCount > 0 ? "degraded" : "ok";
  const operationalStatus = mode === "shadow"
    ? "ok"
    : mode === "alert" && (summary.errorCount > 0 || summary.worstSeverity === "critical")
      ? "error"
      : observedStatus;

  return {
    status: operationalStatus,
    itemCount: summary.totalChecks,
    metadata: JSON.stringify({
      mode,
      observedStatus,
      observedAt: summary.observedAt,
      totalChecks: summary.totalChecks,
      okCount: summary.okCount,
      degradedCount: summary.degradedCount,
      errorCount: summary.errorCount,
      skippedCount: summary.skippedCount,
      worstStatus: summary.worstStatus,
      worstSeverity: summary.worstSeverity,
      checks: summary.results.map((result) => ({
        checkId: result.checkId,
        status: result.status,
        severity: result.severity,
        durationMs: result.durationMs,
        ...(result.error ? { error: result.error } : {}),
      })),
    }),
  };
}

import { getCronQualityReasons } from "@shared/lib/cron-quality-reasons";
import {
  CRON_RUN_SUMMARY_ERROR_MAX_CHARS,
  type CronRunSummary,
  type CronRunDetail,
  type CronStatus,
  type CronStatusDetail,
} from "@shared/types/status";

/**
 * The only metadata keys the default `/api/status` summary carries, as
 * `latestRunFacts` of the latest attempt. Each list is what a default operator
 * view reads without opening job detail: the comms workbench (dispatch), the
 * reserve recovery forecast and the triage slowest-probe hint. Everything else
 * is served only by `/api/status-cron-detail`.
 */
export const CRON_STATUS_LATEST_FACT_KEYS: Readonly<Record<string, readonly string[]>> = {
  "dispatch-telegram-alerts": [
    "pendingDroppedPermanentFailure", "pendingDroppedMaxAttemptsFallback",
    "pendingRetryQueued", "pendingRateLimited", "pendingRetryAfterSec",
    "safetyAlertsSuppressed", "safetyAlertSourceState", "reserveAlertsSuppressed", "reserveAlertSourceState",
    "skipped", "subscribersNotified", "messagesSent",
    "pendingAttempted", "pendingDrained", "pendingDeferred", "pendingDropped", "pendingDroppedTtlExpired",
    "cappedAtLimit", "snapshotSeeded",
  ],
  "sync-live-reserves": ["synced", "total", "nextCursorStablecoinId"],
  "status-self-check": ["slowestProbes"],
};

type CronRunOutcome = Omit<CronRunSummary, "startedAt" | "durationMs" | "status" | "error" | "degradedReason" | "itemCount" | "rawStatus">;

const OUTCOME_STRING_MAX_CHARS = 200;
const OUTCOME_STRING_KEYS = ["reason", "skippedReason", "childDisposition", "workerVersion"] as const;
const OUTCOME_NUMBER_KEYS = ["activeDurationMs", "progressUpdatedAt", "reconciledAt", "reconciliationDelayMs"] as const;

/** Typed outcome fields of one attempt, read once from its persisted metadata. */
export function projectCronRunOutcome(metadata: Record<string, unknown> | undefined): CronRunOutcome {
  if (!metadata) return {};
  const outcome: CronRunOutcome = {};
  for (const key of OUTCOME_STRING_KEYS) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) outcome[key] = value.slice(0, OUTCOME_STRING_MAX_CHARS);
  }
  for (const key of OUTCOME_NUMBER_KEYS) {
    const value = metadata[key];
    if (typeof value === "number" && Number.isFinite(value)) outcome[key] = value;
  }
  const qualityReasons = getCronQualityReasons(metadata);
  if (qualityReasons.length > 0) outcome.qualityReasons = qualityReasons;
  return outcome;
}

/** Default-summary attempt: drops metadata and bounds the error text. */
function toCronRunSummary(run: CronRunDetail): CronRunSummary {
  const { metadata: _metadata, error, ...summary } = run;
  return {
    ...summary,
    ...(error != null
      ? { error: error.length > CRON_RUN_SUMMARY_ERROR_MAX_CHARS ? `${error.slice(0, CRON_RUN_SUMMARY_ERROR_MAX_CHARS)}…` : error }
      : {}),
  };
}

function pickLatestRunFacts(job: string, metadata: Record<string, unknown> | undefined): Record<string, unknown> | null {
  const keys = CRON_STATUS_LATEST_FACT_KEYS[job];
  if (!keys || !metadata) return null;
  const facts: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(metadata, key)) facts[key] = metadata[key];
  }
  return facts;
}

export function summarizeCronStatus(job: string, detail: CronStatusDetail): CronStatus {
  const { runs, inFlight, ...verdict } = detail;
  const latestRunFacts = pickLatestRunFacts(job, runs[0]?.metadata);
  let inFlightSummary: CronStatus["inFlight"] = inFlight;
  if (inFlight) {
    const { metadata: _metadata, ...progress } = inFlight;
    inFlightSummary = progress;
  }
  return {
    ...verdict,
    runs: runs.map(toCronRunSummary),
    ...(latestRunFacts ? { latestRunFacts } : {}),
    ...(inFlight !== undefined ? { inFlight: inFlightSummary } : {}),
  };
}

export function summarizeCronStatuses(crons: Readonly<Record<string, CronStatusDetail>>): Record<string, CronStatus> {
  return Object.fromEntries(Object.entries(crons).map(([job, detail]) => [job, summarizeCronStatus(job, detail)]));
}

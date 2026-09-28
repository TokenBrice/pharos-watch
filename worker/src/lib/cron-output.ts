import type { CronResult } from "./cron-logger";

const NON_OUTPUT_REASONS = [
  "already_written_today", "already_written_today_before_freshness_gate",
  "cadence_bucket_completed", "cadence_bucket_in_progress",
  "circuit-open", "no-pending-request", "not-due-today",
] as const;

/** Attempt status/counts are not publication evidence. Explicit no-write facts win. */
export function confirmedCronOutputAt(
  result: CronResult | null | void,
  metadata: Record<string, unknown> | null,
  completedAt: number,
): number | null {
  const status = result?.status ?? "ok";
  if (status !== "ok" && status !== "degraded") return null;
  const rawPersistence = metadata?.persistence;
  const persistence = rawPersistence != null && typeof rawPersistence === "object" && !Array.isArray(rawPersistence)
    ? rawPersistence as Record<string, unknown> : null;
  if (metadata?.casSkipped === true
    || (typeof metadata?.cacheWriteMode === "string" && metadata.cacheWriteMode !== "published")
    || metadata?.cacheWriteSucceeded === false
    || metadata?.cacheWriteSkipped === true
    || metadata?.lastWriteAdvanced === false
    || persistence?.skipped === true
    || persistence?.skippedReason === "liquidity-cadence-reuse") return null;
  if (metadata && Object.prototype.hasOwnProperty.call(metadata, "outputPublishedAt")) {
    const value = metadata.outputPublishedAt;
    return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= completedAt
      ? value : null;
  }
  if (typeof metadata?.reason === "string"
    && (NON_OUTPUT_REASONS as readonly string[]).includes(metadata.reason)) return null;
  if (result?.productivity) {
    if (!result.productivity.productive) return null;
    const publications = result.productivity.publications;
    if (publications?.length) {
      let latest: number | null = null;
      for (const publication of publications) {
        if (publication.generationId.trim() && Number.isFinite(publication.publishedAt)
          && publication.publishedAt > 0 && publication.publishedAt <= completedAt) {
          latest = Math.max(latest ?? 0, publication.publishedAt);
        }
      }
      return latest;
    }
    return completedAt;
  }
  if (metadata?.cacheWriteMode === "published" || metadata?.cacheWriteSucceeded === true
    || metadata?.published === true || metadata?.publicationPointerWritten === true
    || metadata?.lastWriteAdvanced === true) return completedAt;
  // DEX's accepted generation, not candidate/scoring rows or cadence reuse.
  if (persistence?.skipped === false && typeof persistence.generationId === "string"
    && persistence.generationId.length > 0 && typeof metadata?.rowsWritten === "number"
    && metadata.rowsWritten > 0) return completedAt;
  // Legacy quiet scans persisted coverage/cursor state even when no events were inserted.
  const outcomes = metadata?.coverageOutcomeCounts;
  const attempted = metadata?.configsAttempted;
  if (typeof attempted === "number" && Number.isSafeInteger(attempted) && attempted > 0
    && metadata?.configsSucceeded === attempted && metadata?.coverageFailures === 0
    && outcomes != null && typeof outcomes === "object" && !Array.isArray(outcomes)
    && "quiet" in outcomes && outcomes.quiet === attempted) return completedAt;
  return status === "ok" && (result?.itemCount ?? 0) > 0 ? completedAt : null;
}

/** Same legacy evidence boundary as confirmedCronOutputAt; new logger rows carry an explicit clock or null. */
const JSON_METADATA = "CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END";
const field = (path: string) => `json_extract(${JSON_METADATA}, '$.${path}')`;
export const CONFIRMED_CRON_OUTPUT_AT_SQL = `CASE
  WHEN status NOT IN ('ok', 'degraded') THEN NULL
  WHEN COALESCE(${field("casSkipped")}, 0) = 1
    OR (${field("cacheWriteMode")} IS NOT NULL AND ${field("cacheWriteMode")} != 'published')
    OR ${field("cacheWriteSucceeded")} = 0 OR ${field("cacheWriteSkipped")} = 1
    OR ${field("lastWriteAdvanced")} = 0 OR ${field("persistence.skipped")} = 1
    OR ${field("persistence.skippedReason")} = 'liquidity-cadence-reuse' THEN NULL
  WHEN json_type(${JSON_METADATA}, '$.outputPublishedAt') IS NOT NULL THEN
    CASE WHEN json_type(${JSON_METADATA}, '$.outputPublishedAt') IN ('integer', 'real')
      AND ${field("outputPublishedAt")} > 0
      AND ${field("outputPublishedAt")} <= started_at + duration_ms / 1000.0 + 1
      THEN ${field("outputPublishedAt")} END
  WHEN ${field("reason")} IN (${NON_OUTPUT_REASONS.map((reason) => `'${reason}'`).join(", ")}) THEN NULL
  WHEN ${field("cacheWriteMode")} = 'published' OR ${field("cacheWriteSucceeded")} = 1
    OR ${field("published")} = 1 OR ${field("publicationPointerWritten")} = 1
    OR ${field("lastWriteAdvanced")} = 1
    OR (${field("persistence.skipped")} = 0 AND length(${field("persistence.generationId")}) > 0
      AND ${field("rowsWritten")} > 0)
    OR (json_type(${JSON_METADATA}, '$.configsAttempted') IN ('integer', 'real')
      AND ${field("configsAttempted")} > 0 AND ${field("configsAttempted")} <= 9007199254740991
      AND ${field("configsAttempted")} = CAST(${field("configsAttempted")} AS INTEGER)
      AND json_type(${JSON_METADATA}, '$.configsSucceeded') IN ('integer', 'real')
      AND ${field("configsSucceeded")} = ${field("configsAttempted")}
      AND json_type(${JSON_METADATA}, '$.coverageFailures') IN ('integer', 'real')
      AND ${field("coverageFailures")} = 0
      AND json_type(${JSON_METADATA}, '$.coverageOutcomeCounts') = 'object'
      AND json_type(${JSON_METADATA}, '$.coverageOutcomeCounts.quiet') IN ('integer', 'real')
      AND ${field("coverageOutcomeCounts.quiet")} = ${field("configsAttempted")})
    OR (status = 'ok' AND item_count > 0) THEN started_at
  ELSE NULL END`;

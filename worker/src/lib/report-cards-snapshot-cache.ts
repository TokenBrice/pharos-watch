import { ReportCardsResponseSchema, type ReportCardsResponse } from "@shared/types/report-cards";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import {
  loadVersionedSnapshotCache,
  buildVersionedSnapshotCacheValue,
  writeVersionedSnapshotCache,
  type VersionedSnapshotCacheLoadResult,
  type VersionedSnapshotCacheOptions,
} from "./versioned-snapshot-cache";
import { buildReportCardPublicationPlan } from "./report-card-publication";

export const REPORT_CARDS_SNAPSHOT_CACHE_KEY = "report-cards:snapshot";
export const REPORT_CARDS_SNAPSHOT_CACHE_GENERATION = 3;

export type ReportCardsSnapshotCacheFailureReason =
  | "missing-cache"
  | "json-parse-failed"
  | "invalid-payload"
  | "invalid-envelope"
  | "generation-mismatch"
  | "methodology-mismatch"
  | "completeness-missing"
  | "completeness-mismatch";

export type ReportCardsSnapshotCacheLoadResult = VersionedSnapshotCacheLoadResult<
  ReportCardsResponse,
  ReportCardsSnapshotCacheFailureReason
>;

const REPORT_CARDS_SNAPSHOT_CACHE_OPTIONS: VersionedSnapshotCacheOptions<
  ReportCardsResponse,
  ReportCardsSnapshotCacheFailureReason
> = {
  cacheKey: REPORT_CARDS_SNAPSHOT_CACHE_KEY,
  label: "report-cards",
  generation: REPORT_CARDS_SNAPSHOT_CACHE_GENERATION,
  methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
  schema: ReportCardsResponseSchema,
  reasons: {
    missingCache: "missing-cache",
    jsonParseFailed: "json-parse-failed",
    invalidPayload: "invalid-payload",
    invalidEnvelope: "invalid-envelope",
    generationMismatch: "generation-mismatch",
    methodologyMismatch: "methodology-mismatch",
  },
  getUpdatedAt: (payload) => payload.updatedAt,
  validatePayload: (payload) => {
    if (payload.methodology.version !== SAFETY_SCORE_METHODOLOGY_VERSION) {
      return {
        reason: "methodology-mismatch",
        message: `Report-cards snapshot methodology ${payload.methodology.version} does not match ${SAFETY_SCORE_METHODOLOGY_VERSION}`,
      };
    }
    if (!payload.publication) {
      return {
        reason: "completeness-missing",
        message: "Report-cards snapshot has no publication completeness manifest",
      };
    }
    try {
      const expected = buildReportCardPublicationPlan(
        payload.cards,
        payload.methodology.version,
        payload.updatedAt,
      ).completeness;
      if (JSON.stringify(payload.publication) !== JSON.stringify(expected)) {
        return {
          reason: "completeness-mismatch",
          message: "Report-cards snapshot publication completeness does not match its card identities",
        };
      }
    } catch (error) {
      return {
        reason: "completeness-mismatch",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    return null;
  },
};

export async function loadPublishedReportCardsSnapshot(
  db: D1Database,
): Promise<ReportCardsSnapshotCacheLoadResult> {
  return loadVersionedSnapshotCache(db, REPORT_CARDS_SNAPSHOT_CACHE_OPTIONS);
}

export async function writePublishedReportCardsSnapshot(
  db: D1Database,
  snapshot: ReportCardsResponse,
): Promise<void> {
  await writeVersionedSnapshotCache(db, snapshot, REPORT_CARDS_SNAPSHOT_CACHE_OPTIONS);
}

export function buildPublishedReportCardsSnapshotCacheEntry(
  snapshot: ReportCardsResponse,
): { key: string; value: string } {
  return {
    key: REPORT_CARDS_SNAPSHOT_CACHE_KEY,
    value: buildVersionedSnapshotCacheValue(snapshot, REPORT_CARDS_SNAPSHOT_CACHE_OPTIONS),
  };
}

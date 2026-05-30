import { ReportCardsResponseSchema, type ReportCardsResponse } from "@shared/types/report-cards";
import { METHODOLOGY_VERSION } from "@shared/lib/report-cards";
import {
  loadVersionedSnapshotCache,
  writeVersionedSnapshotCache,
  type VersionedSnapshotCacheLoadResult,
  type VersionedSnapshotCacheOptions,
} from "./versioned-snapshot-cache";

const REPORT_CARDS_SNAPSHOT_CACHE_KEY = "report-cards:snapshot";
export const REPORT_CARDS_SNAPSHOT_CACHE_GENERATION = 3;

export type ReportCardsSnapshotCacheFailureReason =
  | "missing-cache"
  | "json-parse-failed"
  | "invalid-payload"
  | "invalid-envelope"
  | "generation-mismatch"
  | "methodology-mismatch";

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
  methodologyVersion: METHODOLOGY_VERSION,
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
  validatePayload: (payload) => (
    payload.methodology.version === METHODOLOGY_VERSION
      ? null
      : {
          reason: "methodology-mismatch",
          message: `Report-cards snapshot methodology ${payload.methodology.version} does not match ${METHODOLOGY_VERSION}`,
        }
  ),
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

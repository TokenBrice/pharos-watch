import { ReportCardsResponseSchema, type ReportCardsResponse } from "@shared/types/report-cards";
import { decodeCachedJson } from "./cache-json";
import { getCache, setCache } from "./db-cache";

const REPORT_CARDS_SNAPSHOT_CACHE_KEY = "report-cards:snapshot";

export type ReportCardsSnapshotCacheFailureReason =
  | "missing-cache"
  | "json-parse-failed"
  | "invalid-payload";

export type ReportCardsSnapshotCacheLoadResult =
  | { kind: "ok"; payload: ReportCardsResponse; updatedAt: number }
  | { kind: "error"; reason: ReportCardsSnapshotCacheFailureReason; updatedAt: number | null };

export async function loadPublishedReportCardsSnapshot(
  db: D1Database,
): Promise<ReportCardsSnapshotCacheLoadResult> {
  const decoded = decodeCachedJson<ReportCardsResponse, ReportCardsSnapshotCacheFailureReason>(
    await getCache(db, REPORT_CARDS_SNAPSHOT_CACHE_KEY),
    {
      mode: "strict",
      missingReason: "missing-cache",
      parseErrorReason: "json-parse-failed",
      normalize: (parsed) => {
        const result = ReportCardsResponseSchema.safeParse(parsed);
        return result.success
          ? { ok: true, payload: result.data }
          : { ok: false, reason: "invalid-payload" };
      },
    },
  );

  if (!decoded.ok) {
    return { kind: "error", reason: decoded.reason, updatedAt: decoded.updatedAt };
  }

  return {
    kind: "ok",
    payload: decoded.payload,
    updatedAt: decoded.payload.updatedAt,
  };
}

export async function writePublishedReportCardsSnapshot(
  db: D1Database,
  snapshot: ReportCardsResponse,
): Promise<void> {
  await setCache(db, REPORT_CARDS_SNAPSHOT_CACHE_KEY, JSON.stringify(snapshot));
}

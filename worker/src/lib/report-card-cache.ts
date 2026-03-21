import { getCache } from "./db-cache";
import { decodeCachedJson } from "./cache-json";

export interface ReportCardScoreEntry {
  score: number;
  grade: string;
}

export interface ReportCardCachePayload {
  scores: Record<string, ReportCardScoreEntry>;
  updatedAt: number;
}

export type ReportCardCacheFailureReason =
  | "missing-cache"
  | "json-parse-failed"
  | "invalid-payload"
  | "stale-cache";

export type ReportCardCacheLoadResult =
  | { kind: "ok"; payload: ReportCardCachePayload; updatedAt: number }
  | { kind: "error"; reason: ReportCardCacheFailureReason; updatedAt: number | null };

export interface LoadReportCardCacheOptions {
  maxAgeMs?: number;
}

function isValidReportCardCachePayload(value: unknown): value is ReportCardCachePayload {
  if (!value || typeof value !== "object") return false;
  const parsed = value as { scores?: unknown; updatedAt?: unknown };
  return parsed.scores != null
    && typeof parsed.scores === "object"
    && typeof parsed.updatedAt === "number"
    && Number.isFinite(parsed.updatedAt);
}

export async function loadReportCardCache(
  db: D1Database,
  options: LoadReportCardCacheOptions = {},
): Promise<ReportCardCacheLoadResult> {
  const decoded = decodeCachedJson<ReportCardCachePayload, ReportCardCacheFailureReason>(
    await getCache(db, "report_card_cache"),
    {
      mode: "strict",
      missingReason: "missing-cache",
      parseErrorReason: "json-parse-failed",
      normalize: (parsed) => (
        isValidReportCardCachePayload(parsed)
          ? { ok: true, payload: parsed }
          : { ok: false, reason: "invalid-payload" }
      ),
    },
  );
  if (!decoded.ok) {
    return { kind: "error", reason: decoded.reason, updatedAt: decoded.updatedAt };
  }

  if (options.maxAgeMs != null) {
    const ageMs = Date.now() - decoded.payload.updatedAt * 1000;
    if (ageMs > options.maxAgeMs) {
      return { kind: "error", reason: "stale-cache", updatedAt: decoded.updatedAt };
    }
  }

  return { kind: "ok", payload: decoded.payload, updatedAt: decoded.updatedAt ?? 0 };
}

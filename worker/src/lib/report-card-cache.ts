import { getCache } from "./db-cache";

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
  const cached = await getCache(db, "report_card_cache");
  if (!cached) {
    return { kind: "error", reason: "missing-cache", updatedAt: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cached.value);
  } catch {
    return { kind: "error", reason: "json-parse-failed", updatedAt: cached.updatedAt };
  }

  if (!isValidReportCardCachePayload(parsed)) {
    return { kind: "error", reason: "invalid-payload", updatedAt: cached.updatedAt };
  }

  if (options.maxAgeMs != null) {
    const ageMs = Date.now() - parsed.updatedAt * 1000;
    if (ageMs > options.maxAgeMs) {
      return { kind: "error", reason: "stale-cache", updatedAt: cached.updatedAt };
    }
  }

  return { kind: "ok", payload: parsed, updatedAt: cached.updatedAt };
}

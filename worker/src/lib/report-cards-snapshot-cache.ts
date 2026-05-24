import { ReportCardsResponseSchema, type ReportCardsResponse } from "@shared/types/report-cards";
import { METHODOLOGY_VERSION } from "@shared/lib/report-cards";
import { decodeCachedJson } from "./cache-json";
import { getCache, setCache } from "./db-cache";

const REPORT_CARDS_SNAPSHOT_CACHE_KEY = "report-cards:snapshot";
export const REPORT_CARDS_SNAPSHOT_CACHE_GENERATION = 3;

export type ReportCardsSnapshotCacheFailureReason =
  | "missing-cache"
  | "json-parse-failed"
  | "invalid-payload"
  | "invalid-envelope"
  | "generation-mismatch"
  | "methodology-mismatch";

interface ReportCardsSnapshotCacheEnvelope {
  generation: number;
  methodologyVersion: string;
  payload: ReportCardsResponse;
}

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
        if (!parsed || typeof parsed !== "object" || !("payload" in parsed)) {
          return { ok: false, reason: "invalid-envelope" };
        }

        const envelope = parsed as Partial<ReportCardsSnapshotCacheEnvelope>;
        if (envelope.generation !== REPORT_CARDS_SNAPSHOT_CACHE_GENERATION) {
          return { ok: false, reason: "generation-mismatch" };
        }
        if (envelope.methodologyVersion !== METHODOLOGY_VERSION) {
          return { ok: false, reason: "methodology-mismatch" };
        }

        const result = ReportCardsResponseSchema.safeParse(envelope.payload);
        if (!result.success) {
          return { ok: false, reason: "invalid-payload" };
        }
        if (result.data.methodology.version !== METHODOLOGY_VERSION) {
          return { ok: false, reason: "methodology-mismatch" };
        }

        return { ok: true, payload: result.data };
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
  const result = ReportCardsResponseSchema.safeParse(snapshot);
  if (!result.success) {
    throw new Error(`Invalid report-cards snapshot payload: ${result.error.message}`);
  }
  if (result.data.methodology.version !== METHODOLOGY_VERSION) {
    throw new Error(
      `Report-cards snapshot methodology ${result.data.methodology.version} does not match ${METHODOLOGY_VERSION}`,
    );
  }

  const envelope: ReportCardsSnapshotCacheEnvelope = {
    generation: REPORT_CARDS_SNAPSHOT_CACHE_GENERATION,
    methodologyVersion: METHODOLOGY_VERSION,
    payload: result.data,
  };
  await setCache(db, REPORT_CARDS_SNAPSHOT_CACHE_KEY, JSON.stringify(envelope));
}

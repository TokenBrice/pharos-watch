import { isRecord } from "@shared/lib/type-guards";
import { decodeCachedJson } from "./cache-json";
import { recordJsonParseFailure } from "./api-cache-read";
import { toFiniteNumber } from "./number-utils";

type YieldRankingsCacheFailureReason = "missing-cache" | "json-parse-failed" | "invalid-shape";

export type YieldRankingsPublishedCutoffResult =
  | { status: "ok"; updatedAt: number }
  | { status: "missing"; updatedAt: null }
  | { status: "parse-error"; updatedAt: null }
  | { status: "invalid-shape"; updatedAt: null };

export function parseYieldRankingsPublishedCutoff(
  cached: { value: string; updatedAt: number } | null,
): YieldRankingsPublishedCutoffResult {
  const decoded = decodeCachedJson<{ updatedAt: number }, YieldRankingsCacheFailureReason>(
    cached,
    {
      missingReason: "missing-cache",
      parseErrorReason: "json-parse-failed",
      normalize: (parsed) => {
        if (!isRecord(parsed)) {
          return { ok: false, reason: "invalid-shape" };
        }

        const updatedAt = toFiniteNumber(parsed.updatedAt);
        if (updatedAt == null || updatedAt <= 0) {
          return { ok: false, reason: "invalid-shape" };
        }

        return { ok: true, payload: { updatedAt } };
      },
      onParseFailure: ({ message }) => recordJsonParseFailure("yield-rankings:published-cutoff", message),
    },
  );

  if (decoded.ok) {
    return { status: "ok", updatedAt: decoded.payload.updatedAt };
  }
  return {
    status: decoded.reason === "missing-cache"
      ? "missing"
      : decoded.reason === "json-parse-failed"
        ? "parse-error"
        : "invalid-shape",
    updatedAt: null,
  };
}

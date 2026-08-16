import { isRecord } from "@shared/lib/type-guards";
import { toFiniteNumber } from "./number-utils";

export type YieldRankingsPublishedCutoffResult =
  | { status: "ok"; updatedAt: number }
  | { status: "missing"; updatedAt: null }
  | { status: "parse-error"; updatedAt: null }
  | { status: "invalid-shape"; updatedAt: null };

export function parseYieldRankingsPublishedCutoff(
  cached: { value: string; updatedAt: number } | null,
): YieldRankingsPublishedCutoffResult {
  if (!cached) {
    return { status: "missing", updatedAt: null };
  }

  try {
    const parsed = JSON.parse(cached.value) as unknown;
    if (!isRecord(parsed)) {
      return { status: "invalid-shape", updatedAt: null };
    }

    const updatedAt = toFiniteNumber(parsed.updatedAt);
    if (updatedAt == null || updatedAt <= 0) {
      return { status: "invalid-shape", updatedAt: null };
    }

    return { status: "ok", updatedAt };
  } catch {
    return { status: "parse-error", updatedAt: null };
  }
}

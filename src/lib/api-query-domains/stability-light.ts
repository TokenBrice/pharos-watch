import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { isFiniteNumber, isRecord } from "@shared/lib/type-guards";
import type { StabilityIndexResponse } from "@shared/types/stability";
import { CRON_STABILITY_INDEX } from "@/lib/cron-intervals";
import { defineApiQuery } from "@/lib/api-query-contract";
import type { SchemaLike, SchemaLikeResult } from "@shared/lib/schema-like";

function invalid(path: readonly PropertyKey[], message: string): SchemaLikeResult<StabilityIndexResponse> {
  return { success: false, error: { issues: [{ path, message }] } };
}

function validateComponents(value: unknown): readonly [readonly PropertyKey[], string] | null {
  if (!isRecord(value)) return [["current", "components"], "Expected object"];
  for (const key of ["severity", "breadth", "trend"] as const) {
    if (!isFiniteNumber(value[key])) return [["current", "components", key], "Expected finite number"];
  }
  if (value.stressBreadth != null && !isFiniteNumber(value.stressBreadth)) {
    return [["current", "components", "stressBreadth"], "Expected finite number"];
  }
  return null;
}

/**
 * The root RegimeBar only needs PSI display fields. Validate that bounded
 * contract without importing the full classic-Zod stability schema into every
 * route, and preserve the original response for richer consumers sharing the
 * same TanStack cache entry.
 */
export const StabilityIndexLightResponseSchema: SchemaLike<StabilityIndexResponse> = {
  safeParse(value) {
    if (!isRecord(value)) return invalid([], "Expected object");
    if (!Array.isArray(value.history)) return invalid(["history"], "Expected array");

    if (value.current !== null) {
      if (!isRecord(value.current)) return invalid(["current"], "Expected object or null");
      for (const key of ["score", "computedAt"] as const) {
        if (!isFiniteNumber(value.current[key])) return invalid(["current", key], "Expected finite number");
      }
      if (typeof value.current.band !== "string") return invalid(["current", "band"], "Expected string");
      if (value.current.avg24h != null && !isFiniteNumber(value.current.avg24h)) {
        return invalid(["current", "avg24h"], "Expected finite number");
      }
      if (value.current.avg24hBand != null && typeof value.current.avg24hBand !== "string") {
        return invalid(["current", "avg24hBand"], "Expected string");
      }
      const componentsError = validateComponents(value.current.components);
      if (componentsError) return invalid(...componentsError);
    }

    for (let index = 0; index < value.history.length; index += 1) {
      const point = value.history[index];
      if (!isRecord(point)) return invalid(["history", index], "Expected object");
      for (const key of ["date", "score"] as const) {
        if (!isFiniteNumber(point[key])) return invalid(["history", index, key], "Expected finite number");
      }
      if (typeof point.band !== "string") return invalid(["history", index, "band"], "Expected string");
    }

    return { success: true, data: value as unknown as StabilityIndexResponse };
  },
};

export const STABILITY_INDEX_QUERY_DESCRIPTOR = defineApiQuery(
  {
    queryKey: ["stability-index"] as const,
    path: API_PATHS.stabilityIndex(),
    producerIntervalMs: CRON_STABILITY_INDEX,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.stabilityIndex,
  },
  "meta",
  StabilityIndexLightResponseSchema,
);

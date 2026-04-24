import {
  FRESHNESS_SENTINEL_CACHE_KEYS,
  getCacheFreshnessLane,
} from "@shared/lib/api-freshness";
import { z } from "zod";

export type FreshnessSentinelBackedCacheKey = (typeof FRESHNESS_SENTINEL_CACHE_KEYS)[number];

const FreshnessSentinelPayloadSchema = z.object({
  updatedAt: z.number().int().nonnegative(),
  source: z.string().min(1),
  publishStatus: z.literal("ok"),
  rowsWritten: z.number().int().nonnegative().optional(),
  coverageRatio: z.number().min(0).max(1).optional(),
});

export type FreshnessSentinelPayload = z.infer<typeof FreshnessSentinelPayloadSchema>;

export type FreshnessSentinelValidationReason =
  | "malformed-json"
  | "invalid-payload"
  | "wrong-source"
  | "stale-payload"
  | "future-updated-at";

export interface FreshnessSentinelValidationResult {
  ok: boolean;
  payload?: FreshnessSentinelPayload;
  reason?: FreshnessSentinelValidationReason;
}

function buildFreshnessSentinelConfigs(): Record<
  FreshnessSentinelBackedCacheKey,
  { cacheKey: string; producerJob: string }
> {
  return Object.fromEntries(
    FRESHNESS_SENTINEL_CACHE_KEYS.map((cacheKey) => {
      const lane = getCacheFreshnessLane(cacheKey);
      if (!lane?.freshnessSentinelKey) {
        throw new Error(`Missing freshness sentinel config for ${cacheKey}`);
      }
      return [
        cacheKey,
        {
          cacheKey: lane.freshnessSentinelKey,
          producerJob: lane.producerJob,
        },
      ];
    }),
  ) as Record<FreshnessSentinelBackedCacheKey, { cacheKey: string; producerJob: string }>;
}

export const FRESHNESS_SENTINEL_CONFIGS = buildFreshnessSentinelConfigs();

export function getFreshnessSentinelCacheKey(key: FreshnessSentinelBackedCacheKey): string {
  return FRESHNESS_SENTINEL_CONFIGS[key].cacheKey;
}

export function getFreshnessSentinelProducerJob(key: FreshnessSentinelBackedCacheKey): string {
  return FRESHNESS_SENTINEL_CONFIGS[key].producerJob;
}

export function listFreshnessSentinelCacheKeys(): string[] {
  return Object.values(FRESHNESS_SENTINEL_CONFIGS).map((config) => config.cacheKey);
}

export function validateFreshnessSentinelPayload(params: {
  value: string | null | undefined;
  rowUpdatedAt: number;
  expectedSource: string;
  now: number;
}): FreshnessSentinelValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(params.value ?? "");
  } catch {
    return { ok: false, reason: "malformed-json" };
  }

  const result = FreshnessSentinelPayloadSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, reason: "invalid-payload" };
  }

  if (result.data.source !== params.expectedSource) {
    return { ok: false, reason: "wrong-source" };
  }

  if (result.data.updatedAt !== params.rowUpdatedAt) {
    return { ok: false, reason: "stale-payload" };
  }

  if (result.data.updatedAt > params.now) {
    return { ok: false, reason: "future-updated-at" };
  }

  return { ok: true, payload: result.data };
}

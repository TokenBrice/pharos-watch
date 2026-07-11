/**
 * Compatibility barrel for status contracts shared by the frontend and Worker.
 *
 * Domain modules live under `./status/`; existing consumers should continue to
 * import from `@shared/types/status` unless they specifically need a lower-level
 * module to avoid loading unrelated runtime schemas.
 */
export type { DiscoveryCandidate, DiscoveryCandidatesResponse } from "./discovery";
export type {
  PriceSourceDepthBucket,
  PriceSourceDepthDistribution,
  PriceSourceHealth,
  PriceSourceHealthBucketKey,
} from "./pricing-source-health";

export * from "./status/core";
export type {
  D1CapacityAssessment,
  D1CapacityForecastBasis,
  D1CapacityThresholdState,
} from "./status/d1-capacity";
export * from "./status/cron";
export * from "./status/telegram";
export * from "./status/yield-liquidity";
export * from "./status/operational";
export * from "./status/response";
export * from "./status/public-health";

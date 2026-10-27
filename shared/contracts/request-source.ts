import { z } from "zod";
import { ApiKeyTrafficClassSchema } from "./api-keys";

export type SiteDataRequestDeliveryPath =
  | "pages-cache-hit"
  | "pages-upstream-fetch"
  | "pages-upstream-timeout"
  | "pages-upstream-error";
export type SiteDataRequestUpstreamLane = "" | "site-api" | "public-api-fallback";

// Operational telemetry identity, not a public scoring methodology version.
export const REQUEST_SOURCE_MEASUREMENT_VERSION = 2;
export const REQUEST_SOURCE_POLICY_ID = "request-source-bernoulli-64-v1";
export const REQUEST_SOURCE_SAMPLE_INVERSE_RATE = 64;
export const REQUEST_SOURCE_LOW_SAMPLE_MINIMUM = 30;
const AttributionMeasurementSchema = z.object({
  kind: z.enum(["observed", "estimated", "mixed", "unavailable"]),
  observedSampleCount: z.number().int().nonnegative(),
  recordedCount: z.number().int().nonnegative(),
  probabilityStrata: z.array(z.object({
    inverseRate: z.number().int().positive(),
    observedSampleCount: z.number().int().nonnegative(),
  })),
  coverage: z.enum(["best-effort", "unknown"]),
  reason: z.enum(["low-sample", "no-observations", "invalid-key-regime", "legacy-keyed-exceeds-source"]).nullable(),
  standardError: z.number().nonnegative().nullable(),
}).superRefine((value, ctx) => {
  if (value.kind === "observed" && value.probabilityStrata.some((row) => row.inverseRate > 1 && row.observedSampleCount > 0)) {
    ctx.addIssue({ code: "custom", message: "Sampled contributions cannot be observed counts", path: ["kind"] });
  }
  if ((value.kind === "unavailable" || value.coverage === "unknown") && value.reason == null) {
    ctx.addIssue({ code: "custom", message: "Unavailable/unknown measurements require a reason", path: ["reason"] });
  }
  if (value.reason != null && value.standardError != null) {
    ctx.addIssue({ code: "custom", message: "Uncertain measurements cannot claim precision", path: ["standardError"] });
  }
});
export type AttributionMeasurement = z.output<typeof AttributionMeasurementSchema>;

const splitMeasurement = z.object({
  siteRequests: AttributionMeasurementSchema,
  externalRequests: AttributionMeasurementSchema,
  totalRequests: AttributionMeasurementSchema,
  siteSharePct: AttributionMeasurementSchema,
  externalSharePct: AttributionMeasurementSchema,
});
const ApiRequestAttributionSplitSchema = z.object({
  siteRequests: z.number(), externalRequests: z.number(), totalRequests: z.number(),
  siteSharePct: z.number().describe("Percentage points; estimated when either input is sampled"),
  externalSharePct: z.number(),
  measurement: splitMeasurement,
});
export type ApiRequestAttributionSplit = z.output<typeof ApiRequestAttributionSplitSchema>;
const ApiRequestAttributionRouteStatSchema = ApiRequestAttributionSplitSchema.extend({ routeKey: z.string(), routePath: z.string() });
const ApiRequestAttributionTimeBucketSchema = ApiRequestAttributionSplitSchema.extend({ bucketStart: z.number() });
const ApiRequestAttributionLaneStatSchema = ApiRequestAttributionSplitSchema.extend({ lane: z.enum(["public-api", "site-api"]) });
export type ApiRequestAttributionLaneStat = z.output<typeof ApiRequestAttributionLaneStatSchema>;
export type ApiRequestWorkerLane = ApiRequestAttributionLaneStat["lane"];

const ApiRequestAttributionSiteDeliverySchema = z.object({
  totalSiteRequests: z.number(), pagesCacheHits: z.number(), pagesUpstreamFetches: z.number(),
  pagesUpstreamTimeouts: z.number(), pagesUpstreamErrors: z.number(), publicApiSiteRequests: z.number(),
  measurement: z.object({
    totalSiteRequests: AttributionMeasurementSchema, pagesCacheHits: AttributionMeasurementSchema,
    pagesUpstreamFetches: AttributionMeasurementSchema, pagesUpstreamTimeouts: AttributionMeasurementSchema,
    pagesUpstreamErrors: AttributionMeasurementSchema, publicApiSiteRequests: AttributionMeasurementSchema,
  }),
});
const ApiRequestAttributionKeyedPublicApiSummarySchema = z.object({
  keyedRequests: z.number(), unkeyedRequests: z.number().nullable(), totalRequests: z.number().nullable(),
  keyedSharePct: z.number().nullable(), unkeyedSharePct: z.number().nullable(),
  totalKeys: z.number(), returnedKeys: z.number(), omittedKeys: z.number(), omittedRequests: z.number(), truncated: z.boolean(),
  measurement: z.object({
    keyedRequests: AttributionMeasurementSchema, unkeyedRequests: AttributionMeasurementSchema,
    totalRequests: AttributionMeasurementSchema, keyedSharePct: AttributionMeasurementSchema,
    unkeyedSharePct: AttributionMeasurementSchema,
  }),
});
const ApiRequestAttributionApiKeyStatSchema = z.object({
  apiKeyId: z.number(), name: z.string(), maskedToken: z.string(), trafficClass: ApiKeyTrafficClassSchema,
  isActive: z.boolean(), expiresAt: z.number().nullable(), rateLimitPerMinute: z.number(), requestCount: z.number(),
  shareOfKeyedRequestsPct: z.number(), shareOfTotalPublicApiRequestsPct: z.number().nullable(),
  measurement: z.object({
    requestCount: AttributionMeasurementSchema, shareOfKeyedRequestsPct: AttributionMeasurementSchema,
    shareOfTotalPublicApiRequestsPct: AttributionMeasurementSchema,
  }),
});
export type ApiRequestAttributionApiKeyStat = z.output<typeof ApiRequestAttributionApiKeyStatSchema>;
export type ApiRequestConsumerClass = ApiRequestAttributionApiKeyStat["trafficClass"];

export const ApiRequestAttributionResponseSchema = z.object({
  measurementVersion: z.literal(REQUEST_SOURCE_MEASUREMENT_VERSION),
  policyId: z.literal(REQUEST_SOURCE_POLICY_ID),
  generatedAt: z.number(),
  window: z.object({
    from: z.number(), to: z.number(), durationSec: z.number(), bucketSizeSec: z.number(),
    routeLimit: z.number(), apiKeyLimit: z.number(), retentionDays: z.number(),
  }),
  totals: ApiRequestAttributionSplitSchema,
  siteDelivery: ApiRequestAttributionSiteDeliverySchema,
  lanes: z.array(ApiRequestAttributionLaneStatSchema), routes: z.array(ApiRequestAttributionRouteStatSchema),
  buckets: z.array(ApiRequestAttributionTimeBucketSchema), keyedPublicApi: ApiRequestAttributionKeyedPublicApiSummarySchema,
  apiKeys: z.array(ApiRequestAttributionApiKeyStatSchema),
  scope: z.object({ countsTotalSiteDemand: z.boolean(), countsWorkerLoad: z.boolean(), includesPagesProxyCacheHits: z.boolean() }),
});
export type ApiRequestAttributionResponse = z.output<typeof ApiRequestAttributionResponseSchema>;

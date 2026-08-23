import { z } from "zod";
import { ApiKeyTrafficClassSchema } from "./api-keys";

export type SiteDataRequestDeliveryPath =
  | "pages-cache-hit"
  | "pages-upstream-fetch"
  | "pages-upstream-timeout"
  | "pages-upstream-error";

export type SiteDataRequestUpstreamLane = "" | "site-api" | "public-api-fallback";

const ApiRequestAttributionSplitSchema = z.object({
  siteRequests: z.number(),
  externalRequests: z.number(),
  totalRequests: z.number(),
  siteSharePct: z.number(),
  externalSharePct: z.number(),
});
export type ApiRequestAttributionSplit = z.output<typeof ApiRequestAttributionSplitSchema>;

const ApiRequestAttributionRouteStatSchema = ApiRequestAttributionSplitSchema.extend({
  routeKey: z.string(),
  routePath: z.string(),
});
export type ApiRequestAttributionRouteStat = z.output<typeof ApiRequestAttributionRouteStatSchema>;

const ApiRequestAttributionTimeBucketSchema = ApiRequestAttributionSplitSchema.extend({
  bucketStart: z.number(),
});
export type ApiRequestAttributionTimeBucket = z.output<typeof ApiRequestAttributionTimeBucketSchema>;

const ApiRequestAttributionLaneStatSchema = ApiRequestAttributionSplitSchema.extend({
  lane: z.enum(["public-api", "site-api"]),
});
export type ApiRequestAttributionLaneStat = z.output<typeof ApiRequestAttributionLaneStatSchema>;
export type ApiRequestWorkerLane = ApiRequestAttributionLaneStat["lane"];

const ApiRequestAttributionSiteDeliverySchema = z.object({
  totalSiteRequests: z.number(),
  pagesCacheHits: z.number(),
  pagesUpstreamFetches: z.number(),
  pagesUpstreamTimeouts: z.number(),
  pagesUpstreamErrors: z.number(),
  publicApiSiteRequests: z.number(),
});
export type ApiRequestAttributionSiteDelivery = z.output<typeof ApiRequestAttributionSiteDeliverySchema>;

const ApiRequestAttributionScopeSchema = z.object({
  countsTotalSiteDemand: z.boolean(),
  countsWorkerLoad: z.boolean(),
  includesPagesProxyCacheHits: z.boolean(),
});
export type ApiRequestAttributionScope = z.output<typeof ApiRequestAttributionScopeSchema>;

const ApiRequestAttributionKeyedPublicApiSummarySchema = z.object({
  keyedRequests: z.number(),
  unkeyedRequests: z.number(),
  totalRequests: z.number(),
  keyedSharePct: z.number(),
  unkeyedSharePct: z.number(),
  totalKeys: z.number(),
  returnedKeys: z.number(),
  omittedKeys: z.number(),
  omittedRequests: z.number(),
  truncated: z.boolean(),
});
export type ApiRequestAttributionKeyedPublicApiSummary = z.output<
  typeof ApiRequestAttributionKeyedPublicApiSummarySchema
>;

const ApiRequestAttributionApiKeyStatSchema = z.object({
  apiKeyId: z.number(),
  name: z.string(),
  maskedToken: z.string(),
  trafficClass: ApiKeyTrafficClassSchema,
  isActive: z.boolean(),
  expiresAt: z.number().nullable(),
  rateLimitPerMinute: z.number(),
  requestCount: z.number(),
  shareOfKeyedRequestsPct: z.number(),
  shareOfTotalPublicApiRequestsPct: z.number(),
});
export type ApiRequestAttributionApiKeyStat = z.output<typeof ApiRequestAttributionApiKeyStatSchema>;
export type ApiRequestConsumerClass = ApiRequestAttributionApiKeyStat["trafficClass"];

export const ApiRequestAttributionResponseSchema = z.object({
  generatedAt: z.number(),
  window: z.object({
    from: z.number(),
    to: z.number(),
    durationSec: z.number(),
    bucketSizeSec: z.number(),
    routeLimit: z.number(),
    apiKeyLimit: z.number(),
    retentionDays: z.number(),
  }),
  totals: ApiRequestAttributionSplitSchema,
  siteDelivery: ApiRequestAttributionSiteDeliverySchema,
  lanes: z.array(ApiRequestAttributionLaneStatSchema),
  routes: z.array(ApiRequestAttributionRouteStatSchema),
  buckets: z.array(ApiRequestAttributionTimeBucketSchema),
  keyedPublicApi: ApiRequestAttributionKeyedPublicApiSummarySchema,
  apiKeys: z.array(ApiRequestAttributionApiKeyStatSchema),
  scope: ApiRequestAttributionScopeSchema,
});
export type ApiRequestAttributionResponse = z.output<typeof ApiRequestAttributionResponseSchema>;

import { z } from "zod";
import { ApiKeyTrafficClassSchema, type ApiKeyTrafficClass } from "./api-keys";

export type ApiRequestConsumerClass = "site" | "external";

export type ApiRequestWorkerLane = "public-api" | "site-api";

export type SiteDataRequestDeliveryPath =
  | "pages-cache-hit"
  | "pages-upstream-fetch"
  | "pages-upstream-timeout"
  | "pages-upstream-error";

export type SiteDataRequestUpstreamLane = "" | "site-api" | "public-api-fallback";

export interface ApiRequestAttributionSplit {
  siteRequests: number;
  externalRequests: number;
  totalRequests: number;
  siteSharePct: number;
  externalSharePct: number;
}

export interface ApiRequestAttributionRouteStat extends ApiRequestAttributionSplit {
  routeKey: string;
  routePath: string;
}

export interface ApiRequestAttributionTimeBucket extends ApiRequestAttributionSplit {
  bucketStart: number;
}

export interface ApiRequestAttributionLaneStat extends ApiRequestAttributionSplit {
  lane: ApiRequestWorkerLane;
}

export interface ApiRequestAttributionSiteDelivery {
  totalSiteRequests: number;
  pagesCacheHits: number;
  pagesUpstreamFetches: number;
  pagesUpstreamTimeouts: number;
  pagesUpstreamErrors: number;
  publicApiSiteRequests: number;
}

export interface ApiRequestAttributionScope {
  countsTotalSiteDemand: boolean;
  countsWorkerLoad: boolean;
  includesPagesProxyCacheHits: boolean;
}

export interface ApiRequestAttributionKeyedPublicApiSummary {
  keyedRequests: number;
  unkeyedRequests: number;
  totalRequests: number;
  keyedSharePct: number;
  unkeyedSharePct: number;
  totalKeys: number;
  returnedKeys: number;
  omittedKeys: number;
  omittedRequests: number;
  truncated: boolean;
}

export interface ApiRequestAttributionApiKeyStat {
  apiKeyId: number;
  name: string;
  maskedToken: string;
  trafficClass: ApiKeyTrafficClass;
  isActive: boolean;
  expiresAt: number | null;
  rateLimitPerMinute: number;
  requestCount: number;
  shareOfKeyedRequestsPct: number;
  shareOfTotalPublicApiRequestsPct: number;
}

export interface ApiRequestAttributionResponse {
  generatedAt: number;
  window: {
    from: number;
    to: number;
    durationSec: number;
    bucketSizeSec: number;
    routeLimit: number;
    apiKeyLimit: number;
    retentionDays: number;
  };
  totals: ApiRequestAttributionSplit;
  siteDelivery: ApiRequestAttributionSiteDelivery;
  lanes: ApiRequestAttributionLaneStat[];
  routes: ApiRequestAttributionRouteStat[];
  buckets: ApiRequestAttributionTimeBucket[];
  keyedPublicApi: ApiRequestAttributionKeyedPublicApiSummary;
  apiKeys: ApiRequestAttributionApiKeyStat[];
  scope: ApiRequestAttributionScope;
}

const ApiRequestAttributionSplitSchema = z.object({
  siteRequests: z.number(),
  externalRequests: z.number(),
  totalRequests: z.number(),
  siteSharePct: z.number(),
  externalSharePct: z.number(),
});

const ApiRequestAttributionRouteStatSchema = ApiRequestAttributionSplitSchema.extend({
  routeKey: z.string(),
  routePath: z.string(),
});

const ApiRequestAttributionTimeBucketSchema = ApiRequestAttributionSplitSchema.extend({
  bucketStart: z.number(),
});

const ApiRequestAttributionLaneStatSchema = ApiRequestAttributionSplitSchema.extend({
  lane: z.enum(["public-api", "site-api"]),
});

const ApiRequestAttributionSiteDeliverySchema = z.object({
  totalSiteRequests: z.number(),
  pagesCacheHits: z.number(),
  pagesUpstreamFetches: z.number(),
  pagesUpstreamTimeouts: z.number(),
  pagesUpstreamErrors: z.number(),
  publicApiSiteRequests: z.number(),
});

const ApiRequestAttributionScopeSchema = z.object({
  countsTotalSiteDemand: z.boolean(),
  countsWorkerLoad: z.boolean(),
  includesPagesProxyCacheHits: z.boolean(),
});

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

export const ApiRequestAttributionResponseSchema: z.ZodType<ApiRequestAttributionResponse> = z.object({
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

export type PublicApiRequestSource = ApiRequestConsumerClass;
export type PublicApiRequestSourceSplit = ApiRequestAttributionSplit;
export type PublicApiRequestSourceRouteStat = ApiRequestAttributionRouteStat;
export type PublicApiRequestSourceTimeBucket = ApiRequestAttributionTimeBucket;
export type PublicApiRequestSourceStatsResponse = ApiRequestAttributionResponse;

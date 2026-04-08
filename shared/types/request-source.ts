import type { ApiKeyTrafficClass } from "./api-keys";

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

export type PublicApiRequestSource = ApiRequestConsumerClass;
export type PublicApiRequestSourceSplit = ApiRequestAttributionSplit;
export type PublicApiRequestSourceRouteStat = ApiRequestAttributionRouteStat;
export type PublicApiRequestSourceTimeBucket = ApiRequestAttributionTimeBucket;
export type PublicApiRequestSourceStatsResponse = ApiRequestAttributionResponse;

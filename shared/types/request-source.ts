export type PublicApiRequestSource = "web" | "external";

export interface PublicApiRequestSourceSplit {
  webRequests: number;
  externalRequests: number;
  totalRequests: number;
  webSharePct: number;
  externalSharePct: number;
}

export interface PublicApiRequestSourceRouteStat extends PublicApiRequestSourceSplit {
  routeKey: string;
  routePath: string;
}

export interface PublicApiRequestSourceTimeBucket extends PublicApiRequestSourceSplit {
  bucketStart: number;
}

export interface PublicApiRequestSourceStatsResponse {
  generatedAt: number;
  window: {
    from: number;
    to: number;
    durationSec: number;
    bucketSizeSec: number;
    routeLimit: number;
    retentionDays: number;
  };
  totals: PublicApiRequestSourceSplit;
  routes: PublicApiRequestSourceRouteStat[];
  buckets: PublicApiRequestSourceTimeBucket[];
}

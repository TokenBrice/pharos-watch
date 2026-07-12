import { API_PATHS } from "./api-endpoints/paths";
import { CRON_INTERVALS } from "./cron-jobs";
import { STABLECOINS_QUERY_KEY } from "./query-keys";
import type { DependencyCriticality } from "../types/status";

export type DataSurfaceDescriptorKey =
  "stablecoins" | "dexLiquidity" | "yieldRankings" | "yieldHistory" | "stressSignals" | "reportCards" | "publicHealth";

export type YieldHistoryMode = "best" | "source";

export interface DataSurfaceDescriptor {
  key: DataSurfaceDescriptorKey;
  apiPath?: string;
  summaryApiPath?: string;
  buildApiPath?: (stablecoinId: string, days?: number, mode?: YieldHistoryMode, sourceKey?: string | null) => string;
  queryKey?: readonly unknown[];
  summaryQueryKey?: readonly unknown[];
  buildQueryKey?: (
    stablecoinId: string,
    days: number,
    mode: YieldHistoryMode,
    sourceKey?: string | null,
  ) => readonly unknown[];
  cacheKey?: string;
  producerJob?: string;
  producerIntervalSec?: number;
  endpointMaxAgeSec?: number;
  availabilityMaxAgeSec?: number;
  freshnessSentinelKey?: string;
  dependencyCriticality?: DependencyCriticality;
  uiLabel?: string;
  pharosVilleSchemaKey?: string;
  apiFreshnessKey?: string;
  cacheFreshnessLaneKey?: string;
  dataDependencyId?: string;
  frontendQueryBaseKey?: string;
  dataHealthPresetKey?: string;
}

export const DATA_SURFACE_DESCRIPTORS = {
  stablecoins: {
    key: "stablecoins",
    apiPath: API_PATHS.stablecoins(),
    queryKey: STABLECOINS_QUERY_KEY,
    cacheKey: "stablecoins",
    producerJob: "sync-stablecoins",
    producerIntervalSec: CRON_INTERVALS["sync-stablecoins"],
    endpointMaxAgeSec: 600,
    availabilityMaxAgeSec: 600,
    dependencyCriticality: "critical",
    uiLabel: "Prices",
    pharosVilleSchemaKey: "stablecoins",
    apiFreshnessKey: "stablecoins",
    cacheFreshnessLaneKey: "stablecoins",
    dataDependencyId: "stablecoins",
    frontendQueryBaseKey: "stablecoins",
    dataHealthPresetKey: "stablecoins",
  },
  dexLiquidity: {
    key: "dexLiquidity",
    apiPath: API_PATHS.dexLiquidity(),
    queryKey: ["dex-liquidity"],
    cacheKey: "dex-liquidity",
    producerJob: "sync-dex-liquidity",
    producerIntervalSec: CRON_INTERVALS["sync-dex-liquidity"],
    endpointMaxAgeSec: 3600,
    availabilityMaxAgeSec: 12 * 3600,
    freshnessSentinelKey: "freshness:dex-liquidity",
    dependencyCriticality: "critical",
    uiLabel: "Liquidity",
    apiFreshnessKey: "dexLiquidity",
    cacheFreshnessLaneKey: "dexLiquidity",
    dataDependencyId: "dex-liquidity",
    frontendQueryBaseKey: "dexLiquidity",
    dataHealthPresetKey: "dexLiquidity",
  },
  yieldRankings: {
    key: "yieldRankings",
    apiPath: API_PATHS.yieldRankings(),
    queryKey: ["yield-rankings"],
    summaryApiPath: API_PATHS.yieldRankingsSummary(),
    summaryQueryKey: ["yield-rankings", "summary"],
    cacheKey: "yield-data",
    producerJob: "sync-yield-data",
    producerIntervalSec: CRON_INTERVALS["sync-yield-data"],
    endpointMaxAgeSec: CRON_INTERVALS["sync-yield-data"],
    availabilityMaxAgeSec: CRON_INTERVALS["sync-yield-data"],
    freshnessSentinelKey: "freshness:yield-data",
    dependencyCriticality: "critical",
    uiLabel: "Yield Rankings",
    apiFreshnessKey: "yieldRankings",
    cacheFreshnessLaneKey: "yieldData",
    dataDependencyId: "yield-rankings",
    frontendQueryBaseKey: "yieldRankings",
    dataHealthPresetKey: "yieldRankings",
  },
  yieldHistory: {
    key: "yieldHistory",
    buildApiPath: (stablecoinId, days = 90, mode, sourceKey) =>
      API_PATHS.yieldHistory(stablecoinId, days, mode, sourceKey ?? undefined),
    buildQueryKey: (stablecoinId, days, mode, sourceKey) => [
      "yield-history",
      stablecoinId,
      days,
      mode,
      sourceKey ?? null,
    ],
    cacheKey: "yield-data",
    producerJob: "sync-yield-data",
    producerIntervalSec: CRON_INTERVALS["sync-yield-data"],
    endpointMaxAgeSec: CRON_INTERVALS["sync-yield-data"],
    availabilityMaxAgeSec: CRON_INTERVALS["sync-yield-data"],
    freshnessSentinelKey: "freshness:yield-data",
    dependencyCriticality: "critical",
    apiFreshnessKey: "yieldHistory",
    cacheFreshnessLaneKey: "yieldData",
    dataDependencyId: "yield-rankings",
    frontendQueryBaseKey: "yieldHistory",
  },
  stressSignals: {
    key: "stressSignals",
    apiPath: API_PATHS.stressSignals(),
    queryKey: ["stress-signals"],
    cacheKey: "dews",
    producerJob: "compute-dews",
    producerIntervalSec: CRON_INTERVALS["compute-dews"],
    endpointMaxAgeSec: CRON_INTERVALS["compute-dews"],
    availabilityMaxAgeSec: CRON_INTERVALS["compute-dews"],
    freshnessSentinelKey: "freshness:dews",
    dependencyCriticality: "critical",
    uiLabel: "DEWS",
    pharosVilleSchemaKey: "stress",
    apiFreshnessKey: "stressSignals",
    cacheFreshnessLaneKey: "dews",
    dataDependencyId: "dews",
    frontendQueryBaseKey: "stressSignals",
    dataHealthPresetKey: "stressSignals",
  },
  reportCards: {
    key: "reportCards",
    apiPath: API_PATHS.reportCards(),
    queryKey: ["report-cards"],
    producerJob: "publish-report-card-cache",
    producerIntervalSec: CRON_INTERVALS["publish-report-card-cache"],
    endpointMaxAgeSec: 900,
    dependencyCriticality: "critical",
    uiLabel: "Report Cards",
    pharosVilleSchemaKey: "reportCards",
    apiFreshnessKey: "reportCards",
    dataDependencyId: "report-card-cache",
    frontendQueryBaseKey: "reportCards",
    dataHealthPresetKey: "reportCards",
  },
  publicHealth: {
    key: "publicHealth",
    apiPath: API_PATHS.health(),
    queryKey: ["health"],
    producerIntervalSec: 60,
    frontendQueryBaseKey: "health",
  },
} as const satisfies Record<DataSurfaceDescriptorKey, DataSurfaceDescriptor>;

export const DATA_SURFACE_DESCRIPTOR_LIST = Object.values(DATA_SURFACE_DESCRIPTORS);

import { API_PATHS } from "./api-endpoints/paths";
import { CRON_INTERVALS } from "./cron-jobs";
import { STABLECOINS_QUERY_KEY } from "./query-keys";
import { DAY_SECONDS } from "./time-constants";
import type { DependencyCriticality } from "../types/status";

/**
 * Cache freshness lanes — the single source for a cached surface's producer
 * cadence and its endpoint/availability freshness budgets.
 *
 * They live beside the data-surface descriptors (rather than in
 * `api-freshness.ts`, which re-exports them for compatibility) so the
 * descriptors below can spread the lane fields without an import cycle:
 * `api-freshness.ts` reads the descriptors, and the descriptors read the lanes.
 * Not every lane has a descriptor — charts, FX, USDS status and Bluechip are
 * cached surfaces with no frontend data-surface entry.
 */
export interface CacheFreshnessLaneConfig {
  cacheKey: string;
  producerJob: string;
  producerIntervalSec: number;
  endpointMaxAgeSec: number;
  availabilityMaxAgeSec: number;
  endpointBudgetReason: string;
  availabilityBudgetReason: string;
  freshnessSentinelKey?: string;
}

export const CACHE_FRESHNESS_LANES = {
  stablecoins: {
    cacheKey: "stablecoins",
    producerJob: "sync-stablecoins",
    producerIntervalSec: CRON_INTERVALS["sync-stablecoins"],
    endpointMaxAgeSec: 600,
    availabilityMaxAgeSec: 600,
    endpointBudgetReason: "Stricter public freshness budget for the core market snapshot.",
    availabilityBudgetReason: "Matches the core market endpoint budget used by public health.",
  },
  stablecoinCharts: {
    cacheKey: "stablecoin-charts",
    producerJob: "sync-stablecoin-charts",
    producerIntervalSec: CRON_INTERVALS["sync-stablecoin-charts"],
    endpointMaxAgeSec: 3600,
    availabilityMaxAgeSec: 3600,
    endpointBudgetReason: "Chart writes are cooldown-gated to at most once per hour.",
    availabilityBudgetReason: "Matches the hourly chart write cooldown.",
  },
  usdsStatus: {
    cacheKey: "usds-status",
    producerJob: "sync-usds-status",
    producerIntervalSec: CRON_INTERVALS["sync-usds-status"],
    endpointMaxAgeSec: DAY_SECONDS,
    availabilityMaxAgeSec: DAY_SECONDS,
    endpointBudgetReason: "USDS protocol status is refreshed daily.",
    availabilityBudgetReason: "Matches the daily USDS status writer cadence.",
  },
  fxRates: {
    cacheKey: "fx-rates",
    producerJob: "sync-fx-rates",
    producerIntervalSec: CRON_INTERVALS["sync-fx-rates"],
    endpointMaxAgeSec: CRON_INTERVALS["sync-fx-rates"],
    availabilityMaxAgeSec: CRON_INTERVALS["sync-fx-rates"],
    endpointBudgetReason: "FX writes are internally cooldown-gated to 30 minutes.",
    availabilityBudgetReason: "Matches the 30-minute usable FX publication cadence.",
  },
  bluechipRatings: {
    cacheKey: "bluechip-ratings",
    producerJob: "sync-bluechip",
    producerIntervalSec: CRON_INTERVALS["sync-bluechip"],
    endpointMaxAgeSec: 12 * 3600,
    availabilityMaxAgeSec: DAY_SECONDS,
    endpointBudgetReason: "Public Bluechip reads use a stricter advisory budget than the daily writer.",
    availabilityBudgetReason: "Availability follows the daily Bluechip producer cadence.",
  },
  dexLiquidity: {
    cacheKey: "dex-liquidity",
    producerJob: "sync-dex-liquidity",
    producerIntervalSec: CRON_INTERVALS["sync-dex-liquidity"],
    endpointMaxAgeSec: 4 * 3600,
    availabilityMaxAgeSec: 12 * 3600,
    endpointBudgetReason: "DEX liquidity endpoints warn after one missed two-hour scoring runway.",
    availabilityBudgetReason: "Public health keeps a slower availability runway for the last successful liquidity dataset.",
    freshnessSentinelKey: "freshness:dex-liquidity",
  },
  yieldData: {
    cacheKey: "yield-data",
    producerJob: "sync-yield-data",
    producerIntervalSec: CRON_INTERVALS["sync-yield-data"],
    endpointMaxAgeSec: CRON_INTERVALS["sync-yield-data"],
    availabilityMaxAgeSec: CRON_INTERVALS["sync-yield-data"],
    endpointBudgetReason: "Yield publication runs after each V9 publication slot.",
    availabilityBudgetReason: "Matches the post-V9 yield publication cadence.",
    freshnessSentinelKey: "freshness:yield-data",
  },
  dews: {
    cacheKey: "dews",
    producerJob: "compute-dews",
    producerIntervalSec: CRON_INTERVALS["compute-dews"],
    endpointMaxAgeSec: CRON_INTERVALS["compute-dews"],
    availabilityMaxAgeSec: CRON_INTERVALS["compute-dews"],
    endpointBudgetReason: "DEWS compute runs every 30 minutes.",
    availabilityBudgetReason: "Matches the 30-minute DEWS compute cadence.",
    freshnessSentinelKey: "freshness:dews",
  },
} as const satisfies Record<string, CacheFreshnessLaneConfig>;

export type CacheFreshnessLaneKey = keyof typeof CACHE_FRESHNESS_LANES;

/**
 * The lane fields a data-surface descriptor mirrors. The two `*BudgetReason`
 * strings are lane documentation and are deliberately not carried onto the
 * descriptor, which is why this is a projection rather than a bare spread.
 */
export type SurfaceFreshnessLaneFields<K extends CacheFreshnessLaneKey> = Omit<
  (typeof CACHE_FRESHNESS_LANES)[K],
  "endpointBudgetReason" | "availabilityBudgetReason"
>;

export function surfaceFreshnessLaneFields<K extends CacheFreshnessLaneKey>(
  laneKey: K,
): SurfaceFreshnessLaneFields<K> {
  const { endpointBudgetReason: _endpointBudgetReason, availabilityBudgetReason: _availabilityBudgetReason, ...fields } =
    CACHE_FRESHNESS_LANES[laneKey];
  return fields;
}

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
    ...surfaceFreshnessLaneFields("stablecoins"),
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
    ...surfaceFreshnessLaneFields("dexLiquidity"),
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
    ...surfaceFreshnessLaneFields("yieldData"),
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
    ...surfaceFreshnessLaneFields("yieldData"),
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
    ...surfaceFreshnessLaneFields("dews"),
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
    apiPath: API_PATHS.reportCardsV9(),
    queryKey: ["report-cards", "v9"],
    producerJob: "compute-safety-score-v9",
    producerIntervalSec: CRON_INTERVALS["compute-safety-score-v9"],
    endpointMaxAgeSec: 900,
    dependencyCriticality: "critical",
    uiLabel: "Report Cards",
    pharosVilleSchemaKey: "reportCards",
    apiFreshnessKey: "reportCards",
    dataDependencyId: "safety-score-v9",
    frontendQueryBaseKey: "reportCardsV9",
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

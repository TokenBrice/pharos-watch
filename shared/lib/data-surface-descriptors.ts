import { API_PATHS } from "./api-endpoints/paths";
import { CRON_INTERVALS } from "./cron-jobs";
import { STABLECOINS_QUERY_KEY } from "./query-keys";
import { DAY_SECONDS } from "./time-constants";
import type { PublicStatusComponentId, DependencyCriticality } from "../types/status";

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
  bootstrapProbePath?: string;
  upstreamProvider: string;
  publicComponent: PublicStatusComponentId;
  publicImpactSummary: string;
  publicStatusOrder: number;
}

export const CACHE_FRESHNESS_LANES = {
  stablecoins: {
    cacheKey: "stablecoins",
    upstreamProvider: "DefiLlama",
    publicComponent: "stablecoin-data",
    publicImpactSummary: "Market caps, rankings and listings",
    publicStatusOrder: 0,
    producerJob: "sync-stablecoins",
    producerIntervalSec: CRON_INTERVALS["sync-stablecoins"],
    endpointMaxAgeSec: 600,
    availabilityMaxAgeSec: 600,
    endpointBudgetReason: "Stricter public freshness budget for the core market snapshot.",
    availabilityBudgetReason: "Matches the core market endpoint budget used by public health.",
  },
  stablecoinCharts: {
    cacheKey: "stablecoin-charts",
    upstreamProvider: "DefiLlama",
    publicComponent: "charts",
    publicImpactSummary: "Historical supply and price charts",
    publicStatusOrder: 3,
    producerJob: "sync-stablecoin-charts",
    producerIntervalSec: CRON_INTERVALS["sync-stablecoin-charts"],
    endpointMaxAgeSec: 3600,
    availabilityMaxAgeSec: 3600,
    endpointBudgetReason: "Chart writes are cooldown-gated to at most once per hour.",
    availabilityBudgetReason: "Matches the hourly chart write cooldown.",
  },
  usdsStatus: {
    bootstrapProbePath: API_PATHS.usdsStatus(),
    cacheKey: "usds-status",
    upstreamProvider: "Etherscan",
    publicComponent: "stablecoin-data",
    publicImpactSummary: "USDS status and reserve context",
    publicStatusOrder: 2,
    producerJob: "sync-usds-status",
    producerIntervalSec: CRON_INTERVALS["sync-usds-status"],
    endpointMaxAgeSec: DAY_SECONDS,
    availabilityMaxAgeSec: DAY_SECONDS,
    endpointBudgetReason: "USDS protocol status is refreshed daily.",
    availabilityBudgetReason: "Matches the daily USDS status writer cadence.",
  },
  fxRates: {
    cacheKey: "fx-rates",
    upstreamProvider: "Frankfurter",
    publicComponent: "stablecoin-data",
    publicImpactSummary: "Non-USD peg conversions",
    publicStatusOrder: 1,
    producerJob: "sync-fx-rates",
    producerIntervalSec: CRON_INTERVALS["sync-fx-rates"],
    endpointMaxAgeSec: CRON_INTERVALS["sync-fx-rates"],
    availabilityMaxAgeSec: CRON_INTERVALS["sync-fx-rates"],
    endpointBudgetReason: "FX writes are internally cooldown-gated to 30 minutes.",
    availabilityBudgetReason: "Matches the 30-minute usable FX publication cadence.",
  },
  bluechipRatings: {
    bootstrapProbePath: API_PATHS.bluechipRatings(),
    cacheKey: "bluechip-ratings",
    upstreamProvider: "Bluechip",
    publicComponent: "risk-signals",
    publicImpactSummary: "Third-party safety ratings",
    publicStatusOrder: 5,
    producerJob: "sync-bluechip",
    producerIntervalSec: CRON_INTERVALS["sync-bluechip"],
    endpointMaxAgeSec: 12 * 3600,
    availabilityMaxAgeSec: DAY_SECONDS,
    endpointBudgetReason: "Public Bluechip reads use a stricter advisory budget than the daily writer.",
    availabilityBudgetReason: "Availability follows the daily Bluechip producer cadence.",
  },
  dexLiquidity: {
    cacheKey: "dex-liquidity",
    upstreamProvider: "DefiLlama",
    publicComponent: "liquidity",
    publicImpactSummary: "DEX liquidity scores and pool data",
    publicStatusOrder: 6,
    producerJob: "sync-dex-liquidity",
    producerIntervalSec: CRON_INTERVALS["sync-dex-liquidity"],
    endpointMaxAgeSec: 4 * 3600,
    availabilityMaxAgeSec: 12 * 3600,
    endpointBudgetReason: "DEX liquidity endpoints retain their reviewed four-hour warning budget despite hourly publication.",
    availabilityBudgetReason: "Public health keeps a slower availability runway for the last successful liquidity dataset.",
    freshnessSentinelKey: "freshness:dex-liquidity",
  },
  yieldData: {
    bootstrapProbePath: API_PATHS.yieldRankings(),
    cacheKey: "yield-data",
    upstreamProvider: "DefiLlama",
    publicComponent: "yield",
    publicImpactSummary: "Yield rankings and yield history",
    publicStatusOrder: 7,
    producerJob: "sync-yield-data",
    producerIntervalSec: CRON_INTERVALS["sync-yield-data"],
    endpointMaxAgeSec: CRON_INTERVALS["sync-yield-data"],
    availabilityMaxAgeSec: CRON_INTERVALS["sync-yield-data"],
    endpointBudgetReason: "Yield publication runs every two hours, after the DEX source stage it reads.",
    availabilityBudgetReason: "Matches the two-hour yield publication cadence.",
    freshnessSentinelKey: "freshness:yield-data",
  },
  dews: {
    cacheKey: "dews",
    upstreamProvider: "Internal compute",
    publicComponent: "risk-signals",
    publicImpactSummary: "Depeg early-warning and stress signals",
    publicStatusOrder: 4,
    producerJob: "compute-dews",
    producerIntervalSec: CRON_INTERVALS["compute-dews"],
    endpointMaxAgeSec: CRON_INTERVALS["compute-dews"],
    availabilityMaxAgeSec: CRON_INTERVALS["compute-dews"],
    endpointBudgetReason: "DEWS compute runs every 30 minutes.",
    availabilityBudgetReason: "Matches the 30-minute DEWS compute cadence.",
    freshnessSentinelKey: "freshness:dews",
  },
} as const satisfies Record<string, CacheFreshnessLaneConfig>;

export const CACHE_UPSTREAM_PROVIDER: Record<string, string> = Object.fromEntries(
  Object.values(CACHE_FRESHNESS_LANES).map((lane) => [lane.cacheKey, lane.upstreamProvider]),
);

export type CacheFreshnessLaneKey = keyof typeof CACHE_FRESHNESS_LANES;

/**
 * The lane fields a data-surface descriptor mirrors. The two `*BudgetReason`
 * strings are lane documentation and are deliberately not carried onto the
 * descriptor, which is why this is a projection rather than a bare spread.
 */
type SurfaceFreshnessLaneFields<K extends CacheFreshnessLaneKey> = Omit<
  (typeof CACHE_FRESHNESS_LANES)[K],
  "endpointBudgetReason" | "availabilityBudgetReason" | "bootstrapProbePath" | "upstreamProvider" | "publicComponent" | "publicImpactSummary" | "publicStatusOrder"
>;

function surfaceFreshnessLaneFields<K extends CacheFreshnessLaneKey>(
  laneKey: K,
): SurfaceFreshnessLaneFields<K> {
  const { endpointBudgetReason: _endpointBudgetReason, availabilityBudgetReason: _availabilityBudgetReason, bootstrapProbePath: _bootstrapProbePath, upstreamProvider: _upstreamProvider, publicComponent: _publicComponent, publicImpactSummary: _publicImpactSummary, publicStatusOrder: _publicStatusOrder, ...fields } =
    CACHE_FRESHNESS_LANES[laneKey] as (typeof CACHE_FRESHNESS_LANES)[K] & { bootstrapProbePath?: string };
  return fields;
}

type DataSurfaceDescriptorKey =
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
    // 2x the publication cadence: the endpoint budget tolerates one missed
    // hourly publication, matching the V9 consumer fail-close basis
    // (worker/src/lib/safety-score-v9/consumer-freshness.ts).
    endpointMaxAgeSec: 2 * CRON_INTERVALS["compute-safety-score-v9"],
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
    // The status self-check publishes this projection on its own cadence.
    producerIntervalSec: CRON_INTERVALS["status-self-check"],
    frontendQueryBaseKey: "health",
  },
} as const satisfies Record<DataSurfaceDescriptorKey, DataSurfaceDescriptor>;

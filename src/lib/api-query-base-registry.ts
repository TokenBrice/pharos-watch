import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import {
  CRON_1H,
  CRON_1MIN,
  CRON_15MIN,
  CRON_24H,
  CRON_30MIN,
  CRON_BLACKLIST,
  CRON_MINT_BURN,
  CRON_RESERVE_SYNC,
  CRON_TELEGRAM_PULSE,
  CRON_YIELD,
} from "@/lib/cron-intervals";

export interface FrontendApiQueryBaseDescriptor {
  queryKey: readonly unknown[];
  path: string;
  producerIntervalMs: number;
  metaMaxAgeSec?: number;
}

export interface FrontendStaticApiQueryBaseDescriptor {
  queryKey: readonly unknown[];
  path: string;
}

export interface NonUsdSharePoint {
  date: number;
  commodityShare: number | null;
  fiatNonUsdShare: number | null;
  commodity: number | null;
  fiatNonUsd: number | null;
  total: number;
}

type YieldHistoryMode = "best" | "source";
type BlacklistEventsDescriptorInput = Pick<FrontendApiQueryBaseDescriptor, "queryKey" | "path">;

export interface MintBurnEventsDescriptorOptions {
  direction?: string;
  burnType?: "effective_burn" | "bridge_burn" | "review_required";
  scope?: "all" | "counted";
  limit?: number;
  offset?: number;
}

const YIELD_META_MAX_AGE_SEC = CRON_YIELD / 1000;

export const FRONTEND_API_QUERY_BASE_REGISTRY = {
  stablecoins: {
    queryKey: ["stablecoins"],
    path: API_PATHS.stablecoins(),
    producerIntervalMs: CRON_15MIN,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.stablecoins,
  },
  chains: {
    queryKey: ["chains"],
    path: API_PATHS.chains(),
    producerIntervalMs: CRON_15MIN,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.chains,
  },
  bluechipRatings: {
    queryKey: ["bluechip-ratings"],
    path: API_PATHS.bluechipRatings(),
    producerIntervalMs: CRON_24H,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.bluechip,
  },
  dailyDigest: {
    queryKey: ["daily-digest"],
    path: API_PATHS.dailyDigest(),
    producerIntervalMs: CRON_24H,
  },
  dexLiquidity: {
    queryKey: ["dex-liquidity"],
    path: API_PATHS.dexLiquidity(),
    producerIntervalMs: CRON_30MIN,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.dexLiquidity,
  },
  dexLiquidityHistory: (stablecoinId: string, days = 90) =>
    ({
      queryKey: ["dex-liquidity-history", stablecoinId, days],
      path: API_PATHS.dexLiquidityHistory(stablecoinId, days),
      producerIntervalMs: CRON_24H,
    }),
  digestArchive: {
    queryKey: ["digest-archive"],
    path: API_PATHS.digestArchive(),
    producerIntervalMs: CRON_24H,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.digestArchive,
  },
  digestSnapshot: (date: string) =>
    ({
      queryKey: ["digest-snapshot", date],
      path: API_PATHS.digestSnapshot(date),
    }),
  health: {
    queryKey: ["health"],
    path: API_PATHS.health(),
    producerIntervalMs: CRON_1MIN,
  },
  blacklistSummary: {
    queryKey: ["blacklist-summary"],
    path: API_PATHS.blacklistSummary(),
    producerIntervalMs: CRON_BLACKLIST,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.blacklistSummary,
  },
  blacklistEvents: ({ queryKey, path }: BlacklistEventsDescriptorInput) =>
    ({
      queryKey,
      path,
      producerIntervalMs: CRON_BLACKLIST,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.blacklist,
    }),
  mintBurnFlows: (hours = 24) =>
    ({
      queryKey: ["mint-burn-flows", "all", hours],
      path: API_PATHS.mintBurnFlows(hours !== 24 ? { hours } : undefined),
      producerIntervalMs: CRON_MINT_BURN,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.mintBurnFlows,
    }),
  mintBurnFlowsCoin: (stablecoinId: string, hours = 24) =>
    ({
      queryKey: ["mint-burn-flows", stablecoinId, hours],
      path: API_PATHS.mintBurnFlows({ stablecoin: stablecoinId, hours: hours !== 24 ? hours : undefined }),
      producerIntervalMs: CRON_MINT_BURN,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.mintBurnFlows,
    }),
  mintBurnEvents: (stablecoinId: string, opts?: MintBurnEventsDescriptorOptions) => {
    const params = new URLSearchParams({ stablecoin: stablecoinId });
    if (opts?.direction) params.set("direction", opts.direction);
    if (opts?.burnType) params.set("burnType", opts.burnType);
    if (opts?.scope && opts.scope !== "all") params.set("scope", opts.scope);
    if (opts?.limit) params.set("limit", opts.limit.toString());
    if (opts?.offset) params.set("offset", opts.offset.toString());

    return {
      queryKey: [
        "mint-burn-events",
        stablecoinId,
        opts?.scope ?? "all",
        opts?.direction ?? "all",
        opts?.burnType ?? "all",
        opts?.limit ?? 50,
        opts?.offset ?? 0,
      ],
      path: API_PATHS.mintBurnEvents(Object.fromEntries(params.entries())),
      producerIntervalMs: CRON_MINT_BURN,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.mintBurnEvents,
    };
  },
  pegSummary: {
    queryKey: ["peg-summary"],
    path: API_PATHS.pegSummary(),
    producerIntervalMs: CRON_15MIN,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.pegSummary,
  },
  reportCards: {
    queryKey: ["report-cards"],
    path: API_PATHS.reportCards(),
    producerIntervalMs: CRON_15MIN,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.reportCards,
  },
  depegResolver: {
    queryKey: ["depeg-resolver"],
    path: API_PATHS.depegResolver(),
    producerIntervalMs: CRON_15MIN,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.depegResolver,
  },
  depegResolverReview: {
    queryKey: ["depeg-resolver-review"],
    path: API_PATHS.depegResolverReview(),
    producerIntervalMs: CRON_15MIN,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.depegResolverReview,
  },
  redemptionBackstops: {
    queryKey: ["redemption-backstops"],
    path: API_PATHS.redemptionBackstops(),
    producerIntervalMs: CRON_RESERVE_SYNC,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.redemptionBackstops,
  },
  safetyScoreHistory: (stablecoinId: string, days = 3650) =>
    ({
      queryKey: ["safety-score-history", stablecoinId, days],
      path: API_PATHS.safetyScoreHistory(stablecoinId, days),
      producerIntervalMs: CRON_24H,
      metaMaxAgeSec: CRON_24H / 1000,
    }),
  stablecoinCharts: {
    queryKey: ["stablecoin-charts"],
    path: API_PATHS.stablecoinCharts(),
    producerIntervalMs: CRON_1H,
  },
  nonUsdShare: {
    queryKey: ["non-usd-share"],
    path: API_PATHS.nonUsdShare(),
    producerIntervalMs: CRON_24H,
  },
  stabilityIndex: {
    queryKey: ["stability-index"],
    path: API_PATHS.stabilityIndex(),
    producerIntervalMs: CRON_30MIN,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.stabilityIndex,
  },
  stabilityIndexDetail: {
    queryKey: ["stability-index-detail"],
    path: API_PATHS.stabilityIndex(true),
    producerIntervalMs: CRON_30MIN,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.stabilityIndex,
  },
  usdsStatus: {
    queryKey: ["usds-status"],
    path: API_PATHS.usdsStatus(),
    producerIntervalMs: CRON_15MIN,
  },
  telegramPulse: {
    queryKey: ["telegram-pulse"],
    path: API_PATHS.telegramPulse(),
    producerIntervalMs: CRON_TELEGRAM_PULSE,
  },
  yieldHistory: (stablecoinId: string, days: number, mode: YieldHistoryMode, sourceKey?: string | null) =>
    ({
      queryKey: ["yield-history", stablecoinId, days, mode, sourceKey ?? null],
      path: API_PATHS.yieldHistory(stablecoinId, days, mode, sourceKey ?? undefined),
      producerIntervalMs: CRON_YIELD,
      metaMaxAgeSec: YIELD_META_MAX_AGE_SEC,
    }),
  yieldRankings: {
    queryKey: ["yield-rankings"],
    path: API_PATHS.yieldRankings(),
    producerIntervalMs: CRON_YIELD,
    metaMaxAgeSec: YIELD_META_MAX_AGE_SEC,
  },
  yieldAdapterManifest: {
    queryKey: ["yield-adapter-manifest"],
    path: API_PATHS.yieldAdapterManifest(),
    producerIntervalMs: CRON_YIELD,
    metaMaxAgeSec: YIELD_META_MAX_AGE_SEC,
  },
  stressSignals: {
    queryKey: ["stress-signals"],
    path: API_PATHS.stressSignals(),
    producerIntervalMs: CRON_30MIN,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.stressSignals,
  },
  stressSignalDetail: (stablecoinId: string, days = 30) =>
    ({
      queryKey: ["stress-signals", stablecoinId, days],
      path: API_PATHS.stressSignals(stablecoinId, days),
      producerIntervalMs: CRON_30MIN,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.stressSignals,
    }),
  supplyHistory: (stablecoinId: string, days = 1825) =>
    ({
      queryKey: ["supply-history", stablecoinId, days],
      path: API_PATHS.supplyHistory(stablecoinId, days),
      producerIntervalMs: CRON_24H,
    }),
} as const;

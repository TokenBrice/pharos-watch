import { API_PATHS } from "./paths";

type EndpointMethod = "GET" | "POST";
export type EndpointProbeGroup = "public" | "admin" | "manual";
export type EndpointPublicApiAccess = "protected" | "exempt";
export type EndpointSiteDataAccess = "allowed" | "denied";
export type EndpointDependency =
  | "apiKeyHashPepper"
  | "alchemyApiKey"
  | "anthropicApiKey"
  | "cloudflareD1StatusConfig"
  | "chainRpcs"
  | "feedbackEnv"
  | "mintBurnFreshnessConfig"
  | "coingeckoApiKey"
  | "telegram";

interface EndpointStatusPageActionConfig {
  label: string;
  confirm: string;
  destructive?: boolean;
  method: EndpointMethod;
  path?: string;
  /** When true the action dialog offers an optional stablecoin ID input to target a single coin. */
  acceptsStablecoinFilter?: boolean;
}

export interface EndpointDefinition {
  key: string;
  path: string;
  methods: readonly EndpointMethod[];
  adminRequired: boolean;
  mutatingAdmin: boolean;
  cacheBypass: boolean;
  publicApiAccess: EndpointPublicApiAccess;
  siteDataAccess: EndpointSiteDataAccess;
  strictContract?: boolean;
  probeGroup?: EndpointProbeGroup;
  probePath?: string;
  statusPageAction?: EndpointStatusPageActionConfig;
  /** Worker-only dependency hydration hints consumed by the route registry/context builder. */
  routeDependencies?: readonly EndpointDependency[];
}

type BaseEndpointDefinition = Omit<EndpointDefinition, "publicApiAccess" | "siteDataAccess"> & {
  publicApiAccess?: EndpointPublicApiAccess;
  siteDataAccess?: EndpointSiteDataAccess;
};

export interface StatusPageAction {
  label: string;
  path: string;
  confirm: string;
  destructive: boolean;
  method: EndpointMethod;
  acceptsStablecoinFilter: boolean;
}

export interface EndpointMethodValidationError {
  message: string;
  allowedMethods: readonly EndpointMethod[];
}

export type DynamicAdminEndpointMatch =
  | {
    key: "discovery-candidate-dismiss";
    path: string;
    candidateId: number;
    methods: readonly EndpointMethod[];
  }
  | {
    key: "api-key-update" | "api-key-deactivate" | "api-key-rotate";
    path: string;
    apiKeyId: number;
    methods: readonly EndpointMethod[];
  };

const BASE_ENDPOINT_DEFINITIONS = [
  // Public endpoints probed by the status dashboard.
  {
    key: "stablecoins",
    path: API_PATHS.stablecoins(),
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    strictContract: true,
    probeGroup: "public",
  },
  {
    key: "stablecoin-detail-canary",
    path: API_PATHS.stablecoinDetail("usdt-tether"),
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    routeDependencies: ["coingeckoApiKey"],
    probeGroup: "public",
    // Probe a smaller detail canary than USDT to avoid oversized-history false negatives.
    probePath: API_PATHS.stablecoinDetail("pyusd-paypal"),
  },
  {
    key: "stablecoin-summary-canary",
    path: API_PATHS.stablecoinSummary("usdt-tether"),
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
  },
  {
    key: "stablecoin-reserves-canary",
    path: API_PATHS.stablecoinReserves("iusd-infinifi"),
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
  },
  {
    key: "stablecoin-charts",
    path: API_PATHS.stablecoinCharts(),
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
  },
  {
    key: "peg-summary",
    path: API_PATHS.pegSummary(),
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    strictContract: true,
    probeGroup: "public",
  },
  {
    key: "health",
    path: API_PATHS.health(),
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: true,
    publicApiAccess: "exempt",
    probeGroup: "public",
  },
  {
    key: "public-status-history",
    path: API_PATHS.publicStatusHistory(),
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
  },
  {
    key: "blacklist",
    path: API_PATHS.blacklist(),
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
  },
  {
    key: "blacklist-summary",
    path: API_PATHS.blacklistSummary(),
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
  },
  {
    key: "depeg-events",
    path: API_PATHS.depegEvents(),
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
  },
  {
    key: "usds-status",
    path: API_PATHS.usdsStatus(),
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
  },
  {
    key: "bluechip-ratings",
    path: API_PATHS.bluechipRatings(),
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
  },
  {
    key: "dex-liquidity",
    path: API_PATHS.dexLiquidity(),
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    strictContract: true,
    probeGroup: "public",
  },
  {
    key: "dex-liquidity-history",
    path: API_PATHS.dexLiquidityHistoryBase(),
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
    probePath: API_PATHS.dexLiquidityHistoryProbe("usdt-tether"),
  },
  {
    key: "supply-history",
    path: API_PATHS.supplyHistoryBase(),
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
    probePath: API_PATHS.supplyHistory("usdt-tether"),
  },
  {
    key: "daily-digest",
    path: API_PATHS.dailyDigest(),
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
  },
  {
    key: "digest-archive",
    path: API_PATHS.digestArchive(),
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
  },
  {
    key: "digest-snapshot",
    path: API_PATHS.digestSnapshotBase(),
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    // Requires a date-specific snapshot that is not stable enough for a generic canary probe.
  },
  {
    key: "yield-rankings",
    path: API_PATHS.yieldRankings(),
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
  },
  {
    key: "yield-history",
    path: API_PATHS.yieldHistoryBase(),
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
    probePath: API_PATHS.yieldHistoryProbe("usdt-tether"),
  },
  {
    key: "safety-score-history",
    path: API_PATHS.safetyScoreHistoryBase(),
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
    probePath: API_PATHS.safetyScoreHistoryProbe("usdt-tether"),
  },
  {
    key: "stability-index",
    path: API_PATHS.stabilityIndex(),
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    strictContract: true,
    probeGroup: "public",
  },
  {
    key: "report-cards",
    path: API_PATHS.reportCards(),
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    strictContract: true,
    probeGroup: "public",
  },
  {
    key: "redemption-backstops",
    path: API_PATHS.redemptionBackstops(),
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    strictContract: true,
    probeGroup: "public",
  },
  {
    key: "mint-burn-flows",
    path: API_PATHS.mintBurnFlowsBase(),
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    strictContract: true,
    probeGroup: "public",
  },
  {
    key: "mint-burn-events",
    path: API_PATHS.mintBurnEventsBase(),
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
    probePath: API_PATHS.mintBurnEvents({ stablecoin: "usdt-tether" }),
  },
  {
    key: "stress-signals",
    path: API_PATHS.stressSignalsBase(),
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    strictContract: true,
    probeGroup: "public",
  },
  {
    key: "chains",
    path: API_PATHS.chains(),
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
  },
  {
    key: "non-usd-share",
    path: API_PATHS.nonUsdShareBase(),
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
    probePath: API_PATHS.nonUsdShare(90),
  },
  {
    key: "telegram-pulse",
    path: API_PATHS.telegramPulse(),
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
  },
  {
    key: "feedback",
    path: API_PATHS.feedback(),
    methods: ["POST"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: true,
    publicApiAccess: "exempt",
    routeDependencies: ["feedbackEnv"],
  },
  {
    key: "telegram-webhook",
    path: API_PATHS.telegramWebhook(),
    methods: ["POST"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: true,
    publicApiAccess: "exempt",
    routeDependencies: ["telegram"],
  },

  // Admin status/probe endpoints.
  {
    key: "status",
    path: API_PATHS.status(),
    methods: ["GET"],
    adminRequired: true,
    mutatingAdmin: false,
    cacheBypass: true,
    routeDependencies: ["coingeckoApiKey", "cloudflareD1StatusConfig"],
    probeGroup: "admin",
  },
  {
    key: "status-history",
    path: API_PATHS.statusHistoryBase(),
    methods: ["GET"],
    adminRequired: true,
    mutatingAdmin: false,
    cacheBypass: true,
    probeGroup: "admin",
    probePath: API_PATHS.statusHistory({ limit: 10 }),
  },
  {
    key: "request-source-stats",
    path: API_PATHS.requestSourceStatsBase(),
    methods: ["GET"],
    adminRequired: true,
    mutatingAdmin: false,
    cacheBypass: true,
  },
  {
    key: "api-keys",
    path: API_PATHS.apiKeys(),
    methods: ["GET", "POST"],
    adminRequired: true,
    mutatingAdmin: false,
    cacheBypass: true,
    routeDependencies: ["apiKeyHashPepper"],
  },
  {
    key: "api-key-audit-log",
    path: API_PATHS.apiKeyAuditLog(),
    methods: ["GET"],
    adminRequired: true,
    mutatingAdmin: false,
    cacheBypass: true,
  },
  {
    key: "admin-action-log",
    path: API_PATHS.adminActionLog(),
    methods: ["GET"],
    adminRequired: true,
    mutatingAdmin: false,
    cacheBypass: true,
  },
  {
    key: "trigger-digest",
    path: API_PATHS.triggerDigest(),
    methods: ["POST"],
    adminRequired: true,
    mutatingAdmin: true,
    cacheBypass: false,
    routeDependencies: ["anthropicApiKey", "telegram"],
    probeGroup: "manual",
    statusPageAction: {
      label: "Trigger Digest",
      confirm: "Trigger daily digest? Bypasses 1h dedup window.",
      method: "POST",
    },
  },
  {
    key: "reset-blacklist-sync",
    path: API_PATHS.resetBlacklistSync(),
    methods: ["POST"],
    adminRequired: true,
    mutatingAdmin: true,
    cacheBypass: false,
    probeGroup: "manual",
    statusPageAction: {
      label: "Reset Blacklist Sync",
      confirm: "Reset blacklist sync? Rolls back EVM 50k blocks, Tron 7 days.",
      destructive: true,
      method: "POST",
    },
  },
  {
    key: "debug-sync-state",
    path: API_PATHS.debugSyncState(),
    methods: ["GET"],
    adminRequired: true,
    mutatingAdmin: false,
    cacheBypass: true,
    probeGroup: "admin",
    statusPageAction: {
      label: "Debug Sync State",
      confirm: "Fetch sync state debug dump?",
      method: "GET",
    },
  },
  {
    key: "remediate-blacklist-amount-gaps",
    path: API_PATHS.remediateBlacklistAmountGaps(),
    methods: ["POST"],
    adminRequired: true,
    mutatingAdmin: true,
    cacheBypass: true,
    routeDependencies: ["chainRpcs"],
    probeGroup: "manual",
    statusPageAction: {
      label: "Remediate Blacklist Gaps",
      confirm: "Run targeted blacklist amount-gap remediation? Prefer dry-run first.",
      method: "POST",
    },
  },
  {
    key: "backfill-blacklist-current-balances",
    path: API_PATHS.backfillBlacklistCurrentBalances(),
    methods: ["POST"],
    adminRequired: true,
    mutatingAdmin: true,
    cacheBypass: true,
    routeDependencies: ["chainRpcs"],
    probeGroup: "manual",
    statusPageAction: {
      label: "Backfill Blacklist Balances",
      confirm: "Backfill current-balance cache for coins missing balance rows? Prefer dry-run first (?dryRun=true).",
      method: "POST",
    },
  },
  {
    key: "backfill-depegs",
    path: API_PATHS.backfillDepegs(),
    methods: ["POST"],
    adminRequired: true,
    mutatingAdmin: true,
    cacheBypass: true,
    probeGroup: "manual",
    statusPageAction: {
      label: "Backfill Depegs",
      confirm: "Run depeg backfill? This may take several minutes.",
      method: "POST",
      acceptsStablecoinFilter: true,
    },
  },
  {
    key: "backfill-supply-history",
    path: API_PATHS.backfillSupplyHistory(),
    methods: ["POST"],
    adminRequired: true,
    mutatingAdmin: true,
    cacheBypass: true,
    routeDependencies: ["coingeckoApiKey", "chainRpcs"],
    probeGroup: "manual",
    statusPageAction: {
      label: "Backfill Supply",
      confirm: "Backfill supply history snapshots?",
      method: "POST",
      acceptsStablecoinFilter: true,
    },
  },
  {
    key: "backfill-cg-prices",
    path: API_PATHS.backfillCgPrices(),
    methods: ["POST"],
    adminRequired: true,
    mutatingAdmin: true,
    cacheBypass: true,
    routeDependencies: ["coingeckoApiKey"],
    probeGroup: "manual",
    statusPageAction: {
      label: "Backfill CG Prices",
      confirm: "Backfill CoinGecko prices?",
      method: "POST",
      acceptsStablecoinFilter: true,
    },
  },
  {
    key: "backfill-stability-index",
    path: API_PATHS.backfillStabilityIndex(),
    methods: ["POST"],
    adminRequired: true,
    mutatingAdmin: true,
    cacheBypass: true,
    probeGroup: "manual",
    statusPageAction: {
      label: "Backfill PSI",
      confirm: "Backfill stability index history?",
      method: "POST",
    },
  },
  {
    key: "backfill-mint-burn-prices",
    path: API_PATHS.backfillMintBurnPrices(),
    methods: ["POST"],
    adminRequired: true,
    mutatingAdmin: true,
    cacheBypass: true,
    probeGroup: "manual",
    statusPageAction: {
      label: "Backfill Mint/Burn Prices",
      confirm: "Backfill mint/burn USD prices for NULL events?",
      method: "POST",
    },
  },
  {
    key: "backfill-mint-burn",
    path: API_PATHS.backfillMintBurn(),
    methods: ["POST"],
    adminRequired: true,
    mutatingAdmin: true,
    cacheBypass: true,
    routeDependencies: ["alchemyApiKey"],
    probeGroup: "manual",
    statusPageAction: {
      label: "Backfill Mint/Burn",
      confirm: "Run mint/burn backfill job?",
      method: "POST",
    },
  },
  {
    key: "reclassify-atomic-roundtrips",
    path: API_PATHS.reclassifyAtomicRoundtrips(),
    methods: ["POST"],
    adminRequired: true,
    mutatingAdmin: true,
    cacheBypass: true,
    probeGroup: "manual",
    statusPageAction: {
      label: "Reclassify Roundtrips",
      confirm: "Reclassify atomic roundtrips in mint/burn data?",
      method: "POST",
    },
  },
  {
    key: "audit-depeg-history",
    path: API_PATHS.auditDepegHistoryBase(),
    methods: ["GET", "POST"],
    adminRequired: true,
    mutatingAdmin: true,
    cacheBypass: true,
    probeGroup: "manual",
    probePath: API_PATHS.auditDepegHistoryDryRun(),
    statusPageAction: {
      label: "Audit Depegs",
      confirm: "Run depeg history audit (dry-run)?",
      method: "GET",
      path: API_PATHS.auditDepegHistoryDryRun(),
    },
  },
  {
    key: "backfill-dews",
    path: API_PATHS.backfillDews(),
    methods: ["GET", "POST"],
    adminRequired: true,
    mutatingAdmin: true,
    cacheBypass: true,
    probeGroup: "manual",
    statusPageAction: {
      label: "Backfill DEWS",
      confirm: "Run DEWS historical backfill validation?",
      method: "GET",
    },
  },
  {
    key: "discovery-candidates",
    path: API_PATHS.discoveryCandidates(),
    methods: ["GET"],
    adminRequired: true,
    mutatingAdmin: false,
    cacheBypass: true,
    probeGroup: "admin",
  },
  // Operator controls that require context-specific query params (?job=,
  // ?circuit=, ?leaseOwner=). Reachable via curl/wrangler or via a future
  // contextual-button UI integration; no generic `statusPageAction` because
  // AdminActionButton doesn't currently collect free-form query params.
  {
    key: "reset-cron-lease",
    path: API_PATHS.resetCronLease(),
    methods: ["POST"],
    adminRequired: true,
    mutatingAdmin: true,
    cacheBypass: true,
    probeGroup: "manual",
  },
  {
    key: "reset-circuit-breaker",
    path: API_PATHS.resetCircuitBreaker(),
    methods: ["POST"],
    adminRequired: true,
    mutatingAdmin: true,
    cacheBypass: true,
    probeGroup: "manual",
  },
  {
    key: "kill-cron-in-flight",
    path: API_PATHS.killCronInFlight(),
    methods: ["POST"],
    adminRequired: true,
    mutatingAdmin: true,
    cacheBypass: true,
    probeGroup: "manual",
  },
  {
    key: "bulk-dismiss-discovery-candidates",
    path: API_PATHS.bulkDismissDiscoveryCandidates(),
    methods: ["POST"],
    adminRequired: true,
    mutatingAdmin: true,
    cacheBypass: true,
    probeGroup: "manual",
  },
  {
    key: "status-probe-history",
    path: API_PATHS.statusProbeHistory(),
    methods: ["GET"],
    adminRequired: true,
    mutatingAdmin: false,
    cacheBypass: true,
    probeGroup: "admin",
  },
] as const satisfies readonly BaseEndpointDefinition[];

export type EndpointKey = (typeof BASE_ENDPOINT_DEFINITIONS)[number]["key"];
export type EndpointDefinitionByKey<K extends EndpointKey> = Extract<(typeof ENDPOINT_DEFINITIONS)[number], { key: K }>;
export type EndpointDependenciesForKey<K extends EndpointKey> =
  Extract<(typeof BASE_ENDPOINT_DEFINITIONS)[number], { key: K }> extends {
    routeDependencies: infer Deps extends readonly EndpointDependency[];
  }
    ? Deps
    : readonly [];

function getSiteDataAccess(endpoint: BaseEndpointDefinition): EndpointSiteDataAccess {
  if (endpoint.siteDataAccess) return endpoint.siteDataAccess;
  return !endpoint.adminRequired && endpoint.methods.includes("GET") ? "allowed" : "denied";
}

function getPublicApiAccess(endpoint: BaseEndpointDefinition): EndpointPublicApiAccess {
  return endpoint.publicApiAccess ?? (endpoint.adminRequired ? "exempt" : "protected");
}

export const ENDPOINT_DEFINITIONS: readonly EndpointDefinition[] = BASE_ENDPOINT_DEFINITIONS.map((endpoint) => ({
  ...endpoint,
  publicApiAccess: getPublicApiAccess(endpoint),
  siteDataAccess: getSiteDataAccess(endpoint),
}));

const ENDPOINT_DEFINITION_BY_PATH = new Map<string, EndpointDefinition>(
  ENDPOINT_DEFINITIONS.map((endpoint) => [endpoint.path, endpoint]),
);

const ENDPOINT_DEFINITION_BY_KEY = new Map<EndpointKey, EndpointDefinition>(
  ENDPOINT_DEFINITIONS.map((endpoint) => [endpoint.key as EndpointKey, endpoint] as const),
);

const MUTATING_ADMIN_PATHS = new Set<string>(
  ENDPOINT_DEFINITIONS.filter((endpoint) => endpoint.mutatingAdmin).map((endpoint) => endpoint.path),
);

const CACHE_BYPASS_PATHS = new Set<string>(
  ENDPOINT_DEFINITIONS.filter((endpoint) => endpoint.cacheBypass).map((endpoint) => endpoint.path),
);

const STRICT_CONTRACT_PATHS = ENDPOINT_DEFINITIONS.filter((endpoint) => endpoint.strictContract).map(
  (endpoint) => endpoint.path,
);

export function isMutatingAdminPath(path: string): boolean {
  return MUTATING_ADMIN_PATHS.has(path);
}

export function isCacheBypassPath(path: string): boolean {
  return CACHE_BYPASS_PATHS.has(path);
}

export function getEndpointDefinition(path: string): EndpointDefinition | undefined {
  return ENDPOINT_DEFINITION_BY_PATH.get(path);
}

export function getEndpointDefinitionByKey(key: EndpointKey): EndpointDefinition | undefined {
  return ENDPOINT_DEFINITION_BY_KEY.get(key);
}

export function getStrictContractPaths(): readonly string[] {
  return STRICT_CONTRACT_PATHS;
}

/** Pre-computed strict contract paths (module-load-time). */
export const STRICT_CONTRACT_PATHS_LIST = getStrictContractPaths();

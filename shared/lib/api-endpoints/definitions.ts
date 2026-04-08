import { API_PATHS, buildQueryPath } from "./paths";

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

type BaseEndpointDefinition = Omit<EndpointDefinition, "publicApiAccess" | "siteDataAccess">;

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
    routeDependencies: ["mintBurnFreshnessConfig"],
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
    path: "/api/dex-liquidity-history",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
    probePath: buildQueryPath("/api/dex-liquidity-history", { stablecoin: "usdt-tether" }),
  },
  {
    key: "supply-history",
    path: "/api/supply-history",
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
    path: "/api/digest-snapshot",
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
    path: "/api/yield-history",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
    probePath: buildQueryPath("/api/yield-history", { stablecoin: "usdt-tether" }),
  },
  {
    key: "safety-score-history",
    path: "/api/safety-score-history",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
    probePath: buildQueryPath("/api/safety-score-history", { stablecoin: "usdt-tether" }),
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
    path: "/api/mint-burn-flows",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    strictContract: true,
    probeGroup: "public",
  },
  {
    key: "mint-burn-events",
    path: "/api/mint-burn-events",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
    probePath: "/api/mint-burn-events?stablecoin=usdt-tether",
  },
  {
    key: "stress-signals",
    path: "/api/stress-signals",
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
    path: "/api/non-usd-share",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
    probePath: "/api/non-usd-share?days=90",
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
    path: "/api/feedback",
    methods: ["POST"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: true,
    routeDependencies: ["feedbackEnv"],
  },
  {
    key: "telegram-webhook",
    path: "/api/telegram-webhook",
    methods: ["POST"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: true,
    routeDependencies: ["telegram"],
  },

  // Admin status/probe endpoints.
  {
    key: "status",
    path: "/api/status",
    methods: ["GET"],
    adminRequired: true,
    mutatingAdmin: false,
    cacheBypass: true,
    routeDependencies: ["coingeckoApiKey", "cloudflareD1StatusConfig"],
    probeGroup: "admin",
  },
  {
    key: "status-history",
    path: "/api/status-history",
    methods: ["GET"],
    adminRequired: true,
    mutatingAdmin: false,
    cacheBypass: true,
    probeGroup: "admin",
    probePath: "/api/status-history?limit=10",
  },
  {
    key: "request-source-stats",
    path: "/api/request-source-stats",
    methods: ["GET"],
    adminRequired: true,
    mutatingAdmin: false,
    cacheBypass: true,
  },
  {
    key: "api-keys",
    path: "/api/api-keys",
    methods: ["GET", "POST"],
    adminRequired: true,
    mutatingAdmin: false,
    cacheBypass: true,
    routeDependencies: ["apiKeyHashPepper"],
  },
  {
    key: "api-key-audit-log",
    path: "/api/api-keys/audit-log",
    methods: ["GET"],
    adminRequired: true,
    mutatingAdmin: false,
    cacheBypass: true,
  },
  {
    key: "trigger-digest",
    path: "/api/trigger-digest",
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
    path: "/api/reset-blacklist-sync",
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
    path: "/api/debug-sync-state",
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
    path: "/api/remediate-blacklist-amount-gaps",
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
    path: "/api/backfill-blacklist-current-balances",
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
    path: "/api/backfill-depegs",
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
    path: "/api/backfill-supply-history",
    methods: ["POST"],
    adminRequired: true,
    mutatingAdmin: true,
    cacheBypass: true,
    routeDependencies: ["coingeckoApiKey"],
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
    path: "/api/backfill-cg-prices",
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
    path: "/api/backfill-stability-index",
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
    path: "/api/backfill-mint-burn-prices",
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
    path: "/api/backfill-mint-burn",
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
    path: "/api/reclassify-atomic-roundtrips",
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
    path: "/api/audit-depeg-history",
    methods: ["GET", "POST"],
    adminRequired: true,
    mutatingAdmin: true,
    cacheBypass: true,
    probeGroup: "manual",
    probePath: "/api/audit-depeg-history?dry-run=true",
    statusPageAction: {
      label: "Audit Depegs",
      confirm: "Run depeg history audit (dry-run)?",
      method: "GET",
      path: "/api/audit-depeg-history?dry-run=true",
    },
  },
  {
    key: "backfill-dews",
    path: "/api/backfill-dews",
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
    path: "/api/discovery-candidates",
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

const SITE_DATA_ALLOWED_ENDPOINT_KEYS = new Set<EndpointKey>([
  "stablecoins",
  "stablecoin-detail-canary",
  "stablecoin-summary-canary",
  "stablecoin-reserves-canary",
  "stablecoin-charts",
  "peg-summary",
  "health",
  "blacklist",
  "blacklist-summary",
  "depeg-events",
  "usds-status",
  "bluechip-ratings",
  "dex-liquidity",
  "dex-liquidity-history",
  "supply-history",
  "daily-digest",
  "digest-archive",
  "digest-snapshot",
  "yield-rankings",
  "yield-history",
  "safety-score-history",
  "stability-index",
  "report-cards",
  "redemption-backstops",
  "mint-burn-flows",
  "mint-burn-events",
  "stress-signals",
  "chains",
  "non-usd-share",
  "public-status-history",
  "telegram-pulse",
]);

const PUBLIC_API_EXEMPT_ENDPOINT_KEYS = new Set<EndpointKey>([
  "health",
  "feedback",
  "telegram-webhook",
]);

export const ENDPOINT_DEFINITIONS: readonly EndpointDefinition[] = BASE_ENDPOINT_DEFINITIONS.map((endpoint) => ({
  ...endpoint,
  publicApiAccess:
    endpoint.adminRequired || PUBLIC_API_EXEMPT_ENDPOINT_KEYS.has(endpoint.key)
      ? "exempt"
      : "protected",
  siteDataAccess: SITE_DATA_ALLOWED_ENDPOINT_KEYS.has(endpoint.key) ? "allowed" : "denied",
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

type EndpointMethod = "GET" | "POST";
export type EndpointProbeGroup = "public" | "admin" | "manual";
export type EndpointDependency =
  | "alchemyApiKey"
  | "anthropicApiKey"
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
  strictContract?: boolean;
  probeGroup?: EndpointProbeGroup;
  probePath?: string;
  statusPageAction?: EndpointStatusPageActionConfig;
  /** Worker-only dependency hydration hints consumed by the route registry/context builder. */
  routeDependencies?: readonly EndpointDependency[];
}

export interface StatusPageAction {
  label: string;
  path: string;
  confirm: string;
  destructive: boolean;
  method: EndpointMethod;
  acceptsStablecoinFilter: boolean;
}

interface EndpointMethodValidationError {
  message: string;
  allowedMethods: readonly EndpointMethod[];
}

export interface DynamicAdminEndpointMatch {
  key: "discovery-candidate-dismiss";
  path: string;
  candidateId: number;
  methods: readonly EndpointMethod[];
}

type QueryParamValue = string | number | boolean | null | undefined;

function buildQueryPath(path: string, params?: Record<string, QueryParamValue>): string {
  if (!params) return path;
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    searchParams.set(key, String(value));
  }
  const query = searchParams.toString();
  return query ? `${path}?${query}` : path;
}

export const API_PATHS = {
  stablecoins: () => "/api/stablecoins",
  stablecoinDetail: (stablecoinId: string) => `/api/stablecoin/${encodeURIComponent(stablecoinId)}`,
  stablecoinSummary: (stablecoinId: string) => `/api/stablecoin-summary/${encodeURIComponent(stablecoinId)}`,
  stablecoinReserves: (stablecoinId: string) => `/api/stablecoin-reserves/${encodeURIComponent(stablecoinId)}`,
  stablecoinCharts: () => "/api/stablecoin-charts",
  pegSummary: () => "/api/peg-summary",
  health: () => "/api/health",
  blacklist: (params?: Record<string, QueryParamValue>) => buildQueryPath("/api/blacklist", params),
  blacklistSummary: () => "/api/blacklist-summary",
  depegEvents: (params?: { stablecoinId?: string; limit?: number; offset?: number }) =>
    buildQueryPath("/api/depeg-events", {
      stablecoin: params?.stablecoinId,
      limit: params?.limit,
      offset: params?.offset,
    }),
  usdsStatus: () => "/api/usds-status",
  bluechipRatings: () => "/api/bluechip-ratings",
  dexLiquidity: () => "/api/dex-liquidity",
  dexLiquidityHistory: (stablecoinId: string, days = 90) =>
    buildQueryPath("/api/dex-liquidity-history", { stablecoin: stablecoinId, days }),
  supplyHistory: (stablecoinId: string, days?: number) =>
    buildQueryPath("/api/supply-history", { stablecoin: stablecoinId, days }),
  dailyDigest: () => "/api/daily-digest",
  digestArchive: () => "/api/digest-archive",
  digestSnapshot: (date: string) => buildQueryPath("/api/digest-snapshot", { date }),
  yieldRankings: () => "/api/yield-rankings",
  yieldHistory: (stablecoinId: string, days = 90, mode?: string, sourceKey?: string) =>
    buildQueryPath("/api/yield-history", {
      stablecoin: stablecoinId,
      days,
      mode,
      sourceKey,
    }),
  safetyScoreHistory: (stablecoinId: string, days = 3650) =>
    buildQueryPath("/api/safety-score-history", { stablecoin: stablecoinId, days }),
  stabilityIndex: (detail = false) => buildQueryPath("/api/stability-index", detail ? { detail: true } : undefined),
  reportCards: () => "/api/report-cards",
  redemptionBackstops: () => "/api/redemption-backstops",
  mintBurnFlows: (params?: Record<string, QueryParamValue>) => buildQueryPath("/api/mint-burn-flows", params),
  mintBurnEvents: (params?: Record<string, QueryParamValue>) => buildQueryPath("/api/mint-burn-events", params),
  stressSignals: (stablecoinId?: string, days?: number) =>
    buildQueryPath("/api/stress-signals", { stablecoin: stablecoinId, days }),
  chains: () => "/api/chains",
  nonUsdShare: (days?: number) => buildQueryPath("/api/non-usd-share", days ? { days } : undefined),
} as const;

export const ENDPOINT_DEFINITIONS: readonly EndpointDefinition[] = [
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
    routeDependencies: ["coingeckoApiKey"],
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
    methods: ["GET"],
    adminRequired: true,
    mutatingAdmin: false,
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
] as const;

export type EndpointKey = (typeof ENDPOINT_DEFINITIONS)[number]["key"];

const ENDPOINT_DEFINITION_BY_PATH = new Map<string, EndpointDefinition>(
  ENDPOINT_DEFINITIONS.map((endpoint) => [endpoint.path, endpoint]),
);

const ENDPOINT_DEFINITION_BY_KEY = new Map<EndpointKey, EndpointDefinition>(
  ENDPOINT_DEFINITIONS.map((endpoint) => [endpoint.key, endpoint]),
);

const STABLECOIN_DETAIL_PATH_PATTERN = /^\/api\/stablecoin\/[^/]+$/;
const STABLECOIN_SUMMARY_PATH_PATTERN = /^\/api\/stablecoin-summary\/[^/]+$/;
const OG_IMAGE_PATH_PATTERN = /^\/api\/og\//;
const DISCOVERY_DISMISS_PATH_PATTERN = /^\/api\/discovery-candidates\/(\d+)\/dismiss$/;
const GET_ONLY_METHODS = ["GET"] as const satisfies readonly EndpointMethod[];
const POST_ONLY_METHODS = ["POST"] as const satisfies readonly EndpointMethod[];
const GET_AND_POST_METHODS = ["GET", "POST"] as const satisfies readonly EndpointMethod[];
const AUDIT_DEPEG_HISTORY_PATH = "/api/audit-depeg-history";

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

export function matchDynamicAdminEndpoint(path: string): DynamicAdminEndpointMatch | null {
  const discoveryDismissMatch = path.match(DISCOVERY_DISMISS_PATH_PATTERN);
  if (discoveryDismissMatch) {
    const candidateId = Number.parseInt(discoveryDismissMatch[1] ?? "", 10);
    if (!Number.isFinite(candidateId) || candidateId <= 0) {
      return null;
    }
    return {
      key: "discovery-candidate-dismiss",
      path,
      candidateId,
      methods: POST_ONLY_METHODS,
    };
  }

  return null;
}

export function isAdminPath(path: string): boolean {
  return Boolean(getEndpointDefinition(path)?.adminRequired || matchDynamicAdminEndpoint(path));
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

function getAllowedEndpointMethods(url: URL): readonly EndpointMethod[] | null {
  const definition = getEndpointDefinition(url.pathname);
  if (definition) {
    if (url.pathname === AUDIT_DEPEG_HISTORY_PATH && url.searchParams.get("dry-run") !== "true") {
      return POST_ONLY_METHODS;
    }
    return definition.methods;
  }

  if (STABLECOIN_DETAIL_PATH_PATTERN.test(url.pathname)) {
    return GET_ONLY_METHODS;
  }
  if (STABLECOIN_SUMMARY_PATH_PATTERN.test(url.pathname)) {
    return GET_ONLY_METHODS;
  }
  const dynamicAdminEndpoint = matchDynamicAdminEndpoint(url.pathname);
  if (dynamicAdminEndpoint) {
    return dynamicAdminEndpoint.methods;
  }
  if (OG_IMAGE_PATH_PATTERN.test(url.pathname)) {
    return GET_ONLY_METHODS;
  }

  return null;
}

export function validateEndpointMethod(url: URL, method: string): EndpointMethodValidationError | null {
  if (method !== "GET" && method !== "POST") {
    return { message: "Method not allowed", allowedMethods: GET_AND_POST_METHODS };
  }

  const allowedMethods = getAllowedEndpointMethods(url);
  if (!allowedMethods) {
    if (method === "POST") {
      return { message: "Method not allowed", allowedMethods: GET_ONLY_METHODS };
    }
    return null;
  }

  if (allowedMethods.includes(method as EndpointMethod)) {
    return null;
  }

  const postOnly = method === "GET" && allowedMethods.length === 1 && allowedMethods[0] === "POST";
  return {
    message: postOnly ? "Method not allowed. Use POST for this endpoint." : "Method not allowed",
    allowedMethods,
  };
}

export function getProbePaths(group: EndpointProbeGroup): string[] {
  return ENDPOINT_DEFINITIONS.filter((endpoint) => endpoint.probeGroup === group).map(
    (endpoint) => endpoint.probePath ?? endpoint.path,
  );
}

export function getStatusPageActions(): StatusPageAction[] {
  return ENDPOINT_DEFINITIONS.flatMap((endpoint) => {
    if (!endpoint.statusPageAction) return [];
    return [
      {
        label: endpoint.statusPageAction.label,
        path: endpoint.statusPageAction.path ?? endpoint.probePath ?? endpoint.path,
        confirm: endpoint.statusPageAction.confirm,
        destructive: endpoint.statusPageAction.destructive ?? false,
        method: endpoint.statusPageAction.method,
        acceptsStablecoinFilter: endpoint.statusPageAction.acceptsStablecoinFilter ?? false,
      },
    ];
  });
}

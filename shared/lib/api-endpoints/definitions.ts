import { API_PATHS } from "./paths";

export type EndpointMethod = "GET" | "HEAD" | "POST";
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
  | "apiKeySelfServeEnv"
  | "telegram";

export type StatusPageActionGroup = "recovery" | "audit" | "communications";

interface EndpointStatusPageActionConfig {
  label: string;
  confirm: string;
  destructive?: boolean;
  method: EndpointMethod;
  path?: string;
  /** When true the action dialog offers an optional stablecoin ID input to target a single coin. */
  acceptsStablecoinFilter?: boolean;
  /** UI grouping in the admin actions panel. Defaults to "recovery" when omitted. */
  group?: StatusPageActionGroup;
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
  /** Optional Pages ops-admin proxy timeout override for slow admin endpoints. */
  opsProxyTimeoutMs?: number;
  statusPageAction?: EndpointStatusPageActionConfig;
  /** Worker-only dependency hydration hints consumed by the route registry/context builder. */
  routeDependencies?: readonly EndpointDependency[];
}

type BaseEndpointDefinition = Omit<EndpointDefinition, "publicApiAccess" | "siteDataAccess"> & {
  publicApiAccess?: EndpointPublicApiAccess;
  siteDataAccess?: EndpointSiteDataAccess;
};

type EndpointDefinitionFactoryInput<Key extends string = string> = Omit<
  BaseEndpointDefinition,
  "key" | "methods" | "adminRequired" | "mutatingAdmin" | "cacheBypass" | "publicApiAccess" | "siteDataAccess"
> & {
  key: Key;
  cacheBypass?: boolean;
  publicApiAccess?: EndpointPublicApiAccess;
  siteDataAccess?: EndpointSiteDataAccess;
};

type PublicGetDefinition<T extends EndpointDefinitionFactoryInput> = T & {
  readonly methods: readonly ["GET"];
  readonly adminRequired: false;
  readonly mutatingAdmin: false;
  readonly cacheBypass: T["cacheBypass"] extends boolean ? T["cacheBypass"] : false;
};

type PublicPostDefinition<T extends EndpointDefinitionFactoryInput> = T & {
  readonly methods: readonly ["POST"];
  readonly adminRequired: false;
  readonly mutatingAdmin: false;
  readonly cacheBypass: T["cacheBypass"] extends boolean ? T["cacheBypass"] : true;
  readonly publicApiAccess: T["publicApiAccess"] extends EndpointPublicApiAccess ? T["publicApiAccess"] : "exempt";
  readonly siteDataAccess: T["siteDataAccess"] extends EndpointSiteDataAccess ? T["siteDataAccess"] : "denied";
};

type AdminGetDefinition<T extends EndpointDefinitionFactoryInput> = T & {
  readonly methods: readonly ["GET"];
  readonly adminRequired: true;
  readonly mutatingAdmin: false;
  readonly cacheBypass: T["cacheBypass"] extends boolean ? T["cacheBypass"] : true;
};

type AdminMutationDefinition<T extends EndpointDefinitionFactoryInput> = T & {
  readonly methods: readonly ["POST"];
  readonly adminRequired: true;
  readonly mutatingAdmin: true;
  readonly cacheBypass: T["cacheBypass"] extends boolean ? T["cacheBypass"] : true;
};

type AdminDualModeMutationDefinition<T extends EndpointDefinitionFactoryInput> = T & {
  readonly methods: readonly ["GET", "POST"];
  readonly adminRequired: true;
  readonly mutatingAdmin: true;
  readonly cacheBypass: T["cacheBypass"] extends boolean ? T["cacheBypass"] : true;
};

const ENDPOINT_METADATA_FACTORY_MARKER: unique symbol = Symbol("endpointMetadataFactory");

type FactoryMarkedEndpoint = BaseEndpointDefinition & {
  readonly [ENDPOINT_METADATA_FACTORY_MARKER]?: true;
};

function markFactoryDefinition<const T extends BaseEndpointDefinition>(definition: T): T {
  Object.defineProperty(definition, ENDPOINT_METADATA_FACTORY_MARKER, {
    value: true,
  });
  return definition;
}

function isFactoryMarkedEndpoint(endpoint: BaseEndpointDefinition): boolean {
  return (endpoint as FactoryMarkedEndpoint)[ENDPOINT_METADATA_FACTORY_MARKER] === true;
}

function publicGet<const T extends EndpointDefinitionFactoryInput>(definition: T): PublicGetDefinition<T> {
  return markFactoryDefinition({
    cacheBypass: false,
    ...definition,
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
  } as PublicGetDefinition<T>);
}

function publicPostExempt<const T extends EndpointDefinitionFactoryInput>(definition: T): PublicPostDefinition<T> {
  return markFactoryDefinition({
    cacheBypass: true,
    publicApiAccess: "exempt",
    siteDataAccess: "denied",
    ...definition,
    methods: ["POST"],
    adminRequired: false,
    mutatingAdmin: false,
  } as PublicPostDefinition<T>);
}

function adminGet<const T extends EndpointDefinitionFactoryInput>(definition: T): AdminGetDefinition<T> {
  return markFactoryDefinition({
    cacheBypass: true,
    ...definition,
    methods: ["GET"],
    adminRequired: true,
    mutatingAdmin: false,
  } as AdminGetDefinition<T>);
}

function adminMutation<const T extends EndpointDefinitionFactoryInput>(definition: T): AdminMutationDefinition<T> {
  return markFactoryDefinition({
    cacheBypass: true,
    ...definition,
    methods: ["POST"],
    adminRequired: true,
    mutatingAdmin: true,
  } as AdminMutationDefinition<T>);
}

function adminDualModeMutation<const T extends EndpointDefinitionFactoryInput>(
  definition: T,
): AdminDualModeMutationDefinition<T> {
  return markFactoryDefinition({
    cacheBypass: true,
    ...definition,
    methods: ["GET", "POST"],
    adminRequired: true,
    mutatingAdmin: true,
  } as AdminDualModeMutationDefinition<T>);
}

export interface StatusPageAction {
  label: string;
  path: string;
  confirm: string;
  destructive: boolean;
  method: EndpointMethod;
  acceptsStablecoinFilter: boolean;
  group: StatusPageActionGroup;
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
    }
  | {
      key: "api-key-request-reject" | "api-key-request-release-claim";
      path: string;
      requestId: string;
      methods: readonly EndpointMethod[];
    }
  | {
      key: "admin-telegram-chat";
      path: string;
      chatId: string;
      methods: readonly EndpointMethod[];
    };

const BASE_ENDPOINT_DEFINITIONS = [
  // Public endpoints probed by the status dashboard.
  publicGet({
    key: "stablecoins",
    path: API_PATHS.stablecoins(),
    strictContract: true,
    probeGroup: "public",
  }),
  publicGet({
    // Dynamic shape; runtime routing is registered via DYNAMIC_ENDPOINT_DESCRIPTORS.
    key: "stablecoin-detail",
    path: "/api/stablecoin/:id",
    routeDependencies: ["coingeckoApiKey"],
    probeGroup: "public",
    // Probe a smaller detail canary than USDT to avoid oversized-history false negatives.
    probePath: API_PATHS.stablecoinDetail("pyusd-paypal"),
  }),
  publicGet({
    // Dynamic shape; runtime routing is registered via DYNAMIC_ENDPOINT_DESCRIPTORS.
    key: "stablecoin-summary",
    path: "/api/stablecoin-summary/:id",
    probeGroup: "public",
    probePath: API_PATHS.stablecoinSummary("usdt-tether"),
  }),
  publicGet({
    // Dynamic shape; runtime routing is registered via DYNAMIC_ENDPOINT_DESCRIPTORS.
    key: "stablecoin-reserves",
    path: "/api/stablecoin-reserves/:id",
    probeGroup: "public",
    probePath: API_PATHS.stablecoinReserves("iusd-infinifi"),
  }),
  publicGet({
    key: "stablecoin-charts",
    path: API_PATHS.stablecoinCharts(),
    probeGroup: "public",
  }),
  publicGet({
    key: "peg-summary",
    path: API_PATHS.pegSummary(),
    strictContract: true,
    probeGroup: "public",
  }),
  publicGet({
    key: "health",
    path: API_PATHS.health(),
    publicApiAccess: "exempt",
    probeGroup: "public",
  }),
  publicGet({
    key: "public-status-history",
    path: API_PATHS.publicStatusHistory(),
    probeGroup: "public",
  }),
  publicGet({
    key: "blacklist",
    path: API_PATHS.blacklist(),
    strictContract: true,
    probeGroup: "public",
  }),
  publicGet({
    key: "blacklist-summary",
    path: API_PATHS.blacklistSummary(),
    strictContract: true,
    probeGroup: "public",
  }),
  publicGet({
    key: "depeg-events",
    path: API_PATHS.depegEvents(),
    strictContract: true,
    probeGroup: "public",
  }),
  publicGet({
    key: "events",
    path: API_PATHS.events(),
    strictContract: true,
    probeGroup: "public",
  }),
  publicGet({
    key: "usds-status",
    path: API_PATHS.usdsStatus(),
    probeGroup: "public",
  }),
  publicGet({
    key: "bluechip-ratings",
    path: API_PATHS.bluechipRatings(),
    probeGroup: "public",
  }),
  publicGet({
    key: "dex-liquidity",
    path: API_PATHS.dexLiquidity(),
    strictContract: true,
    probeGroup: "public",
  }),
  publicGet({
    key: "dex-liquidity-history",
    path: API_PATHS.dexLiquidityHistoryBase(),
    probeGroup: "public",
    probePath: API_PATHS.dexLiquidityHistoryProbe("usdt-tether"),
  }),
  publicGet({
    key: "supply-history",
    path: API_PATHS.supplyHistoryBase(),
    probeGroup: "public",
    probePath: API_PATHS.supplyHistory("usdt-tether"),
  }),
  publicGet({
    key: "daily-digest",
    path: API_PATHS.dailyDigest(),
    probeGroup: "public",
  }),
  publicGet({
    key: "digest-archive",
    path: API_PATHS.digestArchive(),
    probeGroup: "public",
  }),
  publicGet({
    key: "digest-snapshot",
    path: API_PATHS.digestSnapshotBase(),
    // Requires a date-specific snapshot that is not stable enough for a generic canary probe.
  }),
  publicGet({
    key: "snapshots-index",
    path: API_PATHS.snapshotsIndex(),
    probeGroup: "public",
  }),
  publicGet({
    // Dynamic shape; runtime routing is registered via DYNAMIC_ENDPOINT_DESCRIPTORS.
    // Keep this out of public probes because valid dates come from /api/snapshots/index.
    key: "snapshot-day",
    path: "/api/snapshots/:date.json",
  }),
  publicGet({
    // Dynamic shape; runtime routing is registered via DYNAMIC_ENDPOINT_DESCRIPTORS.
    // Keep this out of public probes because valid dates come from /api/snapshots/index.
    key: "snapshot-coin",
    path: "/api/snapshot/:date/stablecoin/:id",
  }),
  publicGet({
    key: "yield-rankings",
    path: API_PATHS.yieldRankings(),
    probeGroup: "public",
  }),
  publicGet({
    key: "yield-adapter-manifest",
    path: API_PATHS.yieldAdapterManifest(),
    probeGroup: "public",
  }),
  publicGet({
    key: "yield-history",
    path: API_PATHS.yieldHistoryBase(),
    probeGroup: "public",
    probePath: API_PATHS.yieldHistoryProbe("usdt-tether"),
  }),
  publicGet({
    key: "safety-score-history",
    path: API_PATHS.safetyScoreHistoryBase(),
    probeGroup: "public",
    probePath: API_PATHS.safetyScoreHistoryProbe("usdt-tether"),
  }),
  publicGet({
    key: "stability-index",
    path: API_PATHS.stabilityIndex(),
    strictContract: true,
    probeGroup: "public",
  }),
  publicGet({
    key: "report-cards",
    path: API_PATHS.reportCards(),
    strictContract: true,
    probeGroup: "public",
  }),
  publicGet({
    key: "depeg-resolver",
    path: API_PATHS.depegResolver(),
    strictContract: true,
    probeGroup: "public",
  }),
  publicGet({
    key: "depeg-resolver-review",
    path: API_PATHS.depegResolverReview(),
    strictContract: true,
    probeGroup: "public",
  }),
  publicGet({
    key: "redemption-backstops",
    path: API_PATHS.redemptionBackstops(),
    strictContract: true,
    probeGroup: "public",
  }),
  publicGet({
    key: "mint-burn-flows",
    path: API_PATHS.mintBurnFlowsBase(),
    strictContract: true,
    probeGroup: "public",
  }),
  publicGet({
    key: "mint-burn-events",
    path: API_PATHS.mintBurnEventsBase(),
    probeGroup: "public",
    probePath: API_PATHS.mintBurnEvents({ stablecoin: "usdt-tether" }),
  }),
  publicGet({
    key: "stress-signals",
    path: API_PATHS.stressSignalsBase(),
    strictContract: true,
    probeGroup: "public",
  }),
  publicGet({
    key: "chains",
    path: API_PATHS.chains(),
    probeGroup: "public",
  }),
  publicGet({
    key: "non-usd-share",
    path: API_PATHS.nonUsdShareBase(),
    probeGroup: "public",
    probePath: API_PATHS.nonUsdShare(90),
  }),
  publicGet({
    key: "telegram-pulse",
    path: API_PATHS.telegramPulse(),
    probeGroup: "public",
  }),
  publicPostExempt({
    key: "telegram-mini-app-session",
    path: API_PATHS.telegramMiniAppSession(),
    routeDependencies: ["telegram"],
  }),
  publicPostExempt({
    key: "telegram-mini-app-mutation",
    path: API_PATHS.telegramMiniAppMutation(),
    routeDependencies: ["telegram"],
  }),
  publicPostExempt({
    key: "feedback",
    path: API_PATHS.feedback(),
    routeDependencies: ["feedbackEnv"],
  }),
  publicPostExempt({
    key: "api-key-requests",
    path: API_PATHS.apiKeyRequests(),
    routeDependencies: ["apiKeySelfServeEnv"],
  }),
  publicPostExempt({
    key: "api-key-request-verify",
    path: API_PATHS.apiKeyRequestVerify(),
    routeDependencies: ["apiKeyHashPepper", "apiKeySelfServeEnv"],
  }),
  publicPostExempt({
    key: "telegram-webhook",
    path: API_PATHS.telegramWebhook(),
    routeDependencies: ["telegram"],
  }),

  // Admin status/probe endpoints.
  adminGet({
    key: "status",
    path: API_PATHS.status(),
    routeDependencies: ["coingeckoApiKey", "cloudflareD1StatusConfig"],
    probeGroup: "admin",
    opsProxyTimeoutMs: 20_000,
  }),
  adminGet({
    key: "status-history",
    path: API_PATHS.statusHistoryBase(),
    probeGroup: "admin",
    probePath: API_PATHS.statusHistory({ limit: 10 }),
    opsProxyTimeoutMs: 20_000,
  }),
  adminGet({
    key: "request-source-stats",
    path: API_PATHS.requestSourceStatsBase(),
  }),
  adminGet({
    key: "yield-source-decisions",
    path: API_PATHS.yieldSourceDecisions(),
  }),
  {
    key: "api-keys",
    path: API_PATHS.apiKeys(),
    methods: ["GET", "POST"],
    adminRequired: true,
    mutatingAdmin: false,
    cacheBypass: true,
    routeDependencies: ["apiKeyHashPepper"],
  },
  adminGet({
    key: "api-key-requests-admin",
    path: API_PATHS.apiKeyRequestsAdmin(),
    siteDataAccess: "denied",
  }),
  adminGet({
    key: "api-key-audit-log",
    path: API_PATHS.apiKeyAuditLog(),
  }),
  adminGet({
    key: "admin-action-log",
    path: API_PATHS.adminActionLog(),
  }),
  adminMutation({
    key: "trigger-digest",
    path: API_PATHS.triggerDigest(),
    cacheBypass: false,
    routeDependencies: ["anthropicApiKey", "telegram"],
    probeGroup: "manual",
    statusPageAction: {
      label: "Trigger Digest",
      confirm: "Trigger daily digest? Bypasses 1h dedup window.",
      method: "POST",
      group: "communications",
    },
  }),
  adminMutation({
    key: "reset-blacklist-sync",
    path: API_PATHS.resetBlacklistSync(),
    cacheBypass: false,
    probeGroup: "manual",
    statusPageAction: {
      label: "Reset Blacklist Sync",
      confirm: "Reset blacklist sync? Rolls back EVM 50k blocks, Tron 7 days.",
      destructive: true,
      method: "POST",
    },
  }),
  adminGet({
    key: "debug-sync-state",
    path: API_PATHS.debugSyncState(),
    probeGroup: "admin",
    statusPageAction: {
      label: "Debug Sync State",
      confirm: "Fetch sync state debug dump?",
      method: "GET",
      group: "audit",
    },
  }),
  adminMutation({
    key: "remediate-blacklist-amount-gaps",
    path: API_PATHS.remediateBlacklistAmountGaps(),
    routeDependencies: ["chainRpcs"],
    probeGroup: "manual",
    statusPageAction: {
      label: "Remediate Blacklist Gaps",
      confirm: "Run targeted blacklist amount-gap remediation? Prefer dry-run first.",
      method: "POST",
    },
  }),
  adminMutation({
    key: "backfill-blacklist-current-balances",
    path: API_PATHS.backfillBlacklistCurrentBalances(),
    routeDependencies: ["chainRpcs"],
    probeGroup: "manual",
    statusPageAction: {
      label: "Backfill Blacklist Balances",
      confirm: "Backfill current-balance cache for coins missing balance rows? Prefer dry-run first (?dryRun=true).",
      method: "POST",
    },
  }),
  adminMutation({
    key: "backfill-depegs",
    path: API_PATHS.backfillDepegs(),
    routeDependencies: ["coingeckoApiKey"],
    probeGroup: "manual",
    statusPageAction: {
      label: "Backfill Depegs",
      confirm: "Run depeg backfill? This may take several minutes.",
      method: "POST",
      acceptsStablecoinFilter: true,
    },
  }),
  adminMutation({
    key: "backfill-supply-history",
    path: API_PATHS.backfillSupplyHistory(),
    routeDependencies: ["coingeckoApiKey", "chainRpcs"],
    probeGroup: "manual",
    statusPageAction: {
      label: "Backfill Supply",
      confirm: "Backfill supply history snapshots?",
      method: "POST",
      acceptsStablecoinFilter: true,
    },
  }),
  adminMutation({
    key: "backfill-cg-prices",
    path: API_PATHS.backfillCgPrices(),
    routeDependencies: ["coingeckoApiKey"],
    probeGroup: "manual",
    statusPageAction: {
      label: "Backfill CG Prices",
      confirm: "Backfill CoinGecko prices?",
      method: "POST",
      acceptsStablecoinFilter: true,
    },
  }),
  adminMutation({
    key: "backfill-yield-history",
    path: API_PATHS.backfillYieldHistory(),
    probeGroup: "manual",
    statusPageAction: {
      label: "Backfill Yield History",
      confirm: "Backfill protocol yield history?",
      method: "POST",
      acceptsStablecoinFilter: true,
    },
  }),
  adminMutation({
    key: "backfill-stability-index",
    path: API_PATHS.backfillStabilityIndex(),
    probeGroup: "manual",
    statusPageAction: {
      label: "Backfill PSI",
      confirm: "Backfill stability index history?",
      method: "POST",
    },
  }),
  adminMutation({
    key: "backfill-mint-burn-prices",
    path: API_PATHS.backfillMintBurnPrices(),
    probeGroup: "manual",
    statusPageAction: {
      label: "Backfill Mint/Burn Prices",
      confirm: "Backfill mint/burn USD prices for NULL events?",
      method: "POST",
    },
  }),
  adminMutation({
    key: "backfill-mint-burn",
    path: API_PATHS.backfillMintBurn(),
    routeDependencies: ["alchemyApiKey"],
    probeGroup: "manual",
    statusPageAction: {
      label: "Backfill Mint/Burn",
      confirm: "Run mint/burn backfill job?",
      method: "POST",
    },
  }),
  adminMutation({
    key: "backfill-tape",
    path: API_PATHS.backfillTape(),
    probeGroup: "manual",
    statusPageAction: {
      label: "Backfill Tape",
      confirm: "Re-run tape projectors for selected classes? Prefer dry-run first (?dryRun=true).",
      method: "POST",
    },
  }),
  adminMutation({
    key: "reclassify-atomic-roundtrips",
    path: API_PATHS.reclassifyAtomicRoundtrips(),
    probeGroup: "manual",
    statusPageAction: {
      label: "Reclassify Roundtrips",
      confirm: "Reclassify atomic roundtrips in mint/burn data?",
      method: "POST",
      group: "audit",
    },
  }),
  adminDualModeMutation({
    key: "audit-depeg-history",
    path: API_PATHS.auditDepegHistoryBase(),
    probeGroup: "manual",
    probePath: API_PATHS.auditDepegHistoryDryRun(),
    opsProxyTimeoutMs: 45_000,
    statusPageAction: {
      label: "Audit Depegs",
      confirm: "Run depeg history audit (dry-run)?",
      method: "GET",
      path: API_PATHS.auditDepegHistoryDryRun(),
      group: "audit",
    },
  }),
  adminDualModeMutation({
    key: "backfill-dews",
    path: API_PATHS.backfillDews(),
    probeGroup: "manual",
    statusPageAction: {
      label: "Backfill DEWS",
      confirm: "Run DEWS historical backfill validation?",
      method: "GET",
    },
  }),
  adminGet({
    key: "discovery-candidates",
    path: API_PATHS.discoveryCandidates(),
    probeGroup: "admin",
  }),
  // Operator controls that require context-specific query params (?job=,
  // ?circuit=, ?leaseOwner=). Reachable via curl/wrangler or via a future
  // contextual-button UI integration; no generic `statusPageAction` because
  // AdminActionButton doesn't currently collect free-form query params.
  adminMutation({
    key: "reset-cron-lease",
    path: API_PATHS.resetCronLease(),
    probeGroup: "manual",
  }),
  adminMutation({
    key: "reset-circuit-breaker",
    path: API_PATHS.resetCircuitBreaker(),
    probeGroup: "manual",
  }),
  adminMutation({
    key: "kill-cron-in-flight",
    path: API_PATHS.killCronInFlight(),
    probeGroup: "manual",
  }),
  adminMutation({
    key: "bulk-dismiss-discovery-candidates",
    path: API_PATHS.bulkDismissDiscoveryCandidates(),
    probeGroup: "manual",
  }),
  adminMutation({
    key: "clear-telegram-pending",
    path: API_PATHS.clearTelegramPending(),
    probeGroup: "manual",
  }),
  adminMutation({
    key: "admin-telegram-resend",
    path: API_PATHS.adminTelegramResend(),
    routeDependencies: ["telegram"],
    probeGroup: "manual",
  }),
  adminMutation({
    key: "admin-telegram-broadcast",
    path: API_PATHS.adminTelegramBroadcast(),
    probeGroup: "manual",
  }),
  adminGet({
    key: "status-probe-history",
    path: API_PATHS.statusProbeHistory(),
    probePath: API_PATHS.statusProbeHistory({ path: API_PATHS.health() }),
    probeGroup: "admin",
  }),
] as const satisfies readonly BaseEndpointDefinition[];

const ENDPOINT_METADATA_FACTORY_EXEMPT_KEYS = new Set<string>([
  // GET lists keys; POST creates a key. The admin mutation gate is enforced
  // inside the route handler because this endpoint intentionally supports both
  // read and write operations on the same path.
  "api-keys",
]);

function assertStandardEndpointMetadataUsesFactories(definitions: readonly BaseEndpointDefinition[]): void {
  for (const endpoint of definitions) {
    if (isFactoryMarkedEndpoint(endpoint)) continue;
    if (ENDPOINT_METADATA_FACTORY_EXEMPT_KEYS.has(endpoint.key)) continue;
    throw new Error(
      `Endpoint "${endpoint.key}" repeats standard method/auth/cache metadata; use an endpoint metadata factory or add an explicit exemption.`,
    );
  }
}

assertStandardEndpointMetadataUsesFactories(BASE_ENDPOINT_DEFINITIONS);

export type EndpointKey = (typeof BASE_ENDPOINT_DEFINITIONS)[number]["key"];
export type EndpointDefinitionByKey<K extends EndpointKey> = Extract<(typeof ENDPOINT_DEFINITIONS)[number], { key: K }>;
export type EndpointDependenciesForKey<K extends EndpointKey> =
  Extract<(typeof BASE_ENDPOINT_DEFINITIONS)[number], { key: K }> extends {
    routeDependencies: infer Deps extends readonly EndpointDependency[];
  }
    ? Deps
    : readonly [];

function resolveEndpointSiteDataAccess(endpoint: BaseEndpointDefinition): EndpointSiteDataAccess {
  if (endpoint.siteDataAccess) return endpoint.siteDataAccess;
  return !endpoint.adminRequired && endpoint.methods.includes("GET") ? "allowed" : "denied";
}

function resolveEndpointPublicApiAccess(endpoint: BaseEndpointDefinition): EndpointPublicApiAccess {
  return endpoint.publicApiAccess ?? (endpoint.adminRequired ? "exempt" : "protected");
}

export const ENDPOINT_DEFINITIONS: readonly EndpointDefinition[] = BASE_ENDPOINT_DEFINITIONS.map((endpoint) => ({
  ...endpoint,
  publicApiAccess: resolveEndpointPublicApiAccess(endpoint),
  siteDataAccess: resolveEndpointSiteDataAccess(endpoint),
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

export function getEndpointOpsProxyTimeoutMs(path: string, fallbackMs: number): number {
  return ENDPOINT_DEFINITION_BY_PATH.get(path)?.opsProxyTimeoutMs ?? fallbackMs;
}

/** Pre-computed strict contract paths (module-load-time). */
export const STRICT_CONTRACT_PATHS_LIST = STRICT_CONTRACT_PATHS;

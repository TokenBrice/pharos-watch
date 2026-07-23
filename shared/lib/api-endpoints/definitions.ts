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
  | "workerStatusConfig"
  | "workerVersion"
  | "telegram"
  | "telegramRecapRollout";

export type StatusPageActionGroup = "recovery" | "audit" | "communications";

export type StatusPageActionKind = "inspect" | "backfill" | "repair" | "reset" | "communication";
export type StatusPageActionRisk = "read-only" | "low" | "moderate" | "high";
export type StatusPageActionResultMode = "immediate" | "queued" | "continuation";
export type StatusPageActionAuditMode = "canonical" | "handler";
export type StatusPageActionRunbookPath =
  | "docs/data-pipeline.md"
  | "docs/depeg-detection.md"
  | "docs/dews.md"
  | "docs/mint-burn-flows.md"
  | "docs/pricing-pipeline.md"
  | "docs/stability-index.md"
  | "docs/yield-intelligence.md";

export type StatusPageActionScope =
  | {
      type: "global" | "automatic";
      label: string;
    }
  | {
      type: "asset-or-batch";
      assetIdentifier: "stablecoin-id" | "symbol";
      assetLabel: string;
      assetPlaceholder: string;
      batchLabel: string;
      queryParam: "stablecoin" | "stablecoinId" | "symbol";
    };

export type StatusPageActionDryRun =
  | {
      supported: false;
      default: false;
      liveSupported: true;
    }
  | {
      supported: true;
      default: true;
      /** False when the endpoint supports live mode but this generic control cannot satisfy its extra execution fence. */
      liveSupported: boolean;
      queryParam: "dry-run" | "dryRun";
      dryRunMethod?: EndpointMethod;
      liveMethod?: EndpointMethod;
    };

interface EndpointStatusPageActionConfig {
  label: string;
  confirm: string;
  destructive?: boolean;
  method: EndpointMethod;
  path?: string;
  /** UI grouping in the admin actions panel. Defaults to "recovery" when omitted. */
  group?: StatusPageActionGroup;
  kind: StatusPageActionKind;
  risk: StatusPageActionRisk;
  scope: StatusPageActionScope;
  dryRun: StatusPageActionDryRun;
  expectedDuration: string;
  preconditions: readonly string[];
  blockedBy: readonly string[];
  resultMode: StatusPageActionResultMode;
  /** Canonical router audit is the default. Use handler only when the handler writes one richer audit row itself. */
  auditMode?: StatusPageActionAuditMode;
  rollback?: string;
  runbookPath?: StatusPageActionRunbookPath;
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
  /** Optional semantic parser kind for status-page probes. */
  probeSemanticKind?: "health" | "status";
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
  /** Compatibility projection for callers that only need to know whether an asset filter exists. */
  acceptsStablecoinFilter: boolean;
  group: StatusPageActionGroup;
  kind: StatusPageActionKind;
  risk: StatusPageActionRisk;
  scope: StatusPageActionScope;
  dryRun: StatusPageActionDryRun;
  expectedDuration: string;
  preconditions: readonly string[];
  blockedBy: readonly string[];
  resultMode: StatusPageActionResultMode;
  rollback?: string;
  runbookPath?: StatusPageActionRunbookPath;
}

export interface EndpointMethodValidationError {
  message: string;
  allowedMethods: readonly EndpointMethod[];
}

export type DynamicAdminEndpointMatch =
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

const NO_DRY_RUN: StatusPageActionDryRun = {
  supported: false,
  default: false,
  liveSupported: true,
};

function globalActionScope(label: string): StatusPageActionScope {
  return { type: "global", label };
}

function automaticActionScope(label: string): StatusPageActionScope {
  return { type: "automatic", label };
}

function assetOrBatchActionScope(
  options: Omit<Extract<StatusPageActionScope, { type: "asset-or-batch" }>, "type">,
): StatusPageActionScope {
  return { type: "asset-or-batch", ...options };
}

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
    probeSemanticKind: "health",
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
    key: "safety-score-history-v2",
    path: API_PATHS.safetyScoreHistoryV2Base(),
    probeGroup: "public",
    probePath: API_PATHS.safetyScoreHistoryV2("usdt-tether"),
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
    key: "report-cards-v9",
    path: API_PATHS.reportCardsV9(),
    cacheBypass: true,
    strictContract: true,
    probeGroup: "manual",
  }),
  publicGet({
    key: "report-cards-v9-preview",
    path: API_PATHS.reportCardsV9Preview(),
    cacheBypass: true,
    strictContract: true,
    probeGroup: "manual",
  }),
  publicGet({
    key: "report-cards-v9-preview-legacy",
    path: API_PATHS.reportCardsV9PreviewLegacy(),
    cacheBypass: true,
    strictContract: true,
    probeGroup: "manual",
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
    routeDependencies: ["telegram", "telegramRecapRollout"],
  }),
  publicPostExempt({
    key: "telegram-mini-app-mutation",
    path: API_PATHS.telegramMiniAppMutation(),
    routeDependencies: ["telegram", "telegramRecapRollout"],
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
    routeDependencies: ["telegram", "telegramRecapRollout"],
  }),

  // Admin status/probe endpoints.
  adminGet({
    key: "status",
    path: API_PATHS.status(),
    routeDependencies: ["coingeckoApiKey", "cloudflareD1StatusConfig", "workerStatusConfig"],
    probeGroup: "admin",
    opsProxyTimeoutMs: 20_000,
    probeSemanticKind: "status",
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
    key: "credential-lifecycle-summary",
    path: API_PATHS.credentialLifecycleSummary(),
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
      kind: "communication",
      risk: "moderate",
      scope: globalActionScope("All digest recipients"),
      dryRun: NO_DRY_RUN,
      expectedDuration: "Queued; starts within 5 minutes",
      preconditions: ["Review current digest state and downstream delivery health."],
      blockedBy: [],
      resultMode: "queued",
      rollback: "No automatic recall is available after downstream delivery begins.",
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
      kind: "reset",
      risk: "high",
      scope: globalActionScope("All blacklist sync configurations"),
      dryRun: NO_DRY_RUN,
      expectedDuration: "Seconds; replay continues on scheduled syncs",
      preconditions: ["Use only when blacklist cursors require a controlled replay."],
      blockedBy: [],
      resultMode: "immediate",
      rollback: "No direct rollback; later syncs advance the rewound cursors.",
      runbookPath: "docs/data-pipeline.md",
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
      kind: "inspect",
      risk: "read-only",
      scope: globalActionScope("Blacklist sync state"),
      dryRun: NO_DRY_RUN,
      expectedDuration: "Seconds",
      preconditions: [],
      blockedBy: [],
      resultMode: "immediate",
      runbookPath: "docs/data-pipeline.md",
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
      kind: "repair",
      risk: "moderate",
      scope: assetOrBatchActionScope({
        assetIdentifier: "symbol",
        assetLabel: "Stablecoin symbol",
        assetPlaceholder: "e.g. USDT",
        batchLabel: "Bounded eligible gap rows",
        queryParam: "stablecoin",
      }),
      dryRun: {
        supported: true,
        default: true,
        liveSupported: true,
        queryParam: "dryRun",
      },
      expectedDuration: "Seconds to minutes; bounded to 200 rows",
      preconditions: ["Review the dry-run candidate and resolution counts before live remediation."],
      blockedBy: ["Live mode requires configured chain RPCs."],
      resultMode: "immediate",
      runbookPath: "docs/data-pipeline.md",
    },
  }),
  adminMutation({
    key: "backfill-blacklist-current-balances",
    path: API_PATHS.backfillBlacklistCurrentBalances(),
    routeDependencies: ["chainRpcs"],
    probeGroup: "manual",
    statusPageAction: {
      label: "Backfill Blacklist Balances",
      confirm: "Backfill current-balance cache for coins missing balance rows?",
      method: "POST",
      kind: "repair",
      risk: "moderate",
      scope: assetOrBatchActionScope({
        assetIdentifier: "symbol",
        assetLabel: "Stablecoin symbol",
        assetPlaceholder: "e.g. USDC",
        batchLabel: "All matching blacklist configurations",
        queryParam: "stablecoin",
      }),
      dryRun: {
        supported: true,
        default: true,
        liveSupported: true,
        queryParam: "dryRun",
      },
      expectedDuration: "Seconds to minutes; bounded per configuration",
      preconditions: ["Review the dry-run candidate totals before writing balance cache rows."],
      blockedBy: ["At least one active matching blacklist configuration is required."],
      resultMode: "immediate",
      runbookPath: "docs/data-pipeline.md",
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
      kind: "backfill",
      risk: "high",
      scope: assetOrBatchActionScope({
        assetIdentifier: "stablecoin-id",
        assetLabel: "Stablecoin ID",
        assetPlaceholder: "e.g. usdt-tether",
        batchLabel: "Bounded registry batch",
        queryParam: "stablecoin",
      }),
      dryRun: {
        supported: true,
        default: true,
        liveSupported: true,
        queryParam: "dry-run",
      },
      expectedDuration: "Several minutes per batch",
      preconditions: ["Review the planned event replacements in dry-run mode before writing."],
      blockedBy: ["Unknown targets and unavailable historical price inputs are rejected or reported."],
      resultMode: "immediate",
      runbookPath: "docs/depeg-detection.md",
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
      kind: "backfill",
      risk: "moderate",
      scope: assetOrBatchActionScope({
        assetIdentifier: "stablecoin-id",
        assetLabel: "Stablecoin ID",
        assetPlaceholder: "e.g. usdc-circle",
        batchLabel: "Bounded registry batch",
        queryParam: "stablecoin",
      }),
      dryRun: NO_DRY_RUN,
      expectedDuration: "Several minutes per batch",
      preconditions: ["Prefer a single asset for targeted repair; batch mode processes a bounded registry slice."],
      blockedBy: ["Unknown targets, invalid windows, and malformed continuation cursors are rejected."],
      resultMode: "continuation",
      runbookPath: "docs/data-pipeline.md",
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
      kind: "backfill",
      risk: "moderate",
      scope: assetOrBatchActionScope({
        assetIdentifier: "stablecoin-id",
        assetLabel: "Stablecoin ID",
        assetPlaceholder: "e.g. usdc-circle",
        batchLabel: "Bounded registry batch",
        queryParam: "stablecoin",
      }),
      dryRun: NO_DRY_RUN,
      expectedDuration: "Several minutes; CoinGecko requests are rate-limited",
      preconditions: ["Confirm the selected assets should fill missing historical price or market-cap rows."],
      blockedBy: ["Targets without a CoinGecko ID are skipped."],
      resultMode: "immediate",
      runbookPath: "docs/pricing-pipeline.md",
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
      kind: "backfill",
      risk: "low",
      scope: assetOrBatchActionScope({
        assetIdentifier: "stablecoin-id",
        assetLabel: "Stablecoin ID",
        assetPlaceholder: "e.g. zys-zephyr-protocol",
        batchLabel: "Supported protocol-history targets",
        queryParam: "stablecoin",
      }),
      dryRun: NO_DRY_RUN,
      expectedDuration: "Usually under a minute",
      preconditions: ["Use only for protocol-history sources explicitly supported by the handler."],
      blockedBy: ["Unsupported targets return no matching backfill rows."],
      resultMode: "immediate",
      runbookPath: "docs/yield-intelligence.md",
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
      kind: "backfill",
      risk: "high",
      scope: globalActionScope("Historical PSI daily table"),
      dryRun: {
        supported: true,
        default: true,
        liveSupported: true,
        queryParam: "dry-run",
      },
      expectedDuration: "Several minutes for the full historical window",
      preconditions: [
        "Repair supply, price, and DEWS history before rebuilding PSI.",
        "Review dry-run day and score-change counts before the live table swap.",
      ],
      blockedBy: ["No depeg history, an active PSI rebuild lease, or an invalid day window."],
      resultMode: "immediate",
      rollback: "Re-run a verified window; live mode swaps through a rebuild table.",
      runbookPath: "docs/stability-index.md",
    },
  }),
  adminMutation({
    key: "backfill-mint-burn-prices",
    path: API_PATHS.backfillMintBurnPrices(),
    routeDependencies: ["coingeckoApiKey"],
    probeGroup: "manual",
    statusPageAction: {
      label: "Preview Mint/Burn Price Repair",
      confirm: "Preview historical mint/burn USD price repairs for NULL events?",
      method: "POST",
      group: "audit",
      kind: "inspect",
      risk: "high",
      scope: assetOrBatchActionScope({
        assetIdentifier: "stablecoin-id",
        assetLabel: "Stablecoin ID",
        assetPlaceholder: "e.g. usdc-circle",
        batchLabel: "Bounded NULL-price backlog",
        queryParam: "stablecoin",
      }),
      dryRun: {
        supported: true,
        default: true,
        liveSupported: false,
        queryParam: "dry-run",
      },
      expectedDuration: "Seconds to minutes; bounded repair preview",
      preconditions: [
        "This generic control is preview-only.",
        "Live repair requires the preview bookmark and endpoint execution confirmation.",
      ],
      blockedBy: ["Live mode requires a fresh bookmark and an idempotency key."],
      resultMode: "immediate",
      runbookPath: "docs/mint-burn-flows.md",
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
      kind: "backfill",
      risk: "high",
      scope: automaticActionScope("Most-behind eligible mint/burn configuration"),
      dryRun: NO_DRY_RUN,
      expectedDuration: "Several minutes; bounded to 24 chunks by default",
      preconditions: ["Confirm automatic critical-first target selection is appropriate for the incident."],
      blockedBy: ["Alchemy credentials and a supported chain URL are required."],
      resultMode: "continuation",
      runbookPath: "docs/mint-burn-flows.md",
    },
  }),
  adminMutation({
    key: "backfill-tape",
    path: API_PATHS.backfillTape(),
    probeGroup: "manual",
    statusPageAction: {
      label: "Backfill Tape",
      confirm: "Re-run tape projectors for selected classes?",
      method: "POST",
      kind: "backfill",
      risk: "moderate",
      scope: globalActionScope("All tape projector classes"),
      dryRun: {
        supported: true,
        default: true,
        liveSupported: true,
        queryParam: "dryRun",
      },
      expectedDuration: "Seconds to minutes, depending on projector backlog",
      preconditions: ["Review per-class dry-run counts before advancing projector watermarks."],
      blockedBy: [],
      resultMode: "immediate",
      rollback: "Projector writes are idempotent; rerun the corrected scope when needed.",
      runbookPath: "docs/data-pipeline.md",
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
      kind: "repair",
      risk: "high",
      scope: assetOrBatchActionScope({
        assetIdentifier: "stablecoin-id",
        assetLabel: "Stablecoin ID",
        assetPlaceholder: "e.g. usdc-circle",
        batchLabel: "Default 90-day mint/burn window",
        queryParam: "stablecoinId",
      }),
      dryRun: NO_DRY_RUN,
      expectedDuration: "Seconds to minutes; 1,000 groups per pass",
      preconditions: ["Prefer single-asset scope when the roundtrip partition is large."],
      blockedBy: ["Broad or unbounded scans can exceed D1 statement CPU limits."],
      resultMode: "continuation",
      rollback: "Rerunning applies both forward and reverse amount-tolerance checks.",
      runbookPath: "docs/mint-burn-flows.md",
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
      confirm: "Audit depeg history and review possible provenance repairs?",
      method: "GET",
      path: API_PATHS.auditDepegHistoryDryRun(),
      group: "audit",
      kind: "repair",
      risk: "high",
      scope: assetOrBatchActionScope({
        assetIdentifier: "symbol",
        assetLabel: "Stablecoin symbol",
        assetPlaceholder: "e.g. USDT",
        batchLabel: "Bounded closed-depeg audit batch",
        queryParam: "symbol",
      }),
      dryRun: {
        supported: true,
        default: true,
        liveSupported: true,
        queryParam: "dry-run",
        dryRunMethod: "GET",
        liveMethod: "POST",
      },
      expectedDuration: "Seconds; proxy timeout is 45 seconds",
      preconditions: ["Review the audit preview before persisting provenance verdicts or repairs."],
      blockedBy: ["Mutations that touch sealed DDRv2 events require the explicit repair migration path."],
      resultMode: "immediate",
      rollback: "No generic rollback exists for persisted audit repairs.",
      runbookPath: "docs/depeg-detection.md",
    },
  }),
  adminDualModeMutation({
    key: "backfill-dews",
    path: API_PATHS.backfillDews(),
    probeGroup: "manual",
    statusPageAction: {
      label: "Validate DEWS History",
      confirm: "Run the read-only DEWS historical backtest?",
      method: "GET",
      group: "audit",
      kind: "inspect",
      risk: "read-only",
      scope: globalActionScope("Completed depeg-event history"),
      dryRun: NO_DRY_RUN,
      expectedDuration: "Seconds to minutes",
      preconditions: ["Completed depeg events and historical supply/liquidity inputs must exist."],
      blockedBy: ["The endpoint returns no result when completed depeg history is unavailable."],
      resultMode: "immediate",
      runbookPath: "docs/dews.md",
    },
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
    key: "reserve-recovery-fault-injection",
    path: API_PATHS.armReserveRecoveryFaultInjection(),
    routeDependencies: ["workerVersion"],
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
    routeDependencies: [],
    probeGroup: "manual",
  }),
  adminMutation({
    key: "admin-telegram-broadcast",
    path: API_PATHS.adminTelegramBroadcast(),
    routeDependencies: ["telegram"],
    probeGroup: "manual",
  }),
  adminDualModeMutation({
    key: "admin-telegram-delivery-control",
    path: API_PATHS.adminTelegramDeliveryControl(),
    probeGroup: "manual",
  }),
  adminGet({
    key: "admin-telegram-adoption-report",
    path: API_PATHS.adminTelegramAdoptionReport(),
    probeGroup: "admin",
  }),
  adminGet({
    key: "admin-safety-score-v9",
    path: API_PATHS.adminSafetyScoreV9(),
  }),
  adminMutation({
    key: "admin-safety-score-v9-review",
    path: API_PATHS.adminSafetyScoreV9Review(),
    probeGroup: "manual",
  }),
  adminMutation({
    key: "admin-safety-score-v9-history-boundary",
    path: API_PATHS.adminSafetyScoreV9HistoryBoundary(),
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

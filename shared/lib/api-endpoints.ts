type EndpointMethod = "GET" | "POST";
export type EndpointProbeGroup = "public" | "admin" | "manual";

interface EndpointStatusPageActionConfig {
  label: string;
  confirm: string;
  destructive?: boolean;
  method: EndpointMethod;
  path?: string;
}

interface EndpointDefinition {
  path: string;
  methods: readonly EndpointMethod[];
  adminRequired: boolean;
  mutatingAdmin: boolean;
  cacheBypass: boolean;
  strictContract?: boolean;
  handlerKey?: string;
  routerHandled?: boolean;
  probeGroup?: EndpointProbeGroup;
  probePath?: string;
  statusPageAction?: EndpointStatusPageActionConfig;
}

export interface StatusPageAction {
  label: string;
  path: string;
  confirm: string;
  destructive: boolean;
  method: EndpointMethod;
}

interface EndpointMethodValidationError {
  message: string;
  allowedMethods: readonly EndpointMethod[];
}

export const ENDPOINT_DEFINITIONS: readonly EndpointDefinition[] = [
  // Public endpoints probed by the status dashboard.
  {
    path: "/api/stablecoins",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    strictContract: true,
    handlerKey: "stablecoins",
    probeGroup: "public",
  },
  {
    path: "/api/stablecoin/usdt-tether",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    handlerKey: "stablecoin-probe-detail",
    probeGroup: "public",
  },
  {
    path: "/api/stablecoin-summary/usdt-tether",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    handlerKey: "stablecoin-probe-summary",
    probeGroup: "public",
  },
  {
    path: "/api/stablecoin-charts",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    handlerKey: "stablecoin-charts",
    probeGroup: "public",
  },
  {
    path: "/api/peg-summary",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    strictContract: true,
    handlerKey: "peg-summary",
    probeGroup: "public",
  },
  {
    path: "/api/health",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: true,
    handlerKey: "health",
    probeGroup: "public",
  },
  {
    path: "/api/blacklist",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    handlerKey: "blacklist",
    probeGroup: "public",
  },
  {
    path: "/api/depeg-events",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    handlerKey: "depeg-events",
    probeGroup: "public",
  },
  {
    path: "/api/usds-status",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    handlerKey: "usds-status",
    probeGroup: "public",
  },
  {
    path: "/api/bluechip-ratings",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    handlerKey: "bluechip-ratings",
    probeGroup: "public",
  },
  {
    path: "/api/dex-liquidity",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    strictContract: true,
    handlerKey: "dex-liquidity",
    probeGroup: "public",
  },
  {
    path: "/api/dex-liquidity-history",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    handlerKey: "dex-liquidity-history",
    probeGroup: "public",
    probePath: "/api/dex-liquidity-history?stablecoin=usdt-tether",
  },
  {
    path: "/api/supply-history",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    handlerKey: "supply-history",
    probeGroup: "public",
    probePath: "/api/supply-history?stablecoin=usdt-tether",
  },
  {
    path: "/api/daily-digest",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    handlerKey: "daily-digest",
    probeGroup: "public",
  },
  {
    path: "/api/digest-archive",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    handlerKey: "digest-archive",
    probeGroup: "public",
  },
  {
    path: "/api/digest-snapshot",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    handlerKey: "digest-snapshot",
    // Requires a date-specific snapshot that is not stable enough for a generic canary probe.
  },
  {
    path: "/api/yield-rankings",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    handlerKey: "yield-rankings",
    probeGroup: "public",
  },
  {
    path: "/api/yield-history",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    handlerKey: "yield-history",
    probeGroup: "public",
    probePath: "/api/yield-history?stablecoin=usdt-tether",
  },
  {
    path: "/api/safety-score-history",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    handlerKey: "safety-score-history",
    probeGroup: "public",
    probePath: "/api/safety-score-history?stablecoin=usdt-tether",
  },
  {
    path: "/api/stability-index",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    strictContract: true,
    handlerKey: "stability-index",
    probeGroup: "public",
  },
  {
    path: "/api/report-cards",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    strictContract: true,
    handlerKey: "report-cards",
    probeGroup: "public",
  },
  {
    path: "/api/mint-burn-flows",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    strictContract: true,
    handlerKey: "mint-burn-flows",
    probeGroup: "public",
  },
  {
    path: "/api/mint-burn-events",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    handlerKey: "mint-burn-events",
    probeGroup: "public",
    probePath: "/api/mint-burn-events?stablecoin=usdt-tether",
  },
  {
    path: "/api/stress-signals",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    strictContract: true,
    handlerKey: "stress-signals",
    probeGroup: "public",
  },
  {
    path: "/api/feedback",
    methods: ["POST"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: true,
    handlerKey: "feedback",
  },
  {
    path: "/api/telegram-webhook",
    methods: ["POST"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: true,
    handlerKey: "telegram-webhook",
  },

  // Admin status/probe endpoints.
  {
    path: "/api/status",
    methods: ["GET"],
    adminRequired: true,
    mutatingAdmin: false,
    cacheBypass: true,
    handlerKey: "status",
    probeGroup: "admin",
  },
  {
    path: "/api/status-history",
    methods: ["GET"],
    adminRequired: true,
    mutatingAdmin: false,
    cacheBypass: true,
    handlerKey: "status-history",
    probeGroup: "admin",
    probePath: "/api/status-history?limit=10",
  },
  {
    path: "/api/trigger-digest",
    methods: ["POST"],
    adminRequired: true,
    mutatingAdmin: true,
    cacheBypass: false,
    handlerKey: "trigger-digest",
    probeGroup: "manual",
    statusPageAction: {
      label: "Trigger Digest",
      confirm: "Trigger daily digest? Bypasses 1h dedup window.",
      method: "POST",
    },
  },
  {
    path: "/api/reset-blacklist-sync",
    methods: ["POST"],
    adminRequired: true,
    mutatingAdmin: true,
    cacheBypass: false,
    handlerKey: "reset-blacklist-sync",
    probeGroup: "manual",
    statusPageAction: {
      label: "Reset Blacklist Sync",
      confirm: "Reset blacklist sync? Rolls back EVM 50k blocks, Tron 7 days.",
      destructive: true,
      method: "POST",
    },
  },
  {
    path: "/api/debug-sync-state",
    methods: ["GET"],
    adminRequired: true,
    mutatingAdmin: false,
    cacheBypass: true,
    handlerKey: "debug-sync-state",
    probeGroup: "admin",
    statusPageAction: {
      label: "Debug Sync State",
      confirm: "Fetch sync state debug dump?",
      method: "GET",
    },
  },
  {
    path: "/api/backfill-depegs",
    methods: ["POST"],
    adminRequired: true,
    mutatingAdmin: true,
    cacheBypass: true,
    handlerKey: "backfill-depegs",
    probeGroup: "manual",
    statusPageAction: {
      label: "Backfill Depegs",
      confirm: "Run depeg backfill? This may take several minutes.",
      method: "POST",
    },
  },
  {
    path: "/api/backfill-supply-history",
    methods: ["POST"],
    adminRequired: true,
    mutatingAdmin: true,
    cacheBypass: true,
    handlerKey: "backfill-supply-history",
    probeGroup: "manual",
    statusPageAction: {
      label: "Backfill Supply",
      confirm: "Backfill supply history snapshots?",
      method: "POST",
    },
  },
  {
    path: "/api/backfill-cg-prices",
    methods: ["POST"],
    adminRequired: true,
    mutatingAdmin: true,
    cacheBypass: true,
    handlerKey: "backfill-cg-prices",
    probeGroup: "manual",
    statusPageAction: {
      label: "Backfill CG Prices",
      confirm: "Backfill CoinGecko prices?",
      method: "POST",
    },
  },
  {
    path: "/api/backfill-stability-index",
    methods: ["POST"],
    adminRequired: true,
    mutatingAdmin: true,
    cacheBypass: true,
    handlerKey: "backfill-stability-index",
    probeGroup: "manual",
    statusPageAction: {
      label: "Backfill PSI",
      confirm: "Backfill stability index history?",
      method: "POST",
    },
  },
  {
    path: "/api/backfill-mint-burn-prices",
    methods: ["POST"],
    adminRequired: true,
    mutatingAdmin: true,
    cacheBypass: true,
    handlerKey: "backfill-mint-burn-prices",
    probeGroup: "manual",
    statusPageAction: {
      label: "Backfill Mint/Burn Prices",
      confirm: "Backfill mint/burn USD prices for NULL events?",
      method: "POST",
    },
  },
  {
    path: "/api/backfill-mint-burn",
    methods: ["POST"],
    adminRequired: true,
    mutatingAdmin: true,
    cacheBypass: true,
    handlerKey: "backfill-mint-burn",
    probeGroup: "manual",
    statusPageAction: {
      label: "Backfill Mint/Burn",
      confirm: "Run mint/burn backfill job?",
      method: "POST",
    },
  },
  {
    path: "/api/reclassify-atomic-roundtrips",
    methods: ["POST"],
    adminRequired: true,
    mutatingAdmin: true,
    cacheBypass: true,
    handlerKey: "reclassify-atomic-roundtrips",
    probeGroup: "manual",
  },
  {
    path: "/api/audit-depeg-history",
    methods: ["GET", "POST"],
    adminRequired: true,
    mutatingAdmin: true,
    cacheBypass: true,
    handlerKey: "audit-depeg-history",
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
    path: "/api/backfill-dews",
    methods: ["GET"],
    adminRequired: true,
    mutatingAdmin: false,
    cacheBypass: true,
    handlerKey: "backfill-dews",
    probeGroup: "manual",
    statusPageAction: {
      label: "Backfill DEWS",
      confirm: "Run DEWS historical backfill validation?",
      method: "GET",
    },
  },
] as const;

const ENDPOINT_DEFINITION_BY_PATH = new Map<string, EndpointDefinition>(
  ENDPOINT_DEFINITIONS.map((endpoint) => [endpoint.path, endpoint]),
);

const STABLECOIN_DETAIL_PATH_PATTERN = /^\/api\/stablecoin\/[^/]+$/;
const STABLECOIN_SUMMARY_PATH_PATTERN = /^\/api\/stablecoin-summary\/[^/]+$/;
const OG_IMAGE_PATH_PATTERN = /^\/api\/og\//;
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

const ROUTER_HANDLED_ENDPOINTS = ENDPOINT_DEFINITIONS.filter(
  (endpoint) => endpoint.routerHandled !== false && endpoint.handlerKey,
);
const ROUTER_HANDLED_PATHS = ROUTER_HANDLED_ENDPOINTS.map(
  (endpoint) => endpoint.path,
);

export function isMutatingAdminPath(path: string): boolean {
  return MUTATING_ADMIN_PATHS.has(path);
}

export function isCacheBypassPath(path: string): boolean {
  return CACHE_BYPASS_PATHS.has(path);
}

export function getRouterHandledPaths(): readonly string[] {
  return ROUTER_HANDLED_PATHS;
}

export function getRouterHandledEndpoints(): readonly EndpointDefinition[] {
  return ROUTER_HANDLED_ENDPOINTS;
}

export function getEndpointDefinition(path: string): EndpointDefinition | undefined {
  return ENDPOINT_DEFINITION_BY_PATH.get(path);
}

export function getStrictContractPaths(): readonly string[] {
  return STRICT_CONTRACT_PATHS;
}

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
      },
    ];
  });
}

export type EndpointMethod = "GET" | "POST";
export type EndpointProbeGroup = "public" | "admin" | "manual";

interface EndpointStatusPageActionConfig {
  label: string;
  confirm: string;
  destructive?: boolean;
  method: EndpointMethod;
  path?: string;
}

export interface EndpointDefinition {
  path: string;
  methods: readonly EndpointMethod[];
  adminRequired: boolean;
  mutatingAdmin: boolean;
  cacheBypass: boolean;
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

export const ENDPOINT_DEFINITIONS: readonly EndpointDefinition[] = [
  // Public endpoints probed by the status dashboard.
  {
    path: "/api/stablecoins",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
  },
  {
    path: "/api/stablecoin/1",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
  },
  {
    path: "/api/stablecoin-charts",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
  },
  {
    path: "/api/peg-summary",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
  },
  {
    path: "/api/health",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: true,
    probeGroup: "public",
  },
  {
    path: "/api/blacklist",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
  },
  {
    path: "/api/depeg-events",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
  },
  {
    path: "/api/usds-status",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
  },
  {
    path: "/api/bluechip-ratings",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
  },
  {
    path: "/api/dex-liquidity",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
  },
  {
    path: "/api/dex-liquidity-history",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
    probePath: "/api/dex-liquidity-history?stablecoin=1",
  },
  {
    path: "/api/supply-history",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
    probePath: "/api/supply-history?stablecoin=1",
  },
  {
    path: "/api/daily-digest",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
  },
  {
    path: "/api/digest-archive",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
  },
  {
    path: "/api/yield-rankings",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
  },
  {
    path: "/api/yield-history",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
    probePath: "/api/yield-history?stablecoin=1",
  },
  {
    path: "/api/stability-index",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
  },
  {
    path: "/api/report-cards",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
  },
  {
    path: "/api/mint-burn-flows",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
  },
  {
    path: "/api/mint-burn-events",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
    probePath: "/api/mint-burn-events?stablecoin=1",
  },
  {
    path: "/api/stress-signals",
    methods: ["GET"],
    adminRequired: false,
    mutatingAdmin: false,
    cacheBypass: false,
    probeGroup: "public",
  },

  // Admin status/probe endpoints.
  {
    path: "/api/status",
    methods: ["GET"],
    adminRequired: true,
    mutatingAdmin: false,
    cacheBypass: true,
    probeGroup: "admin",
  },
  {
    path: "/api/status-history",
    methods: ["GET"],
    adminRequired: true,
    mutatingAdmin: false,
    cacheBypass: true,
    probeGroup: "admin",
    probePath: "/api/status-history?limit=10",
  },
  {
    path: "/api/trigger-digest",
    methods: ["POST"],
    adminRequired: true,
    mutatingAdmin: true,
    cacheBypass: false,
    routerHandled: false,
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
    routerHandled: false,
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
    cacheBypass: false,
    routerHandled: false,
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
    probeGroup: "manual",
    statusPageAction: {
      label: "Backfill Mint/Burn",
      confirm: "Run mint/burn backfill job?",
      method: "POST",
    },
  },
  {
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
] as const;

const MUTATING_ADMIN_PATHS = new Set<string>(
  ENDPOINT_DEFINITIONS.filter((endpoint) => endpoint.mutatingAdmin).map((endpoint) => endpoint.path),
);

const CACHE_BYPASS_PATHS = new Set<string>(
  ENDPOINT_DEFINITIONS.filter((endpoint) => endpoint.cacheBypass).map((endpoint) => endpoint.path),
);

export function isMutatingAdminPath(path: string): boolean {
  return MUTATING_ADMIN_PATHS.has(path);
}

export function isCacheBypassPath(path: string): boolean {
  return CACHE_BYPASS_PATHS.has(path);
}

export function getProbePaths(group: EndpointProbeGroup): string[] {
  return ENDPOINT_DEFINITIONS
    .filter((endpoint) => endpoint.probeGroup === group)
    .map((endpoint) => endpoint.probePath ?? endpoint.path);
}

export function getStatusPageActions(): StatusPageAction[] {
  return ENDPOINT_DEFINITIONS.flatMap((endpoint) => {
    if (!endpoint.statusPageAction) return [];
    return [{
      label: endpoint.statusPageAction.label,
      path: endpoint.statusPageAction.path ?? endpoint.probePath ?? endpoint.path,
      confirm: endpoint.statusPageAction.confirm,
      destructive: endpoint.statusPageAction.destructive ?? false,
      method: endpoint.statusPageAction.method,
    }];
  });
}

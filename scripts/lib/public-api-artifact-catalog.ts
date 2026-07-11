import { API_PATHS } from "../../shared/lib/api-endpoints/paths";
import { BLACKLIST_STABLECOINS } from "../../shared/types/market";

export type QueryParamType = "string" | "integer" | "number" | "boolean";

export interface PublicApiArtifactParameter {
  name: string;
  in: "path" | "query";
  required?: boolean;
  schema: { type: QueryParamType; enum?: string[]; minimum?: number; maximum?: number };
  description: string;
}

export interface PublicApiArtifactEndpoint {
  key: string;
  path: string;
  summary: string;
  description: string;
  tags: readonly string[];
  security?: "apiKey" | "none";
  responseSchema?: string;
  parameters?: readonly PublicApiArtifactParameter[];
  postman?: PostmanRequestConfig | readonly PostmanRequestConfig[];
}

export interface PostmanRequestConfig {
  folder: PostmanFolderName;
  order?: number;
  name?: string;
  path?: string;
  description?: string;
  query?: Record<string, string>;
  noAuth?: boolean;
}

interface PostmanStaticRequest {
  name: string;
  path: string;
  description: string;
  noAuth: true;
  base: "site";
}

export type PostmanFolderName =
  | "Getting started"
  | "Risk and market structure"
  | "Flows, blacklist, yield, and chains"
  | "Status"
  | "Historical data"
  | "Static datasets";

export const PUBLIC_API_ARTIFACT_TAGS = [
  "Health",
  "Stablecoins",
  "Peg Monitoring",
  "Liquidity",
  "Risk",
  "Blacklist",
  "Flows",
  "Yield",
  "Chains",
  "Market Structure",
  "History",
  "Digest",
  "Status",
  "Reserves",
] as const;

export const POSTMAN_FOLDERS: readonly { name: PostmanFolderName; description: string }[] = [
  {
    name: "Getting started",
    description: "Basic canaries and high-level market reads.",
  },
  {
    name: "Risk and market structure",
    description: "Stablecoin risk, peg, liquidity, flow, and dependency data.",
  },
  {
    name: "Flows, blacklist, yield, and chains",
    description: "Operational and market-structure surfaces beyond price and peg data.",
  },
  {
    name: "Status",
    description: "Public operational status surfaces.",
  },
  {
    name: "Historical data",
    description: "Per-asset and archive endpoints that should be polled less frequently.",
  },
  {
    name: "Static datasets",
    description: "Website-hosted public datasets. These do not require a Pharos API key.",
  },
] as const;

export const STABLECOIN_ID_PARAM = {
  name: "stablecoinId",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "Canonical Pharos stablecoin ID, for example `usdt-tether` or `usdc-circle`.",
} as const satisfies PublicApiArtifactParameter;

export const STABLECOIN_QUERY_PARAM = {
  name: "stablecoin",
  in: "query",
  schema: { type: "string" },
  description: "Optional canonical Pharos stablecoin ID filter.",
} as const satisfies PublicApiArtifactParameter;

export const REQUIRED_STABLECOIN_QUERY_PARAM = {
  name: "stablecoin",
  in: "query",
  required: true,
  schema: { type: "string" },
  description: "Required canonical Pharos stablecoin ID.",
} as const satisfies PublicApiArtifactParameter;

export const BLACKLIST_STABLECOIN_SYMBOL_QUERY_PARAM = {
  name: "stablecoin",
  in: "query",
  schema: { type: "string", enum: [...BLACKLIST_STABLECOINS] },
  description: "Optional uppercase blacklist-tracker stablecoin symbol filter, for example `USDT` or `USDC`.",
} as const satisfies PublicApiArtifactParameter;

export const DAYS_PARAM = {
  name: "days",
  in: "query",
  schema: { type: "integer", minimum: 1 },
  description: "Historical lookback window in days. Endpoint-specific bounds may apply.",
} as const satisfies PublicApiArtifactParameter;

export const DEX_LIQUIDITY_HISTORY_DAYS_PARAM = {
  name: "days",
  in: "query",
  schema: { type: "integer", minimum: 1, maximum: 365 },
  description: "Historical lookback window in days. Defaults to 90.",
} as const satisfies PublicApiArtifactParameter;

export const SUPPLY_HISTORY_DAYS_PARAM = {
  name: "days",
  in: "query",
  schema: { type: "integer", minimum: 1, maximum: 5000 },
  description: "Historical lookback window in days. Defaults to 365.",
} as const satisfies PublicApiArtifactParameter;

export const NON_USD_SHARE_DAYS_PARAM = {
  name: "days",
  in: "query",
  schema: { type: "integer", minimum: 30, maximum: 5000 },
  description: "Historical lookback window in days. Defaults to 5000; `0` maps to the default.",
} as const satisfies PublicApiArtifactParameter;

export const SAFETY_SCORE_HISTORY_DAYS_PARAM = {
  name: "days",
  in: "query",
  schema: { type: "integer", minimum: 1, maximum: 3650 },
  description: "Historical lookback window in days. Defaults to 365.",
} as const satisfies PublicApiArtifactParameter;

export const YIELD_HISTORY_MODE_PARAM = {
  name: "mode",
  in: "query",
  schema: { type: "string", enum: ["best", "source"] },
  description: "History mode. `best` returns historically selected best-source rows; `source` requires `sourceKey`.",
} as const satisfies PublicApiArtifactParameter;

export const HOURS_PARAM = {
  name: "hours",
  in: "query",
  schema: { type: "integer", minimum: 1, maximum: 720 },
  description: "Historical lookback window in hours. Defaults to 24.",
} as const satisfies PublicApiArtifactParameter;

export const LIMIT_PARAM = {
  name: "limit",
  in: "query",
  schema: { type: "integer", minimum: 1 },
  description: "Maximum number of records to return.",
} as const satisfies PublicApiArtifactParameter;

const STABLECOIN_ID_TOKEN = "__stablecoinId__";
const stablecoinPathTemplate = (path: string) => path.replace(STABLECOIN_ID_TOKEN, "{stablecoinId}");
const stablecoinPostmanPath = (path: string, variable = "stablecoinId") =>
  path.replace(STABLECOIN_ID_TOKEN, `{{${variable}}}`);

const SNAPSHOT_DATE_TOKEN = "__snapshotDate__";
const snapshotPathTemplate = (path: string) =>
  path.replace(SNAPSHOT_DATE_TOKEN, "{date}").replace(STABLECOIN_ID_TOKEN, "{stablecoinId}");
const snapshotPostmanPath = (path: string) =>
  path
    .replace(SNAPSHOT_DATE_TOKEN, "{{snapshotDate}}")
    .replace(STABLECOIN_ID_TOKEN, "{{stablecoinId}}");

export const PUBLIC_API_ARTIFACT_ENDPOINTS = [
  {
    key: "health",
    path: API_PATHS.health(),
    summary: "Health check",
    description: "No-key health check for the public API host.",
    tags: ["Health"],
    security: "none",
    postman: {
      folder: "Getting started",
      noAuth: true,
    },
  },
  {
    key: "stablecoins",
    path: API_PATHS.stablecoins(),
    summary: "List stablecoins",
    description: "Current stablecoin list with supply, price, peg, chain distribution, and freshness headers.",
    tags: ["Stablecoins"],
    postman: {
      folder: "Getting started",
      name: "Stablecoins list",
    },
  },
  {
    key: "stablecoin-detail",
    path: stablecoinPathTemplate(API_PATHS.stablecoinDetail(STABLECOIN_ID_TOKEN)),
    summary: "Stablecoin detail",
    description: "Full per-coin analytics dossier for a canonical Pharos stablecoin ID.",
    tags: ["Stablecoins"],
    parameters: [STABLECOIN_ID_PARAM],
    postman: {
      folder: "Getting started",
      path: stablecoinPostmanPath(API_PATHS.stablecoinDetail(STABLECOIN_ID_TOKEN)),
    },
  },
  {
    key: "stablecoin-summary",
    path: stablecoinPathTemplate(API_PATHS.stablecoinSummary(STABLECOIN_ID_TOKEN)),
    summary: "Stablecoin summary",
    description: "Lightweight per-coin price and aggregate supply snapshot.",
    tags: ["Stablecoins"],
    parameters: [STABLECOIN_ID_PARAM],
    postman: {
      folder: "Getting started",
      path: stablecoinPostmanPath(API_PATHS.stablecoinSummary(STABLECOIN_ID_TOKEN)),
    },
  },
  {
    key: "stablecoin-reserves",
    path: stablecoinPathTemplate(API_PATHS.stablecoinReserves(STABLECOIN_ID_TOKEN)),
    summary: "Stablecoin reserves",
    description: "Live or fallback reserve composition for live-reserve-enabled assets.",
    tags: ["Stablecoins", "Reserves"],
    parameters: [STABLECOIN_ID_PARAM],
    postman: {
      folder: "Getting started",
      path: stablecoinPostmanPath(API_PATHS.stablecoinReserves(STABLECOIN_ID_TOKEN), "reserveStablecoinId"),
    },
  },
  {
    key: "stablecoin-charts",
    path: API_PATHS.stablecoinCharts(),
    summary: "Stablecoin charts",
    description: "Historical total supply chart data.",
    tags: ["Stablecoins", "History"],
    postman: {
      folder: "Getting started",
    },
  },
  {
    key: "peg-summary",
    path: API_PATHS.pegSummary(),
    summary: "Peg summary",
    description: "Per-coin peg scores plus aggregate peg-monitoring summary.",
    tags: ["Peg Monitoring"],
    postman: {
      folder: "Risk and market structure",
    },
  },
  {
    key: "depeg-events",
    path: API_PATHS.depegEvents(),
    summary: "Depeg events",
    description: "Historical and active depeg events, filterable by stablecoin.",
    tags: ["Peg Monitoring"],
    parameters: [
      STABLECOIN_QUERY_PARAM,
      LIMIT_PARAM,
      {
        name: "offset",
        in: "query",
        schema: { type: "integer", minimum: 0 },
        description: "Pagination offset.",
      },
      {
        name: "cursor",
        in: "query",
        schema: { type: "string" },
        description: "Opaque keyset cursor returned as nextCursor.",
      },
      {
        name: "active",
        in: "query",
        schema: { type: "boolean" },
        description: "When true, returns active depeg events only.",
      },
      {
        name: "includeTotal",
        in: "query",
        schema: { type: "boolean" },
        description: "When false, skips the exact total count.",
      },
      {
        name: "includePending",
        in: "query",
        schema: { type: "boolean" },
        description: "When true, includes pending incidents awaiting confirmation.",
      },
    ],
    postman: {
      folder: "Risk and market structure",
      query: { stablecoin: "{{stablecoinId}}", limit: "{{limit}}", offset: "0" },
    },
  },
  {
    key: "events",
    path: API_PATHS.events(),
    summary: "Tape events",
    description:
      "Materialized chronological feed of typed events (depeg, freeze, score) backed by the tape_events table. Supports filtering by type, coin, severity floor, and time window, plus keyset pagination.",
    tags: ["Risk"],
    parameters: [
      {
        name: "type",
        in: "query",
        schema: { type: "string" },
        description: "Repeatable: exact event slug (e.g. depeg.opened) or prefix wildcard (depeg.*).",
      },
      {
        name: "class",
        in: "query",
        schema: { type: "string" },
        description: "Shortcut for type=<class>.* (e.g. class=depeg).",
      },
      {
        name: "coin",
        in: "query",
        schema: { type: "string" },
        description: "Repeatable canonical stablecoin id filter.",
      },
      {
        name: "pegCurrency",
        in: "query",
        schema: { type: "string" },
        description: "Filter to events for a specific peg currency.",
      },
      {
        name: "chain",
        in: "query",
        schema: { type: "string" },
        description: "Filter to events on a specific chain.",
      },
      {
        name: "q",
        in: "query",
        schema: { type: "string" },
        description: "Case-insensitive free-text search filter (trimmed and lowercased).",
      },
      {
        name: "severityFloor",
        in: "query",
        schema: { type: "string", enum: ["info", "notice", "warning", "severe", "critical"] },
        description: "Drop events below this severity.",
      },
      {
        name: "since",
        in: "query",
        schema: { type: "integer" },
        description: "Lower bound on ts (epoch ms, inclusive).",
      },
      {
        name: "until",
        in: "query",
        schema: { type: "integer" },
        description: "Upper bound on ts (epoch ms, inclusive).",
      },
      {
        name: "cursor",
        in: "query",
        schema: { type: "string" },
        description: "Opaque keyset cursor returned as nextCursor.",
      },
      {
        name: "limit",
        in: "query",
        schema: { type: "integer", minimum: 1, maximum: 500 },
        description: "Default 50, max 500.",
      },
      {
        name: "includeTotal",
        in: "query",
        schema: { type: "boolean" },
        description: "When true, computes the exact total count.",
      },
    ],
    postman: {
      folder: "Risk and market structure",
      query: { limit: "50" },
    },
  },
  {
    key: "usds-status",
    path: API_PATHS.usdsStatus(),
    summary: "USDS freeze status",
    description: "Sky/USDS protocol status, including whether the freeze module is currently active.",
    tags: ["Risk"],
    postman: {
      folder: "Risk and market structure",
    },
  },
  {
    key: "bluechip-ratings",
    path: API_PATHS.bluechipRatings(),
    summary: "Bluechip ratings",
    description: "Safety ratings from bluechip.org for covered stablecoins.",
    tags: ["Risk"],
    postman: {
      folder: "Risk and market structure",
    },
  },
  {
    key: "dex-liquidity",
    path: API_PATHS.dexLiquidity(),
    summary: "DEX liquidity",
    description: "DEX liquidity scores, top pools, chain/protocol breakdowns, and quality metadata.",
    tags: ["Liquidity"],
    postman: {
      folder: "Risk and market structure",
    },
  },
  {
    key: "dex-liquidity-history",
    path: API_PATHS.dexLiquidityHistoryBase(),
    summary: "DEX liquidity history",
    description: "Historical liquidity-score data for a stablecoin.",
    tags: ["Liquidity", "History"],
    parameters: [REQUIRED_STABLECOIN_QUERY_PARAM, DEX_LIQUIDITY_HISTORY_DAYS_PARAM],
    postman: {
      folder: "Historical data",
      order: 1,
      query: { stablecoin: "{{stablecoinId}}", days: "{{days}}" },
    },
  },
  {
    key: "report-cards",
    path: API_PATHS.reportCards(),
    summary: "Report cards",
    description: "Safety report-card snapshot across liquidity, resilience, decentralization, dependency, and peg stability.",
    tags: ["Risk"],
    postman: {
      folder: "Risk and market structure",
    },
  },
  {
    key: "depeg-resolver",
    path: API_PATHS.depegResolver(),
    summary: "Depeg Duration Resolver",
    description:
      "Per active confirmed depeg: a mechanistic resolution outlook (terminal vs recoverable) and a stratified empirical duration estimate with per-horizon resolution likelihood.",
    tags: ["Risk", "Peg Monitoring"],
    postman: {
      folder: "Risk and market structure",
    },
  },
  {
    key: "depeg-resolver-review",
    path: API_PATHS.depegResolverReview(),
    summary: "Depeg Duration Resolver Reviewer",
    description:
      "Review of stored DDR predictions against later depeg-event outcomes, including recovery-likelihood accuracy and observed-minus-predicted recovery duration error.",
    tags: ["Risk", "Peg Monitoring"],
    postman: {
      folder: "Risk and market structure",
    },
  },
  {
    key: "redemption-backstops",
    path: API_PATHS.redemptionBackstops(),
    summary: "Redemption backstops",
    description: "Modeled issuer/protocol redemption routes and effective-exit scoring for configured assets.",
    tags: ["Risk", "Reserves"],
    postman: {
      folder: "Risk and market structure",
    },
  },
  {
    key: "stress-signals",
    path: API_PATHS.stressSignalsBase(),
    summary: "Stress signals",
    description: "DEWS-style stress signals for the stablecoin universe or one selected asset.",
    tags: ["Risk", "Peg Monitoring"],
    parameters: [STABLECOIN_QUERY_PARAM, DAYS_PARAM],
    postman: {
      folder: "Risk and market structure",
      query: { stablecoin: "{{stablecoinId}}", days: "{{days}}" },
    },
  },
  {
    key: "stability-index",
    path: API_PATHS.stabilityIndex(),
    summary: "Pharos Stability Index",
    description: "Latest Pharos Stability Index with optional detail payload and history.",
    tags: ["Risk"],
    parameters: [
      {
        name: "detail",
        in: "query",
        schema: { type: "boolean" },
        description: "When true, includes detailed input components.",
      },
    ],
    postman: {
      folder: "Risk and market structure",
      name: "Stability index",
      query: { detail: "true" },
      description: "Latest Pharos Stability Index with detail payload and history.",
    },
  },
  {
    key: "blacklist",
    path: API_PATHS.blacklist(),
    summary: "Blacklist events",
    description: "Freeze and blacklist events with optional uppercase symbol, chain display-name or chain ID, event type, search, sort, exact-count, and pagination filters. Responses include `chainId` join keys; the `chain` query filter is display-name based.",
    tags: ["Blacklist"],
    parameters: [
      BLACKLIST_STABLECOIN_SYMBOL_QUERY_PARAM,
      {
        name: "chain",
        in: "query",
        schema: { type: "string" },
        description: "Optional exact chain display-name filter, for example `Ethereum` or `Tron`. Use response `chainId` fields for programmatic joins.",
      },
      {
        name: "chainId",
        in: "query",
        schema: { type: "string" },
        description: "Optional canonical chain-registry ID filter, for example `ethereum` or `tron`. When both `chain` and `chainId` are supplied, they must identify the same chain.",
      },
      {
        name: "eventType",
        in: "query",
        schema: { type: "string", enum: ["blacklist", "unblacklist", "destroy"] },
        description: "Optional event type filter.",
      },
      {
        name: "q",
        in: "query",
        schema: { type: "string" },
        description: "Optional case-insensitive affected-address substring search.",
      },
      {
        name: "sortBy",
        in: "query",
        schema: { type: "string", enum: ["date", "stablecoin", "chain", "event"] },
        description: "Sort field. Defaults to `date`.",
      },
      {
        name: "sortDirection",
        in: "query",
        schema: { type: "string", enum: ["asc", "desc"] },
        description: "Sort direction. Defaults to `desc`.",
      },
      {
        name: "limit",
        in: "query",
        schema: { type: "integer", minimum: 0, maximum: 1000 },
        description: "Maximum number of events to return. Defaults to 1000; `0` maps to the default.",
      },
      {
        name: "offset",
        in: "query",
        schema: { type: "integer", minimum: 0 },
        description: "Pagination offset. Defaults to 0.",
      },
      {
        name: "includeTotal",
        in: "query",
        schema: { type: "boolean" },
        description: "When false, skips the exact total count.",
      },
    ],
    postman: {
      folder: "Flows, blacklist, yield, and chains",
      query: {
        stablecoin: "{{blacklistStablecoinSymbol}}",
        chain: "Ethereum",
        chainId: "ethereum",
        eventType: "blacklist",
        q: "",
        sortBy: "date",
        sortDirection: "desc",
        limit: "{{limit}}",
        offset: "0",
        includeTotal: "true",
      },
    },
  },
  {
    key: "blacklist-summary",
    path: API_PATHS.blacklistSummary(),
    summary: "Blacklist summary",
    description: "Blacklist summary statistics, chart data, chain options, manifest-derived coverage metadata, and freeze-ledger data-quality context. Prefer tracked freeze-ledger fields over legacy active-state fields for public frozen exposure.",
    tags: ["Blacklist"],
    postman: {
      folder: "Flows, blacklist, yield, and chains",
    },
  },
  {
    key: "mint-burn-flows",
    path: API_PATHS.mintBurnFlowsBase(),
    summary: "Mint and burn flows",
    description: "Mint/burn flow aggregates for the selected window.",
    tags: ["Flows"],
    parameters: [STABLECOIN_QUERY_PARAM, HOURS_PARAM],
    postman: {
      folder: "Flows, blacklist, yield, and chains",
      query: { stablecoin: "{{stablecoinId}}", hours: "168" },
    },
  },
  {
    key: "mint-burn-events",
    path: API_PATHS.mintBurnEventsBase(),
    summary: "Mint and burn events",
    description: "Individual mint/burn events for supported stablecoins.",
    tags: ["Flows"],
    parameters: [
      REQUIRED_STABLECOIN_QUERY_PARAM,
      {
        name: "direction",
        in: "query",
        schema: { type: "string", enum: ["mint", "burn"] },
        description: "Optional direction filter.",
      },
      {
        name: "chain",
        in: "query",
        schema: { type: "string" },
        description: "Optional chain ID within the stablecoin's configured issuance scope.",
      },
      {
        name: "burnType",
        in: "query",
        schema: { type: "string", enum: ["effective_burn", "bridge_burn", "review_required"] },
        description: "Optional burn classification filter.",
      },
      {
        name: "scope",
        in: "query",
        schema: { type: "string", enum: ["all", "counted"] },
        description: "`counted` returns only rows used in economic-flow aggregates. Defaults to `all`.",
      },
      {
        name: "minAmount",
        in: "query",
        schema: { type: "number", minimum: 0 },
        description: "Minimum USD amount; unpriced rows are excluded when this filter is used.",
      },
      {
        name: "limit",
        in: "query",
        schema: { type: "integer", minimum: 1, maximum: 500 },
        description: "Maximum number of records to return. Defaults to 50.",
      },
      {
        name: "offset",
        in: "query",
        schema: { type: "integer", minimum: 0 },
        description: "Pagination offset. Defaults to 0.",
      },
      {
        name: "cursor",
        in: "query",
        schema: { type: "string" },
        description: "Opaque keyset cursor returned as nextCursor; cannot be combined with a non-zero offset.",
      },
      {
        name: "includeTotal",
        in: "query",
        schema: { type: "boolean" },
        description: "When false, skips the exact total count.",
      },
    ],
    postman: {
      folder: "Flows, blacklist, yield, and chains",
      query: {
        stablecoin: "{{stablecoinId}}",
        direction: "",
        chain: "ethereum",
        burnType: "",
        scope: "all",
        minAmount: "0",
        limit: "{{limit}}",
        offset: "0",
        includeTotal: "true",
      },
    },
  },
  {
    key: "yield-rankings",
    path: API_PATHS.yieldRankings(),
    summary: "Yield rankings",
    description: "Yield-bearing stablecoin rankings with safety, benchmark-aware context, and optional publication/source-risk metadata fields.",
    tags: ["Yield"],
    responseSchema: "YieldRankingsResponse",
    parameters: [
      {
        name: "projection",
        in: "query",
        schema: { type: "string", enum: ["summary"] },
        description: "Returns the compact Yield workbench contract while preserving the detailed response as the default.",
      },
    ],
    postman: {
      folder: "Flows, blacklist, yield, and chains",
      query: { projection: "" },
    },
  },
  {
    key: "yield-adapter-manifest",
    path: API_PATHS.yieldAdapterManifest(),
    summary: "Yield adapter manifest",
    description:
      "Machine-readable source-list manifest for every yield-bearing asset, including adapter family, exact runtime source key when known, source-key pattern for runtime-resolved or disabled strategies, label, chain/project hints, lifecycle state, and methodology version.",
    tags: ["Yield"],
    responseSchema: "YieldAdapterManifestResponse",
    postman: {
      folder: "Flows, blacklist, yield, and chains",
    },
  },
  {
    key: "yield-history",
    path: API_PATHS.yieldHistoryBase(),
    summary: "Yield history",
    description: "Historical yield observations for a stablecoin, with optional publication/source-risk metadata fields.",
    tags: ["Yield", "History"],
    responseSchema: "YieldHistoryResponse",
    parameters: [
      REQUIRED_STABLECOIN_QUERY_PARAM,
      DEX_LIQUIDITY_HISTORY_DAYS_PARAM,
      YIELD_HISTORY_MODE_PARAM,
      {
        name: "sourceKey",
        in: "query",
        schema: { type: "string" },
        description: "Required with `mode=source`; filters history to a single source key.",
      },
    ],
    postman: [
      {
        folder: "Historical data",
        order: 2,
        name: "Yield history - best source",
        description: "Historical best-source yield observations for a required stablecoin. `days` accepts 1-365; `mode=best` returns rows selected as best source at publication time.",
        query: { stablecoin: "{{stablecoinId}}", days: "{{days}}", mode: "best" },
      },
      {
        folder: "Historical data",
        order: 3,
        name: "Yield history - source key",
        description: "Source-specific historical yield observations. `mode=source` requires a stablecoin id plus `sourceKey` for the source series to inspect.",
        query: {
          stablecoin: "{{yieldSourceStablecoinId}}",
          days: "{{days}}",
          mode: "source",
          sourceKey: "{{yieldSourceKey}}",
        },
      },
    ],
  },
  {
    key: "chains",
    path: API_PATHS.chains(),
    summary: "Chains",
    description: "Chain-level stablecoin aggregates with Chain Health Scores.",
    tags: ["Chains"],
    postman: {
      folder: "Flows, blacklist, yield, and chains",
    },
  },
  {
    key: "non-usd-share",
    path: API_PATHS.nonUsdShareBase(),
    summary: "Non-USD share",
    description: "Historical non-USD peg share series for market-structure views.",
    tags: ["Market Structure", "History"],
    parameters: [NON_USD_SHARE_DAYS_PARAM],
    postman: {
      folder: "Flows, blacklist, yield, and chains",
      query: { days: "{{days}}" },
    },
  },
  {
    key: "supply-history",
    path: API_PATHS.supplyHistoryBase(),
    summary: "Supply history",
    description: "Historical supply series for a stablecoin.",
    tags: ["History"],
    parameters: [REQUIRED_STABLECOIN_QUERY_PARAM, SUPPLY_HISTORY_DAYS_PARAM],
    postman: {
      folder: "Historical data",
      order: 0,
      query: { stablecoin: "{{stablecoinId}}", days: "365" },
    },
  },
  {
    key: "safety-score-history",
    path: API_PATHS.safetyScoreHistoryBase(),
    summary: "Safety score history",
    description: "Long-range safety-score history for a stablecoin.",
    tags: ["Risk", "History"],
    parameters: [REQUIRED_STABLECOIN_QUERY_PARAM, SAFETY_SCORE_HISTORY_DAYS_PARAM],
    postman: {
      folder: "Historical data",
      order: 4,
      query: { stablecoin: "{{stablecoinId}}", days: "3650" },
    },
  },
  {
    key: "daily-digest",
    path: API_PATHS.dailyDigest(),
    summary: "Daily digest",
    description: "Latest AI-generated stablecoin market digest.",
    tags: ["Digest"],
    postman: {
      folder: "Historical data",
      order: 5,
      description: "Latest AI-generated market digest.",
    },
  },
  {
    key: "digest-archive",
    path: API_PATHS.digestArchive(),
    summary: "Digest archive",
    description: "Archive of daily and weekly digests.",
    tags: ["Digest"],
    postman: {
      folder: "Historical data",
      order: 6,
    },
  },
  {
    key: "digest-snapshot",
    path: API_PATHS.digestSnapshotBase(),
    summary: "Digest snapshot",
    description: "Build-time digest context snapshot for a specific digest date.",
    tags: ["Digest"],
    parameters: [
      {
        name: "date",
        in: "query",
        required: true,
        schema: { type: "string" },
        description: "Digest date slug, for example `2026-03-16`.",
      },
    ],
    postman: {
      folder: "Historical data",
      order: 7,
      query: { date: "{{digestDate}}" },
    },
  },
  {
    key: "snapshots-index",
    path: API_PATHS.snapshotsIndex(),
    summary: "Public snapshot index",
    description: "Listing of available daily public snapshots with content hashes and methodology versions.",
    tags: ["Digest"],
    postman: {
      folder: "Historical data",
      order: 8,
    },
  },
  {
    key: "snapshot-day",
    path: snapshotPathTemplate(API_PATHS.snapshotDay(SNAPSHOT_DATE_TOKEN)),
    summary: "Public snapshot for a single day",
    description:
      "Full per-day public dataset snapshot (camelCase). Immutable artifact keyed by YYYY-MM-DD; served with public, immutable, max-age=1y cache headers.",
    tags: ["Digest", "History"],
    parameters: [
      {
        name: "date",
        in: "path",
        required: true,
        schema: { type: "string" },
        description: "ISO 8601 date (YYYY-MM-DD) matching a row in the snapshot index.",
      },
    ],
    postman: {
      folder: "Historical data",
      order: 9,
      path: snapshotPostmanPath(API_PATHS.snapshotDay(SNAPSHOT_DATE_TOKEN)),
    },
  },
  {
    key: "snapshot-coin",
    path: snapshotPathTemplate(API_PATHS.snapshotCoin(SNAPSHOT_DATE_TOKEN, STABLECOIN_ID_TOKEN)),
    summary: "Public snapshot projection for a single coin",
    description:
      "Per-coin slice of a daily snapshot (camelCase). Immutable artifact keyed by YYYY-MM-DD + stablecoin id; served with public, immutable, max-age=1y cache headers.",
    tags: ["Digest", "Stablecoins", "History"],
    parameters: [
      {
        name: "date",
        in: "path",
        required: true,
        schema: { type: "string" },
        description: "ISO 8601 date (YYYY-MM-DD) matching a row in the snapshot index.",
      },
      {
        name: "stablecoinId",
        in: "path",
        required: true,
        schema: { type: "string" },
        description: "Stablecoin id (lowercase-kebab).",
      },
    ],
    postman: {
      folder: "Historical data",
      order: 10,
      path: snapshotPostmanPath(API_PATHS.snapshotCoin(SNAPSHOT_DATE_TOKEN, STABLECOIN_ID_TOKEN)),
    },
  },
  {
    key: "public-status-history",
    path: API_PATHS.publicStatusHistory(),
    summary: "Public status history",
    description: "Public status timeline for the Pharos system.",
    tags: ["Status"],
    parameters: [
      LIMIT_PARAM,
      {
        name: "window",
        in: "query",
        schema: { type: "string", enum: ["24h", "7d", "30d"] },
        description: "Status history window.",
      },
    ],
    postman: {
      folder: "Status",
      query: { window: "7d", limit: "{{limit}}" },
    },
  },
  {
    key: "telegram-pulse",
    path: API_PATHS.telegramPulse(),
    summary: "Telegram pulse",
    description: "Lightweight public telemetry for Telegram alert surfaces.",
    tags: ["Status"],
    postman: {
      folder: "Flows, blacklist, yield, and chains",
    },
  },
] as const satisfies readonly PublicApiArtifactEndpoint[];

export const PUBLIC_STATIC_POSTMAN_REQUESTS = [
  {
    name: "Stablecoin Cemetery dataset - JSON",
    path: "/datasets/stablecoin-cemetery.json",
    noAuth: true,
    base: "site",
    description: "Citation-ready JSON export of failed, abandoned, depegged, and discontinued stablecoins.",
  },
  {
    name: "Stablecoin Cemetery dataset - CSV",
    path: "/datasets/stablecoin-cemetery.csv",
    noAuth: true,
    base: "site",
    description: "Tabular CSV export of the Stablecoin Cemetery dataset.",
  },
  {
    name: "LLM index",
    path: "/llms.txt",
    noAuth: true,
    base: "site",
    description: "LLM-facing route and documentation index for Pharos.",
  },
] as const satisfies readonly PostmanStaticRequest[];

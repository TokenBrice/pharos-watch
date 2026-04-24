import { API_PATHS } from "../../shared/lib/api-endpoints/paths";

export type QueryParamType = "string" | "integer" | "boolean";

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
  parameters?: readonly PublicApiArtifactParameter[];
  postman?: {
    folder: PostmanFolderName;
    order?: number;
    name?: string;
    path?: string;
    description?: string;
    query?: Record<string, string>;
    noAuth?: boolean;
  };
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

export const DAYS_PARAM = {
  name: "days",
  in: "query",
  schema: { type: "integer", minimum: 1 },
  description: "Historical lookback window in days. Endpoint-specific bounds may apply.",
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
    key: "stablecoin-detail-canary",
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
    key: "stablecoin-summary-canary",
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
    key: "stablecoin-reserves-canary",
    path: stablecoinPathTemplate(API_PATHS.stablecoinReserves(STABLECOIN_ID_TOKEN)),
    summary: "Stablecoin reserves",
    description: "Live or fallback reserve composition where Pharos has reserve coverage.",
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
        name: "active",
        in: "query",
        schema: { type: "boolean" },
        description: "When true, returns active depeg events only.",
      },
    ],
    postman: {
      folder: "Risk and market structure",
      query: { stablecoin: "{{stablecoinId}}", limit: "{{limit}}", offset: "0" },
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
    parameters: [STABLECOIN_QUERY_PARAM, DAYS_PARAM],
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
    description: "Freeze and blacklist events with optional stablecoin/chain filters.",
    tags: ["Blacklist"],
    parameters: [
      STABLECOIN_QUERY_PARAM,
      {
        name: "chain",
        in: "query",
        schema: { type: "string" },
        description: "Optional chain filter.",
      },
    ],
    postman: {
      folder: "Flows, blacklist, yield, and chains",
      query: { stablecoin: "{{stablecoinId}}" },
    },
  },
  {
    key: "blacklist-summary",
    path: API_PATHS.blacklistSummary(),
    summary: "Blacklist summary",
    description: "Blacklist summary statistics, chart data, and chain options.",
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
    parameters: [STABLECOIN_QUERY_PARAM, LIMIT_PARAM],
    postman: {
      folder: "Flows, blacklist, yield, and chains",
      query: { stablecoin: "{{stablecoinId}}", limit: "{{limit}}" },
    },
  },
  {
    key: "yield-rankings",
    path: API_PATHS.yieldRankings(),
    summary: "Yield rankings",
    description: "Yield-bearing stablecoin rankings with safety and benchmark-aware context.",
    tags: ["Yield"],
    postman: {
      folder: "Flows, blacklist, yield, and chains",
    },
  },
  {
    key: "yield-history",
    path: API_PATHS.yieldHistoryBase(),
    summary: "Yield history",
    description: "Historical yield observations for a stablecoin.",
    tags: ["Yield", "History"],
    parameters: [
      STABLECOIN_QUERY_PARAM,
      DAYS_PARAM,
      {
        name: "mode",
        in: "query",
        schema: { type: "string" },
        description: "Optional yield mode filter.",
      },
      {
        name: "sourceKey",
        in: "query",
        schema: { type: "string" },
        description: "Optional source key filter.",
      },
    ],
    postman: {
      folder: "Historical data",
      order: 2,
      query: { stablecoin: "{{stablecoinId}}", days: "{{days}}" },
    },
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
    parameters: [DAYS_PARAM],
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
    parameters: [STABLECOIN_QUERY_PARAM, DAYS_PARAM],
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
    parameters: [STABLECOIN_QUERY_PARAM, DAYS_PARAM],
    postman: {
      folder: "Historical data",
      order: 3,
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
      order: 4,
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
      order: 5,
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
      order: 6,
      query: { date: "{{digestDate}}" },
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

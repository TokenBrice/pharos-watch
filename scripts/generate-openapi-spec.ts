import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, "../public/openapi.json");
const CHECK_MODE = process.argv.includes("--check");

type QueryParamType = "string" | "integer" | "boolean";

interface ApiEndpoint {
  path: string;
  summary: string;
  description: string;
  tags: string[];
  security?: "apiKey" | "none";
  parameters?: {
    name: string;
    in: "path" | "query";
    required?: boolean;
    schema: { type: QueryParamType; enum?: string[]; minimum?: number; maximum?: number };
    description: string;
  }[];
}

const STABLECOIN_ID_PARAM = {
  name: "stablecoinId",
  in: "path" as const,
  required: true,
  schema: { type: "string" as const },
  description: "Canonical Pharos stablecoin ID, for example `usdt-tether` or `usdc-circle`.",
};

const STABLECOIN_QUERY_PARAM = {
  name: "stablecoin",
  in: "query" as const,
  schema: { type: "string" as const },
  description: "Optional canonical Pharos stablecoin ID filter.",
};

const DAYS_PARAM = {
  name: "days",
  in: "query" as const,
  schema: { type: "integer" as const, minimum: 1 },
  description: "Historical lookback window in days. Endpoint-specific bounds may apply.",
};

const LIMIT_PARAM = {
  name: "limit",
  in: "query" as const,
  schema: { type: "integer" as const, minimum: 1 },
  description: "Maximum number of records to return.",
};

const endpoints: ApiEndpoint[] = [
  {
    path: "/api/health",
    summary: "Health check",
    description: "No-key health check for the public API host.",
    tags: ["Health"],
    security: "none",
  },
  {
    path: "/api/stablecoins",
    summary: "List stablecoins",
    description: "Current stablecoin list with supply, price, peg, chain distribution, and freshness headers.",
    tags: ["Stablecoins"],
  },
  {
    path: "/api/stablecoin/{stablecoinId}",
    summary: "Stablecoin detail",
    description: "Full per-coin analytics dossier for a canonical Pharos stablecoin ID.",
    tags: ["Stablecoins"],
    parameters: [STABLECOIN_ID_PARAM],
  },
  {
    path: "/api/stablecoin-summary/{stablecoinId}",
    summary: "Stablecoin summary",
    description: "Lightweight per-coin price and aggregate supply snapshot.",
    tags: ["Stablecoins"],
    parameters: [STABLECOIN_ID_PARAM],
  },
  {
    path: "/api/stablecoin-reserves/{stablecoinId}",
    summary: "Stablecoin reserves",
    description: "Live or fallback reserve composition where Pharos has reserve coverage.",
    tags: ["Stablecoins", "Reserves"],
    parameters: [STABLECOIN_ID_PARAM],
  },
  {
    path: "/api/stablecoin-charts",
    summary: "Stablecoin charts",
    description: "Historical total supply chart data.",
    tags: ["Stablecoins", "History"],
  },
  {
    path: "/api/peg-summary",
    summary: "Peg summary",
    description: "Per-coin peg scores plus aggregate peg-monitoring summary.",
    tags: ["Peg Monitoring"],
  },
  {
    path: "/api/depeg-events",
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
  },
  {
    path: "/api/dex-liquidity",
    summary: "DEX liquidity",
    description: "DEX liquidity scores, top pools, chain/protocol breakdowns, and quality metadata.",
    tags: ["Liquidity"],
  },
  {
    path: "/api/dex-liquidity-history",
    summary: "DEX liquidity history",
    description: "Historical liquidity-score data for a stablecoin.",
    tags: ["Liquidity", "History"],
    parameters: [STABLECOIN_QUERY_PARAM, DAYS_PARAM],
  },
  {
    path: "/api/report-cards",
    summary: "Report cards",
    description: "Safety report-card snapshot across liquidity, resilience, decentralization, dependency, and peg stability.",
    tags: ["Risk"],
  },
  {
    path: "/api/redemption-backstops",
    summary: "Redemption backstops",
    description: "Modeled issuer/protocol redemption routes and effective-exit scoring for configured assets.",
    tags: ["Risk", "Reserves"],
  },
  {
    path: "/api/stress-signals",
    summary: "Stress signals",
    description: "DEWS-style stress signals for the stablecoin universe or one selected asset.",
    tags: ["Risk", "Peg Monitoring"],
    parameters: [STABLECOIN_QUERY_PARAM, DAYS_PARAM],
  },
  {
    path: "/api/stability-index",
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
  },
  {
    path: "/api/blacklist",
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
  },
  {
    path: "/api/blacklist-summary",
    summary: "Blacklist summary",
    description: "Blacklist summary statistics, chart data, and chain options.",
    tags: ["Blacklist"],
  },
  {
    path: "/api/mint-burn-flows",
    summary: "Mint and burn flows",
    description: "Mint/burn flow aggregates for the selected window.",
    tags: ["Flows"],
    parameters: [STABLECOIN_QUERY_PARAM, DAYS_PARAM],
  },
  {
    path: "/api/mint-burn-events",
    summary: "Mint and burn events",
    description: "Individual mint/burn events for supported stablecoins.",
    tags: ["Flows"],
    parameters: [STABLECOIN_QUERY_PARAM, LIMIT_PARAM],
  },
  {
    path: "/api/yield-rankings",
    summary: "Yield rankings",
    description: "Yield-bearing stablecoin rankings with safety and benchmark-aware context.",
    tags: ["Yield"],
  },
  {
    path: "/api/yield-history",
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
  },
  {
    path: "/api/chains",
    summary: "Chains",
    description: "Chain-level stablecoin aggregates with Chain Health Scores.",
    tags: ["Chains"],
  },
  {
    path: "/api/non-usd-share",
    summary: "Non-USD share",
    description: "Historical non-USD peg share series for market-structure views.",
    tags: ["Market Structure", "History"],
    parameters: [DAYS_PARAM],
  },
  {
    path: "/api/supply-history",
    summary: "Supply history",
    description: "Historical supply series for a stablecoin.",
    tags: ["History"],
    parameters: [STABLECOIN_QUERY_PARAM, DAYS_PARAM],
  },
  {
    path: "/api/safety-score-history",
    summary: "Safety score history",
    description: "Long-range safety-score history for a stablecoin.",
    tags: ["Risk", "History"],
    parameters: [STABLECOIN_QUERY_PARAM, DAYS_PARAM],
  },
  {
    path: "/api/daily-digest",
    summary: "Daily digest",
    description: "Latest AI-generated stablecoin market digest.",
    tags: ["Digest"],
  },
  {
    path: "/api/digest-archive",
    summary: "Digest archive",
    description: "Archive of daily and weekly digests.",
    tags: ["Digest"],
  },
  {
    path: "/api/digest-snapshot",
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
  },
  {
    path: "/api/public-status-history",
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
  },
  {
    path: "/api/telegram-pulse",
    summary: "Telegram pulse",
    description: "Lightweight public telemetry for Telegram alert surfaces.",
    tags: ["Status"],
  },
];

function schemaRef(name: string) {
  return { $ref: `#/components/schemas/${name}` };
}

function buildParameters(endpoint: ApiEndpoint) {
  return endpoint.parameters?.map((parameter) => ({
    name: parameter.name,
    in: parameter.in,
    required: parameter.required ?? parameter.in === "path",
    description: parameter.description,
    schema: parameter.schema,
  })) ?? [];
}

function buildOperation(endpoint: ApiEndpoint) {
  return {
    tags: endpoint.tags,
    summary: endpoint.summary,
    description: endpoint.description,
    operationId: endpoint.path
      .replace(/^\/api\//, "")
      .replace(/[{}]/g, "")
      .replace(/[^a-zA-Z0-9]+(.)/g, (_, char: string) => char.toUpperCase()),
    ...(endpoint.security === "none" ? { security: [] } : {}),
    parameters: buildParameters(endpoint),
    responses: {
      "200": {
        description: "Successful response. See the public API reference for endpoint-specific payload fields.",
        content: {
          "application/json": {
            schema: schemaRef("JsonValue"),
          },
        },
      },
      "400": { description: "Bad request" },
      "401": { description: "Missing or invalid API key" },
      "429": { description: "Rate limit exceeded" },
      "503": { description: "Service unavailable or cache not populated" },
    },
  };
}

function render() {
  const paths = Object.fromEntries(
    endpoints.map((endpoint) => [
      endpoint.path,
      {
        get: buildOperation(endpoint),
      },
    ]),
  );

  return `${JSON.stringify({
    openapi: "3.1.0",
    info: {
      title: "Pharos API",
      version: "1.0.0",
      description:
        "Stablecoin analytics API for peg monitoring, liquidity, risk, blacklist events, mint/burn flows, yield, chains, and market-structure data. Protected public routes require X-API-Key. Request access in the Pharos Telegram channel with intended endpoints, cadence, and expected volume.",
      contact: {
        name: "Pharos",
        url: "https://pharos.watch/about/api/",
        email: "admin@pharos.watch",
      },
      license: {
        name: "MIT",
        url: "https://github.com/TokenBrice/stablecoin-dashboard/blob/main/LICENSE",
      },
    },
    externalDocs: {
      description: "Full Pharos API reference",
      url: "https://pharos.watch/about/api/",
    },
    servers: [
      {
        url: "https://api.pharos.watch",
        description: "Public integration API",
      },
    ],
    security: [{ ApiKeyAuth: [] }],
    tags: [
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
    ].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "X-API-Key",
          description: "Required for protected public routes on https://api.pharos.watch.",
        },
      },
      schemas: {
        JsonValue: {
          description: "Endpoint-specific JSON response. See https://pharos.watch/about/api/ for detailed contracts.",
        },
      },
    },
  }, null, 2)}\n`;
}

const next = render();

if (CHECK_MODE) {
  const current = existsSync(OUTPUT_PATH) ? readFileSync(OUTPUT_PATH, "utf8") : "";
  if (current !== next) {
    console.error("OpenAPI spec is out of date. Run `tsx scripts/generate-openapi-spec.ts`.");
    process.exit(1);
  }

  console.log("OpenAPI spec is current");
} else {
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, next, "utf8");
  console.log("Generated OpenAPI spec");
}

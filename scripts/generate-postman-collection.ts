import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, "../public/postman");
const COLLECTION_OUTPUT = join(OUTPUT_DIR, "pharos-api.postman_collection.json");
const ENVIRONMENT_OUTPUT = join(OUTPUT_DIR, "pharos-api.postman_environment.json");
const CHECK_MODE = process.argv.includes("--check");

interface PostmanRequest {
  name: string;
  method?: "GET" | "POST";
  path: string;
  description: string;
  query?: Record<string, string>;
  noAuth?: boolean;
  base?: "api" | "site";
}

interface PostmanFolder {
  name: string;
  description: string;
  requests: PostmanRequest[];
}

const COLLECTION_SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

const folders: PostmanFolder[] = [
  {
    name: "Getting started",
    description: "Basic canaries and high-level market reads.",
    requests: [
      {
        name: "Health check",
        path: "/api/health",
        noAuth: true,
        description: "No-key health check for the public API host.",
      },
      {
        name: "Stablecoins list",
        path: "/api/stablecoins",
        description: "Current stablecoin list with supply, price, peg, chain distribution, and freshness headers.",
      },
      {
        name: "Stablecoin detail",
        path: "/api/stablecoin/{{stablecoinId}}",
        description: "Full per-coin analytics dossier for a canonical Pharos stablecoin ID.",
      },
      {
        name: "Stablecoin summary",
        path: "/api/stablecoin-summary/{{stablecoinId}}",
        description: "Lightweight per-coin price and aggregate supply snapshot.",
      },
      {
        name: "Stablecoin reserves",
        path: "/api/stablecoin-reserves/{{reserveStablecoinId}}",
        description: "Live or fallback reserve composition where Pharos has reserve coverage.",
      },
      {
        name: "Stablecoin charts",
        path: "/api/stablecoin-charts",
        description: "Historical total supply chart data.",
      },
    ],
  },
  {
    name: "Risk and market structure",
    description: "Stablecoin risk, peg, liquidity, flow, and dependency data.",
    requests: [
      {
        name: "Peg summary",
        path: "/api/peg-summary",
        description: "Per-coin peg scores plus aggregate peg-monitoring summary.",
      },
      {
        name: "Depeg events",
        path: "/api/depeg-events",
        query: { stablecoin: "{{stablecoinId}}", limit: "{{limit}}", offset: "0" },
        description: "Historical and active depeg events, filterable by stablecoin.",
      },
      {
        name: "USDS freeze status",
        path: "/api/usds-status",
        description: "Sky/USDS protocol status, including whether the freeze module is currently active.",
      },
      {
        name: "Bluechip ratings",
        path: "/api/bluechip-ratings",
        description: "Safety ratings from bluechip.org for covered stablecoins.",
      },
      {
        name: "DEX liquidity",
        path: "/api/dex-liquidity",
        description: "DEX liquidity scores, top pools, chain/protocol breakdowns, and quality metadata.",
      },
      {
        name: "Report cards",
        path: "/api/report-cards",
        description: "Safety report-card snapshot across liquidity, resilience, decentralization, dependency, and peg stability.",
      },
      {
        name: "Redemption backstops",
        path: "/api/redemption-backstops",
        description: "Modeled issuer/protocol redemption routes and effective-exit scoring for configured assets.",
      },
      {
        name: "Stress signals",
        path: "/api/stress-signals",
        query: { stablecoin: "{{stablecoinId}}", days: "{{days}}" },
        description: "DEWS-style stress signals for the stablecoin universe or one selected asset.",
      },
      {
        name: "Stability index",
        path: "/api/stability-index",
        query: { detail: "true" },
        description: "Latest Pharos Stability Index with detail payload and history.",
      },
    ],
  },
  {
    name: "Flows, blacklist, yield, and chains",
    description: "Operational and market-structure surfaces beyond price and peg data.",
    requests: [
      {
        name: "Blacklist events",
        path: "/api/blacklist",
        query: { stablecoin: "{{stablecoinId}}" },
        description: "Freeze and blacklist events with optional stablecoin/chain filters.",
      },
      {
        name: "Blacklist summary",
        path: "/api/blacklist-summary",
        description: "Blacklist summary statistics, chart data, and chain options.",
      },
      {
        name: "Mint and burn flows",
        path: "/api/mint-burn-flows",
        query: { stablecoin: "{{stablecoinId}}", hours: "168" },
        description: "Mint/burn flow aggregates for the selected window.",
      },
      {
        name: "Mint and burn events",
        path: "/api/mint-burn-events",
        query: { stablecoin: "{{stablecoinId}}", limit: "{{limit}}" },
        description: "Individual mint/burn events for supported stablecoins.",
      },
      {
        name: "Yield rankings",
        path: "/api/yield-rankings",
        description: "Yield-bearing stablecoin rankings with safety and benchmark-aware context.",
      },
      {
        name: "Chains",
        path: "/api/chains",
        description: "Chain-level stablecoin aggregates with Chain Health Scores.",
      },
      {
        name: "Non-USD share",
        path: "/api/non-usd-share",
        query: { days: "{{days}}" },
        description: "Historical non-USD peg share series for market-structure views.",
      },
      {
        name: "Telegram pulse",
        path: "/api/telegram-pulse",
        description: "Lightweight public telemetry for Telegram alert surfaces.",
      },
    ],
  },
  {
    name: "Status",
    description: "Public operational status surfaces.",
    requests: [
      {
        name: "Public status history",
        path: "/api/public-status-history",
        query: { window: "7d", limit: "{{limit}}" },
        description: "Public status timeline for the Pharos system.",
      },
    ],
  },
  {
    name: "Historical data",
    description: "Per-asset and archive endpoints that should be polled less frequently.",
    requests: [
      {
        name: "Supply history",
        path: "/api/supply-history",
        query: { stablecoin: "{{stablecoinId}}", days: "365" },
        description: "Historical supply series for a stablecoin.",
      },
      {
        name: "DEX liquidity history",
        path: "/api/dex-liquidity-history",
        query: { stablecoin: "{{stablecoinId}}", days: "{{days}}" },
        description: "Historical liquidity-score data for a stablecoin.",
      },
      {
        name: "Yield history",
        path: "/api/yield-history",
        query: { stablecoin: "{{stablecoinId}}", days: "{{days}}" },
        description: "Historical yield observations for a stablecoin.",
      },
      {
        name: "Safety score history",
        path: "/api/safety-score-history",
        query: { stablecoin: "{{stablecoinId}}", days: "3650" },
        description: "Long-range safety-score history for a stablecoin.",
      },
      {
        name: "Daily digest",
        path: "/api/daily-digest",
        description: "Latest AI-generated market digest.",
      },
      {
        name: "Digest archive",
        path: "/api/digest-archive",
        description: "Archive of daily and weekly digests.",
      },
      {
        name: "Digest snapshot",
        path: "/api/digest-snapshot",
        query: { date: "{{digestDate}}" },
        description: "Build-time digest context snapshot for a specific digest date.",
      },
    ],
  },
  {
    name: "Static datasets",
    description: "Website-hosted public datasets. These do not require a Pharos API key.",
    requests: [
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
    ],
  },
];

function withQuery(path: string, query?: Record<string, string>): string {
  if (!query || Object.keys(query).length === 0) {
    return path;
  }

  const suffix = Object.entries(query)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");

  return `${path}?${suffix}`;
}

function buildItem(request: PostmanRequest) {
  const method = request.method ?? "GET";
  const baseVariable = request.base === "site" ? "siteBaseUrl" : "apiBaseUrl";
  const rawPath = withQuery(request.path, request.query);

  return {
    name: request.name,
    request: {
      ...(request.noAuth ? { auth: { type: "noauth" } } : {}),
      method,
      header: method === "POST"
        ? [{ key: "Content-Type", value: "application/json", type: "text" }]
        : [],
      url: {
        raw: `{{${baseVariable}}}${rawPath}`,
        host: [`{{${baseVariable}}}`],
        path: request.path.split("/").filter(Boolean),
        ...(request.query
          ? {
            query: Object.entries(request.query).map(([key, value]) => ({ key, value })),
          }
          : {}),
      },
      description: request.description,
    },
    response: [],
  };
}

function renderCollection() {
  return `${JSON.stringify({
    info: {
      name: "Pharos API",
      description:
        "Postman collection for the Pharos stablecoin analytics API. Protected public routes require an X-API-Key on https://api.pharos.watch. Request a key in the Pharos Telegram channel and include intended endpoints, cadence, and volume. Static website datasets do not require a key.",
      schema: COLLECTION_SCHEMA,
    },
    auth: {
      type: "apikey",
      apikey: [
        { key: "key", value: "X-API-Key", type: "string" },
        { key: "value", value: "{{apiKey}}", type: "string" },
        { key: "in", value: "header", type: "string" },
      ],
    },
    variable: [
      { key: "apiBaseUrl", value: "https://api.pharos.watch" },
      { key: "siteBaseUrl", value: "https://pharos.watch" },
      { key: "stablecoinId", value: "usdt-tether" },
      { key: "reserveStablecoinId", value: "usdc-circle" },
      { key: "days", value: "90" },
      { key: "limit", value: "50" },
      { key: "digestDate", value: "2026-03-16" },
    ],
    item: folders.map((folder) => ({
      name: folder.name,
      description: folder.description,
      item: folder.requests.map(buildItem),
    })),
  }, null, 2)}\n`;
}

function renderEnvironment() {
  return `${JSON.stringify({
    name: "Pharos API - Production",
    values: [
      { key: "apiBaseUrl", value: "https://api.pharos.watch", type: "default", enabled: true },
      { key: "siteBaseUrl", value: "https://pharos.watch", type: "default", enabled: true },
      { key: "apiKey", value: "ph_live_REPLACE_WITH_YOUR_KEY", type: "secret", enabled: true },
      { key: "stablecoinId", value: "usdt-tether", type: "default", enabled: true },
      { key: "reserveStablecoinId", value: "usdc-circle", type: "default", enabled: true },
      { key: "days", value: "90", type: "default", enabled: true },
      { key: "limit", value: "50", type: "default", enabled: true },
      { key: "digestDate", value: "2026-03-16", type: "default", enabled: true },
    ],
    _postman_variable_scope: "environment",
    _postman_exported_using: "Pharos generator",
  }, null, 2)}\n`;
}

const nextCollection = renderCollection();
const nextEnvironment = renderEnvironment();

if (CHECK_MODE) {
  const currentCollection = existsSync(COLLECTION_OUTPUT) ? readFileSync(COLLECTION_OUTPUT, "utf8") : "";
  const currentEnvironment = existsSync(ENVIRONMENT_OUTPUT) ? readFileSync(ENVIRONMENT_OUTPUT, "utf8") : "";

  if (currentCollection !== nextCollection || currentEnvironment !== nextEnvironment) {
    console.error("Postman exports are out of date. Run `tsx scripts/generate-postman-collection.ts`.");
    process.exit(1);
  }

  console.log("Postman exports are current");
} else {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(COLLECTION_OUTPUT, nextCollection, "utf8");
  writeFileSync(ENVIRONMENT_OUTPUT, nextEnvironment, "utf8");
  console.log("Generated Postman collection and environment");
}

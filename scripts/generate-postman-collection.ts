import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  POSTMAN_FOLDERS,
  PUBLIC_API_ARTIFACT_ENDPOINTS,
  PUBLIC_STATIC_POSTMAN_REQUESTS,
  type PostmanFolderName,
  type PublicApiArtifactEndpoint,
} from "./lib/public-api-artifact-catalog";
import { syncGeneratedArtifacts } from "./lib/generated-artifacts";

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

interface PostmanRequestEntry {
  folder: PostmanFolderName;
  order?: number;
  request: PostmanRequest;
}

const COLLECTION_SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

const requests: PostmanRequestEntry[] = [
  ...PUBLIC_API_ARTIFACT_ENDPOINTS.flatMap((endpoint: PublicApiArtifactEndpoint) => {
    if (!endpoint.postman) {
      return [];
    }

    return [{
      folder: endpoint.postman.folder,
      order: endpoint.postman.order,
      request: {
        name: endpoint.postman.name ?? endpoint.summary,
        path: endpoint.postman.path ?? endpoint.path,
        description: endpoint.postman.description ?? endpoint.description,
        query: endpoint.postman.query,
        noAuth: endpoint.postman.noAuth,
      },
    }];
  }),
  ...PUBLIC_STATIC_POSTMAN_REQUESTS.map((request) => ({
    folder: "Static datasets" as const,
    request,
  })),
];

const folders = POSTMAN_FOLDERS.map((folder) => ({
  ...folder,
  requests: requests
    .filter((entry) => entry.folder === folder.name)
    .sort((left, right) => (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER))
    .map((entry) => entry.request),
}));

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

syncGeneratedArtifacts({
  artifacts: [
    { path: COLLECTION_OUTPUT, contents: renderCollection() },
    { path: ENVIRONMENT_OUTPUT, contents: renderEnvironment() },
  ],
  check: CHECK_MODE,
  staleMessage: "Postman exports are out of date. Run `tsx scripts/generate-postman-collection.ts`.",
  currentMessage: "Postman exports are current",
  writtenMessage: "Generated Postman collection and environment",
});

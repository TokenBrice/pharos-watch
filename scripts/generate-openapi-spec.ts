import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_API_ARTIFACT_ENDPOINTS,
  PUBLIC_API_ARTIFACT_TAGS,
  type PublicApiArtifactEndpoint,
} from "./lib/public-api-artifact-catalog";
import { syncGeneratedArtifacts } from "./lib/generated-artifacts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, "../public/openapi.json");
const CHECK_MODE = process.argv.includes("--check");

function schemaRef(name: string) {
  return { $ref: `#/components/schemas/${name}` };
}

function buildParameters(endpoint: PublicApiArtifactEndpoint) {
  return endpoint.parameters?.map((parameter) => ({
    name: parameter.name,
    in: parameter.in,
    required: parameter.required ?? parameter.in === "path",
    description: parameter.description,
    schema: parameter.schema,
  })) ?? [];
}

function buildOperation(endpoint: PublicApiArtifactEndpoint) {
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
    PUBLIC_API_ARTIFACT_ENDPOINTS.map((endpoint) => [
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
    tags: PUBLIC_API_ARTIFACT_TAGS.map((name) => ({ name })),
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

syncGeneratedArtifacts({
  artifacts: [{ path: OUTPUT_PATH, contents: render() }],
  check: CHECK_MODE,
  staleMessage: "OpenAPI spec is out of date. Run `tsx scripts/generate-openapi-spec.ts`.",
  currentMessage: "OpenAPI spec is current",
  writtenMessage: "Generated OpenAPI spec",
});

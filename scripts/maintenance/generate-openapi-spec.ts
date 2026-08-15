import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
  PUBLIC_API_ARTIFACT_ENDPOINTS,
  PUBLIC_API_ARTIFACT_TAGS,
  type PublicApiArtifactEndpoint,
} from "../lib/public-api-artifact-catalog";
import {
  PUBLIC_API_RESPONSE_SCHEMAS,
  type PublicApiResponseSchemaName,
} from "../lib/public-api-response-schemas";
import { syncGeneratedArtifacts } from "../lib/generated-artifacts";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, "../../public/openapi.json");
const CHECK_MODE = process.argv.includes("--check");

function schemaRef(name: PublicApiResponseSchemaName | "JsonValue") {
  return { $ref: `#/components/schemas/${name}` };
}

const TAG_DESCRIPTIONS = {
  Health: "No-key canary and health probes for API availability checks.",
  Stablecoins: "Current stablecoin registry, per-asset detail, reserves, summaries, and chart surfaces.",
  "Peg Monitoring": "Peg summaries, depeg incidents, and stress signals for stablecoin peg stability.",
  Liquidity: "DEX liquidity scores, history, pool quality, and exit-capacity analytics.",
  Risk: "Safety reports, bluechip ratings, redemption backstops, events, and cross-signal risk surfaces.",
  Blacklist: "Issuer freeze, blacklist, unblacklist, destroy, and exposure summary data.",
  Flows: "Mint and burn flow aggregates plus normalized issuance-chain event streams.",
  Yield: "Yield Intelligence rankings, adapter manifests, and per-stablecoin yield history.",
  Chains: "Per-chain stablecoin distribution, concentration, quality, and health surfaces.",
  "Market Structure": "Non-USD peg share, alternate peg composition, and public market-structure snapshots.",
  History: "Historical and archive endpoints intended for slower polling or point-in-time retrieval.",
  Digest: "Daily and weekly stablecoin market digest snapshots and archive indexes.",
  Status: "Public operational status timelines and lightweight product telemetry.",
  Reserves: "Reserve composition and redemption-support context for supported stablecoins.",
} as const satisfies Record<(typeof PUBLIC_API_ARTIFACT_TAGS)[number], string>;

function buildParameters(endpoint: PublicApiArtifactEndpoint) {
  return endpoint.parameters?.map((parameter) => ({
    name: parameter.name,
    in: parameter.in,
    required: parameter.required ?? parameter.in === "path",
    description: parameter.description,
    schema: parameter.schema,
  })) ?? [];
}

function buildErrorResponses(endpoint: PublicApiArtifactEndpoint) {
  return {
    "400": { description: "Bad request" },
    ...(endpoint.security === "none"
      ? {}
      : {
        "401": { description: "Missing or invalid API key" },
        "429": { description: "Rate limit exceeded" },
      }),
    "503": { description: "Service unavailable or cache not populated" },
  };
}

function buildOperation(endpoint: PublicApiArtifactEndpoint) {
  const responseSchema = endpoint.responseSchema ?? "JsonValue";
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
            schema: schemaRef(responseSchema),
          },
        },
      },
      ...buildErrorResponses(endpoint),
    },
  };
}

export function buildOpenApiResponseSchemas() {
  return Object.fromEntries(
    Object.entries(PUBLIC_API_RESPONSE_SCHEMAS).map(([name, schema]) => {
      const { $schema: _dialect, ...openApiSchema } = z.toJSONSchema(schema, {
        target: "draft-2020-12",
        io: "output",
        unrepresentable: "any",
        reused: "inline",
      });
      return [name, openApiSchema];
    }),
    // `Object.fromEntries` widens to an index signature, which does not overlap
    // the literal-key Record; keys are exhaustive by construction.
  ) as unknown as Record<PublicApiResponseSchemaName, Record<string, unknown>>;
}

export function buildOpenApiDocument() {
  const paths = Object.fromEntries(
    PUBLIC_API_ARTIFACT_ENDPOINTS.map((endpoint) => [
      endpoint.path,
      { get: buildOperation(endpoint) },
    ]),
  );

  return {
    openapi: "3.1.0",
    info: {
      title: "Pharos API",
      version: "1.0.0",
      description:
        "Stablecoin analytics API for peg monitoring, liquidity, risk, blacklist events, mint/burn flows, yield, chains, and market-structure data. Protected public routes require X-API-Key. Request email-verified access at https://pharos.watch/api/.",
      contact: {
        name: "Pharos",
        url: "https://pharos.watch/api/",
        email: "admin@pharos.watch",
      },
      license: {
        name: "MIT",
        url: "https://github.com/TokenBrice/pharos-watch/blob/main/LICENSE",
      },
    },
    externalDocs: {
      description: "Full Pharos API reference",
      url: "https://pharos.watch/about/api/",
    },
    servers: [{ url: "https://api.pharos.watch", description: "Public integration API" }],
    security: [{ ApiKeyAuth: [] }],
    tags: PUBLIC_API_ARTIFACT_TAGS.map((name) => ({ name, description: TAG_DESCRIPTIONS[name] })),
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
        ...buildOpenApiResponseSchemas(),
      },
    },
  };
}

function render() {
  return `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  syncGeneratedArtifacts({
    artifacts: [{ path: OUTPUT_PATH, contents: render() }],
    check: CHECK_MODE,
    staleMessage: "OpenAPI spec is out of date. Run `tsx scripts/maintenance/generate-openapi-spec.ts`.",
    currentMessage: "OpenAPI spec is current",
    writtenMessage: "Generated OpenAPI spec",
  });
}

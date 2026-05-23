import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_API_ARTIFACT_ENDPOINTS,
  PUBLIC_API_ARTIFACT_TAGS,
  type PublicApiArtifactEndpoint,
} from "../lib/public-api-artifact-catalog";
import { syncGeneratedArtifacts } from "../lib/generated-artifacts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, "../../public/openapi.json");
const CHECK_MODE = process.argv.includes("--check");

function schemaRef(name: string) {
  return { $ref: `#/components/schemas/${name}` };
}

function nullableRef(name: string) {
  return {
    oneOf: [
      schemaRef(name),
      { type: "null" },
    ],
  };
}

const stringOrNull = { type: ["string", "null"] };
const numberOrNull = { type: ["number", "null"] };

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
        YieldRankingsResponse: {
          type: "object",
          description: "Yield Intelligence rankings payload.",
          required: ["rankings", "riskFreeRate", "scalingFactor", "medianApy", "updatedAt"],
          properties: {
            rankings: {
              type: "array",
              items: schemaRef("YieldRanking"),
            },
            riskFreeRate: { type: "number" },
            benchmarks: {
              type: "object",
              description: "Benchmark registry keyed by currency such as USD, EUR, and CHF.",
              additionalProperties: true,
            },
            scalingFactor: { type: "number" },
            medianApy: { type: "number" },
            updatedAt: {
              type: "number",
              description: "Unix seconds when the rankings were last computed.",
            },
            provenance: {
              type: ["object", "null"],
              description: "Snapshot-level source, benchmark, pool, and safety provenance.",
              additionalProperties: true,
            },
            warnings: {
              type: "array",
              items: {
                type: "object",
                required: ["code", "message"],
                properties: {
                  code: { type: "string" },
                  message: { type: "string" },
                  reasons: {
                    type: "array",
                    items: { type: "string" },
                  },
                },
                additionalProperties: true,
              },
            },
            publication: nullableRef("YieldPublicationMetadata"),
            methodology: {
              type: "object",
              description: "Yield methodology envelope when emitted by the rankings publisher.",
              additionalProperties: true,
            },
            _meta: {
              type: "object",
              description: "Cache freshness metadata when present.",
              additionalProperties: true,
            },
          },
          additionalProperties: true,
        },
        YieldRanking: {
          type: "object",
          description: "Ranked stablecoin yield row.",
          required: [
            "id",
            "symbol",
            "name",
            "currentApy",
            "apy7d",
            "apy30d",
            "apyBase",
            "apyReward",
            "yieldSource",
            "yieldType",
            "dataSource",
            "sourceTvlUsd",
            "pharosYieldScore",
            "safetyScore",
            "safetyGrade",
            "yieldToRisk",
            "excessYield",
            "yieldStability",
            "apyVariance30d",
            "apyMin30d",
            "apyMax30d",
            "warningSignals",
            "altSources",
          ],
          properties: {
            id: { type: "string" },
            symbol: { type: "string" },
            name: { type: "string" },
            currentApy: { type: "number" },
            apy7d: { type: "number" },
            apy30d: { type: "number" },
            apyBase: numberOrNull,
            apyReward: numberOrNull,
            yieldSource: { type: "string" },
            yieldSourceUrl: stringOrNull,
            yieldType: { type: "string" },
            dataSource: { type: "string" },
            sourceTvlUsd: numberOrNull,
            pharosYieldScore: numberOrNull,
            safetyScore: numberOrNull,
            safetyGrade: stringOrNull,
            yieldToRisk: numberOrNull,
            excessYield: numberOrNull,
            benchmarkKey: {
              type: "string",
              enum: ["USD", "EUR", "CHF"],
            },
            benchmarkLabel: { type: "string" },
            benchmarkCurrency: { type: "string" },
            benchmarkRate: { type: "number" },
            benchmarkRecordDate: stringOrNull,
            benchmarkIsFallback: { type: "boolean" },
            benchmarkFallbackMode: stringOrNull,
            benchmarkSelectionMode: {
              type: "string",
              enum: ["native", "fallback-usd", "manual-override"],
            },
            benchmarkIsProxy: { type: "boolean" },
            yieldStability: numberOrNull,
            apyVariance30d: numberOrNull,
            apyMin30d: numberOrNull,
            apyMax30d: numberOrNull,
            warningSignals: {
              type: "array",
              items: { type: "string" },
            },
            altSources: {
              type: "array",
              items: schemaRef("AltYieldSource"),
            },
            provenance: {
              type: ["object", "null"],
              description: "Selected-source provenance, benchmark state, and source-switch metadata.",
              additionalProperties: true,
            },
            publicationGenerationId: stringOrNull,
            publishedRank: numberOrNull,
            liveRank: numberOrNull,
            sourceRisk: nullableRef("YieldSourceRisk"),
            rankChangeAttribution: {
              type: ["object", "null"],
              description:
                "Optional rank-change attribution with previous rank/PYS, delta, primary driver, and driver contribution hints.",
              additionalProperties: true,
            },
          },
          additionalProperties: true,
        },
        AltYieldSource: {
          type: "object",
          description: "Retained non-selected yield source row for the same stablecoin.",
          required: [
            "sourceKey",
            "yieldSource",
            "yieldType",
            "currentApy",
            "apy30d",
            "sourceTvlUsd",
            "dataSource",
          ],
          properties: {
            sourceKey: { type: "string" },
            yieldSource: { type: "string" },
            yieldSourceUrl: stringOrNull,
            yieldType: { type: "string" },
            currentApy: { type: "number" },
            apy30d: { type: "number" },
            sourceTvlUsd: numberOrNull,
            dataSource: { type: "string" },
            sourceRisk: nullableRef("YieldSourceRisk"),
          },
          additionalProperties: true,
        },
        YieldSourceRisk: {
          type: "object",
          description: "Nested source-risk evidence used by PYS v8. Missing or unknown evidence is neutral.",
          properties: {
            sourceRiskScore: {
              ...numberOrNull,
              minimum: 0,
              maximum: 100,
            },
            sourceRiskPenalty: {
              ...numberOrNull,
              minimum: 1,
              description: "PYS v8 source-risk multiplier; runtime clamps populated values to the active range.",
            },
            sourceDepthRatio: {
              ...numberOrNull,
              minimum: 0,
            },
            rewardShare: {
              ...numberOrNull,
              minimum: 0,
              maximum: 1,
            },
            sourceAgeSeconds: {
              type: ["integer", "null"],
              minimum: 0,
            },
            observationCount30d: {
              type: ["integer", "null"],
              minimum: 0,
            },
            sourceSwitchCount30d: {
              type: ["integer", "null"],
              minimum: 0,
            },
            deploymentPlace: {
              type: ["string", "null"],
              enum: [
                "native-wrapper",
                "issuer-savings",
                "lending-market",
                "strategy-vault",
                "lp-or-dex",
                "rwa-fund",
                "reward-program",
                "rate-derived",
                "price-derived",
                null,
              ],
            },
            venueProtocol: stringOrNull,
            venueChain: stringOrNull,
            venueRiskTier: {
              type: ["string", "null"],
              enum: ["low", "medium", "high", "unknown", null],
              description: "`unknown` remains neutral and should be treated as missing evidence.",
            },
            investabilityFlags: {
              type: "array",
              items: { type: "string" },
            },
          },
          additionalProperties: true,
        },
        YieldPublicationMetadata: {
          type: "object",
          description: "Generation metadata for published yield payloads.",
          properties: {
            generationId: stringOrNull,
            updatedAt: numberOrNull,
            cutoffAt: numberOrNull,
            schemaVersion: {
              type: ["integer", "null"],
              minimum: 1,
            },
            status: {
              type: ["string", "null"],
              enum: ["staged", "published", "failed", null],
            },
          },
          additionalProperties: true,
        },
        YieldAdapterManifestResponse: {
          type: "object",
          description: "Yield adapter source-list manifest payload.",
          required: ["methodologyVersion", "updatedAt", "entries"],
          properties: {
            methodologyVersion: { type: "string" },
            updatedAt: {
              type: "number",
              description: "Unix seconds for the methodology snapshot backing the manifest.",
            },
            entries: {
              type: "array",
              items: schemaRef("YieldAdapterManifestEntry"),
            },
          },
          additionalProperties: true,
        },
        YieldAdapterManifestEntry: {
          type: "object",
          description: "One yield adapter manifest row.",
          required: [
            "stablecoinId",
            "coinSymbol",
            "family",
            "sourceKey",
            "label",
            "lifecycle",
            "methodologyVersion",
            "updatedAt",
          ],
          properties: {
            stablecoinId: { type: "string" },
            coinSymbol: { type: "string" },
            family: {
              type: "string",
              enum: [
                "onchain",
                "protocol-api",
                "defillama",
                "defillama-auto",
                "rate-derived",
                "price-derived",
                "intentional-gap",
              ],
            },
            sourceKey: {
              type: ["string", "null"],
              description: "Exact runtime source key when the strategy publishes a joinable yield_history/rankings source; null for disabled or runtime-resolved strategies.",
            },
            sourceKeyPattern: {
              ...stringOrNull,
              description: "Human-readable source-key pattern or would-be key for runtime-resolved or disabled strategies.",
            },
            label: { type: "string" },
            chain: stringOrNull,
            project: stringOrNull,
            lifecycle: { type: "string" },
            quarantineReason: stringOrNull,
            methodologyVersion: { type: "string" },
            updatedAt: {
              type: "number",
              description: "Unix seconds for the methodology snapshot backing the manifest entry.",
            },
          },
          additionalProperties: true,
        },
        YieldHistoryResponse: {
          type: "object",
          description: "Per-stablecoin yield history payload.",
          required: ["current", "history", "methodology"],
          properties: {
            current: nullableRef("YieldHistoryPoint"),
            history: {
              type: "array",
              items: schemaRef("YieldHistoryPoint"),
            },
            warning: { type: "string" },
            methodology: {
              type: "object",
              description: "Yield methodology envelope.",
              additionalProperties: true,
            },
            publication: nullableRef("YieldPublicationMetadata"),
          },
          additionalProperties: true,
        },
        YieldHistoryPoint: {
          type: "object",
          description: "One historical yield observation.",
          required: ["date", "apy", "apyBase", "apyReward", "exchangeRate", "sourceTvlUsd", "warningSignals"],
          properties: {
            date: {
              oneOf: [
                { type: "number" },
                { type: "string" },
              ],
            },
            apy: { type: "number" },
            apyBase: numberOrNull,
            apyReward: numberOrNull,
            exchangeRate: numberOrNull,
            sourceTvlUsd: numberOrNull,
            warningSignals: {
              type: "array",
              items: { type: "string" },
            },
            sourceKey: stringOrNull,
            yieldSource: stringOrNull,
            yieldSourceUrl: stringOrNull,
            yieldType: stringOrNull,
            dataSource: stringOrNull,
            isBest: { type: "boolean" },
            sourceSwitch: { type: "boolean" },
            publicationGenerationId: stringOrNull,
            sourceRisk: nullableRef("YieldSourceRisk"),
          },
          additionalProperties: true,
        },
      },
    },
  }, null, 2)}\n`;
}

syncGeneratedArtifacts({
  artifacts: [{ path: OUTPUT_PATH, contents: render() }],
  check: CHECK_MODE,
  staleMessage: "OpenAPI spec is out of date. Run `tsx scripts/maintenance/generate-openapi-spec.ts`.",
  currentMessage: "OpenAPI spec is current",
  writtenMessage: "Generated OpenAPI spec",
});

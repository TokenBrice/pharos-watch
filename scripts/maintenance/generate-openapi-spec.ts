import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_API_ARTIFACT_ENDPOINTS,
  PUBLIC_API_ARTIFACT_TAGS,
  type PublicApiArtifactEndpoint,
} from "../lib/public-api-artifact-catalog";
import { syncGeneratedArtifacts } from "../lib/generated-artifacts";
import { REPORT_CARDS_V9_RESPONSE_SCHEMA_VERSION } from "../../shared/types/report-cards-v9";

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
const numberScore = { type: "number", minimum: 0, maximum: 100 };
const sourceConfidenceTierEnum = ["deterministic", "curated", "discovered", "fallback"];
const yieldSourceRoleEnum = [
  "canonical-holder",
  "external-opportunity",
  "fallback-proxy",
  "audit-alternate",
  "degraded-canonical",
];
const yieldDecisionRejectionReasonEnum = [
  "thinner",
  "stale",
  "lower-confidence",
  "rewards-only",
  "smaller",
  "unspecified",
];

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
        SafetyScoreV9PublicationIdentity: {
          type: "object",
          additionalProperties: false,
          required: [
            "model",
            "schemaVersion",
            "methodologyVersion",
            "policyId",
            "policyDigest",
            "evaluationBuildDigest",
            "baseInputGenerationId",
            "publicationGenerationId",
          ],
          properties: {
            model: { const: "v9" },
            schemaVersion: { const: 1 },
            methodologyVersion: { type: "string", minLength: 1 },
            policyId: { type: "string", minLength: 1 },
            policyDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
            evaluationBuildDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
            baseInputGenerationId: { type: "string", pattern: "^report-cards-input:v1:[a-f0-9]{64}$" },
            publicationGenerationId: { type: "string", minLength: 1 },
          },
        },
        ReportCardsV9PublicReason: {
          type: "object",
          additionalProperties: false,
          required: ["code", "message", "path"],
          properties: {
            code: { type: "string" },
            message: { type: "string", minLength: 1 },
            path: stringOrNull,
          },
        },
        ReportCardsV9Pillar: {
          type: "object",
          additionalProperties: false,
          required: ["score", "evidenceLevel", "freshness", "components", "reasons"],
          properties: {
            score: numberOrNull,
            evidenceLevel: { enum: ["strong", "adequate", "limited", "insufficient"] },
            freshness: { enum: ["current", "stale", "unknown"] },
            components: { type: "array", items: { type: "string" } },
            reasons: { type: "array", items: schemaRef("ReportCardsV9PublicReason") },
          },
        },
        ReportCardsV9Card: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "score",
            "grade",
            "qualityScore",
            "pegMultiplier",
            "pegAdjustedScore",
            "pillars",
            "weakestPillar",
            "caps",
            "bindingCap",
            "nrReasons",
            "reasonCodes",
            "evidence",
            "accessPosture",
            "dependencies",
            "scoreTrace",
            "breakdowns",
          ],
          properties: {
            id: { type: "string", minLength: 1 },
            score: numberOrNull,
            grade: { enum: ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D", "F", "NR"] },
            qualityScore: numberOrNull,
            pegMultiplier: numberOrNull,
            pegAdjustedScore: numberOrNull,
            pillars: {
              type: "object",
              additionalProperties: false,
              required: ["backing", "exit", "control"],
              properties: {
                backing: schemaRef("ReportCardsV9Pillar"),
                exit: schemaRef("ReportCardsV9Pillar"),
                control: schemaRef("ReportCardsV9Pillar"),
              },
            },
            weakestPillar: {
              oneOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["pillar", "score"],
                  properties: {
                    pillar: { enum: ["backing", "exit", "control"] },
                    score: { type: "number", minimum: 0, maximum: 100 },
                  },
                },
                { type: "null" },
              ],
            },
            caps: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["kind", "limit", "source", "reason", "binding"],
                properties: {
                  kind: { type: "string", minLength: 1 },
                  limit: { type: "number", minimum: 0, maximum: 100 },
                  source: { type: "string" },
                  reason: { type: "string", minLength: 1 },
                  binding: { type: "boolean" },
                },
              },
            },
            bindingCap: {
              oneOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "limit", "source", "reason", "binding"],
                  properties: {
                    kind: { type: "string", minLength: 1 },
                    limit: { type: "number", minimum: 0, maximum: 100 },
                    source: { type: "string" },
                    reason: { type: "string", minLength: 1 },
                    binding: { type: "boolean" },
                  },
                },
                { type: "null" },
              ],
            },
            nrReasons: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["code", "message", "field", "origin"],
                properties: {
                  code: { type: "string" },
                  message: { type: "string", minLength: 1 },
                  field: stringOrNull,
                  origin: { enum: ["asset", "upstream"] },
                },
              },
            },
            reasonCodes: { type: "array", items: { type: "string" } },
            evidence: {
              type: "object",
              additionalProperties: false,
              required: ["level", "freshness", "reasons"],
              properties: {
                level: { enum: ["strong", "adequate", "limited", "insufficient"] },
                freshness: { enum: ["current", "stale", "unknown"] },
                reasons: { type: "array", items: schemaRef("ReportCardsV9PublicReason") },
              },
            },
            accessPosture: {
              type: "object",
              additionalProperties: false,
              required: ["transfer", "freezeExposure", "primaryExit", "governance", "unknownFields", "signals", "reasons"],
              properties: {
                transfer: { enum: ["permissionless", "restrictable", "permissioned", "unknown"] },
                freezeExposure: { enum: ["none-known", "upstream", "direct", "possible", "unknown"] },
                primaryExit: { enum: ["permissionless", "eligibility-gated", "issuer-discretionary", "none", "unknown"] },
                governance: { enum: ["immutable", "distributed", "concentrated", "single-entity", "unknown"] },
                unknownFields: { type: "array", items: { type: "string" } },
                signals: { type: "array", items: { type: "string" } },
                reasons: { type: "array", items: schemaRef("ReportCardsV9PublicReason") },
              },
            },
            dependencies: {
              type: "object",
              additionalProperties: false,
              required: ["serial", "basket", "cycleBlocked", "reasonCodes"],
              properties: {
                serial: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["upstreamAssetId", "score", "blocked"],
                    properties: {
                      upstreamAssetId: { type: "string", minLength: 1 },
                      score: numberOrNull,
                      blocked: { type: "boolean" },
                    },
                  },
                },
                basket: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["upstreamAssetId", "weight", "score", "boundedUnknown"],
                    properties: {
                      upstreamAssetId: { type: "string", minLength: 1 },
                      weight: { type: "number", minimum: 0, maximum: 1 },
                      score: numberOrNull,
                      boundedUnknown: { type: "boolean" },
                    },
                  },
                },
                cycleBlocked: { type: "boolean" },
                reasonCodes: { type: "array", items: { type: "string" } },
              },
            },
            scoreTrace: schemaRef("ReportCardsV9ScoreTrace"),
            breakdowns: {
              oneOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["backing", "exit", "control"],
                  properties: {
                    backing: { type: "object", additionalProperties: true },
                    exit: { type: "object", additionalProperties: true },
                    control: { type: "object", additionalProperties: true },
                  },
                },
                { type: "null" },
              ],
            },
          },
        },
        ReportCardsV9ScoreAdjustment: {
          type: "object",
          additionalProperties: false,
          required: [
            "source",
            "kind",
            "label",
            "configuredPoints",
            "appliedPoints",
            "scoreBefore",
            "scoreAfter",
            "publishedScoreBefore",
            "publishedScoreAfter",
            "capRelief",
          ],
          properties: {
            source: { const: "asset-premium" },
            kind: { enum: ["market-anchor-longevity"] },
            label: { type: "string", minLength: 1 },
            configuredPoints: { type: "number", exclusiveMinimum: 0, maximum: 20 },
            appliedPoints: { type: "number", exclusiveMinimum: 0, maximum: 20 },
            scoreBefore: numberScore,
            scoreAfter: numberScore,
            publishedScoreBefore: numberScore,
            publishedScoreAfter: numberScore,
            capRelief: {
              type: "object",
              additionalProperties: false,
              required: ["source", "kind", "fromLimit", "toLimit"],
              properties: {
                source: { const: "structural" },
                kind: { type: "string", minLength: 1 },
                fromLimit: numberScore,
                toLimit: numberScore,
              },
            },
          },
        },
        ReportCardsV9ScoreTrace: {
          type: "object",
          description: "Current causal scoring trace with explicit policy-defined score adjustments.",
          required: [
            "schemaVersion",
            "legacyAliases",
            "aggregation",
            "stages",
            "deploymentRisk",
            "adverseAttribution",
            "boundedUncertaintyAttribution",
            "evidenceResponsibility",
            "scoreAdjustments",
            "wrapperParentLimit",
          ],
          properties: {
            schemaVersion: { const: 3 },
            legacyAliases: { type: "object" },
            aggregation: { type: ["object", "null"] },
            stages: { type: "object" },
            deploymentRisk: { type: "object" },
            adverseAttribution: { type: "object" },
            boundedUncertaintyAttribution: { type: "object" },
            evidenceResponsibility: { type: "object" },
            scoreAdjustments: {
              type: "array",
              maxItems: 1,
              items: schemaRef("ReportCardsV9ScoreAdjustment"),
            },
            wrapperParentLimit: { type: ["object", "null"] },
          },
          additionalProperties: false,
        },
        ReportCardsV9DependencyEdge: {
          type: "object",
          additionalProperties: false,
          required: ["from", "to", "kind", "materiality", "weight", "upstreamScore"],
          properties: {
            from: { type: "string", minLength: 1 },
            to: { type: "string", minLength: 1 },
            kind: { enum: ["serial", "basket"] },
            materiality: { enum: ["serial", "serial-blocked", "basket-weighted", "basket-bounded-unknown"] },
            weight: numberOrNull,
            upstreamScore: numberOrNull,
          },
        },
        ReportCardsV9Response: {
          type: "object",
          additionalProperties: false,
          required: [
            "model",
            "schemaVersion",
            "lifecycle",
            "safetyScoreIdentity",
            "methodology",
            "asOfSec",
            "updatedAt",
            "completeness",
            "source",
            "publicationHealth",
            "cards",
            "dependencyGraph",
          ],
          properties: {
            model: { const: "v9" },
            schemaVersion: { const: REPORT_CARDS_V9_RESPONSE_SCHEMA_VERSION },
            lifecycle: { const: "active" },
            safetyScoreIdentity: schemaRef("SafetyScoreV9PublicationIdentity"),
            methodology: {
              type: "object",
              additionalProperties: false,
              required: ["version", "policy"],
              properties: {
                version: { type: "string", minLength: 1 },
                policy: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id", "semanticDigest"],
                  properties: {
                    id: { type: "string", minLength: 1 },
                    semanticDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
                  },
                },
              },
            },
            asOfSec: { type: "integer", minimum: 0 },
            updatedAt: { type: "integer", minimum: 0 },
            completeness: {
              type: "object",
              additionalProperties: false,
              required: ["expectedCount", "ratedCount", "notRatedCount", "notRatedIds"],
              properties: {
                expectedCount: { type: "integer", minimum: 0 },
                ratedCount: { type: "integer", minimum: 0 },
                notRatedCount: { type: "integer", minimum: 0 },
                notRatedIds: { type: "array", items: { type: "string" } },
              },
            },
            source: {
              type: "object",
              additionalProperties: false,
              required: ["candidateId", "factSetDigest", "resultDigest", "sourceGenerations"],
              properties: {
                candidateId: { type: "string", minLength: 1 },
                factSetDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
                resultDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
                sourceGenerations: { type: "object", additionalProperties: { type: "string" } },
              },
            },
            publicationHealth: {
              type: "object",
              additionalProperties: false,
              required: [
                "schemaVersion",
                "status",
                "acceptedPublicationGenerationId",
                "acceptedAtSec",
                "attemptedAtSec",
                "heldSinceSec",
                "reasons",
              ],
              properties: {
                schemaVersion: { const: 1 },
                status: { enum: ["current", "held"] },
                acceptedPublicationGenerationId: stringOrNull,
                acceptedAtSec: { type: ["integer", "null"], minimum: 0 },
                attemptedAtSec: { type: "integer", minimum: 0 },
                heldSinceSec: { type: ["integer", "null"], minimum: 0 },
                reasons: { type: "array", maxItems: 24, items: { type: "object" } },
              },
            },
            cards: { type: "array", items: schemaRef("ReportCardsV9Card") },
            dependencyGraph: {
              type: "object",
              additionalProperties: false,
              required: ["edges"],
              properties: {
                edges: { type: "array", items: schemaRef("ReportCardsV9DependencyEdge") },
              },
            },
          },
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
            alternateSummary: nullableRef("YieldAlternateSummary"),
            provenance: {
              type: ["object", "null"],
              description: "Selected-source provenance, benchmark state, and source-switch metadata.",
              additionalProperties: true,
            },
            publicationGenerationId: stringOrNull,
            publishedRank: numberOrNull,
            liveRank: numberOrNull,
            sourceRisk: nullableRef("YieldSourceRisk"),
            sourceRole: {
              type: "string",
              enum: yieldSourceRoleEnum,
              description: "Worker-derived role explaining how the selected source participates in arbitration.",
            },
            rankChangeAttribution: {
              type: ["object", "null"],
              description:
                "Optional rank-change attribution with previous rank/PYS, delta, primary driver, and driver contribution hints.",
              additionalProperties: true,
            },
            decisionLedger: nullableRef("YieldPublicDecisionLedger"),
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
            sourceRole: {
              type: "string",
              enum: yieldSourceRoleEnum,
            },
            confidenceTier: {
              type: "string",
              enum: sourceConfidenceTierEnum,
            },
            selectionRank: {
              type: "integer",
              minimum: 1,
              description: "Rank inside the worker's source-candidate ordering for this stablecoin.",
            },
            rejectionReasonCode: {
              type: "string",
              enum: yieldDecisionRejectionReasonEnum,
            },
          },
          additionalProperties: true,
        },
        YieldAlternateSummary: {
          type: "object",
          description: "Deterministic summary of retained non-selected source rows.",
          required: ["count", "bestAlternateByApy", "bestRiskAdjustedAlternate", "alternateApySpread"],
          properties: {
            count: {
              type: "integer",
              minimum: 0,
            },
            bestAlternateByApy: nullableRef("YieldAlternateSourceSummary"),
            bestRiskAdjustedAlternate: nullableRef("YieldAlternateSourceSummary"),
            alternateApySpread: numberOrNull,
          },
          additionalProperties: true,
        },
        YieldAlternateSourceSummary: {
          type: "object",
          description: "Compact alternate source summary used by ranking rows.",
          required: [
            "sourceKey",
            "yieldSource",
            "yieldType",
            "dataSource",
            "currentApy",
            "apy30d",
            "apy30dDelta",
            "sourceTvlUsd",
          ],
          properties: {
            sourceKey: { type: "string" },
            yieldSource: { type: "string" },
            yieldType: { type: "string" },
            dataSource: { type: "string" },
            currentApy: { type: "number" },
            apy30d: { type: "number" },
            apy30dDelta: { type: "number" },
            sourceTvlUsd: numberOrNull,
            confidenceTier: {
              type: "string",
              enum: sourceConfidenceTierEnum,
            },
            sourceRole: {
              type: "string",
              enum: yieldSourceRoleEnum,
            },
            sourceRiskPenalty: numberOrNull,
            riskAdjustedUtility: numberOrNull,
          },
          additionalProperties: true,
        },
        YieldPublicDecisionLedger: {
          type: "object",
          description: "Bounded public source-selection decision evidence for a ranking row.",
          properties: {
            selectedReasonCode: {
              type: "string",
              enum: [
                "best-by-confidence-and-apy",
                "deterministic-preferred",
                "curated-over-discovered",
                "tier-preference",
                "tvl-floor",
                "freshness-tiebreaker",
                "fallback",
                "no-alternatives",
              ],
            },
            previousBestSourceKey: stringOrNull,
            sourceSwitch: { type: "boolean" },
            apy30dDeltaFromPrevious: numberOrNull,
            rejectedCount: {
              type: "integer",
              minimum: 0,
            },
            alternatives: {
              type: "array",
              maxItems: 2,
              items: schemaRef("YieldPublicDecisionAlternative"),
            },
          },
          additionalProperties: true,
        },
        YieldPublicDecisionAlternative: {
          type: "object",
          description: "Compact retained alternate inside a row decision ledger.",
          required: ["sourceKey", "yieldSource", "apy30dDelta", "rejectionReasonCode"],
          properties: {
            sourceKey: { type: "string" },
            yieldSource: { type: "string" },
            apy30dDelta: { type: "number" },
            rejectionReasonCode: {
              type: "string",
              enum: yieldDecisionRejectionReasonEnum,
            },
            confidenceTier: {
              type: "string",
              enum: sourceConfidenceTierEnum,
            },
            sourceRole: {
              type: "string",
              enum: yieldSourceRoleEnum,
            },
            selectionRank: {
              type: "integer",
              minimum: 1,
            },
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
                "structured-tranche",
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
            venueRiskScores: {
              type: ["object", "null"],
              properties: {
                audits: { type: "number", minimum: 1, maximum: 5 },
                centralization: { type: "number", minimum: 1, maximum: 5 },
                fundsManagement: { type: "number", minimum: 1, maximum: 5 },
                liquidity: { type: "number", minimum: 1, maximum: 5 },
                operational: { type: "number", minimum: 1, maximum: 5 },
              },
              additionalProperties: false,
            },
            venueRiskWeighted: {
              ...numberOrNull,
              minimum: 1,
              maximum: 5,
            },
            venueRiskConfidence: {
              type: ["string", "null"],
              enum: ["verified", "partial", "low", null],
            },
            dependencyConcentration: {
              type: ["object", "null"],
              properties: {
                ecosystem: { type: "string" },
                severity: {
                  type: "string",
                  enum: ["low", "medium", "high"],
                },
                note: { type: "string" },
                reviewedAt: { type: "string" },
              },
              additionalProperties: true,
            },
            investabilityFlags: {
              type: "array",
              items: { type: "string" },
            },
            trancheSide: {
              type: ["string", "null"],
              enum: ["senior", "junior", null],
            },
            trancheSafetyScore: {
              ...numberOrNull,
              minimum: 0,
              maximum: 100,
            },
            trancheSafetyPenalty: {
              ...numberOrNull,
              minimum: 0,
            },
            underlyingSafetyScore: {
              ...numberOrNull,
              minimum: 0,
              maximum: 100,
            },
            marketCoverageRatio: {
              ...numberOrNull,
              minimum: 0,
            },
            marketMinCoverageRatio: {
              ...numberOrNull,
              minimum: 0,
            },
            marketUtilizationRatio: {
              ...numberOrNull,
              minimum: 0,
            },
            marketUtilizationLimitRatio: {
              ...numberOrNull,
              minimum: 0,
            },
            marketDrawdownRatio: {
              ...numberOrNull,
              minimum: 0,
            },
            marketTotalDrawdowns: {
              type: ["integer", "null"],
              minimum: 0,
            },
            marketStatus: {
              type: ["string", "null"],
              enum: ["normal", "protected", "unhealthy", "critical", null],
            },
            marketTvlUsd: {
              ...numberOrNull,
              minimum: 0,
            },
            trancheTvlUsd: {
              ...numberOrNull,
              minimum: 0,
            },
            trancheShareTokenAddress: stringOrNull,
            trancheDepositTokenAddress: stringOrNull,
            withdrawalDelaySeconds: {
              type: ["integer", "null"],
              minimum: 0,
            },
            kycRequired: {
              type: ["boolean", "null"],
            },
            accessRestricted: {
              type: ["boolean", "null"],
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

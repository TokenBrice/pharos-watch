import { describe, expect, it } from "vitest";
import { z } from "zod";

import { DigestSafetyMapSummarySchema } from "@shared/types/digest";
import { ApiRequestAttributionResponseSchema } from "@shared/types/request-source";
import { StablecoinDataSchema, StablecoinDataOutputSchema } from "@shared/types/market";
import { ReserveBoundedFactKindSchema, ReserveBoundedFactSchema } from "@shared/types/reserve-bounded-facts";
import {
  YIELD_ADAPTER_LIFECYCLE_VALUES,
  YieldHistoryResponseSchema,
} from "@shared/types/yield";
import {
  OPENAPI_JSON_VALUE_ENDPOINT_KEYS,
  PUBLIC_API_ARTIFACT_ENDPOINTS,
  type PublicApiArtifactEndpoint,
} from "../lib/public-api-artifact-catalog";
import { PUBLIC_API_RESPONSE_SCHEMAS } from "../lib/public-api-response-schemas";
import {
  buildOpenApiDocument,
  buildOpenApiResponseSchemas,
} from "../maintenance/generate-openapi-spec";

type JsonSchemaObject = Record<string, unknown> & { $ref?: string };

function resolveSchemaRef(schema: unknown, components: Record<string, unknown>): JsonSchemaObject {
  const candidate = schema as JsonSchemaObject;
  if (typeof candidate.$ref !== "string") {
    return candidate;
  }
  const path = candidate.$ref.replace("#/components/schemas/", "").split("/");
  let resolved: unknown = components;
  for (const segment of path) {
    resolved = (resolved as Record<string, unknown>)[segment];
  }
  return resolved as JsonSchemaObject;
}

function resolveSchemaTree(
  schema: unknown,
  components: Record<string, unknown>,
  seenRefs = new Set<string>(),
): unknown {
  if (Array.isArray(schema)) {
    return schema.map((child) => resolveSchemaTree(child, components, seenRefs));
  }
  if (typeof schema !== "object" || schema === null) {
    return schema;
  }
  const candidate = schema as JsonSchemaObject;
  if (typeof candidate.$ref === "string" && !seenRefs.has(candidate.$ref)) {
    const nextRefs = new Set(seenRefs);
    nextRefs.add(candidate.$ref);
    const resolved = resolveSchemaTree(
      resolveSchemaRef(candidate, components),
      components,
      nextRefs,
    ) as JsonSchemaObject;
    const siblings = Object.fromEntries(
      Object.entries(candidate)
        .filter(([key]) => key !== "$ref")
        .map(([key, child]) => [key, resolveSchemaTree(child, components, nextRefs)]),
    );
    return { ...resolved, ...siblings };
  }
  return Object.fromEntries(
    Object.entries(candidate).map(([key, child]) => [key, resolveSchemaTree(child, components, seenRefs)]),
  );
}

function collectPropertySchemas(schema: unknown, propertyName: string): JsonSchemaObject[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((child) => collectPropertySchemas(child, propertyName));
  }
  if (typeof schema !== "object" || schema === null) {
    return [];
  }
  const candidate = schema as JsonSchemaObject;
  const properties = candidate.properties as Record<string, unknown> | undefined;
  return [
    ...(properties?.[propertyName] ? [properties[propertyName] as JsonSchemaObject] : []),
    ...Object.values(candidate).flatMap((child) => collectPropertySchemas(child, propertyName)),
  ];
}

describe("OpenAPI runtime response contracts", () => {
  const document = buildOpenApiDocument();

  it("derives documented response components from their canonical Zod schemas", () => {
    const schemas = document.components.schemas as Record<string, unknown>;
    const historySchema = schemas.YieldHistoryResponse as {
      properties: { history: { items: Record<string, unknown> } };
    };
    const manifestSchema = schemas.YieldAdapterManifestResponse as {
      properties: { entries: { items: { properties: { lifecycle: { enum: readonly string[] } } } } };
    };
    const runtimeHistoryFields = Object.keys(
      YieldHistoryResponseSchema.shape.history.element.shape,
    );
    const historyItems = resolveSchemaRef(historySchema.properties.history.items, schemas);
    const openApiHistoryFields = Object.keys(historyItems.properties as Record<string, unknown>);

    expect(openApiHistoryFields).toEqual(runtimeHistoryFields);
    expect(openApiHistoryFields).toEqual(expect.arrayContaining([
      "pysAtPublish",
      "safetyAtPublish",
      "varianceAtPublish",
      "pysInputsAtPublish",
      "pysReproducibility",
    ]));
    expect(
      manifestSchema.properties.entries.items.properties.lifecycle.enum,
    ).toEqual(YIELD_ADAPTER_LIFECYCLE_VALUES);
  });

  it("publishes the expired-evidence responsibility in the report-card schema", () => {
    const schemas = document.components.schemas as Record<string, JsonSchemaObject>;
    const reportCardsSchema = resolveSchemaTree(schemas.ReportCardsV9Response, schemas) as {
      properties: { cards: { items: { properties: { scoreTrace: { properties: {
        evidenceResponsibility: { properties: { summaries: { items: { properties: {
          responsibility: { enum: string[] };
        } } } } };
      } } } } } };
    };
    expect(reportCardsSchema.properties.cards.items.properties.scoreTrace.properties
      .evidenceResponsibility.properties.summaries.items.properties.responsibility.enum)
      .toContain("published-evidence-expired");
  });

  it("emits protected and public operation security, errors, and required path parameters", () => {
    const protectedOperation = document.paths["/api/stablecoin/{stablecoinId}"].get;
    expect(protectedOperation.security ?? document.security).toEqual([{ ApiKeyAuth: [] }]);
    expect(protectedOperation.responses).toHaveProperty("401");
    expect(protectedOperation.responses).toHaveProperty("429");
    expect(protectedOperation.parameters).toContainEqual(expect.objectContaining({
      name: "stablecoinId", in: "path", required: true,
    }));
    expect(protectedOperation.responses["200"].content["application/json"].schema)
      .toEqual({ $ref: "#/components/schemas/StablecoinDetailResponse" });
    const publicOperation = document.paths["/api/health"].get;
    expect(publicOperation.security).toEqual([]);
    expect(publicOperation.responses).not.toHaveProperty("401");
    expect(publicOperation.responses).not.toHaveProperty("429");
  });

  it("resolves every emitted reference, including colliding shared shapes", () => {
    const left = z.object({ value: z.string() });
    const right = z.object({ value: z.number() });
    const schemas = buildOpenApiResponseSchemas({
      CollisionResponse: z.object({ left, leftAgain: left, right, rightAgain: right }),
    });
    const walk = (value: unknown, root: unknown): void => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "$ref") {
          expect(child).toMatch(/^#\//);
          let resolved = root;
          for (const segment of (child as string).slice(2).split("/")) {
            resolved = (resolved as Record<string, unknown>)?.[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
          }
          expect(resolved, String(child)).toBeDefined();
        } else {
          walk(child, root);
        }
      }
    };
    walk(document, document);
    walk(schemas, { components: { schemas } });
    const collision = resolveSchemaTree(schemas.CollisionResponse, schemas) as {
      properties: Record<string, { properties: { value: { type: string } } }>;
    };
    expect(collision.properties.left.properties.value.type).toBe("string");
    expect(collision.properties.right.properties.value.type).toBe("number");
  });

  it("keeps every named endpoint response tied to the typed runtime registry", () => {
    const registeredNames = new Set(Object.keys(PUBLIC_API_RESPONSE_SCHEMAS));
    const endpoints: readonly PublicApiArtifactEndpoint[] = PUBLIC_API_ARTIFACT_ENDPOINTS;
    const namedResponses = endpoints
      .map((endpoint) => endpoint.responseSchema)
      .filter((name): name is NonNullable<typeof name> => name !== undefined);

    expect(namedResponses.length).toBeGreaterThan(0);
    expect(namedResponses.every((name) => registeredNames.has(name))).toBe(true);
    expect(
      endpoints
        .filter((endpoint) => endpoint.responseSchema === undefined)
        .map((endpoint) => endpoint.key)
        .sort(),
    ).toEqual([...OPENAPI_JSON_VALUE_ENDPOINT_KEYS].sort());
  });

  it("uses canonical runtime contracts for the five promoted response families", () => {
    const endpoints: readonly PublicApiArtifactEndpoint[] = PUBLIC_API_ARTIFACT_ENDPOINTS;
    const responseSchemas = Object.fromEntries(
      endpoints.map((endpoint) => [endpoint.key, endpoint.responseSchema]),
    );

    expect(responseSchemas).toMatchObject({
      "bluechip-ratings": "BluechipRatingsResponse",
      "dex-liquidity": "DexLiquidityResponse",
      "stress-signals": "StressSignalsResponse",
      "mint-burn-flows": "MintBurnFlowsResponse",
      "telegram-pulse": "TelegramPulseResponse",
    });
    // Five of the six former generic endpoints now carry real schemas. `snapshot-day` is the
    // sole remaining entry by decision, not by omission: its producer envelope spans the
    // historical V8 shape and a large inline V9 union. This list is a debt ledger, so it may
    // shrink but must never silently grow.
    expect([...OPENAPI_JSON_VALUE_ENDPOINT_KEYS].sort()).toEqual(["snapshot-day"]);
    expect(responseSchemas).toMatchObject({
      "stablecoin-detail": "StablecoinDetailResponse",
      "stablecoin-summary": "StablecoinSummaryResponse",
      "non-usd-share": "NonUsdShareResponse",
      "snapshots-index": "SnapshotsIndexResponse",
      "snapshot-coin": "SnapshotCoinResponse",
    });
  });

  it("publishes percentage-point scales for every clarified Pct response field", () => {
    const description = "Percentage points, 0-100 scale (not a 0-1 ratio)";
    const schemas = document.components.schemas as Record<string, unknown>;
    const responseFields = [
      ["DdrResponse", "supplyChange7dPct"],
      ["DdrResponse", "supplyChange30dPct"],
    ] as const;

    for (const [schemaName, propertyName] of responseFields) {
      const matches = collectPropertySchemas(
        resolveSchemaTree(schemas[schemaName], schemas),
        propertyName,
      );
      expect(matches.length, `${schemaName}.${propertyName}`).toBeGreaterThan(0);
      expect(matches.map((field) => field.description), `${schemaName}.${propertyName}`)
        .toEqual(Array(matches.length).fill(description));
    }

    expect(
      DigestSafetyMapSummarySchema.shape.tiers.element.shape.sharePct.description,
    ).toBe(description);

    const attributionFields = [
      ApiRequestAttributionResponseSchema.shape.totals.shape.siteSharePct,
      ApiRequestAttributionResponseSchema.shape.totals.shape.externalSharePct,
      ApiRequestAttributionResponseSchema.shape.keyedPublicApi.shape.keyedSharePct,
      ApiRequestAttributionResponseSchema.shape.keyedPublicApi.shape.unkeyedSharePct,
      ApiRequestAttributionResponseSchema.shape.apiKeys.element.shape.shareOfKeyedRequestsPct,
      ApiRequestAttributionResponseSchema.shape.apiKeys.element.shape.shareOfTotalPublicApiRequestsPct,
    ];
    expect(attributionFields.every((field) => field.description === description)).toBe(true);
  });

  it("rejects empty converted response schemas with their schema name", () => {
    expect(() => buildOpenApiResponseSchemas({ BrokenResponse: z.any() })).toThrow(
      'Public API response schema "BrokenResponse" converted to an empty JSON Schema',
    );
  });

  it.each([
    z.array(z.any()),
    z.array(z.object({ value: z.string() }).transform((value) => value)),
  ])("rejects nested erased array items instead of publishing an opaque item", (rows) => {
    expect(() => buildOpenApiResponseSchemas({ BrokenItemsResponse: z.object({ rows }) }))
      .toThrow(/BrokenItemsResponse.*empty array items/);
  });

  it("preserves normalized stablecoin item fields, provenance and nullability in generated JSON Schema", () => {
    const schemas = document.components.schemas as Record<string, unknown>;
    const response = resolveSchemaTree(schemas.StablecoinListResponse, schemas) as {
      properties: { peggedAssets: { items: JsonSchemaObject } };
    };
    const items = response.properties.peggedAssets.items;
    const properties = items.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toEqual(Object.keys(StablecoinDataOutputSchema.shape));
    expect(properties).not.toHaveProperty("gecko_id");
    expect(items.required).toEqual(expect.arrayContaining([
      "geckoId", "priceConfidence", "priceObservedAt", "circulatingPrevDay", "consensusSources",
    ]));
    const output = StablecoinDataSchema.parse({
      id: "usdc-circle", name: "USD Coin", symbol: "USDC", gecko_id: "usd-coin",
      pegType: "peggedUSD", pegMechanism: "fiat-backed", price: null, priceSource: null,
      priceUpdatedAt: 1700000000, circulating: { peggedUSD: 0 }, chains: ["Ethereum"],
      chainCirculating: { Ethereum: { current: null, circulatingPrevDay: 0 } },
      supplySource: "defillama", supplyObservedAt: 1700000000, supplyRestored: true,
      supplyGapFill: {
        method: "coingecko-single-missing-chain", admission: "entered", missingChainId: "1",
        canonicalSource: "defillama", canonicalCurrentUsd: 100,
        supplementalSource: "coingecko", supplementalCurrentUsd: 110,
        ratio: 1.1, maxRatio: 1.2, observedAt: 1700000000,
      },
    });
    expect(output.geckoId).toBe("usd-coin");
    expect(output.priceObservedAt).toBe(1700000000);
    const validator = z.fromJSONSchema(response as Parameters<typeof z.fromJSONSchema>[0]);
    expect(validator.safeParse({ peggedAssets: [output] }).success).toBe(true);
    expect(validator.safeParse({ peggedAssets: [42] }).success).toBe(false);
    expect(validator.safeParse({ peggedAssets: [{ ...output, price: "unavailable" }] }).success).toBe(false);
    expect(validator.safeParse({ peggedAssets: [{
      ...output, chainCirculating: { Ethereum: { current: -1 } },
    }] }).success).toBe(false);
  });

  it("preserves bounded-fact discriminants and evidence fields in generated JSON Schema", () => {
    const schemas = document.components.schemas as Record<string, unknown>;
    const reserves = resolveSchemaTree(schemas.StablecoinReservesResponse, schemas);
    const boundedFacts = collectPropertySchemas(reserves, "boundedFacts");
    expect(boundedFacts.length).toBeGreaterThan(0);
    for (const array of boundedFacts) {
      const items = array.items as { oneOf?: JsonSchemaObject[]; anyOf?: JsonSchemaObject[] };
      const variants = items.oneOf ?? items.anyOf ?? [];
      expect(variants.map((variant) => (variant.properties as Record<string, { const: string }>).kind.const).sort())
        .toEqual([...ReserveBoundedFactKindSchema.options].sort());
      const output = ReserveBoundedFactSchema.parse({
        factKey: "cash-liquidity", kind: "currently-liquid-fraction", scope: { kind: "reserve-envelope" },
        asOfSec: 1700000000, publisher: "issuer", sourceUrls: ["https://example.com/reserves"],
        assertion: "Available native cash", contentDigest: "a".repeat(64),
        provenance: {
          kind: "producer-observation", observer: "issuer-api", sourceId: "reserves",
          sourceGenerationId: "generation-1", observedAtSec: 1700000000, maxAgeSec: 3600, confidence: "high",
        },
        assetId: "cash", unit: "USD", chain: "offchain",
        currentlyWithdrawable: 50, totalHeld: 100, snapshotAtSec: 1700000000,
        availabilityMeaning: "currently-withdrawable-native-asset",
      });
      const validator = z.fromJSONSchema(array as Parameters<typeof z.fromJSONSchema>[0]);
      expect(validator.safeParse([output]).success).toBe(true);
      expect(validator.safeParse([42]).success).toBe(false);
      expect(validator.safeParse([{ ...output, kind: "unknown" }]).success).toBe(false);
      const { provenance: _provenance, ...withoutEvidence } = output;
      expect(validator.safeParse([withoutEvidence]).success).toBe(false);
    }
  });

  it("publishes properties for transform-bearing response output shapes", () => {
    const schemas = document.components.schemas as Record<string, {
      properties?: Record<string, unknown>;
    }>;

    for (const name of ["UsdsStatusResponse", "DailyDigestResponse", "TelegramPulseResponse"]) {
      expect(schemas[name].properties).toBeDefined();
      expect(Object.keys(schemas[name].properties ?? {})).not.toHaveLength(0);
    }
  });
});

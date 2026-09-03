import { describe, expect, it } from "vitest";
import { z } from "zod";

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
    return resolveSchemaTree(resolveSchemaRef(candidate, components), components, nextRefs);
  }
  return Object.fromEntries(
    Object.entries(candidate).map(([key, child]) => [key, resolveSchemaTree(child, components, seenRefs)]),
  );
}

describe("OpenAPI runtime response contracts", () => {
  it("derives documented response components from their canonical Zod schemas", () => {
    const document = buildOpenApiDocument();
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
    const document = buildOpenApiDocument();
    const schemas = document.components.schemas as Record<string, JsonSchemaObject>;
    const reportCardsSchema = resolveSchemaTree(schemas.ReportCardsV9Response, schemas);

    expect(JSON.stringify(reportCardsSchema)).toContain("published-evidence-expired");
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

  it("rejects empty converted response schemas with their schema name", () => {
    expect(() => buildOpenApiResponseSchemas({ BrokenResponse: z.any() })).toThrow(
      'Public API response schema "BrokenResponse" converted to an empty JSON Schema',
    );
  });

  it("publishes properties for transform-bearing response output shapes", () => {
    const schemas = buildOpenApiDocument().components.schemas as Record<string, {
      properties?: Record<string, unknown>;
    }>;

    for (const name of ["UsdsStatusResponse", "DailyDigestResponse", "TelegramPulseResponse"]) {
      expect(schemas[name].properties).toBeDefined();
      expect(Object.keys(schemas[name].properties ?? {})).not.toHaveLength(0);
    }
  });
});

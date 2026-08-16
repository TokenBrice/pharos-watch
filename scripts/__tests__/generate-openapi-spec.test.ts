import { describe, expect, it } from "vitest";

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
import { buildOpenApiDocument } from "../maintenance/generate-openapi-spec";

describe("OpenAPI runtime response contracts", () => {
  it("derives documented response components from their canonical Zod schemas", () => {
    const document = buildOpenApiDocument();
    const schemas = document.components.schemas as Record<string, unknown>;
    const historySchema = schemas.YieldHistoryResponse as {
      properties: { history: { items: { properties: Record<string, unknown> } } };
    };
    const manifestSchema = schemas.YieldAdapterManifestResponse as {
      properties: { entries: { items: { properties: { lifecycle: { enum: readonly string[] } } } } };
    };
    const runtimeHistoryFields = Object.keys(
      YieldHistoryResponseSchema.shape.history.element.shape,
    );
    const openApiHistoryFields = Object.keys(
      historySchema.properties.history.items.properties,
    );

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
    const responseSchemas = Object.fromEntries(
      PUBLIC_API_ARTIFACT_ENDPOINTS.map((endpoint) => [endpoint.key, endpoint.responseSchema]),
    );

    expect(responseSchemas).toMatchObject({
      "bluechip-ratings": "BluechipRatingsResponse",
      "dex-liquidity": "DexLiquidityResponse",
      "stress-signals": "StressSignalsResponse",
      "mint-burn-flows": "MintBurnFlowsResponse",
      "telegram-pulse": "TelegramPulseResponse",
    });
    expect([...OPENAPI_JSON_VALUE_ENDPOINT_KEYS].sort()).toEqual([
      "non-usd-share",
      "snapshot-coin",
      "snapshot-day",
      "snapshots-index",
      "stablecoin-detail",
      "stablecoin-summary",
    ]);
  });
});

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

  it("publishes the expired-evidence responsibility in the report-card schema", () => {
    const document = buildOpenApiDocument();
    const reportCardsSchema = document.components.schemas.ReportCardsV9Response;

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
});

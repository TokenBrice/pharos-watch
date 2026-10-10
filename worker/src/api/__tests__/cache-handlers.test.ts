import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";

import { z } from "zod";
import { handleBluechipRatings, handleStablecoins, handleUsdsStatus } from "../cache-handlers";
import { encodeResponseReadyCacheValue, getResponseReadyCacheKey } from "../../lib/api-cache-read";
import { RESPONSE_READY_CACHE_SCHEMA_IDS } from "../../lib/response-ready-cache-contracts";
import { buildOpenApiDocument } from "../../../../scripts/maintenance/generate-openapi-spec";

const IMPLEMENTATION_ADDRESS = "0x1923dfee706a8e78157416c29cbccfde7cdf4102";

describe("handleUsdsStatus", () => {
  it("returns malformed 503 when freeze capability evidence is absent", async () => {
    const db = mockD1([{
      match: "FROM cache WHERE key = ?",
      matchBinds: ["usds-status"],
      rows: [],
      first: {
        value: JSON.stringify({
          implementationAddress: IMPLEMENTATION_ADDRESS,
          lastChecked: 1_762_000_000,
        }),
        updated_at: 1_762_000_000,
      },
    }]);

    const response = await handleUsdsStatus(db);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Cached usds-status payload is malformed",
    });
  });
});

describe("public cache wire schemas", () => {
  it("validates actual cache wire bodies with typed freshness in generated JSON Schemas", async () => {
    const schemas = buildOpenApiDocument().components.schemas as Record<string, unknown>;
    // The native converter resolves local $defs; relocate the generated
    // OpenAPI component pointers without changing their validation keywords.
    const shared = z.object({ $defs: z.record(z.string(), z.unknown()) }).parse(schemas.SharedComponents);
    const definitions = z.record(z.string(), z.record(z.string(), z.unknown())).parse(JSON.parse(
      JSON.stringify({ ...schemas, ...shared.$defs })
        .replaceAll("#/components/schemas/SharedComponents/$defs/", "#/$defs/")
        .replaceAll("#/components/schemas/", "#/$defs/"),
    ));
    const now = Math.floor(Date.now() / 1000);
    const rating = {
      grade: "A", slug: "usdc", collateralization: null, smartContractAudit: null,
      dateOfRating: null, dateLastChange: null,
      smidge: { stability: null, management: null, implementation: null, decentralization: null, governance: null, externals: null },
    };
    const cases = [
      { name: "StablecoinListResponse", key: "stablecoins", handler: handleStablecoins, payload: { peggedAssets: [] } },
      { name: "BluechipRatingsResponse", key: "bluechip-ratings", handler: handleBluechipRatings, payload: { "usdc-circle": rating } },
      { name: "UsdsStatusResponse", key: "usds-status", handler: handleUsdsStatus,
        payload: { freezeCapabilityPresent: false, implementationAddress: "0x1923dfee706a8e78157416c29cbccfde7cdf4102", lastChecked: now } },
    ];
    for (const testCase of cases) {
      const validate = z.fromJSONSchema({ $ref: `#/$defs/${testCase.name}`, $defs: definitions });
      const db = mockD1([{ match: "cache", rows: [{ key: testCase.key, value: JSON.stringify(testCase.payload), updated_at: now }] }]);
      const response = await testCase.handler(db);
      expect(response.status, testCase.name).toBe(200);
      const body = z.record(z.string(), z.unknown()).parse(await response.json());
      expect(validate.safeParse(body).success).toBe(true);
      expect(validate.safeParse({ ...body, _meta: { updatedAt: now, ageSeconds: 0, status: "invented" } }).success).toBe(false);
      if (testCase.key === "bluechip-ratings") {
        expect(validate.safeParse({ ...body, unrelated: { updatedAt: now, ageSeconds: 0, status: "fresh" } }).success).toBe(false);
        expect(validate.safeParse({ ...body, "usdc-circle": { ...rating, grade: "invalid" } }).success).toBe(false);
      }
    }
    // A matching trusted companion bypasses canonical body parsing, but serves
    // the same freshness envelope and public wire schema.
    const companionDb = mockD1([{ match: "cache", rows: [
      { key: "stablecoins", value: "{malformed", updated_at: now },
      { key: getResponseReadyCacheKey("stablecoins"), updated_at: now,
        value: encodeResponseReadyCacheValue(JSON.stringify({ peggedAssets: [] }), RESPONSE_READY_CACHE_SCHEMA_IDS.stablecoins) },
    ] }]);
    const response = await handleStablecoins(companionDb);
    expect(response.status).toBe(200);
    const validate = z.fromJSONSchema({ $ref: "#/$defs/StablecoinListResponse", $defs: definitions });
    expect(validate.safeParse(await response.json()).success).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { ApiMetaEnvelopeSchema } from "@pharos/contracts/api-meta";
import { ApiKeyListResponseSchema, DonorKeyClaimResponseSchema } from "@pharos/contracts/api-keys";
import { ApiRequestAttributionResponseSchema } from "@pharos/contracts/request-source";
import { makeLargeApiKeyInventory } from "../../../src/test-utils/api-key-fixtures";
import { makeApiRequestAttributionResponse } from "../../../src/test-utils/status-fixtures";

describe("contracts workspace public wire schemas", () => {
  it("preserves unavailable freshness instead of admitting a positive observation", () => {
    const unavailable = { updatedAt: null, ageSeconds: null, status: "unknown", reason: "cache_missing" };
    expect(ApiMetaEnvelopeSchema.parse(unavailable)).toEqual(unavailable);
    expect(ApiMetaEnvelopeSchema.safeParse({ ...unavailable, status: "fresh" }).success).toBe(false);
  });

  it("round-trips the operator key inventory and rejects unknown traffic classes", () => {
    const inventory = makeLargeApiKeyInventory(3);
    expect(ApiKeyListResponseSchema.parse(inventory)).toEqual(inventory);
    expect(ApiKeyListResponseSchema.safeParse({
      ...inventory,
      keys: [{ ...inventory.keys[0], trafficClass: "internal" }],
    }).success).toBe(false);
  });

  it("admits a one-time donor token only with the donor response contract", () => {
    const issued = {
      status: "issued",
      key: { keyPrefix: "phk_fixture", maskedToken: "phk_fixture...", tier: "donor", rateLimitPerMinute: 10, expiresAt: null },
      token: "phk_fixture_secret",
    };
    expect(DonorKeyClaimResponseSchema.parse(issued)).toEqual(issued);
    expect(DonorKeyClaimResponseSchema.safeParse({ ...issued, key: { ...issued.key, tier: "standard" } }).success).toBe(false);
    expect(DonorKeyClaimResponseSchema.safeParse({ ...issued, token: "" }).success).toBe(false);
  });

  it("preserves attribution scope, omitted demand and the shared API-key traffic vocabulary", () => {
    const response = makeApiRequestAttributionResponse({
      keyedPublicApi: { omittedKeys: 2, omittedRequests: 25, truncated: true },
    });
    expect(ApiRequestAttributionResponseSchema.parse(response)).toEqual(response);
    const key = {
      apiKeyId: 1, name: "Fixture", maskedToken: "fx_001...fixture", trafficClass: "site",
      isActive: true, expiresAt: null, rateLimitPerMinute: 120, requestCount: 10,
      shareOfKeyedRequestsPct: 25, shareOfTotalPublicApiRequestsPct: 10,
    };
    expect(ApiRequestAttributionResponseSchema.parse({ ...response, apiKeys: [key] }).apiKeys).toEqual([key]);
    expect(ApiRequestAttributionResponseSchema.safeParse({
      ...response, apiKeys: [{ ...key, trafficClass: "unknown" }],
    }).success).toBe(false);
  });
});

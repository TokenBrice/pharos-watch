import { describe, expect, it } from "vitest";
import { ApiMetaEnvelopeSchema } from "@pharos/contracts/api-meta";
import { ApiKeyListResponseSchema, DonorKeyClaimResponseSchema } from "@pharos/contracts/api-keys";
import { ApiRequestAttributionResponseSchema } from "@pharos/contracts/request-source";
import { makeLargeApiKeyInventory } from "../../../src/test-utils/api-key-fixtures";
import { makeApiRequestAttributionResponse, makeAttributionMeasurement } from "../../../src/test-utils/status-fixtures";

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
      measurement: {
        requestCount: makeAttributionMeasurement(), shareOfKeyedRequestsPct: makeAttributionMeasurement(),
        shareOfTotalPublicApiRequestsPct: makeAttributionMeasurement(),
      },
    };
    expect(ApiRequestAttributionResponseSchema.parse({ ...response, apiKeys: [key] }).apiKeys).toEqual([key]);
    expect(ApiRequestAttributionResponseSchema.safeParse({
      ...response, apiKeys: [{ ...key, trafficClass: "unknown" }],
    }).success).toBe(false);
  });
  it("requires v2 policy and measurement semantics rather than exact-looking unlabeled counts", () => {
    const response = makeApiRequestAttributionResponse();
    expect(ApiRequestAttributionResponseSchema.safeParse({ ...response, measurementVersion: 1 }).success).toBe(false);
    expect(ApiRequestAttributionResponseSchema.safeParse({ ...response, policyId: "unknown" }).success).toBe(false);
    expect(ApiRequestAttributionResponseSchema.safeParse({ ...response, totals: { totalRequests: 0 } }).success).toBe(false);
    const bad = makeAttributionMeasurement({ kind: "unavailable", coverage: "unknown", reason: null, standardError: null });
    expect(ApiRequestAttributionResponseSchema.safeParse({
      ...response, totals: { ...response.totals, measurement: { ...response.totals.measurement, totalRequests: bad } },
    }).success).toBe(false);
    const sampledAsObserved = makeAttributionMeasurement({ observedSampleCount: 1, probabilityStrata: [{ inverseRate: 64, observedSampleCount: 1 }] });
    expect(ApiRequestAttributionResponseSchema.safeParse({
      ...response, totals: { ...response.totals, measurement: { ...response.totals.measurement, totalRequests: sampledAsObserved } },
    }).success).toBe(false);
  });

  it("round-trips nullable inconsistent keyed denominators without losing recorded key load", () => {
    const unavailable = makeAttributionMeasurement({ kind: "unavailable", coverage: "unknown", reason: "invalid-key-regime", standardError: null });
    const response = makeApiRequestAttributionResponse();
    response.keyedPublicApi = {
      ...response.keyedPublicApi, keyedRequests: 10, unkeyedRequests: null, totalRequests: null, keyedSharePct: null, unkeyedSharePct: null,
      measurement: { keyedRequests: makeAttributionMeasurement(), unkeyedRequests: unavailable, totalRequests: unavailable, keyedSharePct: unavailable, unkeyedSharePct: unavailable },
    };
    expect(ApiRequestAttributionResponseSchema.parse(response)).toEqual(response);
  });

});

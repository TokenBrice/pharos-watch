import { describe, expect, it } from "vitest";

import { NonUsdShareResponseSchema } from "@shared/types/market";
import { PSI_CONDITION_BAND_VALUES } from "@shared/types/stability";
import { TelegramPulseOutputSchema, TelegramPulseSchema } from "@shared/types/status/telegram";
import {
  PUBLIC_API_RESPONSE_SCHEMAS,
  SnapshotCoinResponseSchema,
  SnapshotsIndexResponseSchema,
  StablecoinSummaryResponseSchema,
} from "../lib/public-api-response-schemas";
import { buildOpenApiDocument } from "../maintenance/generate-openapi-spec";

const StablecoinDetailResponseSchema = PUBLIC_API_RESPONSE_SCHEMAS.StablecoinDetailResponse;

function documentSchemas(): Record<string, unknown> {
  return buildOpenApiDocument().components.schemas as Record<string, unknown>;
}

type JsonSchemaObject = Record<string, unknown> & { $ref?: string };

function resolveSharedRef(schema: JsonSchemaObject): JsonSchemaObject {
  const ref = schema.$ref;
  if (typeof ref !== "string") {
    return schema;
  }
  let resolved: unknown = buildOpenApiDocument();
  for (const segment of ref.replace("#/", "").split("/")) {
    resolved = (resolved as Record<string, unknown>)[segment];
  }
  return resolved as JsonSchemaObject;
}

describe("public API response schemas", () => {
  it("accepts the public null-price response and preserves its provenance", () => {
    const payload = {
      price: null,
      priceSource: null,
      priceConfidence: null,
      priceUpdatedAt: 1_700_000_000,
      priceObservedAt: null,
      tokens: [{ date: 1_700_000_000, totalCirculatingUSD: { peggedUSD: 100 } }],
      providerExtra: "retained",
    };
    expect(StablecoinDetailResponseSchema.parse(payload)).toEqual(payload);
    expect(StablecoinDetailResponseSchema.safeParse({ ...payload, priceConfidence: "bogus" }).success).toBe(false);
  });
  it("isolates invalid price in StablecoinDetailResponseSchema", () => {
    const payload = {
      price: 1.0001,
      tokens: [{
        date: 1779105600,
        totalCirculatingUSD: { peggedUSD: 100 },
        totalCirculating: { peggedUSD: 100 },
      }],
    };
    expect(StablecoinDetailResponseSchema.safeParse(payload).success).toBe(true);
    const invalid = StablecoinDetailResponseSchema.safeParse({ ...payload, price: "invalid" });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.issues.map(({ code, path }) => ({ code, path }))).toEqual([
        { code: "invalid_type", path: ["price"] },
      ]);
    }
  });
  it("isolates invalid priceUsd in StablecoinSummaryResponseSchema", () => {
    const payload = {
      id: "usdt-tether",
      name: "Tether",
      symbol: "USDT",
      pegType: "peggedUSD",
      pegMechanism: "fiat-backed",
      priceUsd: 1.0001,
      priceSource: "coingecko+defillama-list",
      priceConfidence: "high",
      supplySource: "defillama",
      supplyObservedAt: 1_700_000_000,
      supplyRestored: true,
      supplyByPegUsd: { peggedUSD: 100 },
      supplyUsd: {
        current: 100,
        prevDay: 90,
        prevWeek: 80,
        prevMonth: 70,
        change1d: 10,
        change7d: 20,
        change30d: 30,
      },
      chainCount: 2,
      updatedAt: 1_779_105_600,
    };
    expect(StablecoinSummaryResponseSchema.safeParse(payload).success).toBe(true);
    const invalid = StablecoinSummaryResponseSchema.safeParse({ ...payload, priceUsd: "invalid" });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.issues.map(({ code, path }) => ({ code, path }))).toEqual([
        { code: "invalid_type", path: ["priceUsd"] },
      ]);
    }
  });
  it("isolates invalid date in NonUsdShareResponseSchema", () => {
    const payload = [{
      date: 1_779_105_600,
      commodityShare: null,
      fiatNonUsdShare: 0.0456,
      commodity: null,
      fiatNonUsd: 456,
      total: 10_000,
    }];
    expect(NonUsdShareResponseSchema.safeParse(payload).success).toBe(true);
    const invalid = NonUsdShareResponseSchema.safeParse([{ ...payload[0], date: "invalid" }]);
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.issues.map(({ code, path }) => ({ code, path }))).toEqual([
        { code: "invalid_type", path: [0, "date"] },
      ]);
    }
  });
  it("isolates invalid byteSize in SnapshotsIndexResponseSchema", () => {
    const payload = {
      snapshots: [{
        snapshotDate: "2026-05-16",
        methodologyVersions: { pegScore: "7.25", psi: "3.3" },
        safetyScoreIdentity: null,
        contentHash: "abc123",
        byteSize: 12345,
        createdAt: 1_779_105_600,
      }],
    };
    expect(SnapshotsIndexResponseSchema.safeParse(payload).success).toBe(true);
    const invalid = SnapshotsIndexResponseSchema.safeParse({ ...payload, snapshots: [{ ...payload.snapshots[0], byteSize: "invalid" }]});
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.issues.map(({ code, path }) => ({ code, path }))).toEqual([
        { code: "invalid_type", path: ["snapshots", 0, "byteSize"] },
      ]);
    }
  });
  it("isolates invalid stablecoinId in SnapshotCoinResponseSchema", () => {
    const payload = {
      snapshotDate: "2026-05-16",
      stablecoinId: "usdc-circle",
      generatedAt: 1_779_105_600,
      methodologyVersions: { pegScore: "7.25" },
      safetyScoreIdentity: null,
      stablecoin: { id: "usdc-circle", symbol: "USDC" },
      scores: {
        reportCard: { score: 92.4, grade: "A-" },
        psi: { score: 87.4, band: "STEADY" },
        dews: { stablecoinId: "usdc-circle", score: 18 },
        liquidity: { stablecoinId: "usdc-circle", liquidityScore: 9.2 },
      },
    };
    expect(SnapshotCoinResponseSchema.safeParse(payload).success).toBe(true);
    const invalid = SnapshotCoinResponseSchema.safeParse({ ...payload, stablecoinId: 123 });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.issues.map(({ code, path }) => ({ code, path }))).toEqual([
        { code: "invalid_type", path: ["stablecoinId"] },
      ]);
    }
  });
  it("publishes the closed PSI band vocabulary and the route's malformed-row count", () => {
    const psi = documentSchemas().StabilityIndexResponse as {
      required: readonly string[];
      properties: { current: { anyOf: Array<{ properties: Record<string, Record<string, unknown>> }> } };
    };
    const current = psi.properties.current.anyOf[0].properties;

    expect(resolveSharedRef(current.band as JsonSchemaObject).enum).toEqual([...PSI_CONDITION_BAND_VALUES]);
    expect(resolveSharedRef(current.avg24hBand as JsonSchemaObject).enum).toEqual([...PSI_CONDITION_BAND_VALUES]);
    expect(psi.properties.malformedRows).toMatchObject({ type: "number" });
    // The no-history response omits the count, so the contract must not require it.
    expect(psi.required).not.toContain("malformedRows");
  });
  it("publishes nullable Bluechip fields for values the upstream rating may omit", () => {
    const rating = (documentSchemas().BluechipRatingsResponse as {
      additionalProperties: { properties: Record<string, Record<string, unknown>> };
    }).additionalProperties.properties;

    for (const field of ["collateralization", "smartContractAudit", "dateOfRating"]) {
      expect(rating[field].type, field).toContain("null");
    }
  });
  it("publishes the served USDS shape derived from its runtime contract", () => {
    const usds = (documentSchemas().UsdsStatusResponse as {
      properties: Record<string, Record<string, unknown>>;
    }).properties;

    expect(usds.implementationAddress).toMatchObject({ type: "string" });
    expect(usds.lastChecked).toMatchObject({ type: "number" });
  });
  it("publishes the Telegram pulse fields the runtime transform produces", () => {
    const pulse = (documentSchemas().TelegramPulseResponse as {
      required: readonly string[];
      properties: Record<string, unknown>;
    });
    const served = TelegramPulseSchema.parse({
      activeWatchers: 42,
      coinSubscriptions: 7,
      topCoins: ["USDT"],
      watcherHistory: [{ date: "2026-09-21", timestamp: 1_790_000_000, activeWatchers: 42 }],
      pendingDeliveries: null,
      updatedAt: 1_790_000_000,
      updatedEverySeconds: 900,
    });

    // The artifact documents the post-transform shape, so a runtime field add cannot be
    // served while absent from the published contract.
    expect(TelegramPulseOutputSchema.parse(served)).toEqual(served);
    for (const field of ["currentSnapshotAt", "lifecycleHistoryUpdatedAt", "quality", "privacy"]) {
      expect(pulse.properties[field], field).toBeDefined();
      expect(pulse.required, field).toContain(field);
    }
    expect(pulse.properties).toHaveProperty("watcherHistory");
    expect(pulse.properties).toHaveProperty("privacy");
  });
});

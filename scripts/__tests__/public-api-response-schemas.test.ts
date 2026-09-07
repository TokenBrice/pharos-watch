import { describe, expect, it } from "vitest";

import { NonUsdShareResponseSchema } from "@shared/types/market";
import {
  PUBLIC_API_RESPONSE_SCHEMAS,
  SnapshotCoinResponseSchema,
  SnapshotsIndexResponseSchema,
  StablecoinSummaryResponseSchema,
} from "../lib/public-api-response-schemas";

const StablecoinDetailResponseSchema = PUBLIC_API_RESPONSE_SCHEMAS.StablecoinDetailResponse;

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
  it("accepts representative payloads derived from the worker responses", () => {
    expect(StablecoinDetailResponseSchema.safeParse({
      price: 1.0001,
      tokens: [{
        date: 1779105600,
        totalCirculatingUSD: { peggedUSD: 100 },
        totalCirculating: { peggedUSD: 100 },
      }],
    }).success).toBe(true);

    expect(StablecoinSummaryResponseSchema.safeParse({
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
    }).success).toBe(true);

    expect(NonUsdShareResponseSchema.safeParse([{
      date: 1_779_105_600,
      commodityShare: null,
      fiatNonUsdShare: 0.0456,
      commodity: null,
      fiatNonUsd: 456,
      total: 10_000,
    }]).success).toBe(true);

    expect(SnapshotsIndexResponseSchema.safeParse({
      snapshots: [{
        snapshotDate: "2026-05-16",
        methodologyVersions: { pegScore: "7.25", psi: "3.3" },
        safetyScoreIdentity: null,
        contentHash: "abc123",
        byteSize: 12345,
        createdAt: 1_779_105_600,
      }],
    }).success).toBe(true);

    expect(SnapshotCoinResponseSchema.safeParse({
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
    }).success).toBe(true);
  });

  it("rejects clearly invalid payloads for each typed endpoint", () => {
    expect(StablecoinDetailResponseSchema.safeParse({ price: "1" }).success).toBe(false);
    expect(StablecoinSummaryResponseSchema.safeParse({
      id: "usdt-tether",
      name: "Tether",
      symbol: "USDT",
      pegType: "peggedUSD",
      pegMechanism: "fiat-backed",
      priceUsd: "1",
    }).success).toBe(false);
    expect(NonUsdShareResponseSchema.safeParse([{ date: "1779105600" }]).success).toBe(false);
    expect(SnapshotsIndexResponseSchema.safeParse({
      snapshots: [{
        snapshotDate: "2026-05-16",
        methodologyVersions: null,
        safetyScoreIdentity: null,
        contentHash: "abc123",
        byteSize: "12345",
        createdAt: 1_779_105_600,
      }],
    }).success).toBe(false);
    expect(SnapshotCoinResponseSchema.safeParse({
      snapshotDate: "2026-05-16",
      stablecoinId: 123,
      generatedAt: 1_779_105_600,
      methodologyVersions: null,
      safetyScoreIdentity: null,
      stablecoin: { id: "usdc-circle" },
      scores: { reportCard: null, psi: null, dews: null, liquidity: null },
    }).success).toBe(false);
  });
});

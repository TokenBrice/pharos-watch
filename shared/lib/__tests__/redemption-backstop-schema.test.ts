import { describe, expect, it } from "vitest";
import { RedemptionBackstopConfigSchema } from "@shared/lib/redemption-backstop-configs/schema";
import { resolveReviewedRedemptionSettlement } from "@shared/lib/redemption-backstop-configs/settlement";
import type { RedemptionSettlementModel } from "@shared/types";
import {
  RedemptionBackstopDetailsSchema,
  RedemptionBackstopEntrySchema,
  RedemptionResolutionStateSchema,
} from "@shared/types/redemption";
import { getRedemptionBackstopConfig } from "../redemption-backstops";
import { valuePhysicalCommodityDelivery } from "../physical-commodity-delivery";
import { computeRedemptionOutputAssetQuality } from "../redemption-backstop-scoring";

function settlementReviewConfig(
  settlementModel: RedemptionSettlementModel,
  v9RouteReviewTerms: unknown,
): unknown {
  return {
    routeFamily: "queue-redeem",
    accessModel: "issuer-api",
    settlementModel,
    executionModel: "rules-based-nav",
    outputAssetType: "stable-single",
    capacityModel: { kind: "supply-full" },
    costModel: { kind: "fee-bps", feeBps: 0 },
    v9RouteReviewTerms,
  };
}

describe("redemption backstop entry score coherence", () => {
  const resolvedEntry = {
    stablecoinId: "alpha",
    score: 80,
    dexLiquidityScore: null,
    accessScore: 80,
    settlementScore: 80,
    executionCertaintyScore: 80,
    capacityScore: 80,
    outputAssetQualityScore: 80,
    costScore: 80,
    routeFamily: "stablecoin-redeem",
    accessModel: "permissionless-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-onchain",
    outputAssetType: "stable-single",
    provider: "Alpha redemption",
    sourceMode: "dynamic",
    resolutionState: "resolved",
    routeStatus: "open",
    holderEligibility: "any-holder",
    capacityConfidence: "live-direct",
    capacitySemantics: "immediate-bounded",
    feeConfidence: "fixed",
    feeModelKind: "fixed-bps",
    modelConfidence: "high",
    immediateCapacityUsd: 10_000_000,
    immediateCapacityRatio: 0.25,
    feeBps: 0,
    queueEnabled: false,
    methodologyVersion: "4.3",
    updatedAt: 1_800_000_000,
  } as const;

  const nonResolvedStates = RedemptionResolutionStateSchema.options.filter((state) => state !== "resolved");

  it.each(nonResolvedStates)("requires an unavailable aggregate for %s routes", (resolutionState) => {
    for (const score of [0, 1, 80, 100]) {
      const result = RedemptionBackstopEntrySchema.safeParse({ ...resolvedEntry, resolutionState, score });
      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected non-resolved score to fail validation");
      expect(result.error.issues.map((issue) => issue.path)).toContainEqual(["score"]);
    }
    expect(RedemptionBackstopEntrySchema.safeParse({ ...resolvedEntry, resolutionState, score: null }).success).toBe(true);
  });

  it("admits resolved positive, unavailable, observed-zero and immaterial scores", () => {
    expect(RedemptionBackstopEntrySchema.safeParse(resolvedEntry).success).toBe(true);
    expect(RedemptionBackstopEntrySchema.safeParse({ ...resolvedEntry, score: null }).success).toBe(true);
    for (const immediateCapacityUsd of [0, 9_999]) {
      expect(RedemptionBackstopEntrySchema.safeParse({
        ...resolvedEntry,
        score: 0,
        capacityScore: 0,
        immediateCapacityUsd,
        immediateCapacityRatio: 0,
      }).success).toBe(true);
    }
  });

  it("preserves inert historical effectiveExitScore without clearing current score coherence", () => {
    const historicEntry = { ...resolvedEntry, methodologyVersion: "4.2", effectiveExitScore: 42 };
    expect(RedemptionBackstopEntrySchema.parse(historicEntry).effectiveExitScore).toBe(42);
    const unavailable = { ...historicEntry, resolutionState: "missing-capacity", score: null };
    expect(RedemptionBackstopEntrySchema.parse(unavailable).effectiveExitScore).toBe(42);
    expect(RedemptionBackstopEntrySchema.safeParse({ ...unavailable, score: 80 }).success).toBe(false);
    expect(RedemptionBackstopDetailsSchema.parse({
      resolutionState: "missing-capacity",
      effectiveExitScore: 42,
    })).toMatchObject({ resolutionState: "missing-capacity", effectiveExitScore: 42 });
  });
});

describe("redemption backstop schema", () => {
  it("admits standalone observers without reserve configuration and binds the complete output set", () => {
    const base = {
      ...settlementReviewConfig("queued", undefined) as Record<string, unknown>,
      outputAssets: ["usdc-circle"],
      capacityModel: {
        kind: "executable-observer", observerId: "lido-earnusd-queue",
        capacityUse: "diagnostic-only", requiredOutputAssetKeys: ["usdc-circle"],
      },
    };
    expect(RedemptionBackstopConfigSchema.safeParse(base).success).toBe(true);
    for (const capacityModel of [
      { ...base.capacityModel, observerId: "unknown-observer" },
      { ...base.capacityModel, capacityUse: "full-supply" },
      { ...base.capacityModel, requiredOutputAssetKeys: [] },
      { ...base.capacityModel, requiredOutputAssetKeys: ["usdt-tether"] },
      { ...base.capacityModel, fallbackUsd: 100 },
    ]) {
      expect(RedemptionBackstopConfigSchema.safeParse({ ...base, capacityModel }).success).toBe(false);
    }
  });
  it("requires a dated, sourced exact-channel review for suspension without changing open or unknown admission", () => {
    const base = settlementReviewConfig("same-day", undefined) as Record<string, unknown>;
    const suspension = {
      routeId: "redemption:alpha:queue-redeem", channel: "Legacy issuer portal",
      suspendedAt: "2026-06-30", reviewedAt: "2026-07-01", reviewer: "reviewer",
      reason: "This portal ceased exchange operations; other channels are independent.",
      sources: [{ url: "https://example.com/notice", quote: "Exchanges suspended June 30." }],
    };
    expect(RedemptionBackstopConfigSchema.safeParse({ ...base, routeStatus: "suspended", routeSuspension: suspension }).success).toBe(true);
    for (const routeStatus of ["open", "unknown"]) {
      expect(RedemptionBackstopConfigSchema.safeParse({ ...base, routeStatus }).success).toBe(true);
      expect(RedemptionBackstopConfigSchema.safeParse({ ...base, routeStatus, routeSuspension: suspension }).success).toBe(false);
    }
    expect(RedemptionBackstopConfigSchema.safeParse({ ...base, routeStatus: "suspended" }).success).toBe(false);
    for (const overrides of [
      { sources: [] }, { reviewer: "" }, { reason: "" }, { reviewedAt: "2026-02-30" },
      { suspendedAt: "2026-07-02" }, { routeId: "" },
    ]) {
      expect(RedemptionBackstopConfigSchema.safeParse({
        ...base, routeStatus: "suspended", routeSuspension: { ...suspension, ...overrides },
      }).success).toBe(false);
    }
  });
  it.each([
    ["xaut-tether", 1, 430, 25, 0],
    ["paxg-paxos", 1, 430, 0, 0],
    ["kau-kinesis", 1 / 31.1034768, 100, 45, 100],
    ["kag-kinesis", 1, 200, 45, 100],
    ["ggbr-goldfish-gold", 0.001, 13500, 300, 0],
    ["pgold-pleasing", 1, 32.15, 50, 0],
    ["xaum-matrixdock", 1, 32.148, 25, 0],
    ["dgld-gold-token-sa", 1, 1 / 31.1034768, 0, 0],
    ["xagm-matrixdock", 0.998463014, 2100, 50, 0],
    ["cgo-comtech", 1 / 31.1034768, 1000, 0, 0],
    ["gldt-gold-dao", 0.01 / 31.1034768, 100, 0, 0],
  ] as const)("values %s only above its cited lot, with published fees and the unbounded tier", (id, ounces, minimum, bps, flatUsd) => {
    const config = RedemptionBackstopConfigSchema.parse(getRedemptionBackstopConfig(id));
    const terms = config.physicalCommodityDelivery!;
    const spot = 5000;
    const lotUsd = spot * ounces * minimum;
    expect(valuePhysicalCommodityDelivery(terms, spot, lotUsd - 0.01)?.unitValueUsd).toBe(0);
    const notional = lotUsd * 2;
    const value = valuePhysicalCommodityDelivery(terms, spot, notional)!;
    expect(value.expectedUnitValueUsd).toBeCloseTo(spot * ounces);
    expect(value.unitValueUsd).toBeCloseTo(spot * ounces * Math.max(0, 1 - bps / 10_000 - flatUsd / notional));
    expect(value.unboundedDeliveryCap).toBe(55);
    expect(terms.sameNotionalEligible).toBe(false);
    expect(computeRedemptionOutputAssetQuality(config.outputAssetType, terms.deliveryTermsUnbounded)).toBe(55);
  });
  it("allows a more conservative reviewed settlement without evidence", () => {
    expect(
      RedemptionBackstopConfigSchema.safeParse(
        settlementReviewConfig("same-day", { settlementModel: "days" }),
      ).success,
    ).toBe(true);
  });

  it("expires a favorable reviewed settlement while retaining conservative corrections", () => {
    const favorable = RedemptionBackstopConfigSchema.parse(
      settlementReviewConfig("days", {
        settlementModel: "atomic",
        settlementDelaySec: 0,
        reviewedAt: "2026-08-24",
        docs: [{ label: "Settlement SLA", url: "https://example.com/settlement", supports: ["settlement"] }],
      }),
    );
    expect(resolveReviewedRedemptionSettlement(favorable, Date.UTC(2026, 7, 26) / 1_000)).toBe("atomic");
    expect(resolveReviewedRedemptionSettlement(favorable, Date.UTC(2027, 7, 26) / 1_000)).toBe("days");

    const conservative = RedemptionBackstopConfigSchema.parse(
      settlementReviewConfig("same-day", { settlementModel: "queued" }),
    );
    expect(resolveReviewedRedemptionSettlement(conservative, Date.UTC(2035, 0, 1) / 1_000)).toBe("queued");
  });

  it("requires route-specific evidence before reserve sync can assert full-supply eventual capacity", () => {
    const base = {
      routeFamily: "stablecoin-redeem",
      accessModel: "permissionless-onchain",
      settlementModel: "atomic",
      executionModel: "deterministic-onchain",
      outputAssetType: "stable-single",
      capacityModel: { kind: "reserve-sync-metadata", eventualCapacityModel: "supply-full" },
      costModel: { kind: "fee-bps", feeBps: 0 },
    } as const;
    const valid = {
      ...base,
      reviewedAt: "2026-07-29",
      docs: [{ label: "Route terms", url: "https://example.com/terms", supports: ["capacity"] }],
    };
    expect(RedemptionBackstopConfigSchema.safeParse(valid).success).toBe(true);
    for (const override of [
      { reviewedAt: undefined },
      { docs: [{ label: "Fee terms", url: "https://example.com/fees", supports: ["fees"] }] },
    ]) {
      const result = RedemptionBackstopConfigSchema.safeParse({ ...valid, ...override });
      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected missing capacity evidence to fail validation");
      expect(result.error.issues.map((issue) => issue.path)).toContainEqual(["capacityModel", "eventualCapacityModel"]);
    }
  });

  it("requires each prerequisite of a faster reviewed settlement SLA independently", () => {
    const terms = {
      settlementModel: "same-day",
      settlementDelaySec: 86_400,
      reviewedAt: "2026-07-29",
      docs: [{ label: "Settlement SLA", url: "https://example.com/settlement", supports: ["settlement"] }],
    };
    expect(RedemptionBackstopConfigSchema.safeParse(settlementReviewConfig("days", terms)).success).toBe(true);
    for (const field of ["settlementDelaySec", "reviewedAt", "docs"] as const) {
      const result = RedemptionBackstopConfigSchema.safeParse(
        settlementReviewConfig("days", { ...terms, [field]: undefined }),
      );
      expect(result.success, field).toBe(false);
      if (result.success) throw new Error("Expected missing SLA evidence to fail validation");
      expect(result.error.issues.map((issue) => issue.path)).toContainEqual(["v9RouteReviewTerms", "settlementModel"]);
    }
  });

  it("rejects an uncited explicit reviewed settlement SLA", () => {
    const result = RedemptionBackstopConfigSchema.safeParse(
      settlementReviewConfig("days", {
        settlementModel: "days",
        settlementDelaySec: 2 * 86_400,
      }),
    );

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected uncited reviewed settlement SLA to fail validation");
    expect(result.error.issues.map((issue) => issue.path)).toContainEqual(["v9RouteReviewTerms", "settlementDelaySec"]);
  });

  it("admits an unchanged reviewed settlement with an explicit cited SLA", () => {
    expect(
      RedemptionBackstopConfigSchema.safeParse(
        settlementReviewConfig("days", {
          settlementModel: "days",
          settlementDelaySec: 2 * 86_400,
          reviewedAt: "2026-07-29",
          docs: [
            {
              label: "Issuer redemption terms",
              url: "https://example.com/redemption-terms",
              supports: ["settlement"],
            },
          ],
        }),
      ).success,
    ).toBe(true);
  });

  it("rejects route-only scalar and faster-model claims while preserving explicit missing-settlement diagnostics", () => {
    for (const settlementModel of ["days", "same-day"] as const) {
      const terms = {
        settlementModel,
        settlementDelaySec: 86_400,
        reviewedAt: "2026-07-29",
        docs: [{ label: "Route terms", url: "https://example.com/terms", supports: ["route"] }],
      };
      expect(RedemptionBackstopConfigSchema.safeParse(settlementReviewConfig("days", terms)).success).toBe(false);
      expect(RedemptionBackstopConfigSchema.safeParse(settlementReviewConfig("days", {
        ...terms,
        docs: [{ label: "Completed payout", url: "https://example.com/payout", supports: ["settlement"] }],
      })).success).toBe(true);
      const diagnosticTerms = {
        ...terms,
        scoringDisposition: "bounded-terms-gap",
        missingScoringFields: ["settlement"],
        rationale: "The stated processing time is not a completed-payout guarantee.",
      };
      expect(RedemptionBackstopConfigSchema.safeParse(settlementReviewConfig("days", diagnosticTerms)).success).toBe(true);
      expect(RedemptionBackstopConfigSchema.safeParse(settlementReviewConfig("days", {
        ...diagnosticTerms, missingScoringFields: ["cost"],
      })).success).toBe(false);
    }
  });

  it("admits fee floors as diagnostics without inventing an authored ceiling", () => {
    for (const floor of [{ feeBpsMin: 25 }, { minFeeUsd: 100 }]) {
      const parsed = RedemptionBackstopConfigSchema.parse({
        ...(settlementReviewConfig("days", undefined) as Record<string, unknown>),
        costModel: { kind: "dynamic-or-unclear", ...floor },
      });
      expect(parsed.costModel.feeBpsMax).toBeUndefined();
    }
  });

  it("enforces numeric and calendar boundaries independently of the catalog", () => {
    const base = RedemptionBackstopConfigSchema.parse(settlementReviewConfig("days", undefined));
    const cases = [
      [{ costModel: { kind: "fee-bps", feeBps: 0 } }, { costModel: { kind: "fee-bps", feeBps: -1 } }, ["costModel", "feeBps"]],
      [{ capacityModel: { kind: "supply-ratio", ratio: 1 } }, { capacityModel: { kind: "supply-ratio", ratio: 0 } }, ["capacityModel", "ratio"]],
      [{ capacityModel: { kind: "supply-ratio", ratio: 0.1 } }, { capacityModel: { kind: "supply-ratio", ratio: 1.01 } }, ["capacityModel", "ratio"]],
      [{ capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 1 } }, { capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0 } }, ["capacityModel", "fallbackRatio"]],
      [{ capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.1 } }, { capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 1.01 } }, ["capacityModel", "fallbackRatio"]],
      [{ totalScoreCap: 100 }, { totalScoreCap: 0 }, ["totalScoreCap"]],
      [{ totalScoreCap: 1 }, { totalScoreCap: 101 }, ["totalScoreCap"]],
      [{ reviewedAt: "2024-02-29" }, { reviewedAt: "2023-02-29" }, ["reviewedAt"]],
    ] as const;
    for (const [valid, invalid, path] of cases) {
      expect(RedemptionBackstopConfigSchema.safeParse({ ...base, ...valid }).success).toBe(true);
      const result = RedemptionBackstopConfigSchema.safeParse({ ...base, ...invalid });
      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected invalid boundary to fail validation");
      expect(result.error.issues.map((issue) => issue.path)).toContainEqual(path);
    }
  });

  it("rejects incompatible route access and settlement while admitting neighboring models", () => {
    const base = RedemptionBackstopConfigSchema.parse(settlementReviewConfig("days", undefined));
    const cases = [
      [{ routeFamily: "offchain-issuer", accessModel: "issuer-api" }, { accessModel: "whitelisted-onchain" }, ["accessModel"]],
      [{ routeFamily: "offchain-issuer", accessModel: "manual" }, { accessModel: "permissionless-onchain" }, ["accessModel"]],
      [{ routeFamily: "offchain-issuer" }, { settlementModel: "atomic" }, ["settlementModel"]],
      [{ routeFamily: "queue-redeem" }, { settlementModel: "immediate" }, ["settlementModel"]],
      [{ routeFamily: "stablecoin-redeem", accessModel: "permissionless-onchain" }, { accessModel: "issuer-api" }, ["accessModel"]],
    ] as const;
    for (const [valid, invalid, path] of cases) {
      expect(RedemptionBackstopConfigSchema.safeParse({ ...base, ...valid }).success).toBe(true);
      const result = RedemptionBackstopConfigSchema.safeParse({ ...base, ...valid, ...invalid });
      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected incompatible route to fail validation");
      expect(result.error.issues.map((issue) => issue.path)).toContainEqual(path);
    }
  });
});

import { describe, expect, it } from "vitest";
import { RedemptionBackstopConfigSchema } from "@shared/lib/redemption-backstop-configs/schema";
import { resolveReviewedRedemptionSettlement } from "@shared/lib/redemption-backstop-configs/settlement";
import type { RedemptionSettlementModel } from "@shared/types";

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

describe("redemption backstop schema", () => {
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
        docs: [{ label: "Settlement SLA", url: "https://example.com/settlement" }],
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
      docs: [{ label: "Settlement SLA", url: "https://example.com/settlement" }],
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
      [{ routeFamily: "offchain-issuer", accessModel: "manual" }, { accessModel: "permissionless-onchain" }, ["routeFamily"]],
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

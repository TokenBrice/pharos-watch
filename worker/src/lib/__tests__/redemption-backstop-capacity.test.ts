import { describe, expect, it } from "vitest";
import { resolveCapacityBasis, resolveRedemptionCapacity } from "../redemption-backstop/capacity";
import { liveSnapshot } from "./redemption-backstop-sources.test-support";
import { getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";

const now = 1_780_000_000;
const baseSnapshot = (metadata: Record<string, unknown>) => liveSnapshot("lusd-liquity", metadata, {
  fetchedAt: now - 60,
  source: "liquity-v1",
  sourceModel: "single-bucket",
});

describe("resolveCapacityBasis", () => {
  it.each([
    ["queue-redeem", { kind: "unquantified" }, undefined, undefined],
    ["offchain-issuer", { kind: "unquantified" }, undefined, undefined],
    ["stablecoin-redeem", { kind: "reserve-sync-metadata", basis: "daily-limit" }, "live-direct", "live-direct-telemetry"],
    ["collateral-redeem", { kind: "reserve-sync-metadata", basis: "daily-limit" }, "live-proxy", "live-proxy-buffer"],
    ["stablecoin-redeem", { kind: "reserve-sync-metadata", basis: "daily-limit" }, "dynamic", "daily-limit"],
    ["stablecoin-redeem", { kind: "reserve-sync-metadata" }, "dynamic", "hot-buffer"],
    ["psm-swap", { kind: "reserve-sync-metadata" }, "documented-bound", "psm-balance-share"],
    ["queue-redeem", { kind: "reserve-sync-metadata" }, "heuristic", "strategy-buffer"],
    ["stablecoin-redeem", { kind: "supply-full", basis: "daily-limit" }, undefined, "daily-limit"],
    ["psm-swap", { kind: "supply-ratio", ratio: 0.1, basis: "strategy-buffer" }, undefined, "strategy-buffer"],
    ["psm-swap", { kind: "fixed-usd", amountUsd: 5_000_000 }, undefined, "fixed-buffer"],
    ["offchain-issuer", { kind: "supply-full" }, undefined, "issuer-term-redemption"],
    ["stablecoin-redeem", { kind: "supply-full" }, undefined, "issuer-term-redemption"],
    ["basket-redeem", { kind: "supply-full" }, undefined, "full-system-eventual"],
    ["collateral-redeem", { kind: "supply-full" }, undefined, "full-system-eventual"],
    ["queue-redeem", { kind: "supply-full" }, undefined, "full-system-eventual"],
    ["psm-swap", { kind: "supply-full" }, undefined, "full-system-eventual"],
    [null, { kind: "supply-full" }, undefined, "full-system-eventual"],
    ["psm-swap", { kind: "supply-ratio", ratio: 0.2 }, undefined, "psm-balance-share"],
    ["queue-redeem", { kind: "supply-ratio", ratio: 0.05 }, undefined, "strategy-buffer"],
    ["collateral-redeem", { kind: "supply-ratio", ratio: 0.1 }, undefined, "hot-buffer"],
    ["stablecoin-redeem", { kind: "supply-ratio", ratio: 0.1 }, undefined, "hot-buffer"],
    ["basket-redeem", { kind: "supply-ratio", ratio: 0.1 }, undefined, "hot-buffer"],
    ["offchain-issuer", { kind: "supply-ratio", ratio: 0.1 }, undefined, "hot-buffer"],
    [null, { kind: "supply-ratio", ratio: 0.1 }, undefined, "hot-buffer"],
  ] as const)("resolves %s with %j and %s to %s", (route, model, confidence, expected) => {
    expect(resolveCapacityBasis(route, model, confidence)).toBe(expected);
  });
});

describe("resolveRedemptionCapacity — unquantified route", () => {
  it.each([null, 0, 100_000_000])("does not borrow supply or reserve balances as executable/eventual capacity (%j)", async (supplyUsd) => {
    const db = { prepare: () => { throw new Error("Unquantified route must not query capacity"); } } as unknown as D1Database;
    const result = await resolveRedemptionCapacity(db, "susdat-saturn", { kind: "unquantified" }, supplyUsd, now, {
      reserveSnapshotMetadata: baseSnapshot({
        freshnessMode: "not-applicable",
        redemption: { capacityUsd: 50_000_000, capacityKind: "live-direct", freshnessKind: "same-run-onchain" },
      }),
    });
    expect(result.immediateCapacityUsd).toBeNull();
    expect(result.immediateCapacityRatio).toBeNull();
    expect(result.scoringCapacityUsd).toBeNull();
    expect(result.scoringCapacityRatio).toBeNull();
    expect(result.eventualCapacityUsd).toBeNull();
    expect(result.eventualCapacityRatio).toBeNull();
    expect(result.capacityProfile?.scoringHorizon).toBe("unknown");
    expect(result.capacitySemantics).toBe("eventual-only");
    expect(result.resolutionState).toBe("missing-capacity");
    expect(result.notes).toContain("redemption-capacity-unquantified");
  });
});

describe("resolveRedemptionCapacity — fixed USD capacity", () => {
  const now = 1_780_000_000;
  const db = {} as D1Database;

  it("resolves a fixed USD buffer and derives ratio from supply", async () => {
    const result = await resolveRedemptionCapacity(
      db,
      "dusd-alto",
      { kind: "fixed-usd", amountUsd: 5_000_000, confidence: "documented-bound" },
      100_000_000,
      now,
    );

    expect(result.immediateCapacityUsd).toBe(5_000_000);
    expect(result.immediateCapacityRatio).toBe(0.05);
    expect(result.scoringCapacityUsd).toBe(5_000_000);
    expect(result.scoringCapacityRatio).toBe(0.05);
    expect(result.capacityProfile).toMatchObject({
      immediateUsd: 5_000_000,
      scoringUsd: 5_000_000,
      scoringHorizon: "immediate",
    });
  });

  it("clamps fixed USD capacity above current supply", async () => {
    const result = await resolveRedemptionCapacity(
      db,
      "dusd-alto",
      { kind: "fixed-usd", amountUsd: 5_000_000, confidence: "documented-bound" },
      1_000_000,
      now,
    );

    expect(result.immediateCapacityUsd).toBe(1_000_000);
    expect(result.immediateCapacityRatio).toBe(1);
    expect(result.scoringCapacityUsd).toBe(1_000_000);
    expect(result.notes.some((note) => /exceeds current supply/i.test(note))).toBe(true);
  });

  it("keeps fixed USD capacity visible when supply is missing", async () => {
    const result = await resolveRedemptionCapacity(
      db,
      "dusd-alto",
      { kind: "fixed-usd", amountUsd: 5_000_000, confidence: "documented-bound" },
      null,
      now,
    );

    expect(result.resolutionState).toBe("resolved");
    expect(result.immediateCapacityUsd).toBe(5_000_000);
    expect(result.immediateCapacityRatio).toBeNull();
    expect(result.capacityScoreMode).toBe("tier-floor");
    expect(result.notes).toContain(
      "Stablecoins cache missing current supply; fixed USD capacity is visible with conservative bounded scoring",
    );
  });
});

describe("resolveRedemptionCapacity — supply ratio capacity", () => {
  const now = 1_780_000_000;
  const db = {} as D1Database;

  it.each([0, -1])("leaves non-positive supply %s unrated", async (supplyUsd) => {
    const result = await resolveRedemptionCapacity(
      db,
      "test-stablecoin",
      { kind: "supply-ratio", ratio: 0.1 },
      supplyUsd,
      now,
    );

    expect(result).toMatchObject({
      immediateCapacityUsd: null,
      immediateCapacityRatio: null,
      scoringCapacityUsd: null,
      scoringCapacityRatio: null,
      resolutionState: "missing-capacity",
    });
  });

  it("labels scoring horizon immediate when the configured daily limit does not bind", async () => {
    const result = await resolveRedemptionCapacity(
      db,
      "test-stablecoin",
      { kind: "supply-ratio", ratio: 0.2, dailyLimitUsd: 25_000_000 },
      100_000_000,
      now,
    );

    expect(result.immediateCapacityUsd).toBe(20_000_000);
    expect(result.scoringCapacityUsd).toBe(20_000_000);
    expect(result.scoringCapacityRatio).toBe(0.2);
    expect(result.capacityProfile).toMatchObject({
      immediateUsd: 20_000_000,
      dailyLimitUsd: 25_000_000,
      scoringUsd: 20_000_000,
      scoringHorizon: "immediate",
    });
  });

  it("labels scoring horizon daily when the configured daily limit caps capacity", async () => {
    const result = await resolveRedemptionCapacity(
      db,
      "test-stablecoin",
      { kind: "supply-ratio", ratio: 0.2, dailyLimitUsd: 5_000_000 },
      100_000_000,
      now,
    );

    expect(result.immediateCapacityUsd).toBe(20_000_000);
    expect(result.scoringCapacityUsd).toBe(5_000_000);
    expect(result.scoringCapacityRatio).toBe(0.05);
    expect(result.capacityProfile).toMatchObject({
      immediateUsd: 20_000_000,
      dailyLimitUsd: 5_000_000,
      scoringUsd: 5_000_000,
      scoringHorizon: "daily",
    });
  });
});

describe("resolveRedemptionCapacity — reserve-sync over-provisioned clamp", () => {
  it("clamps immediateCapacityUsd to supplyUsd and adds a note when nested capacityUsd exceeds supply", async () => {
    const db = {} as D1Database;
    const supplyUsd = 1_000_000;
    const result = await resolveRedemptionCapacity(
      db,
      "lusd-liquity",
      { kind: "reserve-sync-metadata" },
      supplyUsd,
      now,
      {
        reserveSnapshotMetadata: baseSnapshot({
          freshnessMode: "not-applicable",
          redemption: { capacityUsd: 5_000_000 },
        }),
      },
    );
    expect(result.scoringCapacityUsd).toBe(supplyUsd);
    expect(result.scoringCapacityRatio).toBe(1);
    expect(result.immediateCapacityUsd).toBe(supplyUsd);
    expect(result.immediateCapacityRatio).toBe(1);
    expect(result.notes.some((n) => /exceeds current supply/i.test(n))).toBe(true);
  });

  it("rejects ratio-only live capacity above supply ratio bounds", async () => {
    const db = {} as D1Database;
    const supplyUsd = 1_000_000;
    const result = await resolveRedemptionCapacity(
      db,
      "lusd-liquity",
      { kind: "reserve-sync-metadata" },
      supplyUsd,
      now,
      {
        reserveSnapshotMetadata: baseSnapshot({
          freshnessMode: "not-applicable",
          redemption: { capacityRatioOfSupply: 1.5 },
        }),
      },
    );
    expect(result.resolutionState).toBe("missing-capacity");
    expect(result.scoringCapacityUsd).toBeNull();
    expect(result.immediateCapacityUsd).toBeNull();
    expect(result.immediateCapacityRatio).toBeNull();
    expect(result.scoringCapacityRatio).toBeNull();
    expect(result.consumedReserveCapacity).not.toBe(true);
  });

  it("does not clamp or annotate when live capacity is at or below supply", async () => {
    const db = {} as D1Database;
    const supplyUsd = 1_000_000;
    const result = await resolveRedemptionCapacity(
      db,
      "lusd-liquity",
      { kind: "reserve-sync-metadata" },
      supplyUsd,
      now,
      {
        reserveSnapshotMetadata: baseSnapshot({
          freshnessMode: "not-applicable",
          redemption: { capacityUsd: 400_000 },
        }),
      },
    );
    expect(result.scoringCapacityUsd).toBe(400_000);
    expect(result.immediateCapacityUsd).toBe(400_000);
    expect(result.immediateCapacityRatio).toBeCloseTo(0.4);
    expect(result.notes.some((n) => /exceeds current supply/i.test(n))).toBe(false);
  });

  it("uses live daily limits as scoring capacity constraints without hiding raw capacity", async () => {
    const db = {} as D1Database;
    const supplyUsd = 1_000_000;
    const result = await resolveRedemptionCapacity(
      db,
      "lusd-liquity",
      { kind: "reserve-sync-metadata" },
      supplyUsd,
      now,
      {
        reserveSnapshotMetadata: baseSnapshot({
          freshnessMode: "not-applicable",
          redemption: {
            capacityUsd: 800_000,
            capacityKind: "live-direct-bounded",
            freshnessKind: "same-run-onchain",
            dailyLimitUsd: 250_000,
          },
        }),
      },
    );

    expect(result.immediateCapacityUsd).toBe(800_000);
    expect(result.immediateCapacityRatio).toBe(0.8);
    expect(result.scoringCapacityUsd).toBe(250_000);
    expect(result.scoringCapacityRatio).toBe(0.25);
    expect(result.notes).toContain("Live redemption daily limit caps usable scoring capacity");
  });

  it("downgrades a direct-capacity claim when live settlement requires a cooldown", async () => {
    const result = await resolveRedemptionCapacity(
      {} as D1Database, "lusd-liquity", { kind: "reserve-sync-metadata" }, 1_000_000, now,
      { reserveSnapshotMetadata: baseSnapshot({
        freshnessMode: "not-applicable",
        redemption: {
          capacityUsd: 1_000_000, capacityRatioOfSupply: 1,
          capacityKind: "live-direct", freshnessKind: "same-run-onchain",
          settlementDelaySec: 86_400, routeStatus: "open", routeStatusSource: "onchain",
        },
      }) },
    );
    expect(result).toMatchObject({
      capacityKind: "documented-bound", capacityConfidence: "documented-bound",
      settlementDelaySec: 86_400, immediateCapacityUsd: 1_000_000,
      capacityProfile: { capacityProfileConfidence: "documented-bound" },
    });
  });

  it.each([
    [1_000_000, 800_000, 0.9, undefined, 800_000, 800_000],
    [500_000, 800_000, 0.9, undefined, 500_000, 500_000],
    [1_000_000, undefined, 0.4, undefined, 400_000, 400_000],
    [1_000_000, 800_000, undefined, undefined, 800_000, 800_000],
    [1_000_000, 800_000, 0.9, 250_000, 800_000, 250_000],
    [1_000_000, 800_000, 0.9, 900_000, 800_000, 800_000],
  ] as const)("uses the same supply denominator for finalized capacity (%j)", async (
    supply, amount, ratio, dailyLimit, immediate, scoring,
  ) => {
    const result = await resolveRedemptionCapacity(
      {} as D1Database, "lusd-liquity", { kind: "reserve-sync-metadata" }, supply!, now,
      { reserveSnapshotMetadata: baseSnapshot({
        freshnessMode: "not-applicable",
        redemption: {
          ...(amount != null ? { capacityUsd: amount } : {}),
          ...(ratio != null ? { capacityRatioOfSupply: ratio } : {}),
          ...(dailyLimit != null ? { dailyLimitUsd: dailyLimit } : {}),
          capacityKind: "live-direct-bounded",
          freshnessKind: "same-run-onchain",
        },
      }) },
    );
    expect(result.immediateCapacityUsd).toBe(immediate);
    expect(result.immediateCapacityRatio).toBe(immediate! / supply!);
    expect(result.scoringCapacityUsd).toBe(scoring);
    expect(result.scoringCapacityRatio).toBe(scoring! / supply!);
  });

  it("treats an unproven settlement bound as unestablished capacity", async () => {
    const result = await resolveRedemptionCapacity(
      {} as D1Database,
      "lusd-liquity",
      { kind: "reserve-sync-metadata" },
      1_000_000,
      now,
      {
        reserveSnapshotMetadata: baseSnapshot({
          freshnessMode: "not-applicable",
          redemption: {
            capacityUsd: 0,
            capacityKind: "live-direct-bounded",
            freshnessKind: "same-run-onchain",
            settlementBoundUnproven: true,
            settlementDelaySec: 2_592_000,
            routeStatus: "open",
            routeStatusSource: "onchain",
          },
        }),
      },
    );

    expect(result).toMatchObject({
      immediateCapacityUsd: null,
      immediateCapacityRatio: null,
      scoringCapacityUsd: null,
      scoringCapacityRatio: null,
      resolutionState: "missing-capacity",
      settlementBoundUnproven: true,
      capacityProfile: {
        immediateUsd: null,
        scoringUsd: null,
        scoringHorizon: "unknown",
        settlementBoundUnproven: true,
      },
      settlementDelaySec: 2_592_000,
      routeStatus: "open",
      routeStatusSource: "onchain",
    });
    expect(result.eventualCapacityUsd).toBeUndefined();
    expect(result.eventualCapacityRatio).toBeUndefined();
  });

  it("publishes full-supply eventual capacity only when the route config explicitly authorizes it", async () => {
    const result = await resolveRedemptionCapacity(
      {} as D1Database,
      "lusd-liquity",
      { kind: "reserve-sync-metadata", eventualCapacityModel: "supply-full" },
      1_000_000,
      now,
      {
        reserveSnapshotMetadata: baseSnapshot({
          freshnessMode: "not-applicable",
          redemption: {
            capacityUsd: 800_000,
            capacityKind: "live-direct-bounded",
            freshnessKind: "same-run-onchain",
          },
        }),
      },
    );

    expect(result.eventualCapacityUsd).toBe(1_000_000);
    expect(result.eventualCapacityRatio).toBe(1);
    expect(result.capacityProfile?.eventualUsd).toBe(1_000_000);
  });

  it("blocks unverified nested redemption freshness unless a route is explicitly allowlisted", async () => {
    const db = {} as D1Database;
    const result = await resolveRedemptionCapacity(
      db,
      "lusd-liquity",
      { kind: "reserve-sync-metadata" },
      1_000_000,
      now,
      {
        reserveSnapshotMetadata: baseSnapshot({
          freshnessMode: "not-applicable",
          redemption: {
            capacityUsd: 800_000,
            capacityKind: "live-direct-bounded",
            freshnessKind: "unverified",
          },
        }),
      },
    );

    expect(result.resolutionState).toBe("missing-capacity");
    expect(result.immediateCapacityUsd).toBeNull();
    expect(result.notes).toContain("Live redemption capacity has unverified freshness; route-specific approval required");
  });

  it("caps configured fallback-ratio scoring capacity by the live daily limit", async () => {
    const result = await resolveRedemptionCapacity(
      {} as D1Database,
      "lusd-liquity",
      { kind: "reserve-sync-metadata", fallbackRatio: 0.8 },
      1_000_000,
      now,
      {
        reserveSnapshotMetadata: baseSnapshot({
          freshnessMode: "not-applicable",
          redemption: { dailyLimitUsd: 250_000 },
        }),
      },
    );

    expect(result.immediateCapacityUsd).toBe(800_000);
    expect(result.immediateCapacityRatio).toBe(0.8);
    expect(result.scoringCapacityUsd).toBe(250_000);
    expect(result.scoringCapacityRatio).toBe(0.25);
    expect(result.capacityProfile).toMatchObject({
      immediateUsd: 800_000,
      dailyLimitUsd: 250_000,
      scoringUsd: 250_000,
      scoringHorizon: "daily",
    });
  });

  it.each([
    ["paused", "onchain", "Vault redemptions are paused"],
    ["degraded", "protocol-api", "Redemptions are degraded"],
  ] as const)(
    "preserves live %s route impairment without configured fallback rescue",
    async (routeStatus, routeStatusSource, routeStatusReason) => {
      const db = {} as D1Database;
      const result = await resolveRedemptionCapacity(
        db,
        "lusd-liquity",
        { kind: "reserve-sync-metadata", fallbackUsd: 250_000 },
        1_000_000,
        now,
        {
          reserveSnapshotMetadata: baseSnapshot({
            freshnessMode: "not-applicable",
            redemption: {
              routeStatus,
              routeStatusSource,
              routeStatusReason,
              routeStatusReviewedAt: "2026-05-17",
            },
          }),
        },
      );

      expect(result.resolutionState).toBe("missing-capacity");
      expect(result.provider).toBe("reserve-sync-metadata");
      expect(result.immediateCapacityUsd).toBeNull();
      expect(result.scoringCapacityUsd).toBeNull();
      expect(result.routeStatus).toBe(routeStatus);
      expect(result.routeStatusSource).toBe(routeStatusSource);
      expect(result.routeStatusReason).toBe(routeStatusReason);
      expect(result.routeStatusReviewedAt).toBe("2026-05-17");
      expect(result.capacityRejectionReason).toBe("redeemable-capacity-unobserved");
    },
  );

  it("preserves exact fallback USD output and the positive-capacity daily-limit guard", async () => {
    const db = {} as D1Database;
    const result = await resolveRedemptionCapacity(
      db,
      "lusd-liquity",
      { kind: "reserve-sync-metadata", fallbackUsd: 0 },
      1_000_000,
      now,
      {
        reserveSnapshotMetadata: baseSnapshot({
          freshnessMode: "not-applicable",
          redemption: {
            dailyLimitUsd: 250_000,
          },
        }),
      },
    );

    expect(result).toEqual({
      consumedReserveCapacity: true,
      consumedReserveRouteStatus: false,
      immediateCapacityUsd: 0,
      immediateCapacityRatio: 0,
      scoringCapacityUsd: 0,
      scoringCapacityRatio: 0,
      dailyLimitUsd: 250_000,
      capacityScoreMode: "interpolated",
      capacityProfile: {
        immediateUsd: 0,
        dailyLimitUsd: 250_000,
        scoringUsd: 0,
        scoringHorizon: "immediate",
        capacityProfileConfidence: "heuristic",
      },
      provider: "reserve-sync-fallback",
      sourceMode: "estimated",
      resolutionState: "resolved",
      capacityConfidence: "heuristic",
      capacityBasis: "hot-buffer",
      capacitySemantics: "immediate-bounded",
      capacityRejectionReason: "redeemable-capacity-unobserved",
      notes: [
        "Live reserve metadata lacks redeemable-capacity amount; using configured fallback USD capacity",
      ],
    });
  });

  it("clamps live capacity to zero when supplyUsd is zero", async () => {
    const db = {} as D1Database;
    const result = await resolveRedemptionCapacity(
      db,
      "lusd-liquity",
      { kind: "reserve-sync-metadata" },
      0,
      now,
      {
        reserveSnapshotMetadata: baseSnapshot({
          freshnessMode: "not-applicable",
          redemption: { capacityUsd: 500_000 },
        }),
      },
    );
    expect(result.scoringCapacityUsd).toBe(0);
    expect(result.immediateCapacityUsd).toBe(0);
    expect(result.notes.some((n) => /exceeds current supply/i.test(n))).toBe(true);
  });
});

describe("resolveRedemptionCapacity — reserve-sync live capacity confidence override", () => {
  const liveRedemptionSnapshot = () =>
    baseSnapshot({
      freshnessMode: "not-applicable",
      redemption: {
        capacityUsd: 800_000,
        capacityRatioOfSupply: 0.8,
        capacityKind: "live-direct",
        freshnessKind: "same-run-onchain",
        routeStatus: "unknown",
        routeStatusSource: "onchain",
      },
    });

  it("labels the adapter's live-direct capacity as live-direct with no override", async () => {
    const db = {} as D1Database;
    const result = await resolveRedemptionCapacity(db, "lusd-liquity", { kind: "reserve-sync-metadata" }, 1_000_000, now, {
      reserveSnapshotMetadata: liveRedemptionSnapshot(),
    });
    expect(result.capacityConfidence).toBe("live-direct");
    expect(result.immediateCapacityUsd).toBe(800_000);
  });

  it("re-labels the measured live capacity to documented-bound when liveCapacityConfidence is set, preserving the capacity value", async () => {
    const db = {} as D1Database;
    // Mirrors the sBOLD SP-withdrawable read: a bounded proxy for redeemability
    // whose measured capacity still scores, but at documented-bound confidence so
    // deriveModelConfidence lands on "medium" rather than the live-direct "high".
    const result = await resolveRedemptionCapacity(
      db,
      "lusd-liquity",
      { kind: "reserve-sync-metadata", liveCapacityConfidence: "documented-bound", basis: "strategy-buffer" },
      1_000_000,
      now,
      { reserveSnapshotMetadata: liveRedemptionSnapshot() },
    );
    expect(result.capacityConfidence).toBe("documented-bound");
    expect(result.capacityProfile?.capacityProfileConfidence).toBe("documented-bound");
    expect(result.capacityBasis).toBe("strategy-buffer");
    expect(result.immediateCapacityUsd).toBe(800_000);
  });
});

describe("Theo no-fallback measured capacity", () => {
  it.each([220400, 0])("preserves measured %s and uses the canonical supply denominator", async (capacityUsd) => {
    const supplyUsd = 132370676.056526;
    const result = await resolveRedemptionCapacity(
      {} as D1Database, "thusd-theo", { kind: "reserve-sync-metadata", basis: "hot-buffer", fallbackRatio: 0.005 }, supplyUsd, now,
      { reserveSnapshotMetadata: liveSnapshot("thusd-theo", {
        freshnessMode: "not-applicable",
        redemption: {
          capacityUsd, capacityKind: "live-direct-bounded", freshnessKind: "same-run-onchain",
          routeStatus: "open", routeStatusSource: "onchain", settlementDelaySec: 0,
        },
      }, { fetchedAt: now - 60, source: "theo-thusd-redemption", sourceModel: "validated-static", evidenceClass: "static-validated" }) },
    );
    expect(result).toMatchObject({
      resolutionState: "resolved", immediateCapacityUsd: capacityUsd, scoringCapacityUsd: capacityUsd,
      immediateCapacityRatio: capacityUsd / supplyUsd, scoringCapacityRatio: capacityUsd / supplyUsd,
      capacityConfidence: "live-direct",
    });
  });

  it.each(["missing", "stale"] as const)("does not invent a cash floor for %s telemetry", async (state) => {
    const result = await resolveRedemptionCapacity(
      {} as D1Database, "thusd-theo", { kind: "reserve-sync-metadata", basis: "hot-buffer" }, 132370676.056526, now,
      { reserveSnapshotMetadata: state === "missing" ? null : liveSnapshot("thusd-theo", {
        freshnessMode: "not-applicable",
        redemption: { capacityUsd: 220400, capacityKind: "live-direct-bounded", freshnessKind: "same-run-onchain" },
      }, { fetchedAt: now - 3 * 86400, source: "theo-thusd-redemption", sourceModel: "validated-static", evidenceClass: "static-validated" }) },
    );
    expect(result).toMatchObject({
      resolutionState: "missing-capacity", immediateCapacityUsd: null, scoringCapacityUsd: null,
    });
  });
});

describe("Theo rejected producer admission", () => {
  it.each(["config-mismatch", "inconsistent-snapshot", "invalid-freshness"] as const)("cannot reuse telemetry rejected for %s", async (reason) => {
    const result = await resolveRedemptionCapacity(
      {} as D1Database, "thusd-theo", { kind: "reserve-sync-metadata", basis: "hot-buffer" }, 132370676.056526, now,
      { reserveSnapshotMetadata: liveSnapshot("thusd-theo", {
        freshnessMode: "not-applicable",
        redemption: { capacityUsd: 220400, capacityKind: "live-direct-bounded", freshnessKind: "same-run-onchain" },
      }, {
        fetchedAt: now - 60, source: "theo-thusd-redemption", sourceModel: "validated-static",
        evidenceClass: "static-validated", admission: { eligible: false, reasons: [reason], freshness: null },
      }) },
    );
    expect(result).toMatchObject({
      resolutionState: "missing-capacity", immediateCapacityUsd: null, scoringCapacityUsd: null,
    });
  });
});

describe("bounded capacity arithmetic across admitted models", () => {
  it.each([
    [40, 40, "daily"],
    [80, 80, "immediate"],
    [100, 80, "immediate"],
  ] as const)("retains raw capacity with a %s day limit and %s scoring capacity", async (dailyLimitUsd, scoringUsd, horizon) => {
    for (const model of [
      { kind: "fixed-usd", amountUsd: 80, dailyLimitUsd },
      { kind: "supply-ratio", ratio: 0.8, dailyLimitUsd },
      { kind: "reserve-sync-metadata" },
    ] as const) {
      const result = await resolveRedemptionCapacity({} as D1Database, "lusd-liquity", model, 100, now, {
        reserveSnapshotMetadata: baseSnapshot({
          freshnessMode: "not-applicable",
          redemption: { capacityUsd: 80, dailyLimitUsd, capacityKind: "live-direct-bounded", freshnessKind: "same-run-onchain" },
        }),
      });
      expect(result).toMatchObject({
        immediateCapacityUsd: 80, immediateCapacityRatio: 0.8,
        scoringCapacityUsd: scoringUsd, scoringCapacityRatio: scoringUsd / 100,
        capacityProfile: { immediateUsd: 80, dailyLimitUsd, scoringUsd, scoringHorizon: horizon },
      });
    }
  });

  it.each([
    [null, 80, null],
    [0, 0, null],
    [40, 40, 1],
    [100, 80, 0.8],
  ] as const)("retains the absolute buffer/supply boundary for %s supply", async (supplyUsd, immediateUsd, ratio) => {
    for (const model of [
      { kind: "fixed-usd", amountUsd: 80 },
      { kind: "reserve-sync-metadata" },
    ] as const) {
      const result = await resolveRedemptionCapacity({} as D1Database, "lusd-liquity", model, supplyUsd, now, {
        reserveSnapshotMetadata: baseSnapshot({
          freshnessMode: "not-applicable",
          redemption: { capacityUsd: 80, capacityKind: "live-direct-bounded", freshnessKind: "same-run-onchain" },
        }),
      });
      expect(result).toMatchObject({
        immediateCapacityUsd: immediateUsd, immediateCapacityRatio: ratio,
        scoringCapacityUsd: immediateUsd, scoringCapacityRatio: ratio,
        capacityProfile: { immediateUsd, scoringUsd: immediateUsd, scoringHorizon: "immediate" },
      });
      expect(result.capacityProfile).not.toHaveProperty("eventualUsd");
    }
  });

  it.each([
    [0, 0, "daily"],
    [40, 40, "daily"],
    [80, 80, "queued"],
    [100, 80, "queued"],
  ] as const)("preserves queue/day precedence at a %s day limit", async (dailyLimitUsd, scoringUsd, horizon) => {
    const result = await resolveRedemptionCapacity({} as D1Database, "lusd-liquity", { kind: "reserve-sync-metadata" }, 100, now, {
      reserveSnapshotMetadata: baseSnapshot({
        freshnessMode: "not-applicable",
        redemption: { capacityUsd: 80, dailyLimitUsd, queueDepthUsd: 10, capacityKind: "live-direct-bounded", freshnessKind: "same-run-onchain" },
      }),
    });
    expect(result.capacityProfile).toMatchObject({ immediateUsd: 80, queuedUsd: 10, dailyLimitUsd, scoringUsd, scoringHorizon: horizon });
  });

  it.each([null, 0, 100])("publishes eventual supply only when explicitly approved (%s)", async (supplyUsd) => {
    const result = await resolveRedemptionCapacity(
      {} as D1Database, "lusd-liquity", { kind: "reserve-sync-metadata", eventualCapacityModel: "supply-full" }, supplyUsd, now,
      { reserveSnapshotMetadata: baseSnapshot({
        freshnessMode: "not-applicable",
        redemption: { capacityUsd: 80, capacityKind: "live-direct-bounded", freshnessKind: "same-run-onchain" },
      }) },
    );
    if (supplyUsd == null) {
      expect(result.eventualCapacityUsd).toBeUndefined();
      expect(result.capacityProfile).not.toHaveProperty("eventualUsd");
    } else {
      expect(result.eventualCapacityUsd).toBe(supplyUsd);
      expect(result.capacityProfile?.eventualUsd).toBe(supplyUsd);
    }
    expect(result.eventualCapacityRatio).toBe(supplyUsd != null && supplyUsd > 0 ? 1 : undefined);
  });

  it("keeps observed zero distinct from absent capacity and absent supply", async () => {
    const measuredZero = await resolveRedemptionCapacity(
      {} as D1Database, "lusd-liquity", { kind: "reserve-sync-metadata" }, 100, now,
      { reserveSnapshotMetadata: baseSnapshot({
        freshnessMode: "not-applicable",
        redemption: { capacityUsd: 0, capacityKind: "live-direct-bounded", freshnessKind: "same-run-onchain" },
      }) },
    );
    expect(measuredZero).toMatchObject({
      resolutionState: "resolved", immediateCapacityUsd: 0, scoringCapacityUsd: 0,
      immediateCapacityRatio: 0, scoringCapacityRatio: 0,
    });
    const absent = await resolveRedemptionCapacity(
      {} as D1Database, "lusd-liquity", { kind: "reserve-sync-metadata" }, 100, now,
      { reserveSnapshotMetadata: null },
    );
    expect(absent).toMatchObject({ resolutionState: "missing-capacity", immediateCapacityUsd: null, scoringCapacityUsd: null });
    const fullZero = await resolveRedemptionCapacity({} as D1Database, "test-coin", { kind: "supply-full" }, 0, now);
    const ratioZero = await resolveRedemptionCapacity({} as D1Database, "test-coin", { kind: "supply-ratio", ratio: 0.5 }, 0, now);
    expect(fullZero).toMatchObject({ resolutionState: "resolved", eventualCapacityUsd: 0, eventualCapacityRatio: null });
    expect(ratioZero).toMatchObject({ resolutionState: "missing-capacity", immediateCapacityUsd: null });
    for (const model of [{ kind: "supply-full" }, { kind: "supply-ratio", ratio: 0.5 }] as const) {
      const missingSupply = await resolveRedemptionCapacity({} as D1Database, "test-coin", model, null, now);
      expect(missingSupply).toMatchObject({ resolutionState: "missing-cache", immediateCapacityUsd: null, scoringCapacityUsd: null });
      expect(missingSupply.eventualCapacityUsd ?? null).toBeNull();
    }
  });

  it("cannot admit a positive capacity from a quarantined malformed nested packet", async () => {
    const result = await resolveRedemptionCapacity(
      {} as D1Database, "lusd-liquity", { kind: "reserve-sync-metadata" }, 100, now,
      { reserveSnapshotMetadata: baseSnapshot({
        freshnessMode: "not-applicable",
        redemption: { capacityUsd: 80, dailyLimitUsd: -1, capacityKind: "live-direct-bounded", freshnessKind: "same-run-onchain" },
      }) },
    );
    expect(result).toMatchObject({ resolutionState: "missing-capacity", immediateCapacityUsd: null, scoringCapacityUsd: null });
  });
});

describe("unbounded crosschain capacity admission", () => {
  it.each([undefined, 80])("keeps unbounded diagnostics unavailable even with capacity %s and static fallback", async (capacityUsd) => {
    const result = await resolveRedemptionCapacity(
      {} as D1Database, "sfrxusd-frax", { kind: "reserve-sync-metadata", fallbackUsd: 50 }, 100, now,
      { reserveSnapshotMetadata: liveSnapshot("sfrxusd-frax", {
        freshnessMode: "not-applicable",
        redemption: {
          ...(capacityUsd != null ? { capacityUsd } : {}), capacityKind: "documented-bound", freshnessKind: "same-run-onchain",
          settlementBoundUnproven: true, routeStatus: "open", routeStatusSource: "onchain",
        },
      }, { fetchedAt: now - 60, source: "erc4626-single-asset" }) },
    );
    expect(result).toMatchObject({
      resolutionState: "missing-capacity",
      immediateCapacityUsd: null, immediateCapacityRatio: null,
      scoringCapacityUsd: null, scoringCapacityRatio: null,
      capacityConfidence: "heuristic",
      routeStatus: "open",
      capacityProfile: { immediateUsd: null, scoringUsd: null, scoringHorizon: "unknown", settlementBoundUnproven: true },
    });
    expect(result.eventualCapacityUsd ?? null).toBeNull();
  });
});

describe("capacity admission reasons and confidence honesty", () => {
  const nested = {
    capacityUsd: 100, capacityKind: "live-direct", freshnessKind: "same-run-onchain",
    sourceTimestamp: now - 12, blockNumber: 26_142_993, outputAssetKeys: ["usdc-circle"],
    routeStatus: "open", routeStatusSource: "onchain", holderEligibility: "any-holder",
  };

  it.each([100, 0])("admits independently pinned Reservoir capacity %d without upgrading composition", async (capacityUsd) => {
    const input = liveSnapshot("rusd-reservoir", {
      freshnessMode: "unverified", redemption: { ...nested, capacityUsd },
    }, { fetchedAt: now - 10, admission: { eligible: false, reasons: ["invalid-freshness"], freshness: null } });
    const result = await resolveRedemptionCapacity({} as D1Database, "rusd-reservoir",
      { kind: "reserve-sync-metadata", fallbackRatio: 0.0025, confidence: "documented-bound" }, 1_000, now,
      { reserveSnapshotMetadata: input });
    expect(result.immediateCapacityUsd).toBe(capacityUsd);
    expect(result.capacityConfidence).toBe("live-direct");
    expect(result.consumedReserveCapacity).toBe(true);
    expect(result.capacityRejectionReason).toBeUndefined();
    expect(input.admission?.eligible).toBe(false);
  });

  it("preserves a fresh measured pause as zero rather than the configured fallback", async () => {
    const input = liveSnapshot("rusd-reservoir", { freshnessMode: "unverified",
      redemption: { ...nested, capacityUsd: 0, routeStatus: "paused" },
    }, { fetchedAt: now - 10 });
    const result = await resolveRedemptionCapacity({} as D1Database, "rusd-reservoir",
      { kind: "reserve-sync-metadata", fallbackRatio: 0.0025 }, 1_000, now, { reserveSnapshotMetadata: input });
    expect(result.immediateCapacityUsd).toBe(0);
    expect(result.provider).toBe("reserve-sync-metadata");
    expect(result.routeStatus).toBe("paused");
  });

  it("retains a documented fallback and the actual nested rejection cause", async () => {
    const input = liveSnapshot("rusd-reservoir", { freshnessMode: "unverified",
      redemption: { ...nested, sourceTimestamp: now - 172_801 },
    }, { fetchedAt: now - 10 });
    const result = await resolveRedemptionCapacity({} as D1Database, "rusd-reservoir",
      { kind: "reserve-sync-metadata", fallbackRatio: 0.0025, confidence: "documented-bound" }, 1_000, now,
      { reserveSnapshotMetadata: input });
    expect(result.immediateCapacityUsd).toBe(2.5);
    expect(result.capacityConfidence).toBe("documented-bound");
    expect(result.capacityRejectionReason).toBe("stale-source-timestamp");
    expect(result.consumedReserveCapacity).toBe(false);
    expect(result.capacityKind).toBeUndefined();
  });

  it.each([
    ["dllr-sovryn", { ...nested, capacityUsd: undefined }, "redeemable-capacity-unobserved"],
    ["srusde-strata", { ...nested, outputAssetKeys: undefined }, "route-output-identity-unobserved"],
    ["usdr-rise", { ...nested, outputAssetKeys: ["m-m0"] }, "route-output-identity-unobserved"],
    ["dusd-dialectic", { ...nested, sourceTimestamp: now - 172_801 }, "stale-source-timestamp"],
    ["eearn-ember", { ...nested, settlementBoundUnproven: true }, "settlement-bound-unproven"],
  ] as const)("publishes %s missing measurement cause %s honestly", async (stablecoinId, redemption, cause) => {
    const input = liveSnapshot(stablecoinId, { freshnessMode: "not-applicable", redemption }, { fetchedAt: now - 10 });
    const result = await resolveRedemptionCapacity({} as D1Database, stablecoinId,
      { kind: "reserve-sync-metadata" }, 1_000, now, { reserveSnapshotMetadata: input });
    expect(result.immediateCapacityUsd).toBeNull();
    expect(result.scoringCapacityUsd).toBeNull();
    expect(result.capacityConfidence).toBe("heuristic");
    expect(result.capacityRejectionReason).toBe(cause);
  });

  it.each(["config-mismatch", "inconsistent-snapshot", "stale"] as const)(
    "preserves snapshot rejection %s instead of replacing it with a missing amount", async (reason) => {
      const input = baseSnapshot({ freshnessMode: "not-applicable", redemption: nested });
      input.admission = { eligible: false, reasons: [reason], freshness: null };
      const result = await resolveRedemptionCapacity({} as D1Database, "lusd-liquity",
        { kind: "reserve-sync-metadata" }, 1_000, now, { reserveSnapshotMetadata: input });
      expect(result.capacityRejectionReason).toBe(reason);
      expect(result.capacityConfidence).toBe("heuristic");
      expect(result.consumedReserveCapacity).not.toBe(true);
    },
  );

  it.each(["onyc-onre", "nusd-neutrl"])("retains registered %s unquantified capacity without execution evidence", async (id) => {
    const config = getRedemptionBackstopConfig(id);
    expect(config).not.toBeNull();
    const result = await resolveRedemptionCapacity({} as D1Database, id, config!.capacityModel, 1_000_000, now);
    expect(result.immediateCapacityUsd).toBeNull();
    expect(result.scoringCapacityUsd).toBeNull();
    expect(result.eventualCapacityUsd).toBeNull();
    expect(result.resolutionState).toBe("missing-capacity");
  });
});

describe("async settlement flag survives every reserve capacity branch", () => {
  it.each([
    { status: "open", amount: 100, model: { kind: "reserve-sync-metadata" as const }, state: "missing-capacity", capacity: null },
    { status: "unknown", amount: 100, model: { kind: "reserve-sync-metadata" as const }, state: "missing-capacity", capacity: null },
    { status: "paused", amount: 0, model: { kind: "reserve-sync-metadata" as const }, state: "resolved", capacity: 0 },
    { status: "paused", amount: 100, model: { kind: "reserve-sync-metadata" as const }, state: "missing-capacity", capacity: null },
    { status: "paused", amount: undefined, model: { kind: "reserve-sync-metadata" as const, fallbackRatio: 0.1 }, state: "missing-capacity", capacity: null },
    { status: "unknown", amount: undefined, model: { kind: "reserve-sync-metadata" as const, fallbackRatio: 0.1 }, state: "missing-capacity", capacity: null },
    { status: "unknown", amount: undefined, model: { kind: "reserve-sync-metadata" as const, fallbackUsd: 50 }, state: "missing-capacity", capacity: null },
    { status: "unknown", amount: undefined, model: { kind: "reserve-sync-metadata" as const }, state: "missing-capacity", capacity: null },
  ])("retains settlement guard for $status/$amount/$capacity", async ({ status, amount, model, state, capacity }) => {
    const input = baseSnapshot({ freshnessMode: "not-applicable",
      redemption: { capacityUsd: amount, settlementBoundUnproven: true,
        capacityKind: "live-queue", freshnessKind: "same-run-onchain",
        routeStatus: status, routeStatusSource: "onchain" },
    });
    const result = await resolveRedemptionCapacity({} as D1Database, "lusd-liquity", model, 1_000, now,
      { reserveSnapshotMetadata: input });
    expect(result.resolutionState).toBe(state);
    expect(result.immediateCapacityUsd).toBe(capacity);
    expect(result.settlementBoundUnproven).toBe(true);
    if (result.capacityProfile) expect(result.capacityProfile.settlementBoundUnproven).toBe(true);
    if (state === "missing-capacity") {
      expect(result.capacityProfile?.scoringUsd).toBeNull();
      expect(result.capacityRejectionReason).toBe("settlement-bound-unproven");
    }
  });
});

describe("registered executable observer dispatch", () => {
  it.each([null, 1_000_000_000])("cannot fill absent USDfr executable observation from supply/reserves (%s)", async (supplyUsd) => {
    const stablecoinId = "usdfr-forest-road";
    const config = getRedemptionBackstopConfig(stablecoinId);
    expect(config?.capacityModel.kind).toBe("executable-observer");
    if (!config || config.capacityModel.kind !== "executable-observer") throw new Error("USDfr executable route must be registered");
    const db = { prepare: () => { throw new Error("Executable observer must not borrow reserve capacity"); } } as unknown as D1Database;
    const result = await resolveRedemptionCapacity(db, stablecoinId, config.capacityModel, supplyUsd, now, {
      reserveSnapshotMetadata: liveSnapshot(stablecoinId, {
        freshnessMode: "not-applicable",
        redemption: { capacityUsd: 500_000_000, capacityKind: "live-direct", freshnessKind: "same-run-onchain" },
      }, { fetchedAt: now - 10 }),
    });
    expect(result.resolutionState).toBe("missing-capacity");
    expect(result.capacityConfidence).toBe("heuristic");
    expect(result.immediateCapacityUsd).toBeNull();
    expect(result.immediateCapacityRatio).toBeNull();
    expect(result.scoringCapacityUsd).toBeNull();
    expect(result.scoringCapacityRatio).toBeNull();
    expect(result.eventualCapacityUsd ?? null).toBeNull();
  });

  it.each([
    ["receipt guard failed", null],
    ["output unvalued", null],
    ["funded receipt valued", 1_000],
  ] as const)("keeps apyUSD %s separate from generic asynchronous idle cash", async (scenario, eventualCapacityUsd) => {
    const stablecoinId = "apyusd-apyx";
    const config = getRedemptionBackstopConfig(stablecoinId)!;
    const result = await resolveRedemptionCapacity({} as D1Database, stablecoinId, config.capacityModel, 10_000, now, {
      reserveSnapshotMetadata: liveSnapshot(stablecoinId, {
        freshnessMode: "not-applicable",
        redemption: {
          capacityUsd: 500_000_000,
          capacityKind: "live-direct-bounded",
          freshnessKind: "same-run-onchain",
          outputAssetKeys: ["apxusd-apyx"],
          settlementBoundUnproven: true,
        },
      }, { fetchedAt: now - 10 }),
      executableRedemptionObservation: scenario === "receipt guard failed" ? null : {
        capacityRaw: 1_000n * 10n ** 18n,
        capacitySource: "apyusd-funded-unlock-receipt",
        capacityState: "measured",
        underlyingDecimals: 18,
        outputAssetKeys: ["apxusd-apyx"],
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        blockNumber: 26_142_848,
        sourceTimestamp: now,
        sourceUrls: ["https://docs.apyx.fi/product-overview/apyusd-overview"],
        routeStatus: "open",
        routeStatusSource: "onchain",
        routeStatusReason: "Funded receipt claim guards admitted",
        holderEligibility: "whitelisted-primary",
        settlementDelaySec: 259_200,
        feeBps: 10,
        allInFeeBps: 12,
        diagnostics: {},
      },
      executableObserverValuation: scenario === "output unvalued" ? null : {
        outputAssetKey: "apxusd-apyx",
        priceUsd: 1,
        observedAt: now,
      },
    });
    expect(result.provider).toBe("executable-observer");
    expect(result.immediateCapacityUsd).toBeNull();
    expect(result.immediateCapacityRatio).toBeNull();
    expect(result.scoringCapacityUsd).toBeNull();
    expect(result.scoringCapacityRatio).toBeNull();
    expect(result.eventualCapacityUsd).toBe(eventualCapacityUsd);
    expect(result.consumedReserveCapacity).not.toBe(true);
    if (eventualCapacityUsd === null) {
      expect(result.capacityRejectionReason).toBe(
        scenario === "output unvalued" ? "output-valuation-unobserved" : "redeemable-capacity-unobserved",
      );
    }
  });
});

describe("configured fallback cannot rescue adverse live routes", () => {
  it.each(["paused", "degraded", "cohort-limited", "unknown"])("withholds fallback after non-allowlisted degraded %s", async (routeStatus) => {
    const input = liveSnapshot("lusd-liquity", { freshnessMode: "not-applicable",
      redemption: { capacityUsd: 100, capacityKind: "live-direct", freshnessKind: "same-run-onchain",
        routeStatus, routeStatusSource: "onchain", dailyLimitUsd: 5 },
    }, { fetchedAt: now - 60, syncStatus: "degraded" });
    for (const model of [
      { kind: "reserve-sync-metadata", fallbackRatio: 0.1 },
      { kind: "reserve-sync-metadata", fallbackUsd: 50 },
    ] as const) {
      const result = await resolveRedemptionCapacity({} as D1Database, "lusd-liquity", model, 1_000, now,
        { reserveSnapshotMetadata: input });
      expect(result.resolutionState).toBe("missing-capacity");
      expect(result.immediateCapacityUsd).toBeNull();
      expect(result.scoringCapacityUsd).toBeNull();
      expect(result.capacityConfidence).toBe("heuristic");
      expect(result.routeStatus).toBe(routeStatus);
      expect(result.consumedReserveRouteStatus).toBe(true);
    }
  });

  it("retains a limiting daily cap when rejected positive telemetry uses a documented fallback", async () => {
    const input = liveSnapshot("lusd-liquity", { freshnessMode: "not-applicable",
      redemption: { capacityUsd: 100, capacityKind: "live-direct", freshnessKind: "same-run-onchain",
        routeStatus: "open", routeStatusSource: "onchain", dailyLimitUsd: 5 },
    }, { fetchedAt: now - 60, syncStatus: "degraded" });
    const result = await resolveRedemptionCapacity({} as D1Database, "lusd-liquity",
      { kind: "reserve-sync-metadata", fallbackRatio: 0.1, confidence: "documented-bound" }, 1_000, now,
      { reserveSnapshotMetadata: input });
    expect(result.scoringCapacityUsd).toBe(5);
    expect(result.capacityConfidence).toBe("documented-bound");
    expect(result.dailyLimitUsd).toBe(5);
  });
});

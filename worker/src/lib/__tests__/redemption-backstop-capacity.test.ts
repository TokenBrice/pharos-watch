import { describe, expect, it } from "vitest";
import { resolveCapacityBasis, resolveRedemptionCapacity } from "../redemption-backstop-capacity";
import { liveSnapshot } from "./redemption-backstop-sources.test-support";

const now = 1_780_000_000;
const baseSnapshot = (metadata: Record<string, unknown>) => liveSnapshot("lusd-liquity", metadata, {
  fetchedAt: now - 60,
  source: "liquity-v1",
  sourceModel: "single-bucket",
});

describe("resolveCapacityBasis", () => {
  describe("reserve-sync-metadata model", () => {
    it("returns live-direct-telemetry when capacity confidence is live-direct", () => {
      expect(
        resolveCapacityBasis("stablecoin-redeem", { kind: "reserve-sync-metadata" }, "live-direct"),
      ).toBe("live-direct-telemetry");
    });

    it("returns live-proxy-buffer when capacity confidence is live-proxy", () => {
      expect(
        resolveCapacityBasis("collateral-redeem", { kind: "reserve-sync-metadata" }, "live-proxy"),
      ).toBe("live-proxy-buffer");
    });

    it("returns the explicit model.basis when confidence is neither live-direct nor live-proxy", () => {
      expect(
        resolveCapacityBasis(
          "stablecoin-redeem",
          { kind: "reserve-sync-metadata", basis: "hot-buffer" },
          "dynamic",
        ),
      ).toBe("hot-buffer");
    });

    it("falls back to route-family basis when confidence is other and no basis is set", () => {
      expect(
        resolveCapacityBasis("stablecoin-redeem", { kind: "reserve-sync-metadata" }, "dynamic"),
      ).toBe("hot-buffer");
      expect(
        resolveCapacityBasis("psm-swap", { kind: "reserve-sync-metadata" }, "documented-bound"),
      ).toBe("psm-balance-share");
      expect(
        resolveCapacityBasis("queue-redeem", { kind: "reserve-sync-metadata" }, "heuristic"),
      ).toBe("strategy-buffer");
    });
  });

  describe("explicit model.basis on non-reserve models", () => {
    it("returns model.basis verbatim for supply-full", () => {
      expect(
        resolveCapacityBasis("stablecoin-redeem", {
          kind: "supply-full",
          basis: "daily-limit",
        }),
      ).toBe("daily-limit");
    });

    it("returns model.basis verbatim for supply-ratio", () => {
      expect(
        resolveCapacityBasis("psm-swap", {
          kind: "supply-ratio",
          ratio: 0.1,
          basis: "strategy-buffer",
        }),
      ).toBe("strategy-buffer");
    });

    it("returns fixed-buffer for fixed USD capacity without an explicit basis", () => {
      expect(
        resolveCapacityBasis("psm-swap", {
          kind: "fixed-usd",
          amountUsd: 5_000_000,
        }),
      ).toBe("fixed-buffer");
    });
  });

  describe("supply-full fallbacks (no explicit basis)", () => {
    it("returns issuer-term-redemption for offchain-issuer route family", () => {
      expect(resolveCapacityBasis("offchain-issuer", { kind: "supply-full" })).toBe("issuer-term-redemption");
    });

    it("returns issuer-term-redemption for stablecoin-redeem route family", () => {
      expect(resolveCapacityBasis("stablecoin-redeem", { kind: "supply-full" })).toBe("issuer-term-redemption");
    });

    it("returns full-system-eventual for other route families", () => {
      expect(resolveCapacityBasis("basket-redeem", { kind: "supply-full" })).toBe("full-system-eventual");
      expect(resolveCapacityBasis("collateral-redeem", { kind: "supply-full" })).toBe("full-system-eventual");
      expect(resolveCapacityBasis("queue-redeem", { kind: "supply-full" })).toBe("full-system-eventual");
      expect(resolveCapacityBasis("psm-swap", { kind: "supply-full" })).toBe("full-system-eventual");
    });

    it("returns full-system-eventual when routeFamily is null (reserve-sync call-site pattern)", () => {
      expect(resolveCapacityBasis(null, { kind: "supply-full" })).toBe("full-system-eventual");
    });
  });

  describe("supply-ratio fallbacks (no explicit basis)", () => {
    it("returns psm-balance-share for psm-swap route family", () => {
      expect(
        resolveCapacityBasis("psm-swap", { kind: "supply-ratio", ratio: 0.2 }),
      ).toBe("psm-balance-share");
    });

    it("returns strategy-buffer for queue-redeem route family", () => {
      expect(
        resolveCapacityBasis("queue-redeem", { kind: "supply-ratio", ratio: 0.05 }),
      ).toBe("strategy-buffer");
    });

    it("returns hot-buffer for any other route family", () => {
      expect(
        resolveCapacityBasis("collateral-redeem", { kind: "supply-ratio", ratio: 0.1 }),
      ).toBe("hot-buffer");
      expect(
        resolveCapacityBasis("stablecoin-redeem", { kind: "supply-ratio", ratio: 0.1 }),
      ).toBe("hot-buffer");
      expect(
        resolveCapacityBasis("basket-redeem", { kind: "supply-ratio", ratio: 0.1 }),
      ).toBe("hot-buffer");
      expect(
        resolveCapacityBasis("offchain-issuer", { kind: "supply-ratio", ratio: 0.1 }),
      ).toBe("hot-buffer");
    });

    it("returns hot-buffer when routeFamily is null", () => {
      expect(
        resolveCapacityBasis(null, { kind: "supply-ratio", ratio: 0.1 }),
      ).toBe("hot-buffer");
    });
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
    expect(result.notes).toEqual(
      expect.arrayContaining([
        "Live redemption capacity ratio is above 1 and was ignored",
        "Live redemption capacity telemetry is malformed; fresh valid metadata required",
      ]),
    );
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

  it("preserves exact live reserve-sync capacity output when ratio telemetry overrides derived ratio", async () => {
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
            capacityRatioOfSupply: 0.9,
            capacityKind: "live-direct-bounded",
            freshnessKind: "same-run-onchain",
            sourceTimestamp: now - 30,
            sourceUrls: ["https://example.com/reserves"],
            settlementDelaySec: 3_600,
            queueDepthUsd: 50_000,
            dailyLimitUsd: 250_000,
            minRedeemUsd: 100,
            routeStatus: "open",
            routeStatusSource: "onchain",
            routeStatusReason: "Vault open",
            routeStatusReviewedAt: "2026-05-17",
          },
        }),
      },
    );

    expect(result).toEqual({
      immediateCapacityUsd: 800_000,
      immediateCapacityRatio: 0.9,
      scoringCapacityUsd: 250_000,
      scoringCapacityRatio: 0.25,
      eventualCapacityUsd: 1_000_000,
      eventualCapacityRatio: 1,
      capacityProfile: {
        immediateUsd: 800_000,
        dailyLimitUsd: 250_000,
        queuedUsd: 50_000,
        eventualUsd: 1_000_000,
        scoringUsd: 250_000,
        scoringHorizon: "daily",
        capacityProfileConfidence: "live-direct",
      },
      provider: "reserve-sync-metadata",
      sourceMode: "dynamic",
      resolutionState: "resolved",
      capacityConfidence: "live-direct",
      capacityBasis: "live-direct-telemetry",
      capacitySemantics: "immediate-bounded",
      capacityKind: "live-direct-bounded",
      freshnessKind: "same-run-onchain",
      sourceTimestamp: now - 30,
      sourceUrls: ["https://example.com/reserves"],
      settlementDelaySec: 3_600,
      queueDepthUsd: 50_000,
      dailyLimitUsd: 250_000,
      minRedeemUsd: 100,
      routeStatus: "open",
      routeStatusSource: "onchain",
      routeStatusReason: "Vault open",
      routeStatusReviewedAt: "2026-05-17",
      notes: [
        "Live redemption daily limit caps usable scoring capacity",
        "Live redemption queue depth is surfaced as a route constraint",
        "Live redemption settlement delay is surfaced as a route constraint",
      ],
    });
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

  it.each([
    ["paused", "onchain", "Vault redemptions are paused"],
    ["degraded", "protocol-api", "Redemptions are degraded"],
  ] as const)(
    "preserves live %s route status when using configured fallback USD capacity",
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

      expect(result.resolutionState).toBe("resolved");
      expect(result.provider).toBe("reserve-sync-fallback");
      expect(result.immediateCapacityUsd).toBe(250_000);
      expect(result.scoringCapacityUsd).toBe(250_000);
      expect(result.routeStatus).toBe(routeStatus);
      expect(result.routeStatusSource).toBe(routeStatusSource);
      expect(result.routeStatusReason).toBe(routeStatusReason);
      expect(result.routeStatusReviewedAt).toBe("2026-05-17");
      expect(result.notes).toContain(
        "Live reserve metadata lacks redeemable-capacity amount; using configured fallback USD capacity",
      );
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
      immediateCapacityUsd: 0,
      immediateCapacityRatio: 0,
      scoringCapacityUsd: 0,
      scoringCapacityRatio: 0,
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

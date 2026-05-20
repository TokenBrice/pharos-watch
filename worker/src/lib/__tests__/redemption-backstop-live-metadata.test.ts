import { describe, expect, it } from "vitest";
import { readRedemptionBackstopLiveMetadata } from "../redemption-backstop-live-metadata";
import type { ReserveSnapshotMetadataRecord } from "../live-reserves-store";

const now = 1_780_000_000;

function snapshot(
  stablecoinId: string,
  metadata: Record<string, unknown>,
): ReserveSnapshotMetadataRecord {
  return {
    stablecoinId,
    fetchedAt: now - 60,
    source: "unit-test",
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    syncStatus: "ok",
    warningCount: 0,
    warnings: [],
    metadata,
  };
}

describe("readRedemptionBackstopLiveMetadata", () => {
  it.each(["2026-02-30", "2026-13-01", "20260512", "May 12, 2026"])(
    "drops invalid routeStatusReviewedAt value %s",
    (routeStatusReviewedAt) => {
      const metadata = readRedemptionBackstopLiveMetadata(
        "lusd-liquity",
        snapshot("lusd-liquity", {
          freshnessMode: "not-applicable",
          redemption: {
            capacityUsd: 1_000_000,
            capacityKind: "live-direct-bounded",
            freshnessKind: "same-run-onchain",
            routeStatus: "open",
            routeStatusSource: "onchain",
            routeStatusReviewedAt,
          },
        }),
        now,
      );

      expect(metadata.routeStatus).toBe("open");
      expect(metadata.routeStatusSource).toBe("onchain");
      expect(metadata.routeStatusReviewedAt).toBeNull();
    },
  );

  it("deduplicates valid sourceUrls and drops invalid or unsupported URLs", () => {
    const metadata = readRedemptionBackstopLiveMetadata(
      "lusd-liquity",
      snapshot("lusd-liquity", {
        freshnessMode: "not-applicable",
        redemption: {
          capacityUsd: 1_000_000,
          capacityKind: "live-direct-bounded",
          freshnessKind: "same-run-onchain",
          sourceUrls: [
            "https://example.com/redeem",
            "https://example.com/redeem",
            "not-a-url",
            "ftp://example.com/redeem",
            "http://example.com/status",
          ],
        },
      }),
      now,
    );

    expect(metadata.sourceUrls).toEqual([
      "https://example.com/redeem",
      "http://example.com/status",
    ]);
  });

  it("drops negative optional redemption constraints", () => {
    const metadata = readRedemptionBackstopLiveMetadata(
      "lusd-liquity",
      snapshot("lusd-liquity", {
        freshnessMode: "not-applicable",
        redemption: {
          capacityUsd: 1_000_000,
          capacityKind: "live-direct-bounded",
          freshnessKind: "same-run-onchain",
          dailyLimitUsd: -1,
          minRedeemUsd: "-2",
          settlementDelaySec: -3,
          queueDepthUsd: "-4",
        },
      }),
      now,
    );

    expect(metadata.dailyLimitUsd).toBeNull();
    expect(metadata.minRedeemUsd).toBeNull();
    expect(metadata.settlementDelaySec).toBeNull();
    expect(metadata.queueDepthUsd).toBeNull();
  });

  it("treats display-only capacityKind as unusable for scoring capacity", () => {
    const metadata = readRedemptionBackstopLiveMetadata(
      "lusd-liquity",
      snapshot("lusd-liquity", {
        freshnessMode: "not-applicable",
        redemption: {
          capacityUsd: 1_000_000,
          capacityKind: "documented-eventual",
          freshnessKind: "same-run-onchain",
        },
      }),
      now,
    );

    expect(metadata.capacityKind).toBe("documented-eventual");
    expect(metadata.immediateRedeemableUsd).toBe(1_000_000);
    expect(metadata.canUseCapacity).toBe(false);
    expect(metadata.capacityReason).toBe(
      "Live redemption capacity kind documented-eventual is display-only for scoring",
    );
  });

  it("allows unverified freshness for route-approved stablecoins", () => {
    const metadata = readRedemptionBackstopLiveMetadata(
      "frxusd-frax",
      snapshot("frxusd-frax", {
        freshnessMode: "unverified",
        redemption: {
          capacityUsd: 1_000_000,
          capacityKind: "live-proxy-validated",
          freshnessKind: "unverified",
        },
      }),
      now,
    );

    expect(metadata.freshnessKind).toBe("unverified");
    expect(metadata.hasScoringEligibleFreshness).toBe(false);
    expect(metadata.capacityConfidence).toBe("live-proxy");
    expect(metadata.canUseCapacity).toBe(true);
    expect(metadata.capacityReason).toBeNull();
  });

  it("denies unverified freshness when the route lacks explicit approval", () => {
    const metadata = readRedemptionBackstopLiveMetadata(
      "lusd-liquity",
      snapshot("lusd-liquity", {
        freshnessMode: "unverified",
        redemption: {
          capacityUsd: 1_000_000,
          capacityKind: "live-direct-bounded",
          freshnessKind: "unverified",
        },
      }),
      now,
    );

    expect(metadata.freshnessKind).toBe("unverified");
    expect(metadata.hasScoringEligibleFreshness).toBe(false);
    expect(metadata.capacityConfidence).toBe("live-direct");
    expect(metadata.canUseCapacity).toBe(false);
    expect(metadata.capacityReason).toBe(
      "Live redemption capacity has unverified freshness; route-specific approval required",
    );
  });
});

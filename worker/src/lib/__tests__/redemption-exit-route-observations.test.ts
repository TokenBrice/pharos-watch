import { describe, expect, it } from "vitest";
import type { RedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import type { RedemptionCapacityProfile } from "@shared/types/redemption";
import { buildRedemptionExitRouteObservation } from "../redemption-exit-route-observations";

const config: RedemptionBackstopConfig = {
  routeFamily: "offchain-issuer",
  accessModel: "issuer-api",
  settlementModel: "immediate",
  executionModel: "rules-based-nav",
  outputAssetType: "nav",
  capacityModel: { kind: "fixed-usd", amountUsd: 10_000_000, confidence: "documented-bound" },
  costModel: { kind: "fee-bps", feeBps: 25 },
  docs: [{ label: "Terms", url: "https://example.com/terms", supports: ["capacity", "fees", "settlement"] }],
  reviewedAt: "2026-07-01",
};

const profile: RedemptionCapacityProfile = {
  scoringUsd: 10_000_000,
  scoringHorizon: "immediate",
  capacityProfileConfidence: "documented-bound",
  modeledExitSizeUsd: 5_000_000,
};

function build(overrides: Partial<Parameters<typeof buildRedemptionExitRouteObservation>[0]> = {}) {
  return buildRedemptionExitRouteObservation({
    stablecoinId: "usdc-circle",
    config,
    capacityProfile: profile,
    scoringCapacityUsd: 10_000_000,
    supplyUsd: 100_000_000,
    routeStatus: "open",
    resolutionState: "resolved",
    sourceMode: "static",
    capacityConfidence: "documented-bound",
    resolvedFeeBps: 25,
    now: Date.UTC(2026, 6, 13) / 1_000,
    ...overrides,
  });
}

describe("redemption same-notional route observations", () => {
  it("publishes a reviewed immediate route at the common request", () => {
    const observation = build();
    expect(observation).toMatchObject({
      routeId: "redemption:usdc-circle:offchain-issuer",
      routeFamily: "issuer-redemption",
      requestedNotionalUsd: 5_000_000,
      settlementHorizonSec: 300,
      maxCostBps: 200,
      executableUsd: 5_000_000,
      completionRatio: 1,
      output: { kind: "fiat", currency: "USD" },
      evidenceKind: "documented-terms",
      confidence: "medium",
      scoreEligible: true,
    });
    expect(observation?.capacityCurve?.map((point) => point.requestedNotionalUsd)).toEqual([
      100_000, 1_000_000, 5_000_000, 25_000_000,
    ]);
    expect(observation?.capacityCurve?.map((point) => point.executableUsd)).toEqual([
      100_000, 1_000_000, 5_000_000, 10_000_000,
    ]);
  });

  it("retains delayed and over-cost observations without making them score eligible", () => {
    const delayed = build({
      config: { ...config, settlementModel: "same-day" },
      capacityProfile: { ...profile, scoringHorizon: "daily" },
    });
    expect(delayed?.scoreEligible).toBe(false);

    const expensive = build({
      config: { ...config, costModel: { kind: "fee-bps", feeBps: 250 } },
      resolvedFeeBps: 250,
    });
    expect(expensive).toMatchObject({ scoreEligible: false, executableUsd: 0, completionRatio: 0 });
  });

  it("uses fresh direct telemetry as high-confidence route evidence", () => {
    const observedAt = Date.UTC(2026, 6, 13, 10) / 1_000;
    const observation = build({
      sourceMode: "dynamic",
      capacityConfidence: "live-direct",
      capacityKind: "live-direct-bounded",
      freshnessKind: "same-run-onchain",
      sourceTimestamp: observedAt,
      now: observedAt + 60,
    });
    expect(observation).toMatchObject({
      evidenceKind: "onchain-contract-state",
      confidence: "high",
      observedAt,
      freshnessSeconds: 60,
      scoreEligible: true,
    });
  });

  it("returns no observation when the immediate capacity request is undefined", () => {
    expect(build({ capacityProfile: undefined })).toBeNull();
    expect(build({ scoringCapacityUsd: null })).toBeNull();
  });
});

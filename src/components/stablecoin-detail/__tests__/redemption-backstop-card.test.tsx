import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RedemptionBackstopCard } from "../redemption-backstop-card";
import type { RedemptionBackstopEntry } from "@shared/types";

const BASE_ENTRY: RedemptionBackstopEntry = {
  stablecoinId: "eurc-circle",
  score: 65,
  dexLiquidityScore: 44,
  accessScore: 40,
  settlementScore: 65,
  executionCertaintyScore: 60,
  capacityScore: 100,
  outputAssetQualityScore: 100,
  costScore: 40,
  routeFamily: "offchain-issuer",
  accessModel: "issuer-api",
  settlementModel: "same-day",
  executionModel: "rules-based-nav",
  outputAssetType: "stable-single",
  provider: "supply-full-model",
  sourceMode: "estimated",
  resolutionState: "resolved",
  routeStatus: "open",
  routeStatusSource: "static-config",
  holderEligibility: "verified-customer",
  capacityConfidence: "heuristic",
  capacitySemantics: "eventual-only",
  feeConfidence: "undisclosed-reviewed",
  feeModelKind: "undisclosed-reviewed",
  modelConfidence: "low",
  immediateCapacityUsd: null,
  immediateCapacityRatio: null,
  feeBps: null,
  feeDescription: undefined,
  queueEnabled: false,
  methodologyVersion: "1.1",
  updatedAt: 1_700_000_000,
  capsApplied: [],
};

describe("RedemptionBackstopCard", () => {
  it("presents one standalone route score without the legacy effective exit score", () => {
    const html = renderToStaticMarkup(<RedemptionBackstopCard entry={BASE_ENTRY} />);

    expect(html).toContain("Issuer redemption route");
    expect(html).toContain("Standalone route score");
    expect(html).toContain("65/100");
    expect(html).not.toContain("58/100");
  });

  it("renders explicit fixed-fee copy when fee bps are available", () => {
    const html = renderToStaticMarkup(
      <RedemptionBackstopCard
        entry={{
          ...BASE_ENTRY,
          stablecoinId: "avusd-avant",
          routeFamily: "queue-redeem",
          settlementModel: "days",
          feeBps: 5,
          feeDescription: "Protocol docs list a 5 bps redemption fee",
          costScore: 100,
        }}
      />,
    );

    expect(html).toContain("Redemption Fee");
    expect(html).toContain("5 bps (0.05%)");
  });

  it("renders documented variable fee logic when the route is not a single fixed bps value", () => {
    const html = renderToStaticMarkup(
      <RedemptionBackstopCard
        entry={{
          ...BASE_ENTRY,
          stablecoinId: "bold-liquity",
          routeFamily: "collateral-redeem",
          settlementModel: "atomic",
          feeModelKind: "formula",
          feeDescription: "Minimum 50 bps + baseRate (decays over time).",
        }}
      />,
    );

    expect(html).toContain("Redemption Fee");
    expect(html).toContain("Minimum 50 bps + baseRate");
    expect(html).toContain("publish a fee formula");
  });

  it("renders an explicit unknown-fee fallback when no fixed fee is modeled", () => {
    const html = renderToStaticMarkup(<RedemptionBackstopCard entry={BASE_ENTRY} />);

    expect(html).toContain("Redemption Fee");
    expect(html).toContain("Reviewed, but not published");
    expect(html).toContain("do not publish a bounded numeric redemption fee");
  });

  it("renders eventual-only capacity without pretending it is immediate", () => {
    const html = renderToStaticMarkup(<RedemptionBackstopCard entry={BASE_ENTRY} />);

    expect(html).toContain("Eventual Redeemability");
    expect(html).toContain("Not separately quantified");
    expect(html).toContain("eventual redeemability");
  });

  it("renders v4 capacity horizon, exit correlation, cost scenarios, and confidence detail", () => {
    const html = renderToStaticMarkup(
      <RedemptionBackstopCard
        entry={{
          ...BASE_ENTRY,
          capacitySemantics: "immediate-bounded",
          capacityConfidence: "live-direct",
          immediateCapacityUsd: 4_000_000,
          immediateCapacityRatio: 0.08,
          routeExitCorrelation: "independent-issuer-rail",
          eventualRedeemabilityScore: 82,
          capacityProfile: {
            immediateUsd: 4_000_000,
            dailyLimitUsd: 1_500_000,
            queuedUsd: 12_000_000,
            eventualUsd: 20_000_000,
            scoringUsd: 1_500_000,
            scoringHorizon: "daily",
            capacityProfileConfidence: "live-direct",
            modeledExitSizeUsd: 2_000_000,
          },
          costScenarioScores: {
            retail: 40,
            activeUser: 80,
            institutional: 100,
          },
          confidenceDetails: {
            capacityEvidenceQuality: 90,
            feeEvidenceQuality: 70,
            routeStatusFreshness: 80,
            holderCohortBreadth: 60,
            sourceQuality: 95,
            reviewedDocAgeDays: 12,
            reasons: ["live telemetry reviewed"],
          },
        }}
      />,
    );

    expect(html).toContain("Daily Capacity");
    expect(html).toContain("$1.5M");
    expect(html).toContain("Current modeled capacity is daily-limited");
    expect(html).toMatch(/Exit correlation:\s*<span[^>]*>independent issuer rail</);
    expect(html).toContain("Scoring capacity: $1.5M");
    expect(html).toContain("Eventual capacity: $20.0M");
    expect(html).toContain("Queued capacity: $12.0M");
    expect(html).toContain("Modeled exit: $2.0M");
    expect(html).toContain("Eventual score: 82/100");
    // Retail and institutional cost are distinct scores; swapping them must fail.
    expect(html).toContain("Retail cost: 40/100");
    expect(html).toContain("Active-user cost: 80/100");
    expect(html).toContain("Institutional cost: 100/100");
    expect(html).toContain("Confidence Detail");
    expect(html).toContain("Capacity evidence: 90/100");
    expect(html).toContain("Fee evidence: 70/100");
    expect(html).toContain("Route freshness: 80/100");
    expect(html).toContain("Holder breadth: 60/100");
    expect(html).toContain("Source quality: 95/100");
    expect(html).toContain("Reviewed docs age: 12d");
    expect(html).toContain("live telemetry reviewed");
  });

  it("renders configured-but-unrated state when the route has no usable score", () => {
    const html = renderToStaticMarkup(
      <RedemptionBackstopCard
        entry={{
          ...BASE_ENTRY,
          score: null,
          sourceMode: "static",
          resolutionState: "missing-capacity",
          modelConfidence: "low",
        }}
      />,
    );

    expect(html).toContain("missing capacity");
    expect(html).toContain("Confidence: low");
    expect(html).toContain("configured, but the current snapshot could not resolve enough capacity data");
  });

  it("renders source provenance and support tags for fallback docs", () => {
    const html = renderToStaticMarkup(
      <RedemptionBackstopCard
        entry={{
          ...BASE_ENTRY,
          docs: {
            label: "Reserve feed",
            url: "https://example.com/reserves",
            reviewedAt: "2026-03-30",
            provenance: "proof-of-reserves",
            sources: [
              {
                label: "Reserve feed",
                url: "https://example.com/reserves",
                supports: ["capacity"],
              },
            ],
          },
        }}
      />,
    );

    expect(html).toContain("Reserve feed");
    expect(html).toContain("Supports capacity");
    expect(html).toContain("Reviewed 2026-03-30");
    expect(html).toContain("Fallback proof-of-reserves source");
  });

  it("renders impaired route availability state", () => {
    const html = renderToStaticMarkup(
      <RedemptionBackstopCard
        entry={{
          ...BASE_ENTRY,
          score: null,
          resolutionState: "impaired",
          routeStatus: "degraded",
          routeStatusSource: "market-implied",
          routeStatusReason:
            "Active severe depeg of 8332 bps started 2026-03-22; static redemption route requires current live-open evidence before it can score.",
          routeStatusReviewedAt: "2026-04-14",
          modelConfidence: "low",
        }}
      />,
    );

    expect(html).toContain("NR");
    expect(html).toContain("impaired");
    expect(html).toContain("degraded");
    expect(html).toContain("Active severe depeg");
  });
});

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RedemptionBackstopCard } from "../redemption-backstop-card";
import type { RedemptionBackstopEntry } from "@shared/types";

const BASE_ENTRY: RedemptionBackstopEntry = {
  stablecoinId: "eurc-circle",
  score: 65,
  effectiveExitScore: 58,
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
    expect(html).toContain("Protocol docs list a 5 bps redemption fee");
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

    expect(html).toContain("Immediate Capacity");
    expect(html).toContain("Not separately quantified");
    expect(html).toContain("eventual redeemability");
  });

  it("renders configured-but-unrated state when the route has no usable score", () => {
    const html = renderToStaticMarkup(
      <RedemptionBackstopCard
        entry={{
          ...BASE_ENTRY,
          score: null,
          effectiveExitScore: null,
          sourceMode: "static",
          resolutionState: "missing-capacity",
          modelConfidence: "low",
        }}
      />,
    );

    expect(html).toContain("missing capacity");
    expect(html).toContain("confidence: low");
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
          effectiveExitScore: null,
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

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
  immediateCapacityUsd: 1_000_000,
  immediateCapacityRatio: 1,
  feeBps: null,
  queueEnabled: false,
  methodologyVersion: "1.0",
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
          costScore: 100,
        }}
      />,
    );

    expect(html).toContain("Redemption Fee");
    expect(html).toContain("5 bps (0.05%)");
    expect(html).toContain("fixed bounded redemption fee");
  });

  it("renders an explicit unknown-fee fallback when no fixed fee is modeled", () => {
    const html = renderToStaticMarkup(<RedemptionBackstopCard entry={BASE_ENTRY} />);

    expect(html).toContain("Redemption Fee");
    expect(html).toContain("Variable / not explicitly modeled");
    expect(html).toContain("No fixed fee is configured in the current model");
  });
});

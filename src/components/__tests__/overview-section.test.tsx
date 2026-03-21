import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { ApiFetchError } from "@/lib/api";
import { OverviewSection } from "@/components/stablecoin-detail/overview-section";

describe("OverviewSection", () => {
  it("surfaces live-reserve API failures when falling back to curated reserve metadata", () => {
    const coin = TRACKED_META_BY_ID.get("iusd-infinifi");
    expect(coin).toBeDefined();

    const html = renderToStaticMarkup(
      <OverviewSection
        stablecoinId="iusd-infinifi"
        coin={coin!}
        summary={null}
        reserves={{
          reserves: coin!.reserves ?? [{ name: "Curated fallback", pct: 100, risk: "low" }],
          estimated: false,
          mode: "curated-fallback",
        }}
        reserveFetchError={new ApiFetchError("/api/stablecoin-reserves/iusd-infinifi", 503, null)}
        isNavToken
      />,
    );

    expect(html).toContain("Live reserve feed unavailable");
    expect(html).toContain("Showing curated reserve baseline");
  });

  it("surfaces refresh delays when an existing live snapshot cannot be refreshed", () => {
    const coin = TRACKED_META_BY_ID.get("iusd-infinifi");
    expect(coin).toBeDefined();

    const html = renderToStaticMarkup(
      <OverviewSection
        stablecoinId="iusd-infinifi"
        coin={coin!}
        summary={null}
        reserves={{
          reserves: [{ name: "Live farm", pct: 100, risk: "low" }],
          estimated: false,
          mode: "live",
          liveAt: 1_700_000_000,
          source: "infinifi",
        }}
        reserveFetchError={new TypeError("Failed to fetch")}
        isNavToken
      />,
    );

    expect(html).toContain("Live reserve refresh delayed");
    expect(html).toContain("last worker-resolved reserve snapshot");
  });

  it("renders the redemption backstop card when a score is available", () => {
    const coin = TRACKED_META_BY_ID.get("cusd-cap");
    expect(coin).toBeDefined();

    const html = renderToStaticMarkup(
      <OverviewSection
        stablecoinId="cusd-cap"
        coin={coin!}
        summary={null}
        reserves={null}
        reserveFetchError={null}
        redemptionBackstop={{
          stablecoinId: "cusd-cap",
          score: 88,
          effectiveExitScore: 56,
          dexLiquidityScore: 29,
          accessScore: 100,
          settlementScore: 100,
          executionCertaintyScore: 80,
          capacityScore: 100,
          outputAssetQualityScore: 80,
          costScore: 40,
          routeFamily: "basket-redeem",
          accessModel: "permissionless-onchain",
          settlementModel: "atomic",
          executionModel: "deterministic-basket",
          outputAssetType: "stable-basket",
          provider: "supply-full-model",
          sourceMode: "estimated",
          resolutionState: "resolved",
          capacityConfidence: "heuristic",
          feeConfidence: "undisclosed-reviewed",
          modelConfidence: "low",
          immediateCapacityUsd: 10_000_000,
          immediateCapacityRatio: 1,
          feeBps: null,
          queueEnabled: false,
          methodologyVersion: "1.0",
          updatedAt: 1_700_000_000,
          capsApplied: [],
        }}
        isNavToken
      />,
    );

    expect(html).toContain("Redemption Backstop");
    expect(html).toContain("Immediate Capacity");
    expect(html).toContain("10.0M");
  });
});

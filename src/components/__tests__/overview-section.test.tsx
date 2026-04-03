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

  it("renders independent live reserve provenance messaging", () => {
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
          displayBadge: {
            kind: "live",
            label: "Live",
          },
          provenance: {
            evidenceClass: "independent",
            sourceModel: "dynamic-mix",
            freshnessMode: "unverified",
            scoringEligible: false,
          },
        }}
        reserveFetchError={null}
        isNavToken
      />,
    );

    expect(html).toContain("Independent live reserve disclosure");
    expect(html).toContain("freshness is not verified strongly enough for collateral scoring");
    expect(html).toContain(">Live</span>");
  });

  it("renders a Yield Basis share note when live reserve metadata exposes it", () => {
    const coin = TRACKED_META_BY_ID.get("crvusd-curve");
    expect(coin).toBeDefined();

    const html = renderToStaticMarkup(
      <OverviewSection
        stablecoinId="crvusd-curve"
        coin={coin!}
        summary={null}
        reserves={{
          reserves: [{ name: "Custodied BTC (ex: wBTC/cbBTC)", pct: 67, risk: "medium" }],
          estimated: false,
          mode: "live",
          liveAt: 1_700_000_000,
          source: "crvusd",
          displayBadge: {
            kind: "live",
            label: "Live",
          },
          metadata: {
            yieldBasisCollateralPct: 89.7,
          },
        }}
        reserveFetchError={null}
        isNavToken
      />,
    );

    expect(html).toContain("Yield Basis positions account for 89.7% of this live reserve mix.");
  });

  it("renders static-validated reserve provenance messaging", () => {
    const coin = TRACKED_META_BY_ID.get("frax-frax");
    expect(coin).toBeDefined();

    const html = renderToStaticMarkup(
      <OverviewSection
        stablecoinId="frax-frax"
        coin={coin!}
        summary={null}
        reserves={{
          reserves: [{ name: "Reviewed baseline", pct: 100, risk: "very-low" }],
          estimated: false,
          mode: "live",
          liveAt: 1_700_000_000,
          source: "frax",
          displayBadge: {
            kind: "curated-validated",
            label: "Curated-Validated",
          },
          provenance: {
            evidenceClass: "static-validated",
            sourceModel: "validated-static",
            scoringEligible: false,
          },
        }}
        reserveFetchError={null}
        isNavToken
      />,
    );

    expect(html).toContain("Curated-validated reserve baseline");
    expect(html).toContain("Curated-Validated");
  });

  it("renders weak-probe reserve provenance messaging", () => {
    const coin = TRACKED_META_BY_ID.get("pyusd-paypal");
    expect(coin).toBeDefined();

    const html = renderToStaticMarkup(
      <OverviewSection
        stablecoinId="pyusd-paypal"
        coin={coin!}
        summary={null}
        reserves={{
          reserves: [{ name: "Issuer reserves", pct: 100, risk: "very-low" }],
          estimated: false,
          mode: "live",
          liveAt: 1_700_000_000,
          source: "single-asset",
          displayBadge: {
            kind: "proof",
            label: "Proof",
          },
          provenance: {
            evidenceClass: "weak-live-probe",
            sourceModel: "single-bucket",
            scoringEligible: false,
          },
        }}
        reserveFetchError={null}
        isNavToken
      />,
    );

    expect(html).toContain("Proof-based reserve view");
    expect(html).toContain("Proof");
  });

  it("renders a live badge for live-fed static-validated sources without calling them curated-validated", () => {
    const coin = TRACKED_META_BY_ID.get("usdd-tron-dao-reserve");
    expect(coin).toBeDefined();

    const html = renderToStaticMarkup(
      <OverviewSection
        stablecoinId="usdd-tron-dao-reserve"
        coin={coin!}
        summary={null}
        reserves={{
          reserves: [{ name: "Tracked vaults", pct: 100, risk: "medium" }],
          estimated: false,
          mode: "live",
          liveAt: 1_700_000_000,
          source: "usdd-data-platform",
          displayBadge: {
            kind: "live",
            label: "Live",
          },
          provenance: {
            evidenceClass: "static-validated",
            sourceModel: "dynamic-mix",
            scoringEligible: false,
          },
        }}
        reserveFetchError={null}
        isNavToken
      />,
    );

    expect(html).toContain("Live reserve disclosure");
    expect(html).toContain(">Live</span>");
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
          provider: "supply-ratio-model",
          sourceMode: "estimated",
          resolutionState: "resolved",
          capacityConfidence: "documented-bound",
          capacitySemantics: "immediate-bounded",
          feeConfidence: "undisclosed-reviewed",
          feeModelKind: "documented-variable",
          modelConfidence: "medium",
          immediateCapacityUsd: 10_000_000,
          immediateCapacityRatio: 0.5,
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

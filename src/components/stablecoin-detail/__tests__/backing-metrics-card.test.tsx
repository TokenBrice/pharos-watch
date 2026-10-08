// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import mechanismReviewOverlays from "@shared/data/safety-score-v9/mechanism-review-overlays-v1.json";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
import {
  BackingMetricsCard,
  buildBackingMetricsView,
  formatBackingMetric,
  resolveLiveRatioBasis,
  type BackingMetricsInput,
  type BackingMetricsOracleInput,
} from "../backing-metrics-card";
import { StablecoinDetailIdentityProvider } from "../module-title";
import { RAIL_METRIC_MAX_SUB_METRICS } from "../rail-card";
import { buildMechanismBackingView, type MechanismBackingView } from "@/lib/mechanism-backing";
import type { MechanismCollateralizationView } from "@/lib/mechanism-collateralization";
import * as overlayLookup from "@/lib/mechanism-overlay.server";

const reviewed: MechanismCollateralizationView = {
  ratio: 2.455,
  notApplicableRationale: null,
  liquidationCapacityRatio: 0.658,
  reviewedAt: "2026-07-15",
  sourceLabel: "Liquity V2 protocol stats API",
  sourceUrl: "https://example.com/stats",
};

const synthetic: MechanismBackingView = {
  archetype: "synthetic-delta-neutral",
  reviewedAt: "2026-07-20",
  sourceLabel: "Ethena transparency dashboard",
  sourceUrl: "https://example.com/transparency",
  metrics: [
    { key: "hedgeCoverageRatio", label: "Hedge coverage", value: 100, unit: "percent", hint: "Hedged share." },
    { key: "marginBufferPct", label: "Margin buffer", value: 0.104755, unit: "percent", hint: "Margin above maintenance." },
    { key: "lossAbsorptionShare", label: "Loss absorption", value: 1.5493, unit: "percent", hint: "Reserve fund over supply." },
  ],
  protocolFacts: [{ key: "collateralizationVsTotalVatDebt", label: "Collateralization vs total VAT debt", value: "104.2%" }],
  notes: [],
};

const factsOnly: MechanismBackingView = { ...synthetic, archetype: "cdp", metrics: [] };

const gapsOnly: MechanismBackingView = {
  ...synthetic,
  archetype: "fiat-cash",
  metrics: [],
  protocolFacts: [],
  notes: [{ key: "component:custody", label: "Custody", state: "unavailable", rationale: "Not published.", sourceUrl: null }],
};

const notApplicableRatio: MechanismCollateralizationView = {
  ...reviewed,
  ratio: null,
  liquidationCapacityRatio: null,
  notApplicableRationale: "GHO facilitators mint against shared lending markets, so no GHO-only ratio exists.",
};

const reviewedOracle: BackingMetricsOracleInput = {
  reviewedAt: "2026-08-01",
  worstMinCrPct: 110,
  branches: [{ collateralParameters: [{ minCrPct: 110, shutdownCrPct: 150 }] }],
};

function build(input: Partial<BackingMetricsInput>) {
  return buildBackingMetricsView({ collateralization: null, backing: null, ...input });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("buildBackingMetricsView", () => {
  it("labels native CAD amounts and nominal coverage without implying USD", () => {
    const metadata = {
      nativeQuantityBasis: {
        reserveUnit: { kind: "currency" as const, unit: "CAD" },
        supplyToken: "QCAD", nominalValuePerToken: 1,
        reviewedAt: "2026-07-22", evidenceRef: "https://stablecorp.ca/transparency",
      },
      totalReserveQuantity: 105, supplyTokens: 100,
    };
    const view = build({ liveRatio: 1.05, liveRatioBasis: resolveLiveRatioBasis(metadata), liveMetadata: metadata });
    expect(view?.headline.basis).toBe("CAD-native vs QCAD (nominal)");
    expect(view?.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "native-reserves", value: "105 CAD" }),
      expect.objectContaining({ key: "native-supply", value: "100 QCAD" }),
    ]));
    expect(view?.details.some((row) => row.value.includes("$"))).toBe(false);
  });

  it("preserves the released MYRC report clock without requiring top-level native quantities", () => {
    const metadata = {
      details: { assurance: {
        unit: "MYR",
        reportAsOf: "2026-08-31T23:59:00+08:00",
        computedAssetTotal: "1800903.77",
        computedLiabilityTotal: "1800903.74",
        reportedAssetDifference: "0.03",
      } },
    };
    const view = build({
      liveRatio: 1800903.77 / 1800903.74,
      liveRatioBasis: resolveLiveRatioBasis(metadata),
      liveMetadata: metadata,
    });
    expect(view?.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "assurance-report-asof", value: "2026-08-31T23:59:00+08:00" }),
    ]));
    expect(view?.details.some((row) => ["native-reserves", "native-supply", "native-nominal-basis"].includes(row.key))).toBe(false);
    expect(view?.details.some((row) => row.note?.includes("not USD or independent assurance"))).toBe(false);
    expect(view?.details.some((row) => row.value.includes("$"))).toBe(false);
  });

  it("renders unavailable denominator and original observation clocks without inventing a ratio", () => {
    const view = build({ liveMetadata: {
      ratioUnavailableReason: "not-comparable",
      liabilityScope: { basis: "not-comparable", canonicalChain: "kinesis", reason: "Ethereum is a subset" },
      reserveObservedAt: 1_780_000_000,
      supplyObservedAt: { min: 1_780_000_010, max: 1_780_000_020 }, ratioSkewSec: 20,
    } });
    expect(view?.headline.value).toBe("Unavailable");
    expect(view?.visual).toBeNull();
    expect(view?.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "ratio-unavailable", value: "not-comparable", note: "Ethereum is a subset" }),
      expect.objectContaining({ key: "ratio-observation-clocks", note: expect.stringContaining("maximum skew 20 seconds") }),
    ]));
  });

  it.each([
    { name: "live ratio", input: { liveRatio: 1.2, collateralization: reviewed, backing: synthetic }, source: "live-ratio", value: "120.0%" },
    { name: "reviewed ratio", input: { collateralization: reviewed, backing: synthetic }, source: "reviewed-ratio", value: "245.5%" },
    { name: "leading reviewed metric", input: { backing: synthetic }, source: "metric", value: "100.0%" },
    { name: "first protocol fact", input: { backing: factsOnly }, source: "protocol-fact", value: "104.2%" },
  ] as const)("fills the headline from the $name when it is the best available source", ({ input, source, value }) => {
    const view = build(input);
    expect(view?.headline.source).toBe(source);
    expect(view?.headline.value).toBe(value);
    expect(view?.headline.basis.trim()).not.toBe("");
  });

  it("folds the reviewed ratio and protocol ratios into the details when the live ratio leads", () => {
    const view = build({ liveRatio: 1.183, collateralization: { ...reviewed, ratio: 1.042 }, backing: factsOnly });
    expect(view?.headline.value).toBe("118.3%");
    const folded = view?.details.map((row) => row.value) ?? [];
    expect(folded).toContain("104.2%");
    expect(view?.details.every((row) => row.label.trim() !== "")).toBe(true);
  });

  it("names a different live basis for debt-, liability- and supply-denominated feeds", () => {
    const bases = [
      resolveLiveRatioBasis({ totalDebtUsd: 10 }),
      resolveLiveRatioBasis({ totalLiabilitiesUsd: 10 }),
      resolveLiveRatioBasis({ supplyUsd: 10 }),
      resolveLiveRatioBasis({ balanceSheetScope: "shared-sky-maker", totalLiabilitiesUsd: 10 }),
      resolveLiveRatioBasis(undefined),
    ];
    expect(new Set(bases).size).toBe(bases.length);
    expect(bases.every((basis) => basis.trim() !== "")).toBe(true);
  });

  it("returns null for a gaps-only backing review and for no data at all", () => {
    expect(build({ backing: gapsOnly })).toBeNull();
    expect(build({})).toBeNull();
  });

  it("never leads with a not-applicable ratio: the ruling folds as a gap and the next source leads", () => {
    const view = build({ collateralization: notApplicableRatio, backing: factsOnly });
    expect(view?.headline.source).toBe("protocol-fact");
    expect(view?.headline.value).toBe("104.2%");
    const rulings = view?.gaps.filter((gap) => gap.rationale === notApplicableRatio.notApplicableRationale) ?? [];
    expect(rulings).toHaveLength(1);
    expect(rulings[0]?.state).toBe("not-applicable");
  });

  it("renders no card when a not-applicable ruling is all the review has", () => {
    expect(build({ collateralization: notApplicableRatio })).toBeNull();
    expect(build({ collateralization: notApplicableRatio, backing: gapsOnly })).toBeNull();
  });

  it("reads hedge coverage against par, with a status chip", () => {
    const full = build({ backing: synthetic });
    expect(full?.visual).toMatchObject({ kind: "coverage-ratio", valuePct: 100 });
    expect(full?.coverage?.label.trim()).toBeTruthy();
    expect(full?.coverage?.tone).not.toBe("under");

    const partial = build({ backing: { ...synthetic, metrics: [{ ...synthetic.metrics[0]!, value: 96 }, ...synthetic.metrics.slice(1)] } });
    expect(partial?.coverage?.tone).toBe("under");
    expect(partial?.coverage?.label).not.toBe(full?.coverage?.label);
  });

  it("draws share meters only for shares a 0–100 track can show", () => {
    const view = build({ backing: synthetic, liveLiquidationCapacityRatio: 0.575 });
    const byKey = new Map(view?.subMetrics.map((row) => [row.key, row]));
    expect(byKey.get("liquidationCapacityRatio")?.meterPct).toBe(57.5);
    expect(byKey.get("marginBufferPct")?.meterPct).toBeNull();
    expect(view?.details.some((row) => row.key === "lossAbsorptionShare")).toBe(true);
  });

  it("names a pass-through parent's system and whose reading differs", () => {
    const parentBacking: MechanismBackingView = {
      ...synthetic,
      reviewedAt: "2026-07-21",
      metrics: synthetic.metrics.map((metric) => (metric.key === "marginBufferPct" ? { ...metric, value: 0.0648 } : metric)),
    };
    const view = build({ backing: synthetic, parent: { symbol: "USDe", backing: parentBacking } });
    expect(view?.via).toBe("USDe");
    expect(view?.headline.basis).toContain("via USDe");

    const parentRows = view?.details.filter((row) => row.label.includes("USDe")) ?? [];
    expect(parentRows.map((row) => row.value)).toEqual(["0.06%"]);
    expect(parentRows[0]?.note).toContain(parentBacking.reviewedAt);
    // This coin's own reading stays the one on the summary layer, and its row
    // names both reviews so the gap to the parent's figure is not read as an error.
    const margin = view?.subMetrics.find((row) => row.key === "marginBufferPct");
    expect(margin?.value).toBe("0.10%");
    expect(margin?.hint).toContain(synthetic.reviewedAt);
    expect(margin?.hint).toContain(parentBacking.reviewedAt);
    expect(margin?.hint).toContain("0.06%");
  });

  it("keeps a wrapper's own figures unlabelled when they are not a look-through", () => {
    const parent = { symbol: "USDe", backing: { ...synthetic, archetype: "fiat-cash" as const } };
    expect(build({ backing: synthetic, parent })?.via).toBeNull();
    expect(build({ backing: synthetic, collateralization: reviewed, parent: { symbol: "USDe", backing: null } })?.via).toBeNull();
  });

  it("keeps a valid zero live ratio instead of falling back to the reviewed one", () => {
    const view = build({ liveRatio: 0, collateralization: reviewed });
    expect(view?.headline.source).toBe("live-ratio");
    expect(view?.coverage?.tone).toBe("under");
  });

  it("grades a ratio under par as undercollateralized", () => {
    expect(build({ collateralization: { ...reviewed, ratio: 0.211 } })?.coverage?.tone).toBe("under");
    expect(build({ collateralization: reviewed })?.coverage?.tone).toBe("over");
  });

  it("places the MCR and shutdown markers from the reviewed numeric parameters", () => {
    const view = build({
      collateralization: reviewed,
      oracle: { reviewedAt: "2026-08-01", worstMinCrPct: null, branches: [{ collateralParameters: [{ minCrPct: 120, shutdownCrPct: 150 }] }] },
    });
    expect(view?.visual).toMatchObject({ kind: "coverage-ratio", threshold: { pct: 120 }, shutdown: { pct: 150 } });
  });

  it("draws no shutdown marker when no branch reviews a shutdown ratio", () => {
    const view = build({
      collateralization: reviewed,
      oracle: { ...reviewedOracle, branches: [{ collateralParameters: [{ minCrPct: 110, shutdownCrPct: null }] }] },
    });
    expect(view?.visual).toMatchObject({ kind: "coverage-ratio", threshold: { pct: 110 }, shutdown: null });
  });

  it("scopes the shared Sky/Maker book only to a live headline covering both assets", () => {
    const scope = { liveBalanceSheetScope: "shared-sky-maker" as const, liveSharedBookAssetIds: ["dai-makerdao", "usds-sky"] };
    expect(build({ ...scope, liveRatio: 1.2, collateralization: reviewed })?.sharedBookNote).toBe(true);
    expect(build({ ...scope, liveLiquidationCapacityRatio: 0.5, collateralization: reviewed })?.sharedBookNote).toBe(false);
    expect(build({ liveRatio: 1.2, collateralization: reviewed })?.sharedBookNote).toBe(false);
  });

  it("dates a reviewed headline beside a live backstop and keeps both readings", () => {
    const view = build({ collateralization: reviewed, liveLiquidationCapacityRatio: 0.704, liveAtSec: 1785168827 });
    expect(view?.headline.value).toBe("245.5%");
    expect(view?.subMetrics[0]?.value).toBe("70.4%");
    expect(view?.freshness.live).not.toBeNull();
    expect(view?.freshness.reviewedAt).toBe(reviewed.reviewedAt);
  });

  it("stamps live age from epoch seconds and flags a stale feed without dropping the report date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T12:00:00Z"));
    const aged = build({ liveRatio: 5.17, liveAtSec: Date.parse("2026-07-28T10:00:00Z") / 1000 });
    expect(aged?.freshness.live).toContain("2h ago");
    expect(aged?.freshness.stale).toBe(false);

    const report = build({ liveRatio: 1.00057, liveFreshnessLabel: "Report as of 2026-06-30 · Stale · Checked Sep 5" });
    expect(report?.freshness.stale).toBe(true);
    expect(report?.freshness.live).toContain("2026-06-30");
  });

  it("drops an unavailable source date once a check time dates the live reading", () => {
    const checked = build({ liveRatio: 2.784, liveFreshnessLabel: "Source date unavailable · Checked 2026-10-06 20:19 UTC" });
    expect(checked?.freshness.live).toBe("Checked 2026-10-06 20:19 UTC");
    const unchecked = build({ liveRatio: 2.784, liveFreshnessLabel: "Source date unavailable" });
    expect(unchecked?.freshness.live).toBe("Source date unavailable");
  });

  it("keeps at most two sub-metrics and loses no reviewed metric for every archetype", () => {
    const overlays = mechanismReviewOverlays.overlays as unknown as { metrics: Record<string, unknown> }[];
    const metricKeys = [...new Set(overlays.flatMap((overlay) => Object.keys(overlay.metrics)))];
    for (const archetype of MECHANISM_ARCHETYPE_VALUES) {
      vi.spyOn(overlayLookup, "getMechanismReviewOverlay").mockReturnValue({
        assetId: "controlled",
        archetype,
        reviewedAt: "2026-08-01",
        sources: [{ label: "Reviewed evidence", url: "https://example.com/evidence" }],
        notes: "Controlled review",
        metrics: Object.fromEntries(metricKeys.map((key, index) => [key, 0.11 + index * 0.07])),
        components: {},
      });
      const backing = buildMechanismBackingView("controlled");
      for (const liveRatio of [null, 1.4]) {
        const view = build({ backing, liveRatio, liveLiquidationCapacityRatio: 0.3 });
        expect(view, archetype).not.toBeNull();
        expect(view!.subMetrics.length).toBeLessThanOrEqual(RAIL_METRIC_MAX_SUB_METRICS);
        const { container } = render(<BackingMetricsCard view={view!} />);
        for (const metric of backing?.metrics ?? []) {
          expect(container.textContent, `${archetype}:${metric.key}`).toContain(formatBackingMetric(metric));
        }
        cleanup();
      }
      vi.restoreAllMocks();
    }
  });
});

describe("BackingMetricsCard", () => {
  it("states a not-applicable ratio once, folded with its rationale, never as the headline", () => {
    const rationale = notApplicableRatio.notApplicableRationale!;
    const view = build({
      collateralization: notApplicableRatio,
      backing: {
        ...factsOnly,
        notes: [{ key: "metric:collateralizationRatio", label: "Collateralization ratio", state: "not-applicable", rationale, sourceUrl: null }],
      },
    });
    const { container } = render(<BackingMetricsCard view={view!} />);
    const fold = container.querySelector("details") as HTMLElement;
    expect(screen.getAllByText("Not applicable")).toHaveLength(1);
    expect(within(fold).getByText("Not applicable")).toBeTruthy();
    expect(screen.getAllByText(rationale)).toHaveLength(1);
    expect(screen.getByText("104.2%")).toBeTruthy();
    expect(document.querySelector('[role="img"][data-tone]')).toBeNull();
  });

  it("draws a hedge headline with its chip and par marker, and thin buffers without empty bars", () => {
    const view = build({ backing: synthetic })!;
    const { container } = render(<BackingMetricsCard view={view} />);
    expect(screen.getByText(view.coverage!.label)).toBeTruthy();
    expect(container.querySelector('[data-gauge-marker="par"]')).not.toBeNull();
    expect(screen.getByText("0.10%")).toBeTruthy();
    expect(screen.queryByRole("img", { name: /^Margin buffer/ })).toBeNull();
    expect(screen.queryByRole("img", { name: /^Loss absorption/ })).toBeNull();
  });

  it("uses the module header in flow: coin, title and status chip, with an ISO review date", () => {
    const view = build({ collateralization: reviewed })!;
    render(
      <StablecoinDetailIdentityProvider symbol="BOLD" logoSrc={undefined}>
        <BackingMetricsCard view={view} id="collateralization" />
      </StablecoinDetailIdentityProvider>,
    );
    const section = document.getElementById("collateralization") as HTMLElement;
    expect(within(section).getByRole("heading", { name: view.title })).toBeTruthy();
    expect(within(section).getByText("BOLD")).toBeTruthy();
    expect(within(section).getByText(view.coverage!.label)).toBeTruthy();
    expect(section.textContent).toMatch(/Reviewed \d{4}-\d{2}-\d{2}/);
    cleanup();

    render(
      <StablecoinDetailIdentityProvider symbol="BOLD" logoSrc={undefined}>
        <BackingMetricsCard view={view} anchorTwin />
      </StablecoinDetailIdentityProvider>,
    );
    expect(screen.queryByText("BOLD")).toBeNull();
  });

  it("draws the coverage tone on the gauge for an undercollateralized ratio", () => {
    const view = build({ collateralization: { ...reviewed, ratio: 0.211 } });
    const { container } = render(<BackingMetricsCard view={view!} />);
    expect(container.querySelector('[data-tone="under"]')).not.toBeNull();
  });

  it.each([
    { name: "a dated oracle review", oracle: reviewedOracle, marked: true },
    { name: "an undated oracle review", oracle: { ...reviewedOracle, reviewedAt: null }, marked: false },
    { name: "no oracle review", oracle: null, marked: false },
  ])("marks the MCR only for $name", ({ oracle, marked }) => {
    const view = build({ collateralization: reviewed, oracle });
    const { container } = render(<BackingMetricsCard view={view!} />);
    expect(container.querySelector('[data-gauge-marker="threshold"]') != null).toBe(marked);
  });

  it("keeps the citation in the folded details", () => {
    const { container } = render(<BackingMetricsCard view={build({ collateralization: reviewed })!} />);
    const fold = container.querySelector("details");
    expect(fold?.open).toBe(false);
    expect(within(fold as HTMLElement).getByRole("link", { name: /Liquity V2 protocol stats API/ }).getAttribute("href")).toBe(
      reviewed.sourceUrl,
    );
  });

  it("owns both anchors in flow and stands in for both from the rail", () => {
    const view = build({ collateralization: reviewed })!;
    const { container: inFlow } = render(<BackingMetricsCard view={view} id="collateralization" />);
    expect(inFlow.querySelector("#collateralization")).not.toBeNull();
    expect(inFlow.querySelector("#backing-mechanics")).not.toBeNull();
    expect(inFlow.querySelector("[data-anchor-twin]")).toBeNull();
    cleanup();

    const { container: rail } = render(<BackingMetricsCard view={view} anchorTwin />);
    expect(rail.querySelector("#collateralization, #backing-mechanics")).toBeNull();
    expect(rail.querySelector('[data-anchor-twin="collateralization"]')).not.toBeNull();
    expect(rail.querySelector('[data-anchor-twin="backing-mechanics"]')).not.toBeNull();
  });
});

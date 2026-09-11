import { afterEach, describe, expect, it, vi } from "vitest";
import mechanismReviewOverlays from "@shared/data/safety-score-v9/mechanism-review-overlays-v1.json";
import { buildMechanismBackingView } from "../mechanism-backing";
import * as overlayLookup from "../mechanism-overlay.server";

afterEach(() => vi.restoreAllMocks());

function useOverlay(overrides: Partial<overlayLookup.MechanismOverlayEntry>) {
  vi.spyOn(overlayLookup, "getMechanismReviewOverlay").mockReturnValue({
    assetId: "controlled",
    archetype: "cdp",
    reviewedAt: "2026-08-01",
    sources: [{ label: "Reviewed evidence", url: "https://example.com/evidence" }],
    notes: "Controlled review",
    metrics: {},
    components: {},
    ...overrides,
  });
}

interface OverlayShape {
  assetId: string;
  archetype: string;
  metrics: Record<string, number | null>;
}

const OVERLAYS = mechanismReviewOverlays.overlays as unknown as OverlayShape[];

describe("buildMechanismBackingView", () => {
  it("surfaces the delta-neutral hedge metrics the collateral rail cannot serve", () => {
    const view = buildMechanismBackingView("usde-ethena");
    expect(view).not.toBeNull();
    expect(view?.archetype).toBe("synthetic-delta-neutral");
    expect(view?.metrics.map((metric) => metric.key)).toEqual([
      "hedgeCoverageRatio",
      "marginBufferPct",
      "lossAbsorptionShare",
    ]);
    // Ratios are rescaled to percent; marginBufferPct is authored in percent
    // already and must not be multiplied a second time.
    expect(view?.metrics[0]?.value).toBeCloseTo(100, 6);
    expect(view?.metrics[1]?.value).toBeCloseTo(0.104755, 6);
  });

  it("surfaces RWA credit-fund duration and valuation cadence", () => {
    const view = buildMechanismBackingView("jaaa-janus-henderson-anemoy");
    expect(view?.archetype).toBe("rwa-credit-fund");
    const keys = view?.metrics.map((metric) => metric.key) ?? [];
    expect(keys).toContain("weightedAverageMaturityDays");
    expect(keys).toContain("valuationCadenceDays");
    expect(view?.metrics.find((metric) => metric.key === "valuationCadenceDays")?.unit).toBe("days");
  });

  it("leaves the CDP cohort's metrics to the collateralization rail", () => {
    // A CDP asset with reviewed gaps still renders, but carries no metrics of
    // its own — `CollateralizationCard` owns the ratio and the backstop row.
    expect(buildMechanismBackingView("lusd-liquity")?.metrics).toEqual([]);
    // A CDP asset with no gaps has nothing this card can add, so it stays away.
    expect(buildMechanismBackingView("bold-liquity")).toBeNull();
  });

  it("carries reviewed gaps with their rationale and citation", () => {
    // lusd-liquity rules branchIsolation structurally not applicable.
    const view = buildMechanismBackingView("lusd-liquity");
    const note = view?.notes.find((entry) => entry.key === "component:branchIsolation");
    expect(note?.state).toBe("not-applicable");
    expect(note?.rationale.length).toBeGreaterThan(0);
    expect(note?.sourceUrl).toMatch(/^https:\/\//);
  });

  it("distinguishes an undisclosed metric from a structural ruling", () => {
    const view = buildMechanismBackingView("nbasis-nest");
    const note = view?.notes.find((entry) => entry.key === "metric:marginBufferPct");
    expect(note?.state).toBe("unavailable");
    expect(note?.label).toBe("Margin buffer");
  });

  it("omits internal quality fields while preserving legitimate rationale words", () => {
    useOverlay({
      components: {
        custodyContinuity: { quality: "strong" },
        branchIsolation: {
          applicability: "unavailable",
          rationale: "The venue failed to publish evidence.",
          sourceUrl: "https://example.com/evidence",
        },
      },
    });
    expect(buildMechanismBackingView("controlled")).toEqual({
      archetype: "cdp",
      reviewedAt: "2026-08-01",
      metrics: [],
      protocolFacts: [],
      notes: [{
        key: "component:branchIsolation",
        label: "Branch isolation",
        state: "unavailable",
        rationale: "The venue failed to publish evidence.",
        sourceUrl: "https://example.com/evidence",
      }],
      sourceLabel: "Reviewed evidence",
      sourceUrl: "https://example.com/evidence",
    });
  });

  it("returns null when there is nothing beyond what other modules already show", () => {
    expect(buildMechanismBackingView("not-a-real-coin")).toBeNull();
  });

  it("renders a number for every overlay metric the engine requires", () => {
    // Guards against an archetype gaining a metric key upstream that this view
    // silently drops. Every numeric metric on a served archetype must appear.
    const served = new Set(["synthetic-delta-neutral", "rwa-credit-fund", "algorithmic"]);
    const dropped: string[] = [];
    for (const overlay of OVERLAYS) {
      if (!served.has(overlay.archetype)) continue;
      const view = buildMechanismBackingView(overlay.assetId);
      const rendered = new Set(view?.metrics.map((metric) => metric.key) ?? []);
      for (const [key, value] of Object.entries(overlay.metrics)) {
        if (typeof value === "number" && !rendered.has(key)) dropped.push(`${overlay.assetId}:${key}`);
      }
    }
    expect(dropped).toEqual([]);
  });
});

describe("protocol facts", () => {
  it("reads protocol-specific figures with humanized labels", () => {
    const view = buildMechanismBackingView("reusd-resupply");
    const labels = view?.protocolFacts.map((fact) => fact.label) ?? [];
    expect(labels).toContain("Active pair count");
    expect(labels).toContain("Supply debt divergence");
  });

  it("preserves acronyms and formats signed money, percentages, and distinct ratios", () => {
    useOverlay({
      analogousMetrics: {
        hlAccountValueUsd: -9_700_000,
        usdcNav: 1.025,
        reserveShare: 0.125,
        marginPct: 0.125,
        collateralCoverageRatio: 1.5,
        exchangeRateRatio: 1.25,
      },
    });
    expect(buildMechanismBackingView("controlled")?.protocolFacts).toEqual([
      { key: "hlAccountValueUsd", label: "HL account value", value: "-$9.7M" },
      { key: "usdcNav", label: "USDC NAV", value: "1.025" },
      { key: "reserveShare", label: "Reserve share", value: "12.5%" },
      { key: "marginPct", label: "Margin", value: "0.13%" },
      { key: "collateralCoverageRatio", label: "Collateral coverage ratio", value: "150.0%" },
      { key: "exchangeRateRatio", label: "Exchange rate ratio", value: "1.25" },
    ]);
  });

  it("retains exactly the first six finite protocol facts", () => {
    useOverlay({
      analogousMetrics: {
        firstCount: 1, secondCount: 2, thirdCount: 3, fourthCount: 4,
        fifthCount: 5, sixthCount: 6, seventhCount: 7,
      },
    });
    expect(buildMechanismBackingView("controlled")?.protocolFacts).toEqual([
      { key: "firstCount", label: "First count", value: "1" },
      { key: "secondCount", label: "Second count", value: "2" },
      { key: "thirdCount", label: "Third count", value: "3" },
      { key: "fourthCount", label: "Fourth count", value: "4" },
      { key: "fifthCount", label: "Fifth count", value: "5" },
      { key: "sixthCount", label: "Sixth count", value: "6" },
    ]);
  });
});

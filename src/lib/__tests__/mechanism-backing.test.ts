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
  it("surfaces measured delta-neutral backing while retaining unmeasured hedge and margin gaps", () => {
    const view = buildMechanismBackingView("usde-ethena");
    expect(view).not.toBeNull();
    expect(view?.archetype).toBe("synthetic-delta-neutral");
    expect(view?.metrics.map((metric) => metric.key)).toEqual(["lossAbsorptionShare"]);
    expect(view?.metrics[0]?.value).toBeCloseTo(1.5493, 6);
    for (const key of ["hedgeCoverageRatio", "marginBufferPct"]) {
      expect(view?.notes.find((note) => note.key === `metric:${key}`)).toMatchObject({
        state: "unavailable",
        rationale: expect.any(String),
        sourceUrl: expect.stringMatching(/^https:\/\//),
      });
    }
  });

  it("rescales measured ratios without multiplying authored percentages again", () => {
    useOverlay({
      archetype: "synthetic-delta-neutral",
      metrics: { hedgeCoverageRatio: 1, marginBufferPct: 0.104755, lossAbsorptionShare: 0.015493 },
    });
    const metrics = buildMechanismBackingView("controlled")?.metrics;
    expect(metrics?.find((metric) => metric.key === "hedgeCoverageRatio")?.value).toBeCloseTo(100, 6);
    expect(metrics?.find((metric) => metric.key === "marginBufferPct")?.value).toBeCloseTo(0.104755, 6);
    expect(metrics?.find((metric) => metric.key === "lossAbsorptionShare")?.value).toBeCloseTo(1.5493, 6);
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
    // its own — `BackingMetricsCard` (`backing-metrics-card.tsx`) owns the ratio and the backstop row.
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
    // A gap reads under the same name the measured metric carries elsewhere.
    useOverlay({ archetype: "synthetic-delta-neutral", metrics: { marginBufferPct: 1 } });
    const measured = buildMechanismBackingView("controlled")?.metrics.find((metric) => metric.key === "marginBufferPct");
    expect(measured).toBeDefined();
    expect(note?.label).toBe(measured?.label);
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
  it.each([NaN, Infinity, -Infinity])("does not display an invented zero for invalid protocol facts %s", (value) => {
    useOverlay({ analogousMetrics: { reserveUsd: value, reserveAmount: value, capacityUsd: 0 } });
    const facts = buildMechanismBackingView("controlled")?.protocolFacts ?? [];
    expect(facts).toEqual([{ key: "capacityUsd", label: "Capacity", value: "$0.00" }]);
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

  it("reads capacity-over-supply ratios as percentages", () => {
    useOverlay({
      analogousMetrics: {
        facilitatorUnusedCapacityRatio: 0.447412,
        directSwappableGsmCapacityRatio: 0.09975,
      },
    });
    expect(buildMechanismBackingView("controlled")?.protocolFacts.map((fact) => fact.value)).toEqual(["44.7%", "10.0%"]);
  });
});

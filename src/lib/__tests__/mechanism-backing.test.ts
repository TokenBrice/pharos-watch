import { describe, expect, it } from "vitest";
import mechanismReviewOverlays from "@shared/data/safety-score-v9/mechanism-review-overlays-v1.json";
import { buildMechanismBackingView } from "../mechanism-backing";

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

  it("does not expose per-dimension quality ratings", () => {
    // Owner decision 2026-07-28: the 5-level quality scale stays internal. The
    // rationale behind a gap is not part of that ruling; the rating word is.
    for (const assetId of ["usde-ethena", "bold-liquity", "usdc-circle", "lusd-liquity"]) {
      const serialized = JSON.stringify(buildMechanismBackingView(assetId));
      expect(serialized).not.toMatch(/"quality"|strong|adequate|limited|weak|failed/);
    }
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

  it("keeps tickers and acronyms upper-case through humanization", () => {
    const withAcronyms = OVERLAYS.filter((overlay) =>
      Object.keys((overlay as unknown as { analogousMetrics?: Record<string, number> }).analogousMetrics ?? {})
        .some((key) => /Usd$|Usdc|Nav|Hl[A-Z]/.test(key)));
    expect(withAcronyms.length).toBeGreaterThan(0);
    for (const overlay of withAcronyms) {
      for (const fact of buildMechanismBackingView(overlay.assetId)?.protocolFacts ?? []) {
        // "Hl account value usd" is the failure this guards.
        expect(fact.label).not.toMatch(/\busd\b|\bnav\b|\bhl\b/);
      }
    }
  });

  it("formats by key suffix rather than raw number dumping", () => {
    const facts = buildMechanismBackingView("mkusd-prisma")?.protocolFacts
      ?? buildMechanismBackingView("dai-makerdao")?.protocolFacts
      ?? [];
    for (const fact of facts) {
      expect(fact.value).not.toMatch(/\d{7,}|\.\d{5,}/);
    }
  });

  it("truncates a long tail rather than overflowing the rail column", () => {
    for (const overlay of OVERLAYS) {
      expect((buildMechanismBackingView(overlay.assetId)?.protocolFacts ?? []).length).toBeLessThanOrEqual(6);
    }
  });
});

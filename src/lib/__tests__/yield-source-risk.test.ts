import { describe, expect, it } from "vitest";
import {
  classifyYieldSourcePosture,
  classifyYieldSourceDepth,
  formatYieldSourceRiskSummary,
  formatYieldSourceRiskCompact,
  formatYieldSourcePosture,
  formatYieldSourcePostureCountSummary,
  formatYieldSourceRiskDriverSummary,
  getYieldSourceDepthDisplay,
  getYieldSourceRiskDrivers,
  isNativeYieldSource,
  isYieldSourcePostureScoringWindowOnly,
  isYieldSourceRiskMaterial,
  projectYieldSourceDisplayDrivers,
} from "@/lib/yield-source-risk";
import {
  classifyYieldSourceAgeContext,
  getYieldSourceFreshnessDisplay,
} from "@/lib/yield-source-presentation";
import {
  buildSourceRiskGoldenFixture,
} from "@shared/test-utils/yield-source-risk-golden-fixtures";

describe("yield source risk UI helpers", () => {
  it("classifies source posture from source-risk, warnings, and provenance evidence", () => {
    expect(classifyYieldSourcePosture({
      sourceRisk: {
        sourceRiskPenalty: 1.05,
        sourceDepthRatio: 0.005,
        sourceAgeSeconds: 60,
        venueRiskTier: "low",
      },
      sourceTvlUsd: 10_000_000,
    })).toBe("clean");

    expect(classifyYieldSourcePosture({
      sourceRisk: {
        sourceRiskPenalty: 1.15,
        sourceDepthRatio: 0.005,
        sourceAgeSeconds: 60,
        venueRiskTier: "unknown",
      },
      sourceTvlUsd: 10_000_000,
    })).toBe("watch");

    expect(classifyYieldSourcePosture({
      sourceRisk: {
        sourceRiskPenalty: 1,
        sourceDepthRatio: 0.005,
        sourceAgeSeconds: 60,
        venueRiskTier: "high",
      },
      sourceTvlUsd: 10_000_000,
    })).toBe("speculative");

    expect(classifyYieldSourcePosture({
      sourceRisk: {
        sourceRiskPenalty: 1,
        sourceDepthRatio: 0.005,
        sourceAgeSeconds: 60,
        venueRiskTier: "unknown",
      },
      sourceTvlUsd: 10_000_000,
      sourceChanged: true,
    })).toBe("watch");
  });

  it("uses source warning signals as posture drivers without treating unknown venue tier as high risk", () => {
    expect(classifyYieldSourcePosture({
      sourceRisk: { venueRiskTier: "unknown", sourceRiskPenalty: 1, sourceDepthRatio: 0.005, sourceAgeSeconds: 60 },
      sourceTvlUsd: 10_000_000,
      warningSignals: [],
    })).toBe("watch");

    expect(classifyYieldSourcePosture({
      sourceRisk: { venueRiskTier: "unknown", sourceRiskPenalty: 1, sourceDepthRatio: 0.005, sourceAgeSeconds: 60 },
      sourceTvlUsd: 10_000_000,
      warningSignals: ["reward-heavy"],
    })).toBe("speculative");

    expect(getYieldSourceRiskDrivers({
      sourceRisk: { venueRiskTier: "unknown" },
      warningSignals: ["data-stale"],
    }).map((driver) => driver.key)).toEqual(["stale-source"]);
  });

  it("formats material source-risk summaries for compact row cells", () => {
    expect(formatYieldSourceRiskSummary({ sourceRiskScore: 42, sourceRiskPenalty: 1.32 })).toBe(
      "Source risk 42/100 | 1.32x",
    );
    expect(formatYieldSourceRiskSummary({ sourceRiskScore: 2, sourceRiskPenalty: 1.01 })).toBeNull();
  });

  it.each([
    { sourceRisk: null, material: false },
    { sourceRisk: { sourceRiskScore: 9, sourceRiskPenalty: null }, material: false },
    { sourceRisk: { sourceRiskScore: 10, sourceRiskPenalty: null }, material: true },
    { sourceRisk: { sourceRiskScore: 42 }, material: true },
    { sourceRisk: { sourceRiskScore: 99, sourceRiskPenalty: 1.05 }, material: false },
    { sourceRisk: { sourceRiskScore: 2, sourceRiskPenalty: 1.06 }, material: true },
    { sourceRisk: { sourceRiskScore: 42, sourceRiskPenalty: Number.NaN }, material: true },
    { sourceRisk: { sourceRiskScore: Number.NaN }, material: false },
  ])("shares penalty-first materiality with summary visibility: $sourceRisk", ({ sourceRisk, material }) => {
    expect(isYieldSourceRiskMaterial(sourceRisk)).toBe(material);
    expect(formatYieldSourceRiskSummary(sourceRisk) !== null).toBe(material);
  });

  it("does not substitute a neutral scoring multiplier for unobserved display evidence", () => {
    expect(formatYieldSourceRiskSummary({ sourceRiskScore: 42, sourceRiskPenalty: null }))
      .toBe("Source risk 42/100 | n/a");
    expect(formatYieldSourceRiskCompact(null)).toBe("n/a | n/a");
    expect(formatYieldSourceRiskCompact({ sourceRiskPenalty: 1 })).toBe("n/a | 1.00x");
  });

  it("keeps missing source-risk evidence neutral", () => {
    expect(getYieldSourceRiskDrivers({ sourceRisk: null })).toEqual([]);
    expect(getYieldSourceRiskDrivers({ sourceRisk: buildSourceRiskGoldenFixture("missing-safety") })).toEqual([]);
    expect(formatYieldSourceRiskDriverSummary([])).toBe("No source-risk drivers shown.");
  });

  it("classifies source depth only when TVL and supply-relative depth are present", () => {
    expect(classifyYieldSourceDepth({ sourceRisk: { sourceDepthRatio: 0.02 }, sourceTvlUsd: 10_000_000 })).toBe("deep");
    expect(classifyYieldSourceDepth({ sourceRisk: { sourceDepthRatio: 0.005 }, sourceTvlUsd: 10_000_000 })).toBe("moderate");
    expect(classifyYieldSourceDepth({
      sourceRisk: buildSourceRiskGoldenFixture("low-source-depth"),
      sourceTvlUsd: 10_000_000,
    })).toBe("thin");
    expect(classifyYieldSourceDepth({ sourceRisk: { sourceDepthRatio: 0.02 }, sourceTvlUsd: null })).toBe("unknown");
    expect(classifyYieldSourceDepth({ sourceRisk: null, sourceTvlUsd: 10_000_000 })).toBe("unknown");
  });
});

describe("getYieldSourceDepthDisplay", () => {
  it("reads a native row with no venue TVL as not applicable, not unknown", () => {
    const display = getYieldSourceDepthDisplay({
      depthLens: "unknown",
      yieldType: "lending-vault",
      sourceRole: "canonical-holder",
      sourceTvlUsd: null,
    });

    expect(display.lens).toBe("native-unmeasured");
    expect(display.phrase).toBe("Native · depth n/a");
    expect(display.label).toBe("Native");
    expect(display.isNativeUnmeasured).toBe(true);
  });

  it("keeps unknown depth for an external opportunity with no venue TVL", () => {
    const display = getYieldSourceDepthDisplay({
      depthLens: "unknown",
      yieldType: "lending-opportunity",
      sourceRole: "external-opportunity",
      sourceTvlUsd: null,
    });

    expect(display.lens).toBe("unknown");
    expect(display.phrase).toBe("Unknown depth");
    expect(display.isNativeUnmeasured).toBe(false);
  });

  it("falls back to the yield-type split when the row omits sourceRole", () => {
    const native = getYieldSourceDepthDisplay({ depthLens: "unknown", yieldType: "rebase", sourceTvlUsd: null });
    const external = getYieldSourceDepthDisplay({ depthLens: "unknown", yieldType: "fixed-yield", sourceTvlUsd: null });

    expect(native.lens).toBe("native-unmeasured");
    expect(external.lens).toBe("unknown");
  });

  it("reports measured depth verbatim, native or not", () => {
    const display = getYieldSourceDepthDisplay({
      depthLens: "deep",
      yieldType: "lending-vault",
      sourceRole: "canonical-holder",
      sourceTvlUsd: 10_000_000,
    });

    expect(display.lens).toBe("deep");
    expect(display.phrase).toBe("Deep depth");
    expect(display.isNativeUnmeasured).toBe(false);
  });

  it("stays unknown for a native row whose venue TVL is measured but ratio is missing", () => {
    const display = getYieldSourceDepthDisplay({
      depthLens: "unknown",
      yieldType: "lending-vault",
      sourceRole: "canonical-holder",
      sourceTvlUsd: 10_000_000,
    });

    expect(display.lens).toBe("unknown");
    expect(display.isNativeUnmeasured).toBe(false);
  });

  it("treats an audit alternate by yield type and every canonical role as native", () => {
    expect(isNativeYieldSource("audit-alternate", "lending-opportunity")).toBe(false);
    expect(isNativeYieldSource("audit-alternate", "lending-vault")).toBe(true);
    expect(isNativeYieldSource("degraded-canonical", "lending-opportunity")).toBe(true);
    expect(isNativeYieldSource("fallback-proxy", "structured-tranche")).toBe(true);
  });
});

describe("classifyYieldSourceAgeContext", () => {
  it("returns null for null or undefined input", () => {
    expect(classifyYieldSourceAgeContext(null)).toBeNull();
    expect(classifyYieldSourceAgeContext(undefined)).toBeNull();
  });

  it("returns within-6h context for 0s", () => {
    const result = classifyYieldSourceAgeContext(0);
    expect(result?.band).toBe("within-6h");
    expect(result?.relativeText).toBe("0s ago");
  });

  it("returns within-6h context at the 6h boundary", () => {
    const result = classifyYieldSourceAgeContext(6 * 60 * 60);
    expect(result?.band).toBe("within-6h");
    expect(result?.relativeText).toBe("6h ago");
  });

  it("returns within-12h context at the 12h boundary", () => {
    const result = classifyYieldSourceAgeContext(12 * 60 * 60);
    expect(result?.band).toBe("within-12h");
    expect(result?.relativeText).toBe("12h ago");
  });

  it("returns within-24h context at the 24h boundary", () => {
    const result = classifyYieldSourceAgeContext(24 * 60 * 60);
    expect(result?.band).toBe("within-24h");
    expect(result?.relativeText).toBe("1d ago");
  });

  it("clamps days formatting at >30d for 31d", () => {
    const result = classifyYieldSourceAgeContext(31 * 24 * 60 * 60);
    expect(result?.band).toBe("over-24h");
    expect(result?.relativeText).toBe(">30d ago");
  });

  it("returns null for NaN", () => {
    expect(classifyYieldSourceAgeContext(Number.NaN)).toBeNull();
  });
});

describe("getYieldSourceFreshnessDisplay", () => {
  const assessedAt = 1_800_000_000;
  const HOUR = 60 * 60;
  // Core `sync-yield-data` sources publish every 2h; the public gate is 12x.
  const core = { dataSource: "defillama", sourceKey: "defillama:pool" };
  const publicBoundarySec = 12 * 2 * HOUR;

  it("labels a scoring-stale 2h observation neutrally below the public gate", () => {
    const result = getYieldSourceFreshnessDisplay({ ...core, sourceAgeSeconds: 2 * HOUR, clock: { assessedAt } });

    expect(result).toMatchObject({ status: "fresh", displayText: "Observed 2h ago", ageContext: { band: "within-6h" } });
    expect(result?.textClassName).not.toContain("state-warn");
    expect(result?.tooltipText).toBe("Source observed 2h ago; age context: observed within 6 hours.");
  });

  it("warns only past 12x the producer cadence (exact boundary inclusive, +1ms stale)", () => {
    const observed = { ...core, sourceAgeSeconds: 0 };
    const at = (offsetMs: number) => getYieldSourceFreshnessDisplay({
      ...observed,
      clock: { assessedAt, nowMs: (assessedAt + publicBoundarySec) * 1000 + offsetMs },
    });
    expect(at(0)?.status).toBe("fresh");
    expect(at(1)).toMatchObject({ status: "stale", displayText: "Stale · 1d ago" });
    expect(at(1)?.textClassName).toContain("state-warn");
  });

  it("prefers the original observation clock and uses each source's own cadence", () => {
    // A daily price-derived source is still neutral at 5 days.
    expect(getYieldSourceFreshnessDisplay({
      dataSource: "price-derived",
      sourceKey: "price-derived:x",
      sourceObservedAt: assessedAt - 5 * 24 * HOUR,
      sourceAgeSeconds: 0,
      clock: { assessedAt },
    })?.displayText).toBe("Observed 5d ago");
  });

  it.each([
    ["missing", { sourceAgeSeconds: null }],
    ["invalid", { sourceAgeSeconds: Number.NaN }],
    ["negative", { sourceAgeSeconds: -5 }],
    ["future", { sourceObservedAt: assessedAt + 60 }],
    ["zero observation clock", { sourceObservedAt: 0 }],
    ["missing identity", { dataSource: null, sourceAgeSeconds: 60 }],
  ])("keeps a %s clock neutral unavailable", (_label, input) => {
    const result = getYieldSourceFreshnessDisplay({ ...core, ...input, clock: { assessedAt } });
    expect(result).toMatchObject({ status: "unknown", displayText: "Unknown", ageContext: null });
    expect(result?.tooltipText).toBe("Source observation age is unavailable.");
  });

  it("treats a zero age as a valid observation", () => {
    expect(getYieldSourceFreshnessDisplay({ ...core, sourceAgeSeconds: 0, clock: { assessedAt } })?.status).toBe("fresh");
  });

  it("ignores published scoring status and data-stale warnings", () => {
    expect(getYieldSourceFreshnessDisplay({ ...core, sourceAgeSeconds: 60, clock: { assessedAt } })?.status).toBe("fresh");
    expect(getYieldSourceFreshnessDisplay({ ...core, clock: { assessedAt } })?.status).toBe("unknown");
  });

  it("projects stale-source drivers and qualifies scoring-only speculative posture", () => {
    const params = { sourceRisk: { sourceDepthRatio: 0.02, venueRiskTier: "low" as const }, sourceTvlUsd: 10_000_000, sourceFreshness: "stale" as const };
    const drivers = getYieldSourceRiskDrivers(params);
    expect(drivers.map((driver) => driver.key)).toEqual(["stale-source"]);
    expect(projectYieldSourceDisplayDrivers(drivers, false)).toEqual([]);
    expect(projectYieldSourceDisplayDrivers([], true).map((driver) => driver.key)).toEqual(["stale-source"]);
    const posture = classifyYieldSourcePosture(params);
    expect(posture).toBe("speculative");
    expect(isYieldSourcePostureScoringWindowOnly(params, posture, false)).toBe(true);
    expect(isYieldSourcePostureScoringWindowOnly(params, posture, true)).toBe(false);
    expect(formatYieldSourcePosture(posture, true)).toBe("Speculative (scoring window)");
    // An independently justified speculative posture keeps its plain label.
    const thin = { ...params, sourceRisk: { sourceDepthRatio: 0.0001, venueRiskTier: "low" as const } };
    expect(isYieldSourcePostureScoringWindowOnly(thin, classifyYieldSourcePosture(thin), false)).toBe(false);
    expect(formatYieldSourcePostureCountSummary(3, 2)).toBe("Speculative: 3 sources, 2 due only to the scoring window.");
  });

  it("uses the authoritative status for stale-source risk drivers", () => {
    expect(getYieldSourceRiskDrivers({
      sourceRisk: { sourceAgeSeconds: 4 * 60 * 60 },
      sourceFreshness: "stale",
    }).map((driver) => driver.key)).toContain("stale-source");
    expect(getYieldSourceRiskDrivers({
      sourceRisk: { sourceAgeSeconds: 30 * 60 * 60 },
      sourceFreshness: "fresh",
    }).map((driver) => driver.key)).not.toContain("stale-source");
  });
});

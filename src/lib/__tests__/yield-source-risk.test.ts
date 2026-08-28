import { describe, expect, it } from "vitest";
import {
  classifyYieldSourcePosture,
  classifyYieldSourceDepth,
  formatYieldSourceRiskSummary,
  formatYieldSourceRiskDriverSummary,
  getYieldSourceDepthDisplay,
  getYieldSourceRiskDrivers,
  isNativeYieldSource,
} from "@/lib/yield-source-risk";
import {
  classifyYieldSourceAgeContext,
  getYieldSourceFreshnessDisplay,
} from "@/lib/yield-source-presentation";
import {
  SOURCE_RISK_GOLDEN_UI_DRIVER_LABELS,
  buildSourceRiskGoldenFixture,
  mergeSourceRiskGoldenFixtures,
} from "@shared/test-utils/yield-source-risk-golden-fixtures";

describe("yield source risk UI helpers", () => {
  it("maps populated source-risk evidence to public driver labels", () => {
    const drivers = getYieldSourceRiskDrivers({
      sourceChanged: true,
      sourceFreshness: "stale",
      sourceRisk: mergeSourceRiskGoldenFixtures([
        "reward-heavy",
        "low-source-depth",
        "stale-source-age",
        "bootstrap-observation-count",
        "source-switch-churn",
      ]),
    });

    expect(drivers.map((driver) => driver.label)).toEqual(SOURCE_RISK_GOLDEN_UI_DRIVER_LABELS);
    expect(formatYieldSourceRiskDriverSummary(drivers)).toContain("reward-heavy");
  });

  it("surfaces venue-risk and dependency-concentration drivers from populated evidence", () => {
    const high = getYieldSourceRiskDrivers({
      sourceRisk: { venueRiskTier: "high", venueRiskWeighted: 4.4 },
    });
    expect(high.map((driver) => driver.key)).toContain("high-risk-venue");
    expect(high[0]?.description).toContain("4.4/5");

    const concentrated = getYieldSourceRiskDrivers({
      sourceRisk: {
        venueRiskTier: "low",
        dependencyConcentration: {
          ecosystem: "Sky",
          severity: "medium",
          note: "Funded debt sits behind Sky governance.",
          reviewedAt: "2026-06-15",
        },
      },
    });
    expect(concentrated.map((driver) => driver.label)).toContain("Sky concentration");

    // Unknown/low venue with no concentration is a no-op.
    expect(getYieldSourceRiskDrivers({ sourceRisk: { venueRiskTier: "unknown" } })).toEqual([]);
  });

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

  it("flags low/partial venue-score confidence without discounting the penalty", () => {
    const low = getYieldSourceRiskDrivers({
      sourceRisk: { venueRiskTier: "high", venueRiskWeighted: 3.7, venueRiskConfidence: "low" },
    });
    expect(low[0]?.label).toContain("low confidence");
    expect(low[0]?.description).toContain("low-confidence");

    const partial = getYieldSourceRiskDrivers({
      sourceRisk: { venueRiskTier: "medium", venueRiskWeighted: 2.8, venueRiskConfidence: "partial" },
    });
    expect(partial[0]?.label).not.toContain("confidence"); // partial isn't shouted in the label
    expect(partial[0]?.description).toContain("partial-confidence");

    const verified = getYieldSourceRiskDrivers({
      sourceRisk: { venueRiskTier: "high", venueRiskWeighted: 4.4, venueRiskConfidence: "verified" },
    });
    expect(verified[0]?.label).toBe("high-risk venue");
    expect(verified[0]?.description).not.toContain("confidence");
  });

  it("keeps missing source-risk evidence neutral", () => {
    expect(getYieldSourceRiskDrivers({ sourceRisk: null })).toEqual([]);
    expect(getYieldSourceRiskDrivers({ sourceRisk: buildSourceRiskGoldenFixture("missing-safety") })).toEqual([]);
    expect(formatYieldSourceRiskDriverSummary([])).toContain("No populated source-risk driver");
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

  it("returns within-6h context for 1h", () => {
    const result = classifyYieldSourceAgeContext(60 * 60);
    expect(result?.band).toBe("within-6h");
    expect(result?.relativeText).toBe("1h ago");
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

  it("returns over-24h context for 7d with days formatting", () => {
    const result = classifyYieldSourceAgeContext(7 * 24 * 60 * 60);
    expect(result?.band).toBe("over-24h");
    expect(result?.relativeText).toBe("7d ago");
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
  it("keeps a 4h observation stale when the published status is stale", () => {
    const result = getYieldSourceFreshnessDisplay({
      sourceAgeSeconds: 4 * 60 * 60,
      sourceFreshness: "stale",
    });

    expect(result).toMatchObject({
      status: "stale",
      displayText: "Stale · 4h ago",
      ageContext: { band: "within-6h" },
    });
    expect(result?.textClassName).toContain("amber");
    expect(result?.tooltipText).toContain("Published source freshness: Stale");
  });

  it("keeps a 30h observation fresh when the published status is fresh", () => {
    const result = getYieldSourceFreshnessDisplay({
      sourceAgeSeconds: 30 * 60 * 60,
      sourceFreshness: "fresh",
    });

    expect(result).toMatchObject({
      status: "fresh",
      displayText: "Fresh · 1d ago",
      ageContext: { band: "over-24h" },
    });
    expect(result?.textClassName).toContain("emerald");
    expect(result?.tooltipText).toContain("age context: observed more than 24 hours ago");
  });

  it("uses data-stale only when published freshness is absent", () => {
    expect(getYieldSourceFreshnessDisplay({
      sourceAgeSeconds: 60,
      warningSignals: ["data-stale"],
    })?.status).toBe("stale");
    expect(getYieldSourceFreshnessDisplay({
      sourceAgeSeconds: 60,
      sourceFreshness: "fresh",
      warningSignals: ["data-stale"],
    })?.status).toBe("fresh");
  });

  it("keeps freshness unknown when only data-freshness-unknown is published", () => {
    const result = getYieldSourceFreshnessDisplay({
      warningSignals: ["data-freshness-unknown"],
    });

    expect(result).toMatchObject({ status: "unknown", displayText: "Unknown", ageContext: null });
    expect(result?.tooltipText).toContain("Source observation age is unavailable");
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

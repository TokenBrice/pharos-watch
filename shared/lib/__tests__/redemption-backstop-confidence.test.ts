import { describe, expect, it } from "vitest";
import {
  deriveModelConfidence,
  deriveModelConfidenceWithDetails,
  inferStoredFeeConfidence,
  inferStoredFeeModelKind,
  resolveCapacityConfidence,
  resolveCapacitySemantics,
  resolveFeeConfidence,
  resolveFeeModelKind,
} from "../redemption-backstop-confidence";

describe("resolveCapacityConfidence", () => {
  it("returns the explicit confidence when set", () => {
    expect(resolveCapacityConfidence({ kind: "supply-full", confidence: "documented-bound" })).toBe("documented-bound");
    expect(resolveCapacityConfidence({ kind: "reserve-sync-metadata", confidence: "documented-bound" })).toBe(
      "documented-bound",
    );
  });

  it("defaults reserve-sync-metadata to dynamic when confidence is unset", () => {
    expect(resolveCapacityConfidence({ kind: "reserve-sync-metadata" })).toBe("dynamic");
  });

  it("defaults non-reserve-sync models to heuristic when confidence is unset", () => {
    expect(resolveCapacityConfidence({ kind: "supply-full" })).toBe("heuristic");
    expect(resolveCapacityConfidence({ kind: "supply-ratio", ratio: 0.05 })).toBe("heuristic");
  });

  it("defaults fixed USD buffers to documented-bound", () => {
    expect(resolveCapacityConfidence({ kind: "fixed-usd", amountUsd: 1_000_000 })).toBe("documented-bound");
  });
});

describe("resolveCapacitySemantics", () => {
  it("returns eventual-only for supply-full", () => {
    expect(resolveCapacitySemantics({ kind: "supply-full" })).toBe("eventual-only");
    expect(
      resolveCapacitySemantics({ kind: "supply-full", confidence: "documented-bound", basis: "full-system-eventual" }),
    ).toBe("eventual-only");
  });

  it("returns immediate-bounded for supply-ratio", () => {
    expect(resolveCapacitySemantics({ kind: "supply-ratio", ratio: 0.1 })).toBe("immediate-bounded");
  });

  it("returns immediate-bounded for reserve-sync-metadata", () => {
    expect(resolveCapacitySemantics({ kind: "reserve-sync-metadata" })).toBe("immediate-bounded");
    expect(resolveCapacitySemantics({ kind: "reserve-sync-metadata", fallbackRatio: 0.2 })).toBe("immediate-bounded");
  });
});

describe("resolveFeeConfidence", () => {
  it("returns fixed for fee-bps models", () => {
    expect(resolveFeeConfidence({ kind: "fee-bps", feeBps: 10, confidence: "fixed" })).toBe("fixed");
  });

  it("defaults fee-bps to fixed when confidence is unset", () => {
    expect(resolveFeeConfidence({ kind: "fee-bps", feeBps: 25 })).toBe("fixed");
  });

  it("returns the explicit confidence for dynamic-or-unclear models", () => {
    expect(resolveFeeConfidence({ kind: "dynamic-or-unclear", confidence: "formula" })).toBe("formula");
  });

  it("defaults dynamic-or-unclear to undisclosed-reviewed when confidence is unset", () => {
    expect(resolveFeeConfidence({ kind: "dynamic-or-unclear" })).toBe("undisclosed-reviewed");
    expect(resolveFeeConfidence({ kind: "dynamic-or-unclear", feeDescription: "base + variable" })).toBe(
      "undisclosed-reviewed",
    );
  });
});

describe("resolveFeeModelKind", () => {
  it("returns fixed-bps for fee-bps models regardless of other fields", () => {
    expect(resolveFeeModelKind({ kind: "fee-bps", feeBps: 0 })).toBe("fixed-bps");
    expect(resolveFeeModelKind({ kind: "fee-bps", feeBps: 100, confidence: "fixed" })).toBe("fixed-bps");
  });

  it("returns the explicit feeModelKind for dynamic-or-unclear when set", () => {
    expect(
      resolveFeeModelKind({
        kind: "dynamic-or-unclear",
        feeModelKind: "documented-variable",
        feeDescription: "desc",
      }),
    ).toBe("documented-variable");
    expect(
      resolveFeeModelKind({
        kind: "dynamic-or-unclear",
        feeModelKind: "formula",
        confidence: "formula",
      }),
    ).toBe("formula");
  });

  it("returns formula for dynamic-or-unclear when confidence is formula and no explicit kind", () => {
    expect(resolveFeeModelKind({ kind: "dynamic-or-unclear", confidence: "formula" })).toBe("formula");
  });

  it("returns documented-variable for dynamic-or-unclear with feeDescription only", () => {
    expect(resolveFeeModelKind({ kind: "dynamic-or-unclear", feeDescription: "min 50 bps + base" })).toBe(
      "documented-variable",
    );
  });

  it("returns undisclosed-reviewed for dynamic-or-unclear with no description and no formula confidence", () => {
    expect(resolveFeeModelKind({ kind: "dynamic-or-unclear" })).toBe("undisclosed-reviewed");
    expect(resolveFeeModelKind({ kind: "dynamic-or-unclear", confidence: "undisclosed-reviewed" })).toBe(
      "undisclosed-reviewed",
    );
  });
});

describe("deriveModelConfidence", () => {
  type ConfidenceArgs = Parameters<typeof deriveModelConfidenceWithDetails>[0];
  const baseResolvedArgs: ConfidenceArgs = {
    resolutionState: "resolved",
    capacityConfidence: "live-direct",
    feeConfidence: "fixed",
    routeStatus: "open",
    routeStatusSource: "onchain",
    holderEligibility: "any-holder",
    sourceMode: "dynamic",
    freshnessKind: "same-run-onchain",
  };
  const detailsFor = (overrides: Partial<ConfidenceArgs> = {}) =>
    deriveModelConfidenceWithDetails({
      ...baseResolvedArgs,
      ...overrides,
    }).confidenceDetails;

  it("returns low when resolution state is not resolved", () => {
    expect(
      deriveModelConfidence({
        resolutionState: "failed",
        capacityConfidence: "live-direct",
        feeConfidence: "fixed",
      }),
    ).toBe("low");
    expect(
      deriveModelConfidence({
        resolutionState: "missing-capacity",
        capacityConfidence: "live-direct",
        feeConfidence: "fixed",
      }),
    ).toBe("low");
    expect(
      deriveModelConfidence({
        resolutionState: "missing-cache",
        capacityConfidence: "live-direct",
        feeConfidence: "fixed",
      }),
    ).toBe("low");
    expect(
      deriveModelConfidence({
        resolutionState: "impaired",
        capacityConfidence: "live-direct",
        feeConfidence: "fixed",
      }),
    ).toBe("low");
  });

  it("returns low when resolved but capacity confidence is heuristic", () => {
    expect(
      deriveModelConfidence({
        resolutionState: "resolved",
        capacityConfidence: "heuristic",
        feeConfidence: "fixed",
      }),
    ).toBe("low");
  });

  it("returns high for resolved live-direct with any disclosed fee confidence", () => {
    expect(
      deriveModelConfidence({
        resolutionState: "resolved",
        capacityConfidence: "live-direct",
        feeConfidence: "fixed",
      }),
    ).toBe("high");
    expect(
      deriveModelConfidence({
        resolutionState: "resolved",
        capacityConfidence: "live-direct",
        feeConfidence: "formula",
      }),
    ).toBe("high");
  });

  it("returns medium for resolved live-direct with undisclosed-reviewed fee", () => {
    expect(
      deriveModelConfidence({
        resolutionState: "resolved",
        capacityConfidence: "live-direct",
        feeConfidence: "undisclosed-reviewed",
      }),
    ).toBe("medium");
  });

  it("returns medium for resolved live-proxy, dynamic, and documented-bound capacity", () => {
    for (const capacityConfidence of ["live-proxy", "dynamic", "documented-bound"] as const) {
      expect(
        deriveModelConfidence({
          resolutionState: "resolved",
          capacityConfidence,
          feeConfidence: "fixed",
        }),
      ).toBe("medium");
    }
  });

  it("keeps stale documented-bound confidence medium when current route-status evidence exists", () => {
    const result = deriveModelConfidenceWithDetails({
      resolutionState: "resolved",
      capacityConfidence: "documented-bound",
      feeConfidence: "formula",
      routeStatus: "open",
      routeStatusSource: "operator-notice",
      holderEligibility: "any-holder",
      sourceMode: "static",
      reviewedAt: "2024-01-01",
      now: 1_780_000_000,
    });

    expect(result.modelConfidence).toBe("medium");
    expect(result.confidenceDetails.reviewedDocAgeDays).toBeGreaterThan(365);
  });

  it("discounts stale documented-bound routes without current route-status evidence to low", () => {
    expect(
      deriveModelConfidenceWithDetails({
        resolutionState: "resolved",
        capacityConfidence: "documented-bound",
        feeConfidence: "formula",
        routeStatus: "open",
        routeStatusSource: "static-config",
        holderEligibility: "any-holder",
        sourceMode: "static",
        reviewedAt: "2024-01-01",
        now: 1_780_000_000,
      }).modelConfidence,
    ).toBe("low");
  });

  it("keeps live-proxy with undisclosed fees below direct high confidence", () => {
    expect(
      deriveModelConfidenceWithDetails({
        resolutionState: "resolved",
        capacityConfidence: "live-proxy",
        feeConfidence: "undisclosed-reviewed",
        routeStatus: "open",
        routeStatusSource: "protocol-api",
        holderEligibility: "any-holder",
        sourceMode: "dynamic",
        freshnessKind: "same-run-api",
      }).modelConfidence,
    ).toBe("medium");
  });

  it("returns medium for unknown route status with documented-bound capacity", () => {
    expect(
      deriveModelConfidenceWithDetails({
        resolutionState: "resolved",
        capacityConfidence: "documented-bound",
        feeConfidence: "fixed",
        routeStatus: "unknown",
        routeStatusSource: "static-config",
        holderEligibility: "any-holder",
        sourceMode: "static",
      }).modelConfidence,
    ).toBe("medium");
  });

  it("keeps unknown route status high-confidence when capacity evidence is live-direct", () => {
    const result = deriveModelConfidenceWithDetails({
      resolutionState: "resolved",
      capacityConfidence: "live-direct",
      feeConfidence: "fixed",
      routeStatus: "unknown",
      routeStatusSource: "static-config",
      holderEligibility: "any-holder",
      sourceMode: "dynamic",
      freshnessKind: "same-run-onchain",
    });

    expect(result.modelConfidence).toBe("high");
    expect(result.confidenceDetails.reasons).not.toContain(
      "Route status is unknown without direct live telemetry or a documented capacity bound",
    );
  });

  it("returns low for unknown route status with live-proxy capacity", () => {
    const result = deriveModelConfidenceWithDetails({
      resolutionState: "resolved",
      capacityConfidence: "live-proxy",
      feeConfidence: "fixed",
      routeStatus: "unknown",
      routeStatusSource: "static-config",
      holderEligibility: "any-holder",
      sourceMode: "dynamic",
      freshnessKind: "same-run-api",
    });

    expect(result.modelConfidence).toBe("low");
    expect(result.confidenceDetails.reasons).toContain(
      "Route status is unknown without direct live telemetry or a documented capacity bound",
    );
  });

  it("rolls up the unknown-route-status capacity-confidence matrix conservatively", () => {
    // Only live-direct telemetry or a source-reviewed documented bound may keep
    // unknown route status above low; live-proxy and heuristic always roll up low.
    const matrix = [
      { capacityConfidence: "live-direct", expected: "high" },
      { capacityConfidence: "live-proxy", expected: "low" },
      { capacityConfidence: "documented-bound", expected: "medium" },
      { capacityConfidence: "heuristic", expected: "low" },
    ] as const;

    for (const { capacityConfidence, expected } of matrix) {
      const result = deriveModelConfidenceWithDetails({
        resolutionState: "resolved",
        capacityConfidence,
        feeConfidence: "fixed",
        routeStatus: "unknown",
        routeStatusSource: "static-config",
        holderEligibility: "any-holder",
        sourceMode: "dynamic",
        freshnessKind: "same-run-onchain",
      });
      expect(result.modelConfidence, `capacityConfidence=${capacityConfidence}`).toBe(expected);
    }
  });

  it("returns low for unknown route status with dynamic capacity", () => {
    expect(
      deriveModelConfidenceWithDetails({
        resolutionState: "resolved",
        capacityConfidence: "dynamic",
        feeConfidence: "fixed",
        routeStatus: "unknown",
        routeStatusSource: "static-config",
        holderEligibility: "any-holder",
        sourceMode: "dynamic",
      }).modelConfidence,
    ).toBe("low");
  });

  it("downgrades issuer-discretionary and unknown holder cohorts to low confidence", () => {
    for (const holderEligibility of ["issuer-discretionary", "unknown"] as const) {
      const result = deriveModelConfidenceWithDetails({
        resolutionState: "resolved",
        capacityConfidence: "live-direct",
        feeConfidence: "fixed",
        routeStatus: "open",
        routeStatusSource: "onchain",
        holderEligibility,
        sourceMode: "dynamic",
        freshnessKind: "same-run-onchain",
      });

      expect(result.modelConfidence).toBe("low");
      expect(result.confidenceDetails.reasons).toContain("Holder eligibility is narrow or unclear");
    }
  });

  it("does not discount future or invalid reviewedAt values as stale documentation", () => {
    const future = deriveModelConfidenceWithDetails({
      resolutionState: "resolved",
      capacityConfidence: "documented-bound",
      feeConfidence: "fixed",
      routeStatus: "open",
      routeStatusSource: "static-config",
      holderEligibility: "any-holder",
      sourceMode: "static",
      reviewedAt: "2027-01-01",
      now: 1_780_000_000,
    });
    const invalid = deriveModelConfidenceWithDetails({
      resolutionState: "resolved",
      capacityConfidence: "documented-bound",
      feeConfidence: "fixed",
      routeStatus: "open",
      routeStatusSource: "static-config",
      holderEligibility: "any-holder",
      sourceMode: "static",
      reviewedAt: "not-a-date",
      now: 1_780_000_000,
    });

    expect(future.modelConfidence).toBe("medium");
    expect(future.confidenceDetails.reviewedDocAgeDays).toBe(0);
    expect(invalid.modelConfidence).toBe("medium");
    expect(invalid.confidenceDetails.reviewedDocAgeDays).toBeNull();
  });

  it("records source-quality detail scores for live freshness and static fallback evidence", () => {
    expect(
      deriveModelConfidenceWithDetails({
        resolutionState: "resolved",
        capacityConfidence: "live-direct",
        feeConfidence: "fixed",
        routeStatus: "open",
        routeStatusSource: "protocol-api",
        holderEligibility: "any-holder",
        sourceMode: "dynamic",
        freshnessKind: "same-run-api",
      }).confidenceDetails.sourceQuality,
    ).toBe(90);
    expect(
      deriveModelConfidenceWithDetails({
        resolutionState: "resolved",
        capacityConfidence: "documented-bound",
        feeConfidence: "fixed",
        routeStatus: "open",
        routeStatusSource: "static-config",
        holderEligibility: "any-holder",
        sourceMode: "static",
      }).confidenceDetails.sourceQuality,
    ).toBe(40);
  });

  it("keeps reviewed-static and unverified freshness on source-mode/default quality fallbacks", () => {
    const withoutSourceMode: ConfidenceArgs = { ...baseResolvedArgs };
    delete withoutSourceMode.sourceMode;
    expect(
      deriveModelConfidenceWithDetails({
        ...baseResolvedArgs,
        sourceMode: "static",
        freshnessKind: "reviewed-static",
      }).confidenceDetails.sourceQuality,
    ).toBe(40);
    expect(
      deriveModelConfidenceWithDetails({
        ...withoutSourceMode,
        freshnessKind: "unverified",
      }).confidenceDetails.sourceQuality,
    ).toBe(50);
  });

  it("pins capacity evidence detail scores", () => {
    const cases = [
      ["live-direct", 100],
      ["live-proxy", 80],
      ["dynamic", 65],
      ["documented-bound", 60],
      ["heuristic", 25],
    ] as const;

    for (const [capacityConfidence, expected] of cases) {
      expect(
        detailsFor({
          capacityConfidence,
          routeStatus: capacityConfidence === "heuristic" ? "open" : "unknown",
        }).capacityEvidenceQuality,
        capacityConfidence,
      ).toBe(expected);
    }
  });

  it("pins fee evidence detail scores", () => {
    const cases = [
      ["fixed", 100],
      ["formula", 80],
      ["undisclosed-reviewed", 45],
    ] as const;

    for (const [feeConfidence, expected] of cases) {
      expect(detailsFor({ feeConfidence }).feeEvidenceQuality, feeConfidence).toBe(expected);
    }
  });

  it("pins route-status freshness detail scores", () => {
    const cases = [
      [{ routeStatus: "open", routeStatusSource: "protocol-api" }, 100],
      [{ routeStatus: "open", routeStatusSource: "static-config" }, 70],
      [{ routeStatus: "unknown", routeStatusSource: "static-config" }, 30],
      [{ routeStatus: "paused", routeStatusSource: "onchain" }, 20],
    ] as const;

    for (const [overrides, expected] of cases) {
      expect(detailsFor(overrides).routeStatusFreshness, JSON.stringify(overrides)).toBe(expected);
    }

    const withoutRouteStatus: ConfidenceArgs = { ...baseResolvedArgs };
    delete withoutRouteStatus.routeStatus;
    delete withoutRouteStatus.routeStatusSource;
    expect(deriveModelConfidenceWithDetails(withoutRouteStatus).confidenceDetails.routeStatusFreshness).toBe(50);
  });

  it("pins holder cohort breadth detail scores", () => {
    const cases = [
      ["any-holder", 100],
      ["verified-customer", 75],
      ["whitelisted-primary", 55],
      ["pre-incident-holder", 55],
      ["issuer-discretionary", 25],
      ["unknown", 30],
      [undefined, 60],
    ] as const;

    for (const [holderEligibility, expected] of cases) {
      expect(detailsFor({ holderEligibility }).holderCohortBreadth, holderEligibility ?? "default").toBe(expected);
    }
  });
});

describe("inferStoredFeeConfidence", () => {
  it("returns fixed when feeBps is a number", () => {
    expect(inferStoredFeeConfidence({ feeBps: 0 })).toBe("fixed");
    expect(inferStoredFeeConfidence({ feeBps: 25 })).toBe("fixed");
  });

  it("returns undisclosed-reviewed when feeBps is null", () => {
    expect(inferStoredFeeConfidence({ feeBps: null })).toBe("undisclosed-reviewed");
  });
});

describe("inferStoredFeeModelKind", () => {
  it("returns fixed-bps when feeBps is a number, regardless of other fields", () => {
    expect(inferStoredFeeModelKind({ feeBps: 0, feeConfidence: "fixed" })).toBe("fixed-bps");
    expect(
      inferStoredFeeModelKind({
        feeBps: 25,
        feeConfidence: "formula",
        feeDescription: "formula + base",
      }),
    ).toBe("fixed-bps");
  });

  it("returns formula for null feeBps with formula confidence", () => {
    expect(inferStoredFeeModelKind({ feeBps: null, feeConfidence: "formula" })).toBe("formula");
  });

  it("returns documented-variable for null feeBps without formula confidence but with feeDescription", () => {
    expect(
      inferStoredFeeModelKind({
        feeBps: null,
        feeConfidence: "undisclosed-reviewed",
        feeDescription: "reviewed per PR",
      }),
    ).toBe("documented-variable");
  });

  it("returns undisclosed-reviewed when nothing identifies the fee", () => {
    expect(inferStoredFeeModelKind({ feeBps: null, feeConfidence: "undisclosed-reviewed" })).toBe(
      "undisclosed-reviewed",
    );
  });
});

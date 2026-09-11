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

  it.each([
    [{ kind: "supply-full" }, "heuristic", "eventual-only"],
    [{ kind: "supply-ratio", ratio: 0.05 }, "heuristic", "immediate-bounded"],
    [{ kind: "fixed-usd", amountUsd: 1_000_000 }, "documented-bound", "immediate-bounded"],
    [{ kind: "reserve-sync-metadata" }, "dynamic", "immediate-bounded"],
  ] as const)("resolves literal defaults for %j", (model, confidence, semantics) => {
    expect(resolveCapacityConfidence(model)).toBe(confidence);
    expect(resolveCapacitySemantics(model)).toBe(semantics);
  });

  it("preserves semantics when capacity evidence is explicitly configured", () => {
    expect(resolveCapacitySemantics({
      kind: "supply-full", confidence: "documented-bound", basis: "full-system-eventual",
    })).toBe("eventual-only");
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
  const resultFor = (overrides: Partial<ConfidenceArgs> = {}) =>
    deriveModelConfidenceWithDetails({ ...baseResolvedArgs, ...overrides });
  const detailsFor = (overrides: Partial<ConfidenceArgs> = {}) => resultFor(overrides).confidenceDetails;

  it("returns low for each unresolved wrapper state with omitted detail inputs", () => {
    for (const resolutionState of ["failed", "missing-capacity", "missing-cache", "impaired"] as const) {
      expect(deriveModelConfidence({
        resolutionState, capacityConfidence: "live-direct", feeConfidence: "fixed",
      })).toBe("low");
    }
  });

  it("returns low with intact public detail scores for unresolved high-quality evidence", () => {
    for (const resolutionState of ["failed", "missing-capacity", "missing-cache", "impaired"] as const) {
      expect(resultFor({ resolutionState })).toMatchObject({
        modelConfidence: "low",
        confidenceDetails: {
          capacityEvidenceQuality: 100,
          feeEvidenceQuality: 100,
          routeStatusFreshness: 100,
          holderCohortBreadth: 100,
          sourceQuality: 100,
          reviewedDocAgeDays: null,
        },
      });
    }
  });

  it("preserves wrapper confidence when route detail inputs are omitted", () => {
    const cases = [
      ["heuristic", "fixed", "low"],
      ["live-direct", "fixed", "high"],
      ["live-direct", "formula", "high"],
      ["live-direct", "undisclosed-reviewed", "medium"],
      ["live-proxy", "fixed", "medium"],
      ["dynamic", "fixed", "medium"],
      ["documented-bound", "fixed", "medium"],
    ] as const;
    for (const [capacityConfidence, feeConfidence, expected] of cases) {
      expect(deriveModelConfidence({ resolutionState: "resolved", capacityConfidence, feeConfidence })).toBe(expected);
    }
  });

  it("expires static documentation only after 365 complete days", () => {
    const reviewedAt = "2024-01-01";
    const reviewedSec = Date.UTC(2024, 0, 1) / 1_000;
    for (const [elapsed, age, expected] of [
      [365 * 86_400, 365, "medium"],
      [366 * 86_400 - 1, 365, "medium"],
      [366 * 86_400, 366, "low"],
    ] as const) {
      const result = resultFor({
        capacityConfidence: "documented-bound", feeConfidence: "formula",
        routeStatusSource: "static-config", sourceMode: "static", freshnessKind: undefined,
        reviewedAt, now: reviewedSec + elapsed,
      });
      expect(result.modelConfidence).toBe(expected);
      expect(result.confidenceDetails.reviewedDocAgeDays).toBe(age);
    }
  });

  it("retains stale documented confidence for every current route-status evidence source", () => {
    for (const routeStatusSource of ["operator-notice", "protocol-api", "onchain", "market-implied"] as const) {
      const result = resultFor({
        capacityConfidence: "documented-bound", feeConfidence: "formula",
        routeStatusSource, sourceMode: "static", freshnessKind: undefined,
        reviewedAt: "2024-01-01", now: Date.UTC(2025, 0, 1) / 1_000,
      });
      expect(result.modelConfidence, routeStatusSource).toBe("medium");
      expect(result.confidenceDetails.reviewedDocAgeDays).toBe(366);
    }
  });

  it("keeps live-proxy with undisclosed fees below direct high confidence", () => {
    expect(resultFor({
      capacityConfidence: "live-proxy", feeConfidence: "undisclosed-reviewed",
      routeStatusSource: "protocol-api", freshnessKind: "same-run-api",
    }).modelConfidence).toBe("medium");
  });

  it("rolls up the unknown-route-status capacity-confidence matrix conservatively", () => {
    for (const [capacityConfidence, expected] of [
      ["live-direct", "high"],
      ["live-proxy", "low"],
      ["documented-bound", "medium"],
      ["heuristic", "low"],
      ["dynamic", "low"],
    ] as const) {
      expect(resultFor({
        capacityConfidence, routeStatus: "unknown", routeStatusSource: "static-config",
      }).modelConfidence, capacityConfidence).toBe(expected);
    }
  });

  it("downgrades issuer-discretionary and unknown holder cohorts to low confidence", () => {
    for (const holderEligibility of ["issuer-discretionary", "unknown"] as const) {
      expect(resultFor({ holderEligibility }).modelConfidence).toBe("low");
    }
  });

  it("does not discount future or invalid reviewedAt values as stale documentation", () => {
    for (const [reviewedAt, age] of [["2027-01-01", 0], ["not-a-date", null]] as const) {
      const result = resultFor({
        capacityConfidence: "documented-bound", routeStatusSource: "static-config",
        sourceMode: "static", freshnessKind: undefined, reviewedAt, now: 1_780_000_000,
      });
      expect(result.modelConfidence).toBe("medium");
      expect(result.confidenceDetails.reviewedDocAgeDays).toBe(age);
    }
  });

  it("records source-quality detail scores for live freshness and static fallback evidence", () => {
    expect(detailsFor({ routeStatusSource: "protocol-api", freshnessKind: "same-run-api" }).sourceQuality).toBe(90);
    expect(detailsFor({
      capacityConfidence: "documented-bound", routeStatusSource: "static-config",
      sourceMode: "static", freshnessKind: undefined,
    }).sourceQuality).toBe(40);
  });

  it("keeps reviewed-static and unverified freshness on source-mode/default quality fallbacks", () => {
    expect(detailsFor({ sourceMode: "static", freshnessKind: "reviewed-static" }).sourceQuality).toBe(40);
    expect(detailsFor({ sourceMode: undefined, freshnessKind: "unverified" }).sourceQuality).toBe(50);
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

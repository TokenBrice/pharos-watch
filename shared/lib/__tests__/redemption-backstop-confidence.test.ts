import { describe, expect, it } from "vitest";
import {
  deriveModelConfidence,
  inferStoredCapacityConfidence,
  inferStoredCapacitySemantics,
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
    expect(resolveCapacityConfidence({ kind: "supply-ratio", ratio: 0.1, confidence: "live-direct" })).toBe("live-direct");
    expect(
      resolveCapacityConfidence({ kind: "reserve-sync-metadata", confidence: "live-proxy" }),
    ).toBe("live-proxy");
  });

  it("defaults reserve-sync-metadata to dynamic when confidence is unset", () => {
    expect(resolveCapacityConfidence({ kind: "reserve-sync-metadata" })).toBe("dynamic");
  });

  it("defaults non-reserve-sync models to heuristic when confidence is unset", () => {
    expect(resolveCapacityConfidence({ kind: "supply-full" })).toBe("heuristic");
    expect(resolveCapacityConfidence({ kind: "supply-ratio", ratio: 0.05 })).toBe("heuristic");
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
  it("returns the explicit confidence for fee-bps models", () => {
    expect(resolveFeeConfidence({ kind: "fee-bps", feeBps: 10, confidence: "formula" })).toBe("formula");
    expect(resolveFeeConfidence({ kind: "fee-bps", feeBps: 0, confidence: "undisclosed-reviewed" })).toBe("undisclosed-reviewed");
  });

  it("defaults fee-bps to fixed when confidence is unset", () => {
    expect(resolveFeeConfidence({ kind: "fee-bps", feeBps: 25 })).toBe("fixed");
  });

  it("returns the explicit confidence for dynamic-or-unclear models", () => {
    expect(
      resolveFeeConfidence({ kind: "dynamic-or-unclear", confidence: "formula" }),
    ).toBe("formula");
  });

  it("defaults dynamic-or-unclear to undisclosed-reviewed when confidence is unset", () => {
    expect(resolveFeeConfidence({ kind: "dynamic-or-unclear" })).toBe("undisclosed-reviewed");
    expect(
      resolveFeeConfidence({ kind: "dynamic-or-unclear", feeDescription: "base + variable" }),
    ).toBe("undisclosed-reviewed");
  });
});

describe("resolveFeeModelKind", () => {
  it("returns fixed-bps for fee-bps models regardless of other fields", () => {
    expect(resolveFeeModelKind({ kind: "fee-bps", feeBps: 0 })).toBe("fixed-bps");
    expect(resolveFeeModelKind({ kind: "fee-bps", feeBps: 100, confidence: "formula" })).toBe("fixed-bps");
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
    expect(
      resolveFeeModelKind({ kind: "dynamic-or-unclear", feeDescription: "min 50 bps + base" }),
    ).toBe("documented-variable");
  });

  it("returns undisclosed-reviewed for dynamic-or-unclear with no description and no formula confidence", () => {
    expect(resolveFeeModelKind({ kind: "dynamic-or-unclear" })).toBe("undisclosed-reviewed");
    expect(
      resolveFeeModelKind({ kind: "dynamic-or-unclear", confidence: "undisclosed-reviewed" }),
    ).toBe("undisclosed-reviewed");
  });
});

describe("deriveModelConfidence", () => {
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
});

describe("inferStoredCapacityConfidence", () => {
  it("returns dynamic only when provider is reserve-sync-metadata and sourceMode is dynamic", () => {
    expect(
      inferStoredCapacityConfidence({ provider: "reserve-sync-metadata", sourceMode: "dynamic" }),
    ).toBe("dynamic");
  });

  it("returns heuristic for non-dynamic source modes even with reserve-sync-metadata provider", () => {
    expect(
      inferStoredCapacityConfidence({ provider: "reserve-sync-metadata", sourceMode: "estimated" }),
    ).toBe("heuristic");
    expect(
      inferStoredCapacityConfidence({ provider: "reserve-sync-metadata", sourceMode: "static" }),
    ).toBe("heuristic");
  });

  it("returns heuristic for any other provider", () => {
    expect(
      inferStoredCapacityConfidence({ provider: "supply-full-model", sourceMode: "dynamic" }),
    ).toBe("heuristic");
    expect(
      inferStoredCapacityConfidence({ provider: "supply-ratio", sourceMode: "static" }),
    ).toBe("heuristic");
  });
});

describe("inferStoredCapacitySemantics", () => {
  it("returns eventual-only for supply-full-model", () => {
    expect(inferStoredCapacitySemantics({ provider: "supply-full-model" })).toBe("eventual-only");
  });

  it("returns immediate-bounded for any other provider", () => {
    expect(inferStoredCapacitySemantics({ provider: "reserve-sync-metadata" })).toBe("immediate-bounded");
    expect(inferStoredCapacitySemantics({ provider: "supply-ratio" })).toBe("immediate-bounded");
    expect(inferStoredCapacitySemantics({ provider: "sync-error" })).toBe("immediate-bounded");
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
    expect(
      inferStoredFeeModelKind({ feeBps: 0, feeConfidence: "fixed" }),
    ).toBe("fixed-bps");
    expect(
      inferStoredFeeModelKind({
        feeBps: 25,
        feeConfidence: "formula",
        feeDescription: "formula + base",
      }),
    ).toBe("fixed-bps");
  });

  it("returns formula for null feeBps with formula confidence", () => {
    expect(
      inferStoredFeeModelKind({ feeBps: null, feeConfidence: "formula" }),
    ).toBe("formula");
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
    expect(
      inferStoredFeeModelKind({ feeBps: null, feeConfidence: "undisclosed-reviewed" }),
    ).toBe("undisclosed-reviewed");
  });
});

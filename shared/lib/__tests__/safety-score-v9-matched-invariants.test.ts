import { describe, expect, it } from "vitest";
import { MATCHED_V9_INVARIANTS } from "@shared/data/safety-score-v9/matched-invariants-v1";
import type { ExitRouteObservation } from "@shared/types/market";
import type { V9ScoringInput } from "@shared/types/safety-score-v9";
import { computeEffectiveExitScoreDiagnostics } from "../redemption-backstop-scoring";
import { resolveV9StructuralCaps, scoreV9Input } from "../safety-score-v9-research";

const AS_OF = 1_780_000_000;

function route(overrides: Partial<ExitRouteObservation> = {}): ExitRouteObservation {
  return {
    routeId: "dex:strong",
    routeFamily: "dex-amm",
    scope: { kind: "protocol", protocol: "test", chain: "ethereum" },
    requestedNotionalUsd: 1_000_000,
    settlementHorizonSec: 300,
    maxCostBps: 200,
    executableUsd: 1_000_000,
    completionRatio: 1,
    output: { kind: "fiat", currency: "USD" },
    evidenceKind: "measured-executable-depth",
    confidence: "high",
    scoreEligible: true,
    observedAt: AS_OF,
    freshnessSeconds: 0,
    commonModeKeys: ["protocol:test"],
    ...overrides,
  };
}

function scoringInput(overrides: Partial<V9ScoringInput> = {}): V9ScoringInput {
  return {
    assetId: "matched",
    pillars: { backing: 90, exit: 90, control: 90 },
    pegScore: 100,
    pegApplicable: true,
    evidenceLevel: "strong",
    trackRecordMonths: 48,
    activeDepegBps: null,
    parentRequired: false,
    parentScore: null,
    structuralCaps: [],
    structuralSignals: [],
    unresolved: [],
    ...overrides,
  };
}

describe("separate matched v9 invariant corpus", () => {
  it("keeps the transformation registry versioned and unique", () => {
    expect(MATCHED_V9_INVARIANTS).toHaveLength(8);
    expect(new Set(MATCHED_V9_INVARIANTS.map((entry) => entry.id)).size).toBe(8);
  });

  it("rewards credible redemption at the same request and ignores a weak optional route", () => {
    const redemption = route({
      routeId: "redeem:issuer",
      routeFamily: "issuer-redemption",
      scope: { kind: "issuer", issuerId: "issuer" },
      evidenceKind: "documented-terms",
      commonModeKeys: ["issuer:test"],
    });
    const thinDex = route({ executableUsd: 200_000, completionRatio: 0.2 });
    const weakOptional = { ...redemption, routeId: "redeem:weak", executableUsd: 50_000, completionRatio: 0.05 };
    const shared = {
      modeledExitSizeUsd: 1_000_000,
      sameNotionalScoringMode: "active" as const,
      exitObservationAsOfSec: AS_OF,
      dexExitObservationMaxAgeSec: 60,
      liveRedemptionExitObservationMaxAgeSec: 60,
    };
    const thinOnly = computeEffectiveExitScoreDiagnostics(80, null, {
      ...shared,
      dexExitRouteObservations: [thinDex],
    });
    const withRedemption = computeEffectiveExitScoreDiagnostics(80, 90, {
      ...shared,
      dexExitRouteObservations: [thinDex],
      redemptionExitRouteObservations: [redemption],
    });
    const strongOnly = computeEffectiveExitScoreDiagnostics(90, null, {
      ...shared,
      dexExitRouteObservations: [route()],
    });
    const withWeak = computeEffectiveExitScoreDiagnostics(90, 90, {
      ...shared,
      dexExitRouteObservations: [route()],
      redemptionExitRouteObservations: [weakOptional],
    });
    expect(withRedemption.score).toBeGreaterThan(thinOnly.score ?? 0);
    expect(withWeak.score).toBeGreaterThanOrEqual(strongOnly.score ?? 0);
  });

  it("orders reserve and bridge materiality without named-asset thresholds", () => {
    const moderate = scoreV9Input(
      scoringInput({ structuralCaps: [{ kind: "reserve:moderate", limit: 74, reason: "Moderate loss." }] }),
    );
    const material = scoreV9Input(
      scoringInput({ structuralCaps: [{ kind: "reserve:material", limit: 49, reason: "Material loss." }] }),
    );
    const peripheralCaps = resolveV9StructuralCaps([
      {
        kind: "material-bridge",
        severity: "high",
        reason: "Peripheral route.",
        materialSharePct: 2,
        failureDomainKeys: ["bridge:test"],
        evidence: [],
      },
    ]);
    const materialCaps = resolveV9StructuralCaps([
      {
        kind: "material-bridge",
        severity: "high",
        reason: "Material route.",
        materialSharePct: 30,
        failureDomainKeys: ["bridge:test"],
        evidence: [],
      },
    ]);
    expect(material.finalScore).toBeLessThan(moderate.finalScore ?? 0);
    expect(peripheralCaps).toEqual([]);
    expect(materialCaps).toContainEqual(expect.objectContaining({ limit: 59 }));
  });

  it("makes unavailable dependencies and critical evidence reason-coded NR", () => {
    const weak = scoreV9Input(
      scoringInput({ structuralCaps: [{ kind: "dependency:weak", limit: 64, reason: "Weak dependency." }] }),
    );
    const unavailable = scoreV9Input(
      scoringInput({
        unresolved: [{ code: "dependency-unavailable", reason: "Required parent unavailable.", critical: true }],
      }),
    );
    const bounded = scoreV9Input(
      scoringInput({
        unresolved: [{ code: "bounded-gap", reason: "Bounded noncritical gap.", critical: false }],
        evidenceLevel: "limited",
      }),
    );
    expect(weak.finalScore).toBe(64);
    expect(unavailable.finalGrade).toBe("NR");
    expect(bounded.finalGrade).not.toBe("NR");
  });

  it("penalizes a shared weak oracle domain below an isolated weak branch", () => {
    const branch = (reason: string) => ({
      kind: "weak-oracle-branch" as const,
      severity: "high" as const,
      reason,
      failureDomainKeys: ["oracle:shared"],
      evidence: [],
    });
    const isolated = resolveV9StructuralCaps([branch("One branch.")]);
    const common = resolveV9StructuralCaps([branch("First branch."), branch("Second branch.")]);
    expect(Math.min(...common.map((cap) => cap.limit))).toBeLessThan(Math.min(...isolated.map((cap) => cap.limit)));
  });
});

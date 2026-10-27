import { describe, expect, it } from "vitest";
import type {
  SafetyScoreV8PublicationIdentity,
  SafetyScoreV9PublicationIdentity,
} from "../../types/safety-score-publication";
import {
  assessSafetyScoreAcceptedEvidence,
  type SafetyScorePublicationIdentityContract,
  safetyScorePublicationIdentitiesAreComparable,
  safetyScorePublicationIdentitiesShareScoringContract,
  safetyScorePublicationIdentitiesMatch,
} from "../safety-score-publication";
import { isYieldSafetyFallbackWithinWindow, YIELD_SAFETY_STALE_COHERENT_MAX_AGE_SEC } from "../yield-safety-fallback";

const digest = (character: string) => character.repeat(64);

function v8Identity(
  overrides: Partial<SafetyScoreV8PublicationIdentity> = {},
): SafetyScoreV8PublicationIdentity {
  return {
    model: "v8",
    schemaVersion: 1,
    methodologyVersion: "8.17",
    evaluationBuildDigest: digest("a"),
    baseInputGenerationId: `report-cards-input:v1:${digest("b")}`,
    publicationGenerationId: "report-cards:8.17:100",
    ...overrides,
  };
}

function v9Identity(
  overrides: Partial<SafetyScoreV9PublicationIdentity> = {},
): SafetyScoreV9PublicationIdentity {
  return {
    model: "v9",
    schemaVersion: 1,
    methodologyVersion: "9.0",
    policyId: "safety-score-v9",
    policyDigest: digest("c"),
    evaluationBuildDigest: digest("d"),
    baseInputGenerationId: `report-cards-input:v1:${digest("e")}`,
    publicationGenerationId: "report-cards:v9:100",
    ...overrides,
  };
}

describe("Safety Score publication identity comparisons", () => {
  it("requires an exact V8 publication identity match", () => {
    const identity = v8Identity() satisfies SafetyScorePublicationIdentityContract;

    expect(safetyScorePublicationIdentitiesMatch(identity, { ...identity })).toBe(true);
    expect(
      safetyScorePublicationIdentitiesMatch(
        identity,
        v8Identity({ baseInputGenerationId: `report-cards-input:v1:${digest("f")}` }),
      ),
    ).toBe(false);
    expect(
      safetyScorePublicationIdentitiesMatch(
        identity,
        v8Identity({ publicationGenerationId: "report-cards:8.17:101" }),
      ),
    ).toBe(false);
  });

  it("allows organic V8 generations only within the same evaluator series", () => {
    const identity = v8Identity();

    expect(
      safetyScorePublicationIdentitiesAreComparable(
        identity,
        v8Identity({
          baseInputGenerationId: `report-cards-input:v1:${digest("f")}`,
          publicationGenerationId: "report-cards:8.17:101",
        }),
      ),
    ).toBe(true);
    expect(
      safetyScorePublicationIdentitiesAreComparable(
        identity,
        v8Identity({ evaluationBuildDigest: digest("f") }),
      ),
    ).toBe(false);
  });

  it("binds V9 matches and organic comparisons to the policy identity", () => {
    const identity = v9Identity() satisfies SafetyScorePublicationIdentityContract;

    expect(safetyScorePublicationIdentitiesMatch(identity, { ...identity })).toBe(true);
    expect(
      safetyScorePublicationIdentitiesMatch(
        identity,
        v9Identity({ publicationGenerationId: "report-cards:v9:101" }),
      ),
    ).toBe(false);
    expect(
      safetyScorePublicationIdentitiesMatch(
        identity,
        v9Identity({ policyDigest: digest("f") }),
      ),
    ).toBe(false);
    expect(
      safetyScorePublicationIdentitiesAreComparable(
        identity,
        v9Identity({
          baseInputGenerationId: `report-cards-input:v1:${digest("f")}`,
          publicationGenerationId: "report-cards:v9:101",
        }),
      ),
    ).toBe(true);
    expect(
      safetyScorePublicationIdentitiesAreComparable(
        identity,
        v9Identity({ policyId: "safety-score-v9-other-policy" }),
      ),
    ).toBe(false);
  });

  it("shares a scoring contract across evaluator-build rotations but not policy or methodology changes", () => {
    const identity = v9Identity();
    const rotated = v9Identity({ evaluationBuildDigest: digest("f"), publicationGenerationId: "report-cards:v9:101" });

    expect(safetyScorePublicationIdentitiesAreComparable(identity, rotated)).toBe(false);
    expect(safetyScorePublicationIdentitiesShareScoringContract(identity, rotated)).toBe(true);
    expect(safetyScorePublicationIdentitiesShareScoringContract(identity, v9Identity({ policyDigest: digest("f") }))).toBe(false);
    expect(safetyScorePublicationIdentitiesShareScoringContract(identity, v9Identity({ methodologyVersion: "0.0" }))).toBe(false);
    expect(safetyScorePublicationIdentitiesShareScoringContract(v8Identity(), v9Identity())).toBe(false);
  });

  it("never compares identities across model boundaries", () => {
    expect(safetyScorePublicationIdentitiesMatch(v8Identity(), v9Identity())).toBe(false);
    expect(safetyScorePublicationIdentitiesAreComparable(v8Identity(), v9Identity())).toBe(false);
  });
});

describe("assessSafetyScoreAcceptedEvidence", () => {
  const nowSec = 1_800_000_000;
  const current = { status: "current", heldSinceSec: null } as const;
  const assess = (acceptedAtSec: number | null | undefined, overrides: Partial<Parameters<typeof assessSafetyScoreAcceptedEvidence>[0]> = {}) =>
    assessSafetyScoreAcceptedEvidence({
      acceptedGenerationId: "report-cards:v9:1", acceptedAtSec, health: current, nowSec, maxAgeSec: 7_200, ...overrides,
    });

  it("includes the caller-owned budget boundary and rejects one second past it", () => {
    expect(assess(nowSec - 7_200)).toMatchObject({ ageSec: 7_200, maxAgeSec: 7_200, withinBudget: true, reason: null });
    expect(assess(nowSec - 7_201)).toMatchObject({ ageSec: 7_201, withinBudget: false, reason: "accepted-evidence-stale" });
    expect(assess(nowSec - 86_400, { maxAgeSec: 86_400 }).withinBudget).toBe(true);
    expect(assess(nowSec - 86_401, { maxAgeSec: 86_400 }).withinBudget).toBe(false);
  });

  it("fails closed on missing, nonfinite and future accepted clocks without clamping age", () => {
    expect(assess(null)).toMatchObject({ acceptedAtSec: null, ageSec: null, withinBudget: false, reason: "accepted-evidence-missing" });
    expect(assess(undefined).reason).toBe("accepted-evidence-missing");
    expect(assess(Number.NaN)).toMatchObject({ ageSec: null, withinBudget: false, reason: "accepted-evidence-invalid" });
    expect(assess(Number.POSITIVE_INFINITY).reason).toBe("accepted-evidence-invalid");
    expect(assess(nowSec, { nowSec: Number.NaN }).reason).toBe("accepted-evidence-invalid");
    expect(assess(nowSec + 1)).toMatchObject({ ageSec: null, withinBudget: false, reason: "accepted-evidence-future" });
    expect(assess(nowSec).withinBudget).toBe(true);
  });

  it("admits future skew only inside an explicit caller allowance", () => {
    expect(assess(nowSec + 60, { allowedFutureSkewSec: 60 })).toMatchObject({ ageSec: -60, withinBudget: true, reason: null });
    expect(assess(nowSec + 61, { allowedFutureSkewSec: 60 }).reason).toBe("accepted-evidence-future");
  });

  it("reports holds separately from the accepted-clock verdict", () => {
    const held = assess(nowSec - 60, { health: { status: "held", heldSinceSec: nowSec - 30 } });
    expect(held).toMatchObject({ withinBudget: true, reason: null, held: true, heldSinceSec: nowSec - 30, ageSec: 60 });
    expect(assess(nowSec - 60)).toMatchObject({ held: false, heldSinceSec: null });
    expect(assess(nowSec - 60, { health: null })).toMatchObject({ held: false, withinBudget: true });
    expect(held.acceptedGenerationId).toBe("report-cards:v9:1");
  });

  it("keeps the yield 86400s original-clock window on both clocks", () => {
    expect(YIELD_SAFETY_STALE_COHERENT_MAX_AGE_SEC).toBe(86_400);
    expect(isYieldSafetyFallbackWithinWindow(nowSec - 86_400, nowSec - 86_400, nowSec)).toBe(true);
    expect(isYieldSafetyFallbackWithinWindow(nowSec, nowSec - 86_401, nowSec)).toBe(false);
    expect(isYieldSafetyFallbackWithinWindow(nowSec - 86_401, nowSec, nowSec)).toBe(false);
    for (const safety of [null, undefined, Number.NaN, nowSec + 1]) {
      expect(isYieldSafetyFallbackWithinWindow(nowSec, safety, nowSec)).toBe(false);
    }
    expect(isYieldSafetyFallbackWithinWindow(nowSec + 1, nowSec, nowSec)).toBe(false);
  });
});

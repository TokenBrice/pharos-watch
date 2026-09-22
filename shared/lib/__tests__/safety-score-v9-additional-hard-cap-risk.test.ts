import { describe, expect, it } from "vitest";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import { scoreV9Input } from "../safety-score-v9/formula";
import type { V9ScoringInput, V9StructuralSignal } from "../../types/safety-score-v9";
import { makeV9ScoringInput, makeV9Signal } from "./safety-score-v9-score.test-support";

/**
 * A signal already priced inside a pillar has its causal account there. Letting
 * it also impose a whole-asset ceiling charges one fact twice, so the second
 * charge must be an explicit reviewed assertion that the ceiling covers a
 * residual the pillar cannot express.
 */
function signal(overrides: Partial<V9StructuralSignal> = {}): V9StructuralSignal {
  return makeV9Signal({
    kind: "centralized-mint",
    reason: "Economically effective minting is unbounded or compromised.",
    economicLossScope: "global-claim",
    failureDomainKeys: ["mint-control:asset:probe"],
    ...overrides,
  });
}

function input(signals: readonly V9StructuralSignal[]): V9ScoringInput {
  return makeV9ScoringInput({
    assetId: "hard-cap-risk-probe",
    pillars: { backing: 90, exit: 90, control: 55 },
    trackRecordMonths: 120,
    structuralSignals: [...signals],
  });
}

const MARKER = {
  reviewed: true as const,
  reason: "The ceiling covers a residual the compensable control pillar cannot reach.",
};

describe("additionalHardCapRisk gates the second charge for pillar-priced signals", () => {
  it("admits a pillar-priced signal to the cap ladder when the residual is asserted", () => {
    const trace = scoreV9Input(
      input([signal({ pricedInPillar: "control", additionalHardCapRisk: MARKER })]),
      V9_CANDIDATE_POLICY_V1,
    );
    expect(trace.bindingCap?.kind).toBe("signal:centralized-mint:high");
    expect(trace.bindingCap?.limit).toBe(59);
  });

  it("withholds the cap when a pillar-priced signal asserts no residual", () => {
    const trace = scoreV9Input(
      input([signal({ pricedInPillar: "control" })]),
      V9_CANDIDATE_POLICY_V1,
    );
    expect(trace.caps.some((cap) => cap.kind === "signal:centralized-mint:high")).toBe(false);
    expect(trace.bindingCap).toBeNull();
  });

  it("leaves a signal that is not pillar-priced capping without a marker", () => {
    const trace = scoreV9Input(input([signal()]), V9_CANDIDATE_POLICY_V1);
    expect(trace.bindingCap?.kind).toBe("signal:centralized-mint:high");
  });

  it("still refuses reserve-claim and access-only scope even with a marker", () => {
    for (const economicLossScope of ["reserve-claim", "access-only"] as const) {
      const trace = scoreV9Input(
        input([
          signal({
            kind: "unsafe-backing",
            economicLossScope,
            pricedInPillar: "backing",
            additionalHardCapRisk: MARKER,
          }),
        ]),
        V9_CANDIDATE_POLICY_V1,
      );
      expect(trace.caps.some((cap) => cap.kind.startsWith("signal:unsafe-backing"))).toBe(false);
    }
  });

  it("rejects a marker that does not carry a reviewed reason", () => {
    // An empty reason satisfies the TS type but not the schema's min(1), so this
    // is a runtime rejection rather than a compile-time one.
    expect(() =>
      scoreV9Input(
        input([
          signal({
            pricedInPillar: "control",
            additionalHardCapRisk: { reviewed: true, reason: "" },
          }),
        ]),
        V9_CANDIDATE_POLICY_V1,
      ),
    ).toThrow();
  });
});

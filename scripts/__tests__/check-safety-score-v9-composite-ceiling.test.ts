import { describe, expect, it } from "vitest";
import { aggregateV9SmoothBoundedHeadroom } from "@shared/lib/safety-score-v9/aggregation";
import {
  runCompositeCeilingGate,
  type CompositeCeilingGateInput,
} from "../maintenance/check-safety-score-v9-composite-ceiling";

// The FlowSafetyScore-4 counterexample donors: the best real measured pillar
// sub-scores {backing: 100, exit: 100, control: 80} under the live policy
// weights {0.4, 0.35, 0.25}. The retired inline gate scored this vector as
// min(95, 80 + controlCompensabilityHeadroom 30) = 95; the production
// aggregation returns 80 + 20*tanh(15/20) = 92.70297904774574.
const PRODUCTION_POLICY_FORMULA = {
  pillarWeights: { backing: 0.4, exit: 0.35, control: 0.25 },
  gradeThresholds: [
    { grade: "A+", minScore: 87 },
    { grade: "A", minScore: 80 },
  ],
  compensabilityHeadroom: 20,
  // Retired knob: the live formula rejects pillar-dependent headroom, and the
  // gate must ignore it too. Left in the fixture to prove the gate never
  // selects it (with it, the donor vector below would score 95).
  controlCompensabilityHeadroom: 30,
};

function donorCard(id: string, pillars: { backing: number; exit: number; control: number }) {
  return {
    id,
    grade: "A",
    score: 90,
    pillars: {
      backing: { score: pillars.backing },
      exit: { score: pillars.exit },
      control: { score: pillars.control },
    },
  };
}

const COUNTEREXAMPLE_REPLAY = {
  pipeline: {
    candidate: {
      cards: [
        donorCard("backing-donor", { backing: 100, exit: 50, control: 50 }),
        donorCard("exit-donor", { backing: 40, exit: 100, control: 40 }),
        donorCard("control-donor", { backing: 40, exit: 40, control: 80 }),
      ],
    },
  },
};

const ISSUER_REGISTRY = [
  { id: "backing-donor", mechanismArchetype: "fiat-cash" },
  { id: "exit-donor", mechanismArchetype: "fiat-cash" },
  { id: "control-donor", mechanismArchetype: "fiat-cash" },
];

function gateInput(overrides: Partial<CompositeCeilingGateInput> = {}): CompositeCeilingGateInput {
  return {
    replay: COUNTEREXAMPLE_REPLAY,
    policy: { policy: { semantic: { formula: PRODUCTION_POLICY_FORMULA } } },
    registry: ISSUER_REGISTRY,
    ...overrides,
  };
}

describe("safety-score-v9 composite ceiling gate", () => {
  it("scores donor composites with the production smooth-bounded-headroom aggregation, not the retired hard-min control headroom", () => {
    const expected = aggregateV9SmoothBoundedHeadroom(
      { backing: 100, exit: 100, control: 80 },
      { backing: 0.4, exit: 0.35, control: 0.25 },
      20,
    );
    // Frozen anchor from the counterexample: the retired inline gate returned
    // exactly 95 for these donors.
    expect(expected.score).toBe(92.70297904774574);

    const report = runCompositeCeilingGate(gateInput());

    expect(report.passed).toBe(true);
    expect(report.variants.map((variant) => variant.name)).toEqual(["unrestricted", "non-wrapper", "issuer-class"]);
    for (const variant of report.variants) {
      expect(variant.composite).toBe(expected.score);
      expect(variant.passed).toBe(true);
    }
    const output = report.stdout.join("\n");
    expect(output).toContain("composite 92.70");
    expect(output).not.toContain("composite 95.00");
  });

  it("applies the single policy headroom whichever pillar is weakest", () => {
    // Weakest pillar is backing, so a pillar-dependent selector would use the
    // ordinary headroom either way — the exact score still differs from the
    // retired hard minimum (min(84, 80) = 80).
    const replay = {
      pipeline: {
        candidate: {
          cards: [
            donorCard("backing-donor", { backing: 60, exit: 40, control: 40 }),
            donorCard("exit-donor", { backing: 40, exit: 100, control: 40 }),
            donorCard("control-donor", { backing: 40, exit: 40, control: 100 }),
          ],
        },
      },
    };
    const expected = aggregateV9SmoothBoundedHeadroom(
      { backing: 60, exit: 100, control: 100 },
      { backing: 0.4, exit: 0.35, control: 0.25 },
      20,
    );

    const report = runCompositeCeilingGate(gateInput({ replay }));

    for (const variant of report.variants) {
      expect(variant.composite).toBe(expected.score);
    }
    expect(report.passed).toBe(false);
  });

  it("fails when the real frontier cannot reach a raised A+ threshold the retired hard minimum cleared", () => {
    // A+ at 93: the retired gate scored the counterexample donors 95 and
    // passed; the production frontier is 92.70 and must fail.
    const formula = { ...PRODUCTION_POLICY_FORMULA, gradeThresholds: [{ grade: "A+", minScore: 93 }] };

    const report = runCompositeCeilingGate(gateInput({ policy: { policy: { semantic: { formula } } } }));

    expect(report.variants.every((variant) => variant.passed)).toBe(false);
    expect(report.passed).toBe(false);
  });

  it("reports an empty donor pool for a cohort with no eligible cards", () => {
    const report = runCompositeCeilingGate(gateInput({ registry: [] }));

    expect(report.variants.map((variant) => variant.name)).toEqual(["unrestricted", "non-wrapper"]);
    expect(report.passed).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { addSafetyReasonLines, buildV9SafetyReason } from "../telegram-alert-safety-reasons";
import type { SafetySnapshot } from "../telegram-alert-snapshots";
import type { SafetyChange } from "../../lib/telegram-alerts";

const BASE_CHANGE: SafetyChange = {
  stablecoinId: "coin",
  symbol: "COIN",
  oldGrade: "B",
  newGrade: "F",
  oldScore: 72,
  newScore: 39,
};

describe("telegram alert safety reasons", () => {
  it("uses native V9 cap and evidence explanations without V8 dimension projection", () => {
    expect(buildV9SafetyReason({
      grade: "C",
      score: 58,
      v9Explain: {
        bindingCap: { reason: "Issuer discretion limits primary exit" },
        reasons: [{ message: "ignored" }],
        weakestPillar: { pillar: "exit", score: 41 },
      },
    })).toBe("Reason: Issuer discretion limits primary exit.");
    expect(buildV9SafetyReason({
      grade: "C",
      score: 58,
      v9Explain: {
        bindingCap: null,
        reasons: [],
        weakestPillar: { pillar: "exit", score: 41 },
      },
    })).toBe("Reason: Weakest pillar is exit (41).");
  });

  it("routes active V9 rows through native pillar explanations", () => {
    const previous = snapshot({
      grade: "B",
      score: 78,
      v9Explain: {
        bindingCap: null,
        reasons: [],
        weakestPillar: { pillar: "exit", score: 70 },
        pillars: {
          backing: { score: 82, evidenceLevel: "adequate", freshness: "current" },
          exit: { score: 70, evidenceLevel: "adequate", freshness: "current" },
          control: { score: 80, evidenceLevel: "adequate", freshness: "current" },
        },
      },
    });
    const current = snapshot({
      grade: "C",
      score: 58,
      v9Explain: {
        bindingCap: null,
        reasons: [{ code: "exit-capacity-stress", message: "Exit capacity deteriorated." }],
        weakestPillar: { pillar: "exit", score: 41 },
        pillars: {
          backing: { score: 81, evidenceLevel: "adequate", freshness: "current" },
          exit: { score: 41, evidenceLevel: "limited", freshness: "current" },
          control: { score: 79, evidenceLevel: "adequate", freshness: "current" },
        },
      },
    });

    const [result] = addSafetyReasonLines(
      [{ ...BASE_CHANGE, newGrade: "C", newScore: 58 }],
      current,
      previous,
    );
    expect(result.contextLine).toBe("Reason: Exit pillar fell from 70 to 41.");
    expect(result.currentExplain).toBeUndefined();
  });

  it("selects the V9 pillar movement that matches the overall grade direction", () => {
    expect(buildV9SafetyReason({
      grade: "C",
      score: 58,
      v9Explain: {
        bindingCap: null,
        reasons: [],
        weakestPillar: { pillar: "exit", score: 65 },
        pillars: {
          backing: { score: 95, evidenceLevel: "strong", freshness: "current" },
          exit: { score: 65, evidenceLevel: "adequate", freshness: "current" },
          control: { score: 80, evidenceLevel: "adequate", freshness: "current" },
        },
      },
    }, {
      grade: "B",
      score: 78,
      v9Explain: {
        bindingCap: null,
        reasons: [],
        weakestPillar: { pillar: "exit", score: 70 },
        pillars: {
          backing: { score: 60, evidenceLevel: "adequate", freshness: "current" },
          exit: { score: 70, evidenceLevel: "adequate", freshness: "current" },
          control: { score: 80, evidenceLevel: "adequate", freshness: "current" },
        },
      },
    })).toBe("Reason: Exit pillar fell from 70 to 65.");
  });

  it("recognizes a tighter V9 cap when its reason text is unchanged", () => {
    expect(buildV9SafetyReason({
      grade: "C",
      score: 58,
      v9Explain: {
        bindingCap: { kind: "exit", limit: 60, reason: "Primary exit remains issuer-gated" },
        reasons: [],
        weakestPillar: { pillar: "exit", score: 58 },
      },
    }, {
      grade: "B",
      score: 78,
      v9Explain: {
        bindingCap: { kind: "exit", limit: 80, reason: "Primary exit remains issuer-gated" },
      },
    })).toBe("Reason: Primary exit remains issuer-gated.");
  });

  it("uses active-depeg cap explain data as the safety Reason line", () => {
    const current = snapshot({
      grade: "F",
      score: 39,
      explain: {
        schemaVersion: 1,
        stages: { activeDepegCapApplied: true, activeDepegCapScore: 39 },
        rawInputs: { activeDepeg: true, activeDepegBps: 7546 },
      },
    });
    const previous = snapshot({
      grade: "B",
      score: 72,
      explain: { schemaVersion: 1, stages: { activeDepegCapApplied: false } },
    });

    const [result] = addSafetyReasonLines(
      [BASE_CHANGE],
      current,
      previous,
      new Map([["coin", "Context: Safety F 39 · Liquidity 57, DEX TVL $1.2M"]]),
    );

    expect(result.contextLine).toContain("Reason: Active depeg peak 7546 bps capped the pre-variant Safety Score at F (39).");
    expect(result.contextLine).not.toContain("Context:");
  });

  it("does not claim a new active-depeg cap when the previous explain snapshot is missing", () => {
    const current = snapshot({
      grade: "F",
      score: 39,
      explain: {
        schemaVersion: 1,
        stages: { activeDepegCapApplied: true, activeDepegCapScore: 39 },
        rawInputs: { activeDepeg: true, activeDepegBps: 7546 },
      },
    });
    const previous = snapshot({ grade: "B", score: 72 });

    const [result] = addSafetyReasonLines([BASE_CHANGE], current, previous);

    expect(result.contextLine).toBe("Reason: Safety Score declined from 72 to 39.");
  });

  it("does not let an unchanged active cap mask a larger dimension move", () => {
    const previous = snapshot({
      grade: "B",
      score: 72,
      explain: {
        schemaVersion: 1,
        stages: { activeDepegCapApplied: true, activeDepegCapScore: 39 },
        rawInputs: { activeDepeg: true, activeDepegBps: 3000 },
        dimensions: {
          liquidity: { grade: "B", score: 72, detail: "DEX liquidity 72/100" },
        },
      },
    });
    const current = snapshot({
      grade: "F",
      score: 39,
      explain: {
        schemaVersion: 1,
        stages: { activeDepegCapApplied: true, activeDepegCapScore: 39 },
        rawInputs: { activeDepeg: true, activeDepegBps: 3200 },
        dimensions: {
          liquidity: { grade: "F", score: 20, detail: "DEX liquidity 20/100" },
        },
      },
    });

    const [result] = addSafetyReasonLines([BASE_CHANGE], current, previous);

    expect(result.contextLine).toBe(
      "Reason: Liquidity / Exit fell B -> F (72 -> 20). Now: DEX liquidity 20/100.",
    );
  });

  it("uses a tighter active-depeg cap before dimension movement", () => {
    const previous = snapshot({
      grade: "D",
      score: 49,
      explain: {
        schemaVersion: 1,
        stages: { activeDepegCapApplied: true, activeDepegCapScore: 49 },
        rawInputs: { activeDepeg: true, activeDepegBps: 1200 },
        dimensions: {
          liquidity: { grade: "B", score: 72 },
        },
      },
    });
    const current = snapshot({
      grade: "F",
      score: 39,
      explain: {
        schemaVersion: 1,
        stages: { activeDepegCapApplied: true, activeDepegCapScore: 39 },
        rawInputs: { activeDepeg: true, activeDepegBps: 2600 },
        dimensions: {
          liquidity: { grade: "C+", score: 61, detail: "DEX liquidity 61/100" },
        },
      },
    });

    const [result] = addSafetyReasonLines(
      [{ ...BASE_CHANGE, oldGrade: "D", oldScore: 49 }],
      current,
      previous,
    );

    expect(result.contextLine).toBe("Reason: Active depeg peak 2600 bps capped the pre-variant Safety Score at F (39).");
  });

  it("uses variant-cap tightening when an existing parent cap moves lower", () => {
    const previous = snapshot({
      grade: "C+",
      score: 61,
      explain: {
        schemaVersion: 1,
        stages: {
          variantCapApplied: true,
          scoreBeforeVariantCap: 72,
          finalScore: 61,
        },
        rawInputs: { variantParentId: "parent-coin" },
      },
    });
    const current = snapshot({
      grade: "F",
      score: 39,
      explain: {
        schemaVersion: 1,
        stages: {
          variantCapApplied: true,
          scoreBeforeVariantCap: 72,
          finalScore: 39,
        },
        rawInputs: { variantParentId: "parent-coin" },
        dimensions: {
          liquidity: { grade: "F", score: 20, detail: "DEX liquidity 20/100" },
        },
      },
    });

    const [result] = addSafetyReasonLines(
      [{ ...BASE_CHANGE, oldGrade: "C+", oldScore: 61 }],
      current,
      previous,
    );

    expect(result.contextLine).toBe("Reason: Variant parent cap by parent parent-coin tightened Safety Score to F (39).");
  });

  it("selects the dimension movement matching the overall downgrade", () => {
    const previous = snapshot({
      grade: "B",
      score: 72,
      explain: {
        schemaVersion: 1,
        dimensions: {
          liquidity: { grade: "B", score: 72, detail: "DEX liquidity 81/100" },
          pegStability: { grade: "A", score: 96, detail: "stable peg" },
        },
      },
    });
    const current = snapshot({
      grade: "C+",
      score: 61,
      explain: {
        schemaVersion: 1,
        dimensions: {
          liquidity: { grade: "C+", score: 61, detail: "DEX liquidity 32/100" },
          pegStability: { grade: "A", score: 96, detail: "stable peg" },
        },
      },
    });

    const [result] = addSafetyReasonLines(
      [{ ...BASE_CHANGE, newGrade: "C+", newScore: 61 }],
      current,
      previous,
    );

    expect(result.contextLine).toBe(
      "Reason: Liquidity / Exit fell B -> C+ (72 -> 61). Now: DEX liquidity 32/100.",
    );
  });

  it("uses the no-liquidity stage transition when liquidity becomes unrated", () => {
    const previous = snapshot({
      grade: "B",
      score: 72,
      explain: { schemaVersion: 1, stages: { noLiquidityPenaltyApplied: false } },
    });
    const current = snapshot({
      grade: "NR",
      score: null,
      explain: {
        schemaVersion: 1,
        stages: { noLiquidityPenaltyApplied: true },
        dimensions: { liquidity: { grade: "NR", score: null } },
      },
    });

    const [result] = addSafetyReasonLines(
      [{ ...BASE_CHANGE, newGrade: "NR", newScore: null }],
      current,
      previous,
    );

    expect(result.contextLine).toBe("Reason: Exit liquidity became unrated, applying the no-liquidity penalty.");
  });

  it("can explain downgrades from peg movement", () => {
    const previous = snapshot({
      grade: "B",
      score: 72,
      explain: {
        schemaVersion: 1,
        dimensions: { pegStability: { grade: "A", score: 96, detail: "Peg score 96/100" } },
      },
    });
    const current = snapshot({
      grade: "D",
      score: 42,
      explain: {
        schemaVersion: 1,
        stages: { postPegScore: 42 },
        dimensions: { pegStability: { grade: "D", score: 42, detail: "Peg score 42/100" } },
      },
    });

    const [result] = addSafetyReasonLines(
      [{ ...BASE_CHANGE, newGrade: "D", newScore: 42 }],
      current,
      previous,
    );

    expect(result.contextLine).toBe(
      "Reason: Peg stability fell A -> D (96 -> 42). Now: Peg score 42/100.",
    );
  });

  it("can explain downgrades from dependency-risk movement", () => {
    const previous = snapshot({
      grade: "B",
      score: 72,
      explain: {
        schemaVersion: 1,
        dimensions: { dependencyRisk: { grade: "A", score: 90, detail: "Dependency score 90/100" } },
      },
    });
    const current = snapshot({
      grade: "C+",
      score: 61,
      explain: {
        schemaVersion: 1,
        dimensions: { dependencyRisk: { grade: "C+", score: 61, detail: "Dependency score 61/100" } },
      },
    });

    const [result] = addSafetyReasonLines(
      [{ ...BASE_CHANGE, newGrade: "C+", newScore: 61 }],
      current,
      previous,
    );

    expect(result.contextLine).toBe(
      "Reason: Dependency Risk fell A -> C+ (90 -> 61). Now: Dependency score 61/100.",
    );
  });

  it("ranks dimension movements by weighted score impact", () => {
    const previous = snapshot({
      grade: "B",
      score: 72,
      explain: {
        schemaVersion: 1,
        dimensions: {
          liquidity: { grade: "B", score: 72, detail: "DEX liquidity 72/100" },
          decentralization: { grade: "B", score: 72, detail: "Decentralization 72/100" },
        },
      },
    });
    const current = snapshot({
      grade: "C+",
      score: 61,
      explain: {
        schemaVersion: 1,
        dimensions: {
          liquidity: { grade: "C+", score: 52, detail: "DEX liquidity 52/100" },
          decentralization: { grade: "F", score: 42, detail: "Decentralization 42/100" },
        },
      },
    });

    const [result] = addSafetyReasonLines(
      [{ ...BASE_CHANGE, newGrade: "C+", newScore: 61 }],
      current,
      previous,
    );

    expect(result.contextLine).toBe(
      "Reason: Liquidity / Exit fell B -> C+ (72 -> 52). Now: DEX liquidity 52/100.",
    );
  });

  it("uses the dimension movement matching an upgrade", () => {
    const previous = snapshot({
      grade: "D",
      score: 42,
      explain: {
        schemaVersion: 1,
        dimensions: { liquidity: { grade: "D", score: 42, detail: "DEX liquidity 42/100" } },
      },
    });
    const current = snapshot({
      grade: "C+",
      score: 61,
      explain: {
        schemaVersion: 1,
        dimensions: { liquidity: { grade: "C+", score: 61, detail: "DEX liquidity 61/100" } },
      },
    });

    const [result] = addSafetyReasonLines(
      [{ ...BASE_CHANGE, oldGrade: "D", oldScore: 42, newGrade: "C+", newScore: 61 }],
      current,
      previous,
    );

    expect(result.contextLine).toBe(
      "Reason: Liquidity / Exit improved D -> C+ (42 -> 61). Now: DEX liquidity 61/100.",
    );
  });

  it("does not use blacklist or freeze copy as causal detail", () => {
    const previous = snapshot({
      grade: "B",
      score: 72,
      explain: {
        schemaVersion: 1,
        dimensions: { decentralization: { grade: "B", score: 72, detail: "Multisig controls 72/100" } },
      },
    });
    const current = snapshot({
      grade: "F",
      score: 39,
      explain: {
        schemaVersion: 1,
        dimensions: {
          decentralization: {
            grade: "F",
            score: 20,
            detail: "Blacklist and freeze function added",
          },
        },
      },
    });

    const [result] = addSafetyReasonLines([BASE_CHANGE], current, previous);

    expect(result.contextLine).toBe("Reason: Decentralization fell B -> F (72 -> 20).");
    expect(result.contextLine).not.toMatch(/blacklist|freeze/i);
  });

  it("falls back to score movement while preserving a Reason prefix for legacy snapshots", () => {
    const previous = snapshot({ grade: "B", score: 72 });
    const current = snapshot({ grade: "C+", score: 61 });

    const [result] = addSafetyReasonLines(
      [{ ...BASE_CHANGE, newGrade: "C+", newScore: 61 }],
      current,
      previous,
      new Map([["coin", "Context: Safety C+ 61 · Supply $10.0M"]]),
    );

    expect(result.contextLine).toBe(
      "Reason: Safety Score declined from 72 to 61. Now: Safety C+ 61 · Supply $10.0M.",
    );
  });

  it("uses neutral dimension wording when grade and score directions conflict", () => {
    const previous = snapshot({
      grade: "B",
      score: 72,
      explain: {
        schemaVersion: 1,
        dimensions: { liquidity: { grade: "B", score: 72, detail: "DEX liquidity 72/100" } },
      },
    });
    const current = snapshot({
      grade: "C+",
      score: 74,
      explain: {
        schemaVersion: 1,
        dimensions: { liquidity: { grade: "C+", score: 74, detail: "DEX liquidity 74/100" } },
      },
    });

    const [result] = addSafetyReasonLines(
      [{ ...BASE_CHANGE, newGrade: "C+", newScore: 74 }],
      current,
      previous,
    );

    expect(result.contextLine).toBe(
      "Reason: Liquidity / Exit changed B -> C+ (72 -> 74). Now: DEX liquidity 74/100.",
    );
  });
});

function snapshot(row: Record<string, unknown>): SafetySnapshot {
  return {
    coin: {
      methodologyVersion: "v1",
      ...row,
    },
  } as unknown as SafetySnapshot;
}

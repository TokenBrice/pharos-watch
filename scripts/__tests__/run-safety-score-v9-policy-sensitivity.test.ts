import { describe, expect, it, vi } from "vitest";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9-research";
import {
  generateV9PolicySensitivityReport,
  listV9PolicySensitivityNumericPaths,
  parseV9PolicySensitivityArgs,
  runV9PolicySensitivityCli,
} from "../maintenance/run-safety-score-v9-policy-sensitivity";

const V9_EVALUATION_TEST_TIMEOUT_MS = 30_000;

describe("Safety Score v9 V9 policy sensitivity", { timeout: V9_EVALUATION_TEST_TIMEOUT_MS }, () => {
  it("produces deterministic one-parameter V9 cases with distinct semantic digests", () => {
    const options = {
      parameterPaths: ["semantic.formula.compensabilityHeadroom"],
      deltas: [-1, 1],
    } as const;

    const first = generateV9PolicySensitivityReport(options);
    const second = generateV9PolicySensitivityReport(options);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schemaVersion: 1,
      reportKind: "safety-score-v9-policy-sensitivity-research",
      researchOnly: true,
      baseline: {
        policyId: V9_CANDIDATE_POLICY_V1.policy.policyId,
        lifecycle: "active",
        semanticDigest: V9_CANDIDATE_POLICY_V1.semanticDigest,
        scenarioCount: 34,
        pairwiseConstraintCount: 31,
        pairwiseViolationCount: 0,
      },
      selection: {
        parameterPaths: ["semantic.formula.compensabilityHeadroom"],
        explicitDeltas: [-1, 1],
      },
    });
    expect(first.cases).toHaveLength(2);
    expect(first.cases.every((item) => item.pairwiseConstraints.length === 31)).toBe(true);
    expect(first.summary.pairwiseEvaluationCount).toBe(62);
    expect(first.cases.map((item) => item.value)).toEqual([19, 21]);
    expect(first.cases.every((item) => item.policyDigest !== first.baseline.semanticDigest)).toBe(true);
    expect(
      first.cases.every((item) => item.affectedScenarioIds.toSorted().join() === item.affectedScenarioIds.join()),
    ).toBe(true);
  });

  it("reports a perturbation that violates a durable ordering constraint", () => {
    // Lowering the active-depeg:d cap by one narrows the moderate-vs-severe
    // depeg gap from 10 to 9. Raising the active-depeg:f cap (its old form)
    // would break the same gap but now escapes its F grade band and is
    // rejected at policy load by the VER-005 band-coupling invariant, so this
    // exercises the harness's pairwise reporting with a schema-valid case.
    const report = generateV9PolicySensitivityReport({
      parameterPaths: ["semantic.formula.activeDepegCaps[1].limit"],
      deltas: [-1],
    });

    expect(report.summary.newPairwiseViolationCount).toBeGreaterThan(0);
    expect(report.summary.affectedPairwiseConstraintIds).toContain("active-depeg-d>active-depeg-f");
    expect(
      report.cases[0]!.pairwiseConstraints.find(
        (constraint) => constraint.constraintId === "active-depeg-d>active-depeg-f",
      ),
    ).toMatchObject({
      minGap: 10,
      actualGap: { from: 10, to: 9, delta: -1 },
      passed: { from: true, to: false, changed: true },
    });
  });

  it("reports grade cliffs and binding-cap saturation without asset-specific overrides", () => {
    const gradeReport = generateV9PolicySensitivityReport({
      parameterPaths: ["semantic.formula.gradeThresholds[0].minScore"],
      deltas: [-1],
    });
    const pegReport = generateV9PolicySensitivityReport({
      parameterPaths: ["semantic.formula.pegExponent"],
      deltas: [-0.05, 0.05],
    });

    expect(gradeReport.summary.gradeCliffCount).toBeGreaterThan(0);
    expect(gradeReport.cases[0]!.gradeCliffs.every((cliff) => cliff.fromScore === cliff.toScore)).toBe(true);
    expect(gradeReport.cases[0]!.discontinuities.every((item) => item.kinds.includes("grade-cliff"))).toBe(true);
    expect(gradeReport.summary.affectedArchetypes.length).toBeGreaterThan(0);
    expect(pegReport.summary.maskedByBindingCapCount).toBeGreaterThan(0);
    expect(pegReport.summary.maskedByRoundingCount).toBeGreaterThan(0);
    expect(pegReport.summary.bindingCapChangeCount).toBe(0);
    expect(JSON.stringify({ gradeReport, pegReport })).not.toMatch(/assetOverrides|assetIdsByPolicy|exceptionsByAsset/);
  });

  it("reports non-binding cap changes hidden by a tighter cap", () => {
    const report = generateV9PolicySensitivityReport({
      parameterPaths: ["semantic.evidence.ceilings.adequate"],
      deltas: [1],
    });
    const sensitivityCase = report.cases[0]!;

    expect(report.summary.capCandidateChangeCount).toBeGreaterThan(0);
    expect(report.summary.bindingCapChangeCount).toBe(0);
    expect(sensitivityCase.capCandidateChanges.length).toBeGreaterThan(0);
    expect(
      sensitivityCase.changes
        .filter((change) => change.capCandidates.changed)
        .every((change) => change.finalScore.from === change.finalScore.to),
    ).toBe(true);
    expect(sensitivityCase.scoreSaturation.maskedByBindingCapScenarioIds.length).toBeGreaterThan(0);
  });

  it("lists runnable isolated numeric paths without coupled weights or reference fields", () => {
    const stdout = vi.fn();
    runV9PolicySensitivityCli(["--list-parameters"], { stdout, writeOutput: vi.fn() });
    const paths = JSON.parse(stdout.mock.calls[0]![0]) as string[];

    expect(paths).toEqual(listV9PolicySensitivityNumericPaths());
    expect(paths).toContain("semantic.formula.compensabilityHeadroom");
    expect(paths).not.toContain("semantic.formula.pillarWeights.backing");
    expect(paths).not.toContain("semantic.exit.componentWeights.access");
    expect(paths).not.toContain("semantic.exit.stressRequest.referenceNotionalUsd");
    expect(paths).not.toContain("semantic.exit.stressRequest.notionalGridUsd[1]");
    expect(paths).not.toContain("policyId");
    expect(paths).toEqual(paths.toSorted());

    expect(() =>
      generateV9PolicySensitivityReport({ parameterPaths: ["semantic.notAParameter"], deltas: [1] }),
    ).toThrow("Unknown or non-numeric policy parameter");
    expect(() =>
      generateV9PolicySensitivityReport({
        parameterPaths: ["semantic.formula.pillarWeights.backing"],
        deltas: [0.01],
      }),
    ).toThrow("Invalid sensitivity case");
  });

  it("runs the default perturbations for every listed parameter", () => {
    const paths = listV9PolicySensitivityNumericPaths();
    const report = generateV9PolicySensitivityReport({ parameterPaths: paths });

    expect(report.selection).toEqual({ parameterPaths: paths, explicitDeltas: null });
    expect(report.cases).toHaveLength(paths.length * 2);
    expect(new Set(report.cases.map((item) => item.parameterPath))).toEqual(new Set(paths));
  });

  it("parses strict repeatable CLI arguments", () => {
    expect(
      parseV9PolicySensitivityArgs(["--parameter", "semantic.formula.pegExponent", "--delta", "-0.05", "--delta=0.05"]),
    ).toMatchObject({
      parameterPaths: ["semantic.formula.pegExponent"],
      deltas: [-0.05, 0.05],
      outputPath: null,
    });
    expect(() => parseV9PolicySensitivityArgs(["--unknown"])).toThrow();
    expect(() => parseV9PolicySensitivityArgs(["unexpected"])).toThrow();
    expect(() => parseV9PolicySensitivityArgs(["--delta", "0"])).toThrow("--delta must not be zero");
    expect(() => parseV9PolicySensitivityArgs(["--output", "a", "--output", "b"])).toThrow(
      "--output may only be specified once",
    );
  });

  it("writes only when --output is explicit", () => {
    const stdout = vi.fn();
    const writeOutput = vi.fn();

    runV9PolicySensitivityCli(["--parameter", "semantic.formula.compensabilityHeadroom", "--delta", "1"], {
      stdout,
      writeOutput,
    });
    expect(stdout).toHaveBeenCalledOnce();
    expect(writeOutput).not.toHaveBeenCalled();

    stdout.mockClear();
    runV9PolicySensitivityCli(
      ["--parameter", "semantic.formula.compensabilityHeadroom", "--delta", "1", "--output", "sensitivity.json"],
      { stdout, writeOutput },
    );
    expect(stdout).not.toHaveBeenCalled();
    expect(writeOutput).toHaveBeenCalledOnce();
    expect(writeOutput).toHaveBeenCalledWith("sensitivity.json", expect.stringContaining('"researchOnly": true'));
  });
});

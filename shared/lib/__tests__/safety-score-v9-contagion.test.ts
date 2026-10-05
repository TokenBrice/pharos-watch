import { describe, expect, it } from "vitest";
import { compileNativeV3FactSet, coreFixture, V9_CANDIDATE_POLICY_V1, AS_OF_SEC } from "./safety-score-v9-facts.fixture-support";
import { evaluateValidatedV9FactSet, evaluateValidatedV9FactSetForPublication, projectV9EffectiveBackingPillarScore } from "../safety-score-v9/evaluate-set";
import { evaluateV9ContagionScenario } from "../safety-score-v9/contagion";
import { ContagionResultSchema, type ContagionShock } from "../../types/contagion";
import { V9FactSetCoreV3Schema } from "../../types/safety-score-v9-facts";
import { stableJsonStringifyV1 } from "../stable-json";

function fixture() {
  const compiled = compileNativeV3FactSet(coreFixture());
  const { v9FactSetDigest: _digest, ...rawCompileInput } = compiled;
  return { compiled, input: { rawCompileInput, policy: V9_CANDIDATE_POLICY_V1, clock: AS_OF_SEC, publicationGenerationId: "fixture-publication" } };
}
const evaluate = (shocks: ContagionShock[]) => evaluateV9ContagionScenario(fixture().input, { id: "fixture-scenario", shocks });

describe("hypothetical V9 contagion reruns", () => {
  it("projects the same dependency-sensitive rows and digests without retaining full asset graphs", () => {
    const { compiled, input } = fixture();
    const full = evaluateValidatedV9FactSet(compiled, input.policy);
    const rows = new Map<string, string>();
    const owner = { factSet: compiled as typeof compiled | null };
    const projected = evaluateValidatedV9FactSetForPublication(owner, input.policy, (asset) => {
      expect(owner.factSet).toBeNull();
      rows.set(asset.assetId, stableJsonStringifyV1(asset));
    });
    const { assets, ...identity } = full;
    expect(projected).toEqual(identity);
    expect([...rows.keys()].sort()).toEqual(assets.map((asset) => asset.assetId));
    for (const asset of assets) expect(rows.get(asset.assetId)).toBe(stableJsonStringifyV1(asset));
    expect(projected).not.toHaveProperty("assets");
    expect(owner.factSet).toBeNull();
  });

  it("preserves full-set score, grade and pillar parity with zero shocks", () => {
    const { compiled, input } = fixture();
    const baseline = evaluateValidatedV9FactSet(compiled, input.policy);
    const result = evaluateV9ContagionScenario(input, { id: "zero", shocks: [] });
    for (const asset of baseline.assets) {
      expect(result.rows.find((row) => row.coinId === asset.assetId)).toMatchObject({
        baselineScore: asset.trace.finalScore, scenarioScore: asset.trace.finalScore,
        baselineGrade: asset.trace.finalGrade, scenarioGrade: asset.trace.finalGrade,
        baselineRatingStatus: asset.trace.ratingStatus, scenarioRatingStatus: asset.trace.ratingStatus,
        changedDimensions: [], delta: asset.trace.finalScore === null ? null : 0,
      });
    }
  });

  it("limits serial final inheritance without treating a final limit as basket impairment", () => {
    const basket = evaluate([{ kind: "score-limit", assetId: "beta", dimension: "final", limit: 5 }]);
    expect(basket.rows.find((row) => row.coinId === "alpha")).toMatchObject({ delta: 0, changedDimensions: [] });
    const cFloor = V9_CANDIDATE_POLICY_V1.policy.semantic.formula.gradeThresholds.find(row => row.grade === "C-")!.minScore;
    const serial = evaluate([{ kind: "score-limit", assetId: "gamma", dimension: "final", limit: cFloor }]);
    expect(serial.rows.find((row) => row.coinId === "alpha")).toMatchObject({ scenarioScore: cFloor, scenarioRatingStatus: "rated", shortestHop: 1, changedDimensions: ["final"] });
  });

  it("keeps an unattributed danger-grade serial result NR with a nullable delta", () => {
    const result = evaluate([{ kind: "score-limit", assetId: "gamma", dimension: "final", limit: 5 }]);
    expect(result.rows.find((row) => row.coinId === "alpha")).toMatchObject({ scenarioScore: null, scenarioGrade: "NR", scenarioRatingStatus: "not-rated", delta: null, nr: true, bindingCause: "parent" });
    expect(result.manifest.nr).toBe(1);
  });

  it("applies backing limits through the backing projection, not grade midpoints", () => {
    const { compiled } = fixture();
    expect(projectV9EffectiveBackingPillarScore(evaluateValidatedV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets.find((row) => row.assetId === "beta")!)).toBeGreaterThan(5);
    const result = evaluate([{ kind: "score-limit", assetId: "beta", dimension: "backing", limit: 5 }]);
    expect(result.rows.find((row) => row.coinId === "alpha")!.changedDimensions).toContain("backing");
  });

  it.each<ContagionShock>([
    { kind: "depeg", assetId: "gamma", activeDepegBps: 1000, template: "one-day-history-and-exit-held" },
    { kind: "mint-control-compromise", assetId: "gamma" },
  ])("quarantines hypothetical provenance without mutating canonical compile input ($kind)", (shock) => {
    const { input } = fixture();
    const before = JSON.stringify(input.rawCompileInput);
    const result = evaluateV9ContagionScenario(input, { id: "assumed", shocks: [shock] });
    expect(ContagionResultSchema.parse(result)).toMatchObject({ hypothetical: true, provenance: { origin: "scenario-assumptions" }, identity: { publicationGenerationId: "fixture-publication" } });
    expect(JSON.stringify(input.rawCompileInput)).toBe(before);
    expect(result.rows.find((row) => row.coinId === "gamma")!.changedDimensions).toContain(shock.kind === "depeg" ? "final" : "control");
  });

  it("isolates hypothetical evidence and controls from shared source and sibling arrays", () => {
    const { input } = fixture();
    const rawCompileInput = V9FactSetCoreV3Schema.parse(input.rawCompileInput);
    const beta = rawCompileInput.assets.find((asset) => asset.assetId === "beta")!;
    const gamma = rawCompileInput.assets.find((asset) => asset.assetId === "gamma")!;
    const sharedEmpty: [] = [];
    beta.controls = gamma.controls = sharedEmpty;
    beta.gaps = gamma.gaps = sharedEmpty;
    gamma.evidence = beta.evidence;
    const sourceBefore = JSON.stringify(rawCompileInput);
    const baseline = evaluateV9ContagionScenario({ ...input, rawCompileInput }, { id: "shared-zero", shocks: [] });
    const scenario = evaluateV9ContagionScenario({ ...input, rawCompileInput }, {
      id: "shared-assumption",
      shocks: [{ kind: "mint-control-compromise", assetId: "gamma" }],
    });
    const betaBefore = baseline.rows.find((row) => row.coinId === "beta")!;
    expect(scenario.rows.find((row) => row.coinId === "beta")).toMatchObject({
      scenarioScore: betaBefore.scenarioScore,
      scenarioGrade: betaBefore.scenarioGrade,
      scenarioRatingStatus: betaBefore.scenarioRatingStatus,
      changedDimensions: [],
      failure: null,
    });
    expect(scenario.rows.find((row) => row.coinId === "gamma")!.changedDimensions).toContain("control");
    expect(JSON.stringify(rawCompileInput)).toBe(sourceBefore);
    expect(beta.evidence.some((row) => row.sourceId === "hypothetical-scenario-assumption")).toBe(false);
    const repeated = evaluateV9ContagionScenario({ ...input, rawCompileInput }, { id: "shared-after", shocks: [] });
    expect(repeated.rows).toEqual(baseline.rows);
  });

  it("rejects a mixed publication clock instead of silently relabeling facts", () => {
    const { input } = fixture();
    expect(() => evaluateV9ContagionScenario({ ...input, clock: AS_OF_SEC + 1 }, { id: "mixed", shocks: [] })).toThrow("exact evaluation clock");
  });

  it("isolates a failed upstream intervention instead of retaining its successful-looking card", () => {
    const { compiled, input } = fixture();
    const baseline = evaluateValidatedV9FactSet(compiled, input.policy);
    const failures: string[] = [];
    const result = evaluateValidatedV9FactSet(compiled, input.policy, {
      projectUpstream(upstream) {
        if (upstream.assetId === "gamma") throw new Error("Root projection failed");
        return upstream;
      },
      onAssetError: (id) => { failures.push(id); },
    });
    expect(failures).toEqual(["gamma"]);
    expect(result.assets.find((asset) => asset.assetId === "gamma")).toBeUndefined();
    expect(result.assets.find((asset) => asset.assetId === "alpha")!.trace.finalGrade).toBe("NR");
    expect(result.assets.find((asset) => asset.assetId === "beta")!.trace.finalScore).toBe(
      baseline.assets.find((asset) => asset.assetId === "beta")!.trace.finalScore,
    );
  });
});

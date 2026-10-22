import { describe, expect, it } from "vitest";
import { resolveV9LocalAuthorityRisk, scoreV9WithControlReplaced, applyV9AssetPremium, type V9DeploymentAuthority } from "../safety-score-v9/formula";
import { resolveV9ScopedRisk, type V9ScopedRiskSignal } from "../safety-score-v9/scoped-risk";
import { aggregateV9SmoothBoundedHeadroom } from "../safety-score-v9/aggregation";
import { V9_CANDIDATE_POLICY_V1 as policy } from "../safety-score-v9/policy";
import { scoreV9EvaluatedAsset } from "../safety-score-v9/score";
import { makeV9Pillar as pillar, makeV9ProductionScoreInput, makeV9Signal } from "./safety-score-v9-score.test-support";

const pillars = { backing: 70, exit: 80, control: 70 };
const included = ["backing", "exit", "control"] as const;
const base = scoreV9WithControlReplaced(pillars, 90, 1, policy, included);
const sibling: V9ScopedRiskSignal = {
  signalKey: "chain:sibling", exposureKey: "common-mode:sibling", riskEventKey: "chain:sibling",
  failureDomainKeys: ["chain:sibling"], economicLossScope: "deployment", exposedScore: 64,
  exposureShare: 1, reason: "Overlapping infrastructure exposure.",
};
function authority(quality = 60, share = 0.12, deploymentKey = "vault"): V9DeploymentAuthority {
  return { deploymentKey, quality, share, failureDomainKeys: ["upgrade-control:root"], sourceSignals: [] };
}
function resolve(paths: readonly V9DeploymentAuthority[], signals: readonly V9ScopedRiskSignal[] = []) {
  return resolveV9LocalAuthorityRisk(base, signals, paths,
    (q) => scoreV9WithControlReplaced(pillars, q, 1, policy, included));
}

describe("Q* resolved local authority mixture", () => {
  it.each([60, 90])("owns same-controller common mode once at quality %s", (quality) => {
    const common = makeV9Signal({ failureDomainKeys: ["upgrade-control:ethereum:root"], materialSharePct: 100 });
    const local = makeV9ProductionScoreInput({ pillars: {
      backing: pillar(90), exit: pillar(90), control: pillar(90, { deploymentAuthorities: [{
        ...authority(quality, 1), controllerKeys: ["ethereum:root"],
      }] }),
    }, dependencyStructuralSignals: [common] });
    const global = makeV9ProductionScoreInput({ pillars: {
      backing: pillar(90), exit: pillar(90), control: pillar(quality),
    }, dependencyStructuralSignals: [{ ...common, pricedInPillar: "control" }] });
    const result = scoreV9EvaluatedAsset(local, policy);
    expect(result.preCapScore).toBe(scoreV9EvaluatedAsset(global, policy).preCapScore);
    expect(result.deploymentAdjustments).toHaveLength(1);
    if (quality === 90) expect(result.deploymentAdjustments[0]?.adjustmentPoints).toBe(0);
    expect(scoreV9EvaluatedAsset(JSON.parse(JSON.stringify(local)), policy)).toEqual(result);
    for (const failureDomainKeys of [["bridge:ethereum:root"], ["oracle-feed:ethereum:root"], ["chain:ethereum"]]) {
      const infrastructure = scoreV9EvaluatedAsset({ ...local,
        dependencyStructuralSignals: [{ ...common, failureDomainKeys }],
      }, policy);
      expect(infrastructure.deploymentAdjustments.some((row) => !row.signalKey.startsWith("local-authority:"))).toBe(true);
    }
  });

  it("restores the spUSDT-shaped shared-authority result to B−65", () => {
    const paths = [authority(60, 0.9891405992022939, "ethereum"), authority(60, 0.010665186661165968, "xlayer")]
      .map((path) => ({ ...path, controllerKeys: [`${path.deploymentKey}:root`] }));
    const input = makeV9ProductionScoreInput({
      pillars: { backing: pillar(54.603525414216364), exit: pillar(82.22),
        control: pillar(65, { deploymentAuthorities: paths }) },
      peg: { applicable: false, score: null, activeDepegBps: null, reasons: [] },
      dependencyStructuralSignals: paths.map((path) => makeV9Signal({
        failureDomainKeys: [`upgrade-control:${path.controllerKeys[0]}`],
        materialSharePct: path.share * 100,
      })),
    });
    const result = scoreV9EvaluatedAsset(input, policy);
    expect(result.finalScore).toBe(65);
    expect(result.finalGrade).toBe("B-");
    expect(result.preCapScore).toBeCloseTo(64.6253, 3);
    expect(result.deploymentAdjustments.every((row) => row.signalKey.startsWith("local-authority:"))).toBe(true);
  });

  it.each([{ signals: [] }, { signals: [sibling] }])("is monotone over share and quality with sibling pool $signals", ({ signals }) => {
    for (const q of [90, 75, 70, 65, 25]) {
      let previous = Infinity;
      for (let step = 0; step <= 1000; step++) {
        const score = resolve([authority(q, step / 1000)], signals).finalScore;
        expect(score).toBeLessThanOrEqual(previous + 1e-10);
        previous = score;
      }
    }
    for (const share of [0, 0.0999, 0.1, 0.5, 1]) {
      let previous = Infinity;
      for (let q = 90; q >= 25; q--) {
        const score = resolve([authority(q, share)], signals).finalScore;
        expect(score).toBeLessThanOrEqual(previous + 1e-10);
        previous = score;
      }
    }
  });

  it.each([{ signals: [] }, { signals: [sibling] }])("is globally equivalent at 100% including siblings $signals", ({ signals }) => {
    const global = resolveV9ScopedRisk(scoreV9WithControlReplaced(pillars, 60, 1, policy, included), signals);
    expect(resolve([authority(60, 1)], signals).finalScore).toBe(global.finalScore);
  });

  it("charges dominated paths exactly zero without diluting sibling deductions (CE1)", () => {
    const baseline = resolve([], [sibling]);
    for (const share of [0, 0.05, 0.0999, 0.1, 1]) {
      const result = resolve([authority(75, share)], [sibling]);
      expect(result.finalScore).toBe(baseline.finalScore);
      expect(result.adjustments[0]).toEqual(baseline.adjustments[0]);
      expect(result.adjustments[1]?.adjustmentPoints).toBe(0);
    }
  });

  it("groups controls on one slice at worst quality and preserves split/merge invariance", () => {
    const one = resolve([authority(60, 0.12)]);
    const two = resolve([authority(60, 0.06, "a"), authority(60, 0.06, "b")]);
    expect(two.finalScore).toBeCloseTo(one.finalScore, 12);
    const duplicate = resolve([authority(70, 0.12), authority(60, 0.12)]);
    expect(duplicate.finalScore).toBe(one.finalScore);
    expect(duplicate.adjustments).toHaveLength(1);
  });

  it("remains monotone for multi-slice partitions", () => {
    let previous = Infinity;
    for (let step = 0; step <= 700; step++) {
      const result = resolve([authority(25, step / 1000, "a"), authority(60, 0.3, "b")], [sibling]);
      expect(result.finalScore).toBeLessThanOrEqual(previous + 1e-10);
      previous = result.finalScore;
    }
  });

  it("never raises raw or published scores across roundoff integer boundaries", () => {
    const values = { backing: 93.237, exit: 90, control: 90 };
    const initial = scoreV9WithControlReplaced(values, 90, 1, policy, included);
    const calculate = (share: number, free = false) => resolveV9LocalAuthorityRisk(initial, [], [
      authority(25, 0.6, "a"), authority(60, share, "b"),
      ...(free ? [authority(100, 0.001, "c")] : []),
    ], (q) => scoreV9WithControlReplaced(values, q, 1, policy, included));
    const baseline = calculate(0.4);
    expect(Math.round(baseline.finalScore)).toBe(57);
    for (const share of [0.4001, 0.4005, 0.401, 0.4011]) {
      const result = calculate(share);
      expect(result.finalScore).toBeLessThanOrEqual(baseline.finalScore);
      expect(Math.round(result.finalScore)).toBeLessThanOrEqual(57);
      expect(result.adjustments[1]?.exposureShare).toBe(share);
    }
    expect(calculate(0.4, true).finalScore).toBe(baseline.finalScore);
  });

  it("never dilutes an adverse slice when adding real overlap, and emits a diagnostic", () => {
    const original = resolve([authority(25, 1, "a")]);
    const overlap = resolve([authority(25, 1, "a"), authority(60, 0.5, "b")]);
    expect(overlap.finalScore).toBe(original.finalScore);
    expect(overlap.adjustments.every((row) => row.reason.includes("overlapping authority slices"))).toBe(true);
    for (let step = 0; step <= 100; step++) {
      const before = resolve([authority(60, 0.8, "b")]).finalScore;
      expect(resolve([authority(60, 0.8, "b"), authority(25, step / 100, "a")]).finalScore).toBeLessThanOrEqual(before);
    }
  });

  it("uses priced-unknown Control rather than coercing null to zero", () => {
    const unknown = makeV9ProductionScoreInput({ pillars: {
      backing: pillar(90), exit: pillar(90),
      control: pillar(null, { aggregationDisposition: "unavailable", deploymentAuthorities: [authority(50, 1)] }),
    } });
    const actual = scoreV9EvaluatedAsset(unknown, policy);
    const global = scoreV9EvaluatedAsset(makeV9ProductionScoreInput({ pillars: {
      backing: pillar(90), exit: pillar(90), control: pillar(50),
    } }), policy);
    expect(actual.deploymentAdjustedScore).toBe(global.deploymentAdjustedScore);
    expect(actual.deploymentAdjustedScore).toBeGreaterThan(50);
  });

  it("excludes all caps and premium from counterfactuals and reuses injected aggregation and peg", () => {
    const local = authority(50, 0.5);
    const ordinary = makeV9ProductionScoreInput({ pillars: {
      backing: pillar(90), exit: pillar(90), control: pillar(90, { deploymentAuthorities: [local] }),
    }, peg: { applicable: true, score: 20, activeDepegBps: null, reasons: [] } });
    const baseline = scoreV9EvaluatedAsset(ordinary, policy);
    const capped = scoreV9EvaluatedAsset({ ...ordinary, trackRecordMonths: 0,
      parent: { required: true, score: 20, propagatedReasons: [] },
      peg: { ...ordinary.peg, activeDepegBps: 1000 },
      identity: { ...ordinary.identity, asOfSec: 1792689552 },
      realizedHolderLossEvents: [{
        incidentId: "loss", assetId: ordinary.assetId, scope: { kind: "holder-exit" },
        occurredAt: "2026-10-22", realizedHolderLossPct: 20, finding: "Measured loss.",
        primarySources: [{ label: "Holder loss", url: "https://example.com/loss", publishedAt: "2026-10-22" }],
      }],
    }, policy);
    expect(capped.deploymentAdjustments).toEqual(baseline.deploymentAdjustments);
    expect(capped.finalScore).toBeLessThanOrEqual(20);
    const premium = policy.policy.semantic.formula.assetPremiums[0]!;
    const adjusted = applyV9AssetPremium({ ...baseline, assetId: premium.assetId }, premium, policy);
    expect(adjusted.deploymentAdjustments).toEqual(baseline.deploymentAdjustments);
    const strategy = (...args: Parameters<typeof aggregateV9SmoothBoundedHeadroom>) => {
      const result = aggregateV9SmoothBoundedHeadroom(...args);
      return result === null ? null : { ...result, score: result.score / 2 };
    };
    expect(scoreV9WithControlReplaced(pillars, 60, 0.5, policy, included, strategy)).toBe(
      scoreV9WithControlReplaced(pillars, 60, 1, policy, included) / 4);
    expect(scoreV9WithControlReplaced(pillars, 90, 1, policy, included)).toBe(base);
  });

  it("removes authority structural signals from the resolver so one path pays once", () => {
    const signal = makeV9Signal({ kind: "centralized-mint", exposedScore: 50, materialSharePct: 20 });
    const input = makeV9ProductionScoreInput({ pillars: {
      backing: pillar(90), exit: pillar(90), control: pillar(90, {
        structuralSignals: [signal], deploymentAuthorities: [{ ...authority(50, 0.2), sourceSignals: [signal], sourceSignalIndices: [0] }],
      }),
    } });
    const trace = scoreV9EvaluatedAsset(input, policy);
    expect(trace.deploymentAdjustments).toHaveLength(1);
    expect(trace.deploymentAdjustments[0]?.signalKey).toMatch(/^local-authority:/);
    expect(trace.deploymentAdjustments[0]?.adjustmentPoints).toBeGreaterThan(0);
    expect(scoreV9EvaluatedAsset(JSON.parse(JSON.stringify(input)), policy)).toEqual(trace);
  });
  it("keeps a bridge incident in infrastructure even when its event identity matches local authority", () => {
    const signal = makeV9Signal({ kind: "active-control-incident", exposedScore: 25, materialSharePct: 20 });
    const bridgeIncident = { ...signal };
    const input = makeV9ProductionScoreInput({ pillars: {
      backing: pillar(90), exit: pillar(90), control: pillar(90, {
        structuralSignals: [signal, bridgeIncident],
        deploymentAuthorities: [{ ...authority(25, 0.2), sourceSignals: [signal], sourceSignalIndices: [0] }],
      }),
    } });
    const trace = scoreV9EvaluatedAsset(input, policy);
    expect(trace.deploymentAdjustments).toHaveLength(2);
    expect(trace.deploymentAdjustments[0]?.signalKey).toMatch(/^signal:active-control-incident:/);
    expect(trace.deploymentAdjustments[0]?.exposedScore).toBe(25);
    expect(trace.deploymentAdjustments[1]?.signalKey).toMatch(/^local-authority:/);
    expect(scoreV9EvaluatedAsset(JSON.parse(JSON.stringify(input)), policy)).toEqual(trace);
  });

  it("pins infrastructure allocation independently of local-authority exposure", () => {
    const signals = [
      { ...sibling, exposureKey: "chain:monad", exposureShare: 0.53 },
      { ...sibling, signalKey: "chain:linea", exposureKey: "chain:linea", exposureShare: 0.7 },
      { ...sibling, signalKey: "critical:shared", exposureKey: "critical:shared", exposureShare: 1 },
    ];
    const baseline = resolve([], signals);
    const result = resolve([authority(60, 0.2884)], signals);
    expect(result.adjustments.slice(0, 3)).toEqual(baseline.adjustments);
    expect(result.adjustments.find((row) => row.exposureKey === "chain:monad")?.exposureShare).toBeCloseTo(0.53 / 2.23, 12);
  });
});

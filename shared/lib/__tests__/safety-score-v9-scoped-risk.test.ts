import { describe, expect, it } from "vitest";
import { resolveV9ScopedRisk, type V9ScopedRiskSignal } from "../safety-score-v9/scoped-risk";

function deployment(overrides: Partial<V9ScopedRiskSignal> = {}): V9ScopedRiskSignal {
  return {
    signalKey: "chain:xlayer",
    exposureKey: "deployment:xlayer",
    riskEventKey: "chain-failure:xlayer",
    failureDomainKeys: ["chain:xlayer"],
    economicLossScope: "deployment",
    exposedScore: 40,
    exposureShare: 0.1,
    reason: "A deployment-local failure affects ten percent of supply.",
    ...overrides,
  };
}

describe("Safety Score v9 scoped risk", () => {
  it("prices a deployment failure as an average-holder adjustment", () => {
    const result = resolveV9ScopedRisk(80, [deployment()]);
    expect(result.finalScore).toBe(76);
    expect(result.adjustments).toEqual([
      expect.objectContaining({
        scoreBefore: 80,
        scoreAfter: 76,
        adjustmentPoints: 4,
        exposureShare: 0.1,
      }),
    ]);
    expect(result.globalCaps).toEqual([]);
  });

  it("keeps global claim impairment in the hard-cap path", () => {
    const signal = deployment({
      signalKey: "mint:global",
      failureDomainKeys: ["mint-control:global"],
      economicLossScope: "global-claim",
      exposureShare: 1,
      exposedScore: 39,
    });
    const result = resolveV9ScopedRisk(90, [signal]);
    expect(result.finalScore).toBe(90);
    expect(result.globalCaps).toEqual([signal]);
  });

  it("does not convert access-only or reserve-owned facts into a second composite penalty", () => {
    const access = deployment({
      signalKey: "freeze",
      failureDomainKeys: ["access:freeze"],
      economicLossScope: "access-only",
      exposedScore: 30,
    });
    const reserve = deployment({
      signalKey: "reserve",
      failureDomainKeys: ["reserve:bank"],
      economicLossScope: "reserve-claim",
      exposedScore: 20,
    });
    const result = resolveV9ScopedRisk(80, [access, reserve]);
    expect(result.finalScore).toBe(80);
    expect(result.accessOnlySignals).toEqual([access]);
    expect(result.reserveSignals).toEqual([reserve]);
  });

  it("is idempotent for repeated references to one exposure event", () => {
    const single = resolveV9ScopedRisk(80, [
      deployment({ signalKey: "control:xlayer", exposedScore: 40 }),
    ]);
    const result = resolveV9ScopedRisk(80, [
      deployment({ signalKey: "control:xlayer", exposedScore: 40 }),
      deployment({ signalKey: "common-mode:xlayer", exposedScore: 40 }),
    ]);
    expect(result.adjustments).toHaveLength(1);
    expect(result.adjustments[0]?.signalKey).toBe("common-mode:xlayer+control:xlayer");
    expect(result.finalScore).toBe(single.finalScore);
  });

  it("adds disjoint exposure slices even when they share a provider domain and percentage", () => {
    const result = resolveV9ScopedRisk(100, [
      deployment({
        signalKey: "deployment-a",
        exposureKey: "deployment:a",
        riskEventKey: "provider-failure:shared",
        failureDomainKeys: ["bridge:shared"],
        exposedScore: 0,
      }),
      deployment({
        signalKey: "deployment-b",
        exposureKey: "deployment:b",
        riskEventKey: "provider-failure:shared",
        failureDomainKeys: ["bridge:shared"],
        exposedScore: 0,
      }),
    ]);
    expect(result.adjustments).toHaveLength(2);
    expect(result.adjustments.map((adjustment) => adjustment.exposureKey)).toEqual([
      "deployment:a",
      "deployment:b",
    ]);
    expect(result.finalScore).toBe(80);
  });

  it("is invariant to disjoint domain names and input order", () => {
    const left = resolveV9ScopedRisk(90, [
      deployment({
        signalKey: "one",
        exposureKey: "deployment:one",
        riskEventKey: "event:one",
        failureDomainKeys: ["domain:a"],
        exposedScore: 40,
        exposureShare: 0.2,
      }),
      deployment({
        signalKey: "two",
        exposureKey: "deployment:two",
        riskEventKey: "event:two",
        failureDomainKeys: ["domain:z"],
        exposedScore: 70,
        exposureShare: 0.5,
      }),
    ]);
    const renamed = resolveV9ScopedRisk(90, [
      deployment({
        signalKey: "two",
        exposureKey: "deployment:two",
        riskEventKey: "event:two",
        failureDomainKeys: ["domain:a"],
        exposedScore: 70,
        exposureShare: 0.5,
      }),
      deployment({
        signalKey: "one",
        exposureKey: "deployment:one",
        riskEventKey: "event:one",
        failureDomainKeys: ["domain:z"],
        exposedScore: 40,
        exposureShare: 0.2,
      }),
    ]);

    expect(left.finalScore).toBe(70);
    expect(renamed.finalScore).toBe(70);
    expect(left.adjustments.reduce((sum, adjustment) => sum + adjustment.adjustmentPoints, 0)).toBe(20);
    expect(renamed.adjustments.reduce((sum, adjustment) => sum + adjustment.adjustmentPoints, 0)).toBe(20);
  });

  it("does not double count overlapping events on one proven holder slice", () => {
    const result = resolveV9ScopedRisk(82, [
      deployment({
        signalKey: "material-bridge",
        exposureKey: "deployment:bridge-a",
        riskEventKey: "bridge-event:combined",
        failureDomainKeys: ["bridge:contract", "bridge:protocol"],
        exposedScore: 74,
        exposureShare: 0.1155,
      }),
      deployment({
        signalKey: "contract-common-mode",
        exposureKey: "deployment:bridge-a",
        riskEventKey: "bridge-event:contract",
        failureDomainKeys: ["bridge:contract"],
        exposedScore: 79,
        exposureShare: 0.1317,
      }),
      deployment({
        signalKey: "protocol-common-mode",
        exposureKey: "deployment:bridge-a",
        riskEventKey: "bridge-event:protocol",
        failureDomainKeys: ["bridge:protocol"],
        exposedScore: 79,
        exposureShare: 0.1317,
      }),
    ]);

    expect(result.adjustments).toEqual([
      expect.objectContaining({
        exposureKey: "deployment:bridge-a",
        riskEventKey: "bridge-event:combined",
        failureDomainKey: "bridge:contract+bridge:protocol",
        exposedScore: 74,
        exposureShare: 0.1155,
      }),
    ]);
    expect(result.finalScore).toBeCloseTo(81.076, 4);
  });

  it("never pairs one signal's severity with another signal's exposure share", () => {
    const result = resolveV9ScopedRisk(100, [
      deployment({
        signalKey: "wide",
        riskEventKey: "event:wide",
        exposedScore: 50,
        exposureShare: 0.9,
      }),
      deployment({
        signalKey: "deep",
        riskEventKey: "event:deep",
        exposedScore: 0,
        exposureShare: 0.01,
      }),
    ]);
    expect(result.adjustments).toEqual([
      expect.objectContaining({
        signalKey: "wide",
        exposedScore: 50,
        nominalExposureShare: 0.9,
        exposureShare: 0.9,
      }),
    ]);
    expect(result.finalScore).toBe(55);
  });

  it("retains unknown deployment materiality as unresolved instead of assuming whole-asset loss", () => {
    const signal = deployment({ exposureShare: null });
    const result = resolveV9ScopedRisk(80, [signal]);
    expect(result.finalScore).toBe(80);
    expect(result.unresolvedDeploymentSignals).toEqual([signal]);
  });

  it("is monotonic in base quality, local quality, and lower exposure", () => {
    const baseline = resolveV9ScopedRisk(80, [deployment()]).finalScore;
    expect(resolveV9ScopedRisk(81, [deployment()]).finalScore).toBeGreaterThanOrEqual(baseline);
    expect(resolveV9ScopedRisk(80, [deployment({ exposedScore: 41 })]).finalScore).toBeGreaterThanOrEqual(baseline);
    expect(resolveV9ScopedRisk(80, [deployment({ exposureShare: 0.09 })]).finalScore).toBeGreaterThanOrEqual(baseline);
  });

  it("normalizes nominal exposure above one without reversing base-score monotonicity", () => {
    const signals = [
      deployment({
        signalKey: "a",
        exposureKey: "deployment:a",
        riskEventKey: "event:a",
        failureDomainKeys: ["domain:a"],
        exposureShare: 0.6,
        exposedScore: 50,
      }),
      deployment({
        signalKey: "b",
        exposureKey: "deployment:b",
        riskEventKey: "event:b",
        failureDomainKeys: ["domain:b"],
        exposureShare: 0.6,
        exposedScore: 50,
      }),
    ];
    const lower = resolveV9ScopedRisk(60, signals);
    const higher = resolveV9ScopedRisk(70, [...signals].reverse());
    expect(lower.adjustments.map((adjustment) => adjustment.exposureShare)).toEqual([0.5, 0.5]);
    expect(higher.adjustments.map((adjustment) => adjustment.exposureShare)).toEqual([0.5, 0.5]);
    expect(higher.finalScore).toBeGreaterThanOrEqual(lower.finalScore);
    expect(lower.finalScore).toBe(50);
    expect(higher.finalScore).toBe(50);
  });
});

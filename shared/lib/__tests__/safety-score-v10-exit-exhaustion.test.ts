import { describe, expect, it } from "vitest";
import { evaluateV9Exit } from "@shared/lib/safety-score-v9/exit";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { makeExitRoute } from "./safety-score-v9-exit.test-support";

const policy = V9_CANDIDATE_POLICY_V1;
const point = (executableUsd: number) => ({ requestedNotionalUsd: 1_000_000, maxCostBps: 200,
  executableUsd, completionRatio: executableUsd / 1_000_000, executionCostBps: 0 });

describe("Exit exhaustion requires an exhaustive measurement", () => {
  it.each([0, 667.62])("does not infer exhaustion from a $%s exact lower bound", (executableUsd) => {
    const result = evaluateV9Exit({ circulatingUsd: 20_000_000, portfolioStatus: "reviewed-complete",
      routes: [makeExitRoute({ coverageClass: "exact-lower-bound", capacityCurve: [point(executableUsd)] })],
    }, policy);
    expect(result.score).toBe(policy.policy.semantic.exit.boundedUnknownScore);
    expect(result.reasons).toContain("missing-same-notional-route");
    expect(result.reasons).not.toContain("no-viable-exit-path");
    expect(result.routes[0]!.capsApplied).not.toContain("immaterial-executable-capacity");
    expect(result.routes[0]!.capsApplied).not.toContain("zero-executable-capacity");
  });

  it("does not promote non-score-eligible documented zero to a measurement", () => {
    const result = evaluateV9Exit({ circulatingUsd: 20_000_000, portfolioStatus: "reviewed-complete",
      routes: [makeExitRoute({ scoreEligible: false, evidenceKind: "documented-terms",
        observationConfidence: "low", modelConfidence: "low", capacityCurve: [point(0)] })],
    }, policy);
    expect(result.score).toBe(policy.policy.semantic.exit.boundedUnknownScore);
    expect(result.reasons).toContain("missing-same-notional-route");
    expect(result.reasons).not.toContain("no-viable-exit-path");
  });

  it.each([0, 667.62])("keeps a $%s exact-complete measurement adverse", (executableUsd) => {
    const result = evaluateV9Exit({ circulatingUsd: 20_000_000, portfolioStatus: "reviewed-complete",
      routes: [makeExitRoute({ capacityCurve: [point(executableUsd)] })],
    }, policy);
    expect(result.score).toBe(0);
    expect(result.reasons).toContain("no-viable-exit-path");
    expect(result.routes[0]!.included).toBe(true);
  });

  it("retains exact-complete measured zero when its observation ages from known to stale", () => {
    const results = (["known", "stale"] as const).map((observationState) => evaluateV9Exit({
      circulatingUsd: 20_000_000,
      portfolioStatus: "reviewed-complete",
      routes: [makeExitRoute({ observationState, capacityCurve: [point(0)] })],
    }, policy));
    const known = results[0]!;
    const stale = results[1]!;
    expect(known.score).toBe(0);
    expect(stale.score).toBe(known.score);
    expect(stale.reasons).toContain("no-viable-exit-path");
    expect(stale.reasons).not.toContain("missing-same-notional-route");
    expect(stale.routes[0]).toMatchObject({
      included: true, score: 0, capacityPoint: { executableUsd: 0 },
      capsApplied: expect.arrayContaining(["zero-executable-capacity", "observation:stale"]),
    });
  });

  it("still credits the material capacity proved by a lower bound", () => {
    const result = evaluateV9Exit({ circulatingUsd: 20_000_000, portfolioStatus: "reviewed-complete",
      routes: [makeExitRoute({ coverageClass: "exact-lower-bound", capacityCurve: [point(1_000_000)] })],
    }, policy);
    expect(result.score).toBeGreaterThan(policy.policy.semantic.exit.boundedUnknownScore);
    expect(result.primaryRouteKey).toBe("redemption:issuer");
    expect(result.routes[0]!.capacityPoint!.executableUsd).toBe(1_000_000);
  });

  it("keeps the existing raw-capacity materiality boundary when valuing lower-bound credit", () => {
    const result = evaluateV9Exit({ circulatingUsd: 20_000_000, portfolioStatus: "reviewed-complete",
      routes: [makeExitRoute({ coverageClass: "exact-lower-bound", outputValueRetention: 0.9999,
        capacityCurve: [point(10_000)] })],
    }, policy);
    expect(result.routes[0]).toMatchObject({ included: true, capacityPoint: { executableUsd: 9_999 } });
    expect(result.score).toBeGreaterThan(policy.policy.semantic.exit.boundedUnknownScore);
  });

  it("bounds weak positive lower-bound credit without discarding its executable prefix", () => {
    const result = evaluateV9Exit({ circulatingUsd: 20_000_000, portfolioStatus: "reviewed-complete",
      routes: [makeExitRoute({ coverageClass: "exact-lower-bound", observationConfidence: "low",
        modelConfidence: "low", settlement: "queued", settlementDelaySec: 30 * 86_400,
        capacityCurve: [point(100_000)] })],
    }, policy);
    expect(result.score).toBe(policy.policy.semantic.exit.boundedUnknownScore);
    expect(result.reasons).not.toContain("missing-same-notional-route");
    expect(result.reasons).not.toContain("no-viable-exit-path");
    expect(result.routes[0]).toMatchObject({ included: true, capacityPoint: { executableUsd: 100_000 } });
  });

  it.each([
    { coverageClass: "exact-lower-bound" as const },
    { scoreEligible: false, lane: "dex" as const, routeFamily: "dex-amm" as const },
    { executionModelId: "unreviewed-model" },
    { outputResolved: false },
  ])("cannot infer whole-token exhaustion alongside an unmeasured alternative %j", (alternative) => {
    const result = evaluateV9Exit({ circulatingUsd: 20_000_000, portfolioStatus: "reviewed-complete",
      routes: [makeExitRoute({ capacityCurve: [point(0)] }),
        makeExitRoute({ routeKey: "redemption:alternative", capacityCurve: [point(0)], ...alternative })],
    }, policy);
    expect(result.score).toBe(policy.policy.semantic.exit.boundedUnknownScore);
    expect(result.reasons).toContain("missing-same-notional-route");
    expect(result.reasons).not.toContain("no-viable-exit-path");
  });

  it("does not treat an unavailable execution certificate as measured absence", () => {
    const result = evaluateV9Exit({ circulatingUsd: 20_000_000, portfolioStatus: "reviewed-complete",
      routes: [makeExitRoute({ executionModelId: "unreviewed-model" })],
    }, policy);
    expect(result.score).toBe(policy.policy.semantic.exit.boundedUnknownScore);
    expect(result.reasons).toContain("missing-same-notional-route");
    expect(result.reasons).not.toContain("no-viable-exit-path");
  });

  it.each(["reviewed-complete", "incomplete"] as const)("distinguishes a proven-empty %s inventory from unavailable coverage", (portfolioStatus) => {
    const result = evaluateV9Exit({ circulatingUsd: 20_000_000, portfolioStatus, routes: [] }, policy);
    if (portfolioStatus === "reviewed-complete") {
      expect(result.score).toBe(0);
      expect(result.reasons).toEqual(["no-viable-exit-path"]);
    } else {
      expect(result.score).toBe(policy.policy.semantic.exit.boundedUnknownScore);
      expect(result.reasons).toEqual(["missing-same-notional-route"]);
    }
  });
});

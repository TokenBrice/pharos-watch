import { describe, expect, it } from "vitest";
import type { V9DeploymentControlFactV2, V9FactStatusV2 } from "../../types/safety-score-v9-facts";
import {
  evaluateV9AccessPosture,
  type EvaluateV9AccessPostureArgs,
  type V9AccessPostureAssetFacts,
} from "../safety-score-v9/access-posture";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import { missing, notApplicable, requiredKnown, stale } from "./safety-score-v9-fixtures.test-support";

function control(
  controlKey: string,
  controlKind: V9DeploymentControlFactV2["controlKind"],
  capabilities: V9DeploymentControlFactV2["capabilities"],
  overrides: Partial<V9DeploymentControlFactV2> = {},
): V9DeploymentControlFactV2 {
  return {
    controlKey,
    deploymentKey: `deployment:${controlKey}`,
    sourceGenerationId: "research:fixture",
    controlKind,
    scope: "global",
    status: requiredKnown(`control.${controlKey}`),
    capabilities,
    capSemantics: { kind: "bounded", bound: { amount: 0.1, unit: "supply-fraction" } },
    claimImpairment: "bounded",
    economicLossScope: "global-claim",
    authority: { authorityKey: `authority:${controlKey}`, model: "issuer-backend", threshold: null },
    delaySec: 0,
    materialSupplyShare: null,
    keyCustody: "unknown",
    modulesOrGuards: "unknown",
    incidentState: "none",
    failureDomains: [{ kind: "upgrade-control", key: controlKey }],
    ...overrides,
  };
}

type ExitRouteFixture = V9AccessPostureAssetFacts["exitRoutes"][number];

function resolvedOutput(routeKey: string): ExitRouteFixture["output"] {
  return {
    status: requiredKnown(`output.${routeKey}`),
    kind: "tracked-stablecoin",
    assetKeys: ["asset:usd"],
    basketWeights: [],
    valuation: {
      basis: "reviewed-par",
      referenceAssetKey: "asset:usd",
      unitValueUsd: 1,
      expectedUnitValueUsd: 1,
      valueRetentionRatio: 1,
      sourceId: "fixture",
      sourceGenerationId: "fixture:generation",
      observedAtSec: 1_780_000_000,
      asOfSec: 1_780_000_000,
      confidence: "high",
      freshness: { state: "current", ageSec: 0, maxAgeSec: 86_400 },
      evidenceRefIds: [`evidence:output.${routeKey}`],
    },
  };
}

function route(
  routeKey: string,
  holderAccess: ExitRouteFixture["holderAccess"] = "permissionless",
  status = requiredKnown(`route.${routeKey}`),
  overrides: Partial<ExitRouteFixture> = {},
): ExitRouteFixture {
  return {
    routeKey,
    lane: "redemption" as const,
    holderAccess,
    status,
    scoreEligible: true,
    routeFamily: "issuer-redemption",
    coverageClass: "exact-complete",
    evidenceKind: "documented-terms",
    failureDomains: [{ kind: "redemption-rail", key: routeKey }],
    output: resolvedOutput(routeKey),
    ...overrides,
  };
}

function facts(
  controls: readonly V9DeploymentControlFactV2[] = [],
  exitRoutes: V9AccessPostureAssetFacts["exitRoutes"] = [],
  exitStatus: V9FactStatusV2 = exitRoutes.length > 0 ? requiredKnown("exit") : missing("exit"),
): V9AccessPostureAssetFacts {
  return {
    assetId: "fixture-asset",
    controlStatus: controls.length > 0 ? requiredKnown("controls") : notApplicable("controls"),
    exitStatus,
    controls,
    exitRoutes,
  };
}

function args(overrides: Partial<EvaluateV9AccessPostureArgs> = {}): EvaluateV9AccessPostureArgs {
  return {
    policy: V9_CANDIDATE_POLICY_V1,
    facts: facts(),
    transfer: { status: requiredKnown("transfer"), posture: "permissionless" },
    freezeReviews: [
      { source: "blacklist", status: requiredKnown("blacklist"), reach: "none" },
      { source: "upstream", status: requiredKnown("upstream-freeze"), reach: "none" },
    ],
    ...overrides,
  };
}

describe("Safety Score v9 access posture", () => {
  it("exposes restrictive centralized access without producing an economic score", () => {
    const issuer = control("issuer:admin", "governance", ["freeze", "mint", "upgrade"]);
    const redemption = route("redemption:issuer", "institutional-eligible");
    const result = evaluateV9AccessPosture(
      args({
        facts: facts([issuer], [redemption]),
        transfer: { status: requiredKnown("transfer"), posture: "restrictable" },
        freezeReviews: [{ source: "blacklist", status: requiredKnown("blacklist"), reach: "individual" }],
      }),
    );

    expect(result).toEqual({
      transfer: "restrictable",
      freezeExposure: "direct",
      primaryExit: "eligibility-gated",
      governance: "single-entity",
      unknownFields: [],
      signals: [
        "authority:governance:single-entity",
        "authority:issuance:single-entity",
        "authority:pause:single-entity",
        "authority:upgrade:single-entity",
        "freeze:direct",
        "governance:single-entity",
        "primary-exit:eligibility-gated",
        "transfer:restrictable",
      ],
    });
    expect(result).not.toHaveProperty("score");
  });

  it("maps individual blacklistability to direct censorship posture", () => {
    const result = evaluateV9AccessPosture(
      args({
        freezeReviews: [{ source: "blacklist", status: requiredKnown("blacklist"), reach: "individual" }],
      }),
    );

    expect(result.freezeExposure).toBe("direct");
    expect(result).not.toHaveProperty("economicPenalty");
  });

  it("does not let an unresolved optional route erase a known permissionless primary exit", () => {
    const open = route("redemption:open", "permissionless");
    const unresolved = route("redemption:unknown", "unknown", stale("route.unknown"));
    const result = evaluateV9AccessPosture(
      args({
        facts: facts([], [unresolved, open]),
      }),
    );

    expect(result.primaryExit).toBe("permissionless");
    expect(result.unknownFields).not.toContain("primaryExit");
  });

  it("credits the non-atomic redemption families the exit pillar scores instead of asserting no exit", () => {
    const eventual = route("redemption:eventual", "institutional-eligible", requiredKnown("route.eventual"), {
      scoreEligible: false,
      routeFamily: "eventual-redemption",
      coverageClass: "exact-lower-bound",
    });
    const result = evaluateV9AccessPosture(args({ facts: facts([], [eventual]) }));

    expect(result.primaryExit).toBe("eligibility-gated");
    expect(result.unknownFields).not.toContain("primaryExit");
  });

  it("publishes undisclosed, not none, when routes exist but none is credited", () => {
    const diagnostic = route("redemption:diagnostic", "issuer-only", requiredKnown("route.diagnostic"), {
      scoreEligible: false,
      routeFamily: "eventual-redemption",
      coverageClass: "diagnostic",
    });
    const result = evaluateV9AccessPosture(args({ facts: facts([], [diagnostic]) }));

    expect(result.primaryExit).toBe("undisclosed");
    expect(result.unknownFields).not.toContain("primaryExit");
    expect(result.signals).toContain("primary-exit:undisclosed");
  });

  it("publishes undisclosed when the exit surface itself was never observed", () => {
    const result = evaluateV9AccessPosture(args({ facts: facts([], [], missing("exit")) }));

    expect(result.primaryExit).toBe("undisclosed");
    expect(result.unknownFields).not.toContain("primaryExit");
  });

  it("reserves none for a reviewed-complete exit surface with zero routes", () => {
    const result = evaluateV9AccessPosture(args({ facts: facts([], [], requiredKnown("exit")) }));

    expect(result.primaryExit).toBe("none");
    expect(result.unknownFields).not.toContain("primaryExit");
  });

  it("distinguishes upstream, possible, and unknown freeze evidence", () => {
    const upstream = evaluateV9AccessPosture(
      args({
        freezeReviews: [{ source: "upstream", status: requiredKnown("upstream"), reach: "system-wide" }],
      }),
    );
    const possible = evaluateV9AccessPosture(
      args({
        freezeReviews: [{ source: "pause", status: stale("pause"), reach: "system-wide" }],
      }),
    );
    const unknown = evaluateV9AccessPosture(args({ freezeReviews: [] }));

    expect(upstream.freezeExposure).toBe("upstream");
    expect(possible.freezeExposure).toBe("possible");
    expect(unknown.freezeExposure).toBe("unknown");
  });

  it("treats reviewed immutable protocol machinery as immutable alongside peripheral bridges", () => {
    const immutableProtocol = control("liquity-core", "mint", [], {
      deploymentKey: "asset:liquity",
      capSemantics: { kind: "not-applicable", bound: null },
      claimImpairment: "none",
      economicLossScope: "access-only",
      authority: { authorityKey: "ethereum:liquity-core", model: "contract", threshold: null },
    });
    const peripheralBridge = control("liquity-bridge", "bridge", ["bridge-mint"], {
      scope: "deployment",
      capSemantics: { kind: "unbounded", bound: null },
      claimImpairment: "unbounded",
      economicLossScope: "deployment",
      authority: { authorityKey: "ethereum:liquity-bridge", model: "contract", threshold: null },
      materialSupplyShare: 0.01,
      failureDomains: [{ kind: "bridge-route", key: "liquity-bridge" }],
    });

    const result = evaluateV9AccessPosture(
      args({ facts: facts([peripheralBridge, immutableProtocol]) }),
    );

    expect(result.governance).toBe("immutable");
    expect(result.signals).toContain("authority:issuance:immutable");
    expect(result.signals).not.toContain("authority:issuance:concentrated");
  });

  it("uses issuance, governance, pause, and upgrade controls deterministically", () => {
    const issuance = control("issuer", "mint", ["mint"], {
      authority: {
        authorityKey: "authority:issuer",
        model: "multisig",
        threshold: { required: 2, total: 3 },
      },
    });
    const governance = control("governance", "governance", ["parameter-change"], {
      authority: { authorityKey: "authority:governance", model: "governance", threshold: null },
    });
    const pause = control("pause", "freeze", ["freeze"], {
      capSemantics: { kind: "not-applicable", bound: null },
      claimImpairment: "none",
      economicLossScope: "access-only",
      authority: { authorityKey: "authority:pause", model: "none", threshold: null },
    });
    const upgrade = control("upgrade", "upgrade", ["upgrade"], {
      authority: { authorityKey: "authority:upgrade", model: "none", threshold: null },
    });
    const left = evaluateV9AccessPosture(args({ facts: facts([issuance, governance, pause, upgrade]) }));
    const right = evaluateV9AccessPosture(args({ facts: facts([upgrade, pause, governance, issuance]) }));

    expect(left.governance).toBe("concentrated");
    expect(JSON.stringify(left)).toBe(JSON.stringify(right));
  });
});

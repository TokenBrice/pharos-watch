import { describe, expect, it } from "vitest";
import type { V9Severity } from "../../types/safety-score-v9";
import type { V9FailureDomainRef } from "../../types/safety-score-v9-facts";
import * as evaluateSet from "@shared/lib/safety-score-v9/evaluate-set";
import {
  commonModeSignalSeverity,
  resolveV9MintControlGroupSeverity,
  type V9CommonModeContext,
  type V9MintControlGroupIssuerFacts,
} from "@shared/lib/safety-score-v9/evaluate-set";
import type { V9DependencyPathPlan } from "@shared/lib/safety-score-v9/dependencies";
import { scoreV9Input } from "@shared/lib/safety-score-v9/formula";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";

// Own-issuer controller reuse is diagnostic; crossed or unresolved issuer joins fail closed.

const EMPTY_CONTEXT: V9CommonModeContext = {
  supplyExposure: {
    shareBySlug: new Map<string, number>(),
    unattributedShare: 1,
    unmatchedChainLabelPoolShare: 0,
    complete: false,
  },
  dexExposureByDomain: new Map(),
  bridgeExposureByDomain: new Map(),
};

const MATERIALITY = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality;

function mintControlSignal(severity: V9Severity) {
  return {
    kind: "critical-dependency" as const,
    severity,
    reason: "Reviewed paths share a mint-control failure domain.",
    failureDomainKeys: ["mint-control:ethereum:0xfixture"],
    evidence: [],
  };
}

function scoreWithSignal(severity: V9Severity) {
  return scoreV9Input(
    {
      assetId: "d2-fixture",
      pillars: { backing: 95, exit: 95, control: 95 },
      pegScore: 100,
      pegApplicable: true,
      evidenceLevel: "strong",
      trackRecordMonths: 48,
      activeDepegBps: null,
      parentRequired: false,
      parentScore: null,
      structuralSignals: [mintControlSignal(severity)],
      unresolved: [],
    },
    V9_CANDIDATE_POLICY_V1,
  );
}

describe("D2 fail-closed baseline — active", () => {
  it("grades shared mint-control domains high today (the behavior cross-issuer and unresolved groups keep)", () => {
    const domain: V9FailureDomainRef = { kind: "mint-control", key: "ethereum:0xshared-controller" };
    expect(commonModeSignalSeverity(domain, EMPTY_CONTEXT, MATERIALITY)).toBe("high");
  });

  it("keeps reserve-issuer domains diagnostic (single-obligor exposure stays priced in backing)", () => {
    const domain: V9FailureDomainRef = { kind: "reserve-issuer", key: "issuer:fixture" };
    expect(commonModeSignalSeverity(domain, EMPTY_CONTEXT, MATERIALITY)).toBe("low");
  });

  it("caps a high shared-control signal at 64 while the diagnostic rung never caps", () => {
    const high = scoreWithSignal("high");
    expect(high.bindingCap).toMatchObject({ kind: "signal:critical-dependency:high", limit: 64 });
    expect(high.finalScore).toBe(64);

    const diagnostic = scoreWithSignal("low");
    expect(diagnostic.bindingCap).toBeNull();
    expect(diagnostic.finalScore).toBe(95);
  });
});

describe("D2 ruled issuer-scoped grouping — live", () => {
  const sameIssuerGroup = (size: 2 | 4): V9MintControlGroupIssuerFacts => ({
    controllerIssuerKey: "issuer:circle",
    members: Array.from({ length: size }, (_, index) => ({
      assetId: `circle-product-${index}`,
      pathKey: `mint:path-${index}`,
      assetIssuerKey: "issuer:circle",
    })),
  });

  it("grades a same-issuer controller group diagnostic (low)", () => {
    expect(resolveV9MintControlGroupSeverity(sameIssuerGroup(4))).toBe("low");
  });

  it("keeps a cross-issuer shared controller capping (high)", () => {
    const group: V9MintControlGroupIssuerFacts = {
      controllerIssuerKey: "issuer:circle",
      members: [
        { assetId: "usdc-circle", pathKey: "mint:a", assetIssuerKey: "issuer:circle" },
        { assetId: "foreign-wrapper", pathKey: "mint:b", assetIssuerKey: "issuer:other" },
      ],
    };
    expect(resolveV9MintControlGroupSeverity(group)).toBe("high");
  });

  it("fails closed (high) when the controller issuer is unresolved", () => {
    const group: V9MintControlGroupIssuerFacts = { ...sameIssuerGroup(2), controllerIssuerKey: null };
    expect(resolveV9MintControlGroupSeverity(group)).toBe("high");
  });

  it("fails closed (high) when any member asset issuer is unresolved", () => {
    const group: V9MintControlGroupIssuerFacts = {
      controllerIssuerKey: "issuer:circle",
      members: [
        { assetId: "usdc-circle", pathKey: "mint:a", assetIssuerKey: "issuer:circle" },
        { assetId: "unknown-product", pathKey: "mint:b", assetIssuerKey: null },
      ],
    };
    expect(resolveV9MintControlGroupSeverity(group)).toBe("high");
  });

  it("fails closed (high) when a resolved controller has no members", () => {
    expect(resolveV9MintControlGroupSeverity({
      controllerIssuerKey: "issuer:circle",
      members: [],
    })).toBe("high");
  });

  it("preserves diagnostic severity under a disjoint split of the same members", () => {
    const merged = sameIssuerGroup(4);
    const split = [merged.members.slice(0, 2), merged.members.slice(2)].map((members) => ({
      controllerIssuerKey: merged.controllerIssuerKey,
      members,
    }));
    expect(resolveV9MintControlGroupSeverity(merged)).toBe("low");
    expect(split.map((group) => resolveV9MintControlGroupSeverity(group))).toEqual(["low", "low"]);
  });
});

describe("Reshape-v2 D2 — parent-controlled common-mode dedup", () => {
  const serialPaths = [
    {
      assetId: "steakusdt-steakhouse",
      upstreamAssetId: "usdt-tether",
      edgeKey: "wrap",
      exposureKey: "wrap:exposure",
      riskEventKey: "wrap:risk",
      evidenceRefIds: [],
      dependencyType: "wrapper" as const,
      role: "serial-claim" as const,
      weight: 1,
      failureDomains: [],
    },
    {
      assetId: "basket-holder",
      upstreamAssetId: "usdt-tether",
      edgeKey: "basket",
      exposureKey: "basket:exposure",
      riskEventKey: "basket:risk",
      evidenceRefIds: [],
      dependencyType: "collateral" as const,
      role: "basket-exposure" as const,
      weight: 0.4,
      failureDomains: [],
    },
  ] satisfies V9DependencyPathPlan[];

  it("extracts the controller asset id only from asset-keyed control domains", () => {
    expect(evaluateSet.v9ControlAssetDomainId({ kind: "mint-control", key: "asset:usdt-tether" })).toBe("usdt-tether");
    expect(evaluateSet.v9ControlAssetDomainId({ kind: "upgrade-control", key: "asset:usdc-circle" })).toBe("usdc-circle");
    expect(evaluateSet.v9ControlAssetDomainId({ kind: "mint-control", key: "safe:ethereum:0x0a0e" })).toBeNull();
    expect(evaluateSet.v9ControlAssetDomainId({ kind: "bridge-route", key: "asset:usdt-tether" })).toBeNull();
  });

  it("defers to the parent cap only for serial-claim children of the domain asset", () => {
    expect(evaluateSet.isV9ParentControlledCommonModeMember("steakusdt-steakhouse", "usdt-tether", serialPaths)).toBe(
      true,
    );
    // Basket exposure is not a required-parent relationship: the shared-controller risk stays priced.
    expect(evaluateSet.isV9ParentControlledCommonModeMember("basket-holder", "usdt-tether", serialPaths)).toBe(false);
    // A different upstream never matches, and a null domain id never dedups.
    expect(evaluateSet.isV9ParentControlledCommonModeMember("steakusdt-steakhouse", "usdc-circle", serialPaths)).toBe(
      false,
    );
    expect(evaluateSet.isV9ParentControlledCommonModeMember("steakusdt-steakhouse", null, serialPaths)).toBe(false);
  });

  it("does not create a reverse dependency from downstream controller reuse", () => {
    expect(evaluateSet.isV9ControllerOwnedCommonModeMember("usdt-tether", "usdt-tether", serialPaths)).toBe(
      true,
    );
    expect(
      evaluateSet.isV9ControllerOwnedCommonModeMember(
        "steakusdt-steakhouse",
        "usdt-tether",
        serialPaths,
      ),
    ).toBe(true);
    expect(evaluateSet.isV9ControllerOwnedCommonModeMember("basket-holder", "usdt-tether", serialPaths)).toBe(
      false,
    );
    expect(evaluateSet.isV9ControllerOwnedCommonModeMember("foreign-product", "usdt-tether", serialPaths)).toBe(
      false,
    );
  });
});

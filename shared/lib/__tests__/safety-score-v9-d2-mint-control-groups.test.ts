import { describe, expect, it } from "vitest";
import type { V9Severity } from "../../types/safety-score-v9";
import type { V9FailureDomainRef } from "../../types/safety-score-v9-facts";
import * as evaluateSet from "../safety-score-v9/evaluate-set";
import { commonModeSignalSeverity, type V9CommonModeContext } from "../safety-score-v9/evaluate-set";
import { scoreV9Input } from "../safety-score-v9/formula";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";

/**
 * STAGE A pin for owner ruling D2 (2026-07-17, provisional pending the V8
 * counterfactual-matrix review):
 *
 *   An issuer's own mint controller shared across its OWN products no longer
 *   caps each product (single-entity risk stays priced in the control pillar);
 *   the common-mode signal becomes diagnostic (low). Cross-issuer shared
 *   controllers KEEP capping (high). Fail-closed (high) when the controlling
 *   issuer's identity — or any member asset's issuer identity — is unresolved.
 *   Splitting or merging an identical group is score-neutral.
 *
 * The suites pin the fail-closed baseline that D2 keeps for cross-issuer and
 * unresolved cases, plus the shipped issuer-scoped resolution.
 *
 * Issuer-scoped resolution contract:
 *
 *   export interface V9MintControlGroupIssuerFacts {
 *     controllerIssuerKey: string | null;   // resolved issuer of the shared controller
 *     members: readonly {
 *       assetId: string;
 *       pathKey: string;
 *       assetIssuerKey: string | null;      // resolved issuer of the member asset
 *     }[];
 *   }
 *   export function resolveV9MintControlGroupSeverity(
 *     group: V9MintControlGroupIssuerFacts,
 *   ): V9Severity
 */

interface MintControlGroupIssuerFacts {
  controllerIssuerKey: string | null;
  members: readonly { assetId: string; pathKey: string; assetIssuerKey: string | null }[];
}

const resolveV9MintControlGroupSeverity = (evaluateSet as unknown as Record<string, unknown>)
  .resolveV9MintControlGroupSeverity as ((group: MintControlGroupIssuerFacts) => V9Severity) | undefined;

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
  it("exposes the issuer-scoped resolution seam", () => {
    expect(typeof resolveV9MintControlGroupSeverity).toBe("function");
  });

  const sameIssuerGroup = (size: 2 | 4): MintControlGroupIssuerFacts => ({
    controllerIssuerKey: "issuer:circle",
    members: Array.from({ length: size }, (_, index) => ({
      assetId: `circle-product-${index}`,
      pathKey: `mint:path-${index}`,
      assetIssuerKey: "issuer:circle",
    })),
  });

  it("grades a same-issuer controller group diagnostic (low)", () => {
    expect(resolveV9MintControlGroupSeverity!(sameIssuerGroup(4))).toBe("low");
  });

  it("keeps a cross-issuer shared controller capping (high)", () => {
    const group: MintControlGroupIssuerFacts = {
      controllerIssuerKey: "issuer:circle",
      members: [
        { assetId: "usdc-circle", pathKey: "mint:a", assetIssuerKey: "issuer:circle" },
        { assetId: "foreign-wrapper", pathKey: "mint:b", assetIssuerKey: "issuer:other" },
      ],
    };
    expect(resolveV9MintControlGroupSeverity!(group)).toBe("high");
  });

  it("fails closed (high) when the controller issuer is unresolved", () => {
    const group: MintControlGroupIssuerFacts = { ...sameIssuerGroup(2), controllerIssuerKey: null };
    expect(resolveV9MintControlGroupSeverity!(group)).toBe("high");
  });

  it("fails closed (high) when any member asset issuer is unresolved", () => {
    const group: MintControlGroupIssuerFacts = {
      controllerIssuerKey: "issuer:circle",
      members: [
        { assetId: "usdc-circle", pathKey: "mint:a", assetIssuerKey: "issuer:circle" },
        { assetId: "unknown-product", pathKey: "mint:b", assetIssuerKey: null },
      ],
    };
    expect(resolveV9MintControlGroupSeverity!(group)).toBe("high");
  });

  it("is score-neutral under split/merge of an identical same-issuer group", () => {
    const merged = resolveV9MintControlGroupSeverity!(sameIssuerGroup(4));
    const split = [sameIssuerGroup(2), sameIssuerGroup(2)].map((group) => resolveV9MintControlGroupSeverity!(group));
    expect(merged).toBe("low");
    expect(split).toEqual([merged, merged]);
  });
});

describe("Reshape-v2 D2 — parent-controlled common-mode dedup", () => {
  const serialPaths = [
    {
      assetId: "steakusdt-steakhouse",
      upstreamAssetId: "usdt-tether",
      edgeKey: "wrap",
      dependencyType: "wrapped-issuance" as const,
      role: "serial-claim" as const,
      weight: 1,
      failureDomains: [],
    },
    {
      assetId: "basket-holder",
      upstreamAssetId: "usdt-tether",
      edgeKey: "basket",
      dependencyType: "reserve-exposure" as const,
      role: "basket-exposure" as const,
      weight: 0.4,
      failureDomains: [],
    },
  ] as never[];

  it("extracts the controller asset id only from asset-keyed control domains", () => {
    expect(evaluateSet.v9ControlAssetDomainId({ kind: "mint-control", key: "asset:usdt-tether" } as never)).toBe("usdt-tether");
    expect(evaluateSet.v9ControlAssetDomainId({ kind: "upgrade-control", key: "asset:usdc-circle" } as never)).toBe("usdc-circle");
    expect(evaluateSet.v9ControlAssetDomainId({ kind: "mint-control", key: "safe:ethereum:0x0a0e" } as never)).toBeNull();
    expect(evaluateSet.v9ControlAssetDomainId({ kind: "bridge-route", key: "asset:usdt-tether" } as never)).toBeNull();
  });

  it("defers to the parent cap only for serial-claim children of the domain asset", () => {
    expect(evaluateSet.isV9ParentControlledCommonModeMember("steakusdt-steakhouse", "usdt-tether", serialPaths as never)).toBe(
      true,
    );
    // Basket exposure is not a required-parent relationship: the shared-controller risk stays priced.
    expect(evaluateSet.isV9ParentControlledCommonModeMember("basket-holder", "usdt-tether", serialPaths as never)).toBe(false);
    // A different upstream never matches, and a null domain id never dedups.
    expect(evaluateSet.isV9ParentControlledCommonModeMember("steakusdt-steakhouse", "usdc-circle", serialPaths as never)).toBe(
      false,
    );
    expect(evaluateSet.isV9ParentControlledCommonModeMember("steakusdt-steakhouse", null, serialPaths as never)).toBe(false);
  });

  it("does not create a reverse dependency from downstream controller reuse", () => {
    expect(evaluateSet.isV9ControllerOwnedCommonModeMember("usdt-tether", "usdt-tether", serialPaths as never)).toBe(
      true,
    );
    expect(
      evaluateSet.isV9ControllerOwnedCommonModeMember(
        "steakusdt-steakhouse",
        "usdt-tether",
        serialPaths as never,
      ),
    ).toBe(true);
    expect(evaluateSet.isV9ControllerOwnedCommonModeMember("basket-holder", "usdt-tether", serialPaths as never)).toBe(
      false,
    );
    expect(evaluateSet.isV9ControllerOwnedCommonModeMember("foreign-product", "usdt-tether", serialPaths as never)).toBe(
      false,
    );
  });
});

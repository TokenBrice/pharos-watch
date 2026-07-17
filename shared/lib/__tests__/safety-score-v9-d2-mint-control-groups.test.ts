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
 * The ACTIVE block pins the fail-closed baseline that D2 keeps for the
 * cross-issuer and unresolved cases (today's behavior for ALL mint-control
 * groups), plus the cap mechanics the ruled diagnostic rung relies on. The
 * `describe.skip` block pins the ruled issuer-scoped resolution against the
 * Stage B seam documented below; it fails today by construction (the seam does
 * not exist yet) and is enabled by Stage B.
 *
 * STAGE B SEAM (proposed contract — the dependency plan is identity-only
 * today, so issuer attribution must enter via new fact data; see the Stage A
 * report's schema-gap note):
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

const resolveV9MintControlGroupSeverity = (
  evaluateSet as unknown as Record<string, unknown>
).resolveV9MintControlGroupSeverity as ((group: MintControlGroupIssuerFacts) => V9Severity) | undefined;

const EMPTY_CONTEXT: V9CommonModeContext = {
  supplyExposure: { shareBySlug: new Map<string, number>(), unattributedShare: 1, complete: false },
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

describe("D2 fail-closed baseline — active (must hold pre- and post-Stage-B)", () => {
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

// STAGE B: un-skip once resolveV9MintControlGroupSeverity (or the equivalent
// issuer-scoped grouping in evaluate-set.ts/dependencies.ts) exists.
describe.skip("D2 ruled issuer-scoped grouping — pending Stage B implementation", () => {
  it("exposes the Stage B seam", () => {
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
    const split = [sameIssuerGroup(2), sameIssuerGroup(2)].map((group) =>
      resolveV9MintControlGroupSeverity!(group),
    );
    expect(merged).toBe("low");
    expect(split).toEqual([merged, merged]);
  });
});

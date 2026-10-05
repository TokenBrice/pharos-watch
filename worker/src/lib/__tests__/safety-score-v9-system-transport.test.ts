import { describe, expect, it } from "vitest";
import feusdRisk from "@shared/data/stablecoins/domains/risk-review/feusd-felix.json";
import { BridgeRouteRiskProfileSchema } from "@shared/types/stablecoin-meta-control-schemas";
import { effectiveAuthoritySignatureRequirement } from "@shared/lib/safety-score-v9/control-scope";
import { gradeVerifiedControlAuthority } from "@shared/lib/safety-score-v9/control-mint-grade";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { validateMintBridgeOwnership } from "@shared/lib/stablecoins/mint-bridge-ownership";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/evidence";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9/extension";
import { compileSafetyScoreV9FactSetFromNormalizedInput } from "../safety-score-v9/fact-set";
import { projectControlAuthority } from "../safety-score-v9/extension-shared";
import { normalizeFixedInput } from "../report-cards-fixed-input";
import { makeV9FixedInput } from "../../test-helpers/v9-fixed-input";

const CORE_ROUTE = "hyperliquid:0x88102bea0bbad5f301f6e9e4dacdf979";
const CLOCK = 1791184659;

function compileTransport(clockSec = CLOCK) {
  const bridgeRouteRisk = BridgeRouteRiskProfileSchema.parse(feusdRisk.bridgeRouteRisk);
  const fixed = makeV9FixedInput({ assetId: "feusd-felix", clockSec, chainSupplyByChain: {
    hyperevm: { current: 9_000_000, circulatingPrevDay: 9_000_000, circulatingPrevWeek: 9_000_000, circulatingPrevMonth: 9_000_000 },
    hyperliquid: { current: 1_000_000, circulatingPrevDay: 1_000_000, circulatingPrevWeek: 1_000_000, circulatingPrevMonth: 1_000_000 },
  } });
  const extension = buildSafetyScoreV9BaselineExtension(fixed, { metaById: new Map([["feusd-felix", {
    id: "feusd-felix", bridgeRouteRisk, mechanismArchetype: "fiat-cash" as const,
    contracts: [{ chain: "hyperevm", address: "0x02c6a2fa58cc01a18b8d9e00ea48d65e4df26c70", decimals: 18 }],
  }]]) });
  const compiled = compileSafetyScoreV9FactSetFromNormalizedInput(normalizeFixedInput(fixed), extension);
  return compiled.assets[0]!.controls.find((control) => control.deploymentKey === CORE_ROUTE)!;
}

describe("same-chain HyperCore system transport", () => {
  it("compiles consensus authority and escrow impairment without bridge-validator or mint credit", () => {
    const control = compileTransport();
    expect(control).toBeDefined();
    expect(control.status.observationState).toBe("known");
    expect(control.authority).toMatchObject({
      authorityKey: "consensus:hyperliquid", model: "chain-consensus", threshold: null,
      sameChainSystemTransport: { family: "hypercore-evm-spot", tokenIndex: 241,
        systemAddress: "0x20000000000000000000000000000000000000f1" },
    });
    expect(control.capabilities).toEqual(["custody-transfer"]);
    expect(control.capSemantics).toEqual({ kind: "not-applicable", bound: null });
    expect(control.claimImpairment).toBe("bounded");
    expect(control.economicLossScope).toBe("deployment");
    expect(effectiveAuthoritySignatureRequirement(control.authority)).toBeNull();
    expect(gradeVerifiedControlAuthority(control, V9_CANDIDATE_POLICY_V1.policy.semantic))
      .toBe(V9_CANDIDATE_POLICY_V1.policy.semantic.control.boundedUnknownQuality);
    expect(control.failureDomains).toContainEqual({ kind: "bridge-route", key: "consensus:hyperliquid" });
  });

  it("retains stale research as unresolved rather than renewing a system-family label", () => {
    const control = compileTransport(Date.parse("2026-10-05T00:00:00Z") / 1000 + V9_REVIEW_EVIDENCE_MAX_AGE_SEC + 1);
    expect(control.status.observationState).not.toBe("known");
    expect(control.incidentState).toBe("unknown");
  });

  it("admits escrow-only same-chain coverage but rejects an invalid family bypass", () => {
    const bridgeRouteRisk = BridgeRouteRiskProfileSchema.parse(feusdRisk.bridgeRouteRisk);
    const metadata = { id: "feusd-felix", bridgeRouteRisk, contracts: [] };
    expect(validateMintBridgeOwnership(metadata).some((row) => row.code === "representation-route-without-bridge-mint")).toBe(false);
    bridgeRouteRisk.controls![0]!.sameChainSystemTransport!.tokenIndex = 242;
    expect(validateMintBridgeOwnership(metadata).some((row) => row.code === "representation-route-without-bridge-mint")).toBe(true);
  });

  it.each([
    ["wrong index", { sameChainSystemTransport: { ...feusdRisk.bridgeRouteRisk.controls[0]!.sameChainSystemTransport, tokenIndex: 242 } }],
    ["validator relabel", { authorityType: "validator-quorum" }],
    ["invented quorum", { threshold: 2, signerCount: 3 }],
    ["arbitrary mint", { capabilities: ["bridge-mint"] }],
    ["wrong route", { routeRefs: ["hyperliquid:0x11111111111111111111111111111111"] }],
    ["missing evidence pin", { observedBlock: undefined }],
  ])("rejects %s rather than guessing family semantics", (_name, override) => {
    const profile = structuredClone(feusdRisk.bridgeRouteRisk);
    Object.assign(profile.controls[0]!, override);
    expect(BridgeRouteRiskProfileSchema.safeParse(profile).success).toBe(false);
  });

  it("rejects an unjoined linked EVM identity", () => {
    const profile = structuredClone(feusdRisk.bridgeRouteRisk);
    profile.controls[0]!.sameChainSystemTransport.evmToken = "hyperevm:0x1111111111111111111111111111111111111111";
    expect(BridgeRouteRiskProfileSchema.safeParse(profile).success).toBe(false);
  });

  it("does not derive a known consensus authority from a bare label", () => {
    expect(projectControlAuthority({ authorityType: "chain-consensus", fallbackKey: "unproved" })?.model).toBe("unknown");
  });
});

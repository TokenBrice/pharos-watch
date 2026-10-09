import { describe, expect, it } from "vitest";
import { BridgeRouteRiskProfileSchema } from "@shared/types/stablecoin-meta-control-schemas";
import type { BridgeRouteDeployment } from "@shared/types/core";
import usdatRisk from "@shared/data/stablecoins/domains/risk-review/usdat-saturn.json";
import xgldRisk from "@shared/data/stablecoins/domains/risk-review/xgld-unitas.json";
import type { V9AllocationScopeIdentityReview } from "@shared/types/safety-score-v9-allocation";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9/extension";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import { createAssetBuildContext } from "../safety-score-v9/fact-set-context";
import { normalizeSafetyScoreV9CompilerInput } from "../safety-score-v9/native-input";
import { buildWrapperLocalFacts } from "../safety-score-v9/fact-set-wrapper";
import { makeV9TwoAssetFixedInput, v9Status } from "../../test-helpers/v9-fixed-input";
import { alphaMeta, metaMap, reviewedResearchMeta } from "./safety-score-v9-fact-set.test-support";

const CLOCK = Date.parse("2026-10-02T00:00:00Z") / 1_000;
const NATIVE_ADDRESS = "0x1111111111111111111111111111111111111111";
const BRIDGE_ADDRESS = "0x3333333333333333333333333333333333333333";
const SOURCE = { label: "Exact representation code", url: "https://example.com/bridge-code" };
const maxAgeSec = V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.reviewedResearchMaxAgeSec;

function fixture(changeRoute?: (route: BridgeRouteDeployment) => void | false, proxy = false) {
  const fixed = makeV9TwoAssetFixedInput({ clockSec: CLOCK });
  const meta = reviewedResearchMeta("2026-10-01");
  meta.variantKind = "strategy-vault";
  meta.variantOf = "beta";
  meta.contracts = [
    { chain: "ethereum", address: NATIVE_ADDRESS, decimals: 18 },
    { chain: "base", address: BRIDGE_ADDRESS, decimals: 18 },
  ];
  const upgrade = meta.mintAuthority!.upgradeability!;
  upgrade.deploymentRefs = [`ethereum:${NATIVE_ADDRESS}`];
  upgrade.observedAt = "2026-10-01";
  upgrade.observedBlock = 123;
  const bridgeIdentity: V9AllocationScopeIdentityReview["deployments"][number] = proxy
    ? { codeKind: "proxy", chain: "base", address: BRIDGE_ADDRESS,
      implementation: "0x4444444444444444444444444444444444444444", observedAtSec: CLOCK - 100, block: 456, sourceUrl: SOURCE.url }
    : { codeKind: "immutable", chain: "base", address: BRIDGE_ADDRESS,
      observedAtSec: CLOCK - 100, block: 456, sourceUrl: SOURCE.url };
  const route = meta.bridgeRouteRisk!.routes![1]!;
  route.observedAt = "2026-10-01";
  route.observedBlock = 456;
  route.sources = [SOURCE];
  route.deploymentIdentity = bridgeIdentity;
  if (changeRoute?.(route) === false) meta.bridgeRouteRisk!.routes!.pop();
  const extension = buildSafetyScoreV9BaselineExtension(fixed, {
    metaById: metaMap(meta, alphaMeta({ id: "beta" })),
  });
  const wrapper = structuredClone(extension.assets.find((row) => row.assetId === "alpha")!);
  const asset = structuredClone(compileSafetyScoreV9FactSetFromFixedInput(fixed, extension).assets
    .find((row) => row.assetId === "alpha")!);
  asset.economicControlReview.mint.status = v9Status("missing", "v9.control.mint-review");
  asset.economicControlReview.mint.upgrade = { state: "immutable", controlKey: null };
  // Independently authored accounting proof must cover both roots even when the
  // retained bridge row is unavailable; copying an incomplete roster would hide the gate.
  wrapper.wrapperLocalReviews = [{
    kind: "accounting", mechanism: "fixed-face-accounting", assetId: "alpha", reviewer: "Fixture reviewer",
    identity: { assetId: "alpha", registeredDeploymentKeys: [`ethereum:${NATIVE_ADDRESS}`, `base:${BRIDGE_ADDRESS}`],
      deployments: [
        { codeKind: "immutable", chain: "ethereum", address: NATIVE_ADDRESS,
          observedAtSec: CLOCK, block: 123, sourceUrl: upgrade.sources[0]!.url },
        bridgeIdentity,
      ] },
    reviewedAt: new Date(CLOCK * 1_000).toISOString(), observedAtSec: CLOCK, expiresAtSec: CLOCK + 100,
    rationale: "Both exact registered roots implement fixed-face accounting without a NAV oracle.",
    sources: [...upgrade.sources, SOURCE], observations: [{ sourceUrl: SOURCE.url, description: "Exact pinned representation code." }],
  }];
  const build = () => {
    const context = createAssetBuildContext(normalizeSafetyScoreV9CompilerInput(fixed), extension, wrapper, "a".repeat(64));
    const facts = buildWrapperLocalFacts(context, asset);
    if (facts.applicability !== "wrapper") throw new Error("Expected wrapper facts");
    return { context, facts };
  };
  return { meta, wrapper, build };
}

describe("reviewed bridge representation allocation identity", () => {
  it("keeps existing bridge sidecars valid without requiring identity curation", () => {
    expect(BridgeRouteRiskProfileSchema.safeParse(usdatRisk.bridgeRouteRisk).success).toBe(true);
    expect(BridgeRouteRiskProfileSchema.safeParse(xgldRisk.bridgeRouteRisk).success).toBe(true);
  });

  it("preserves native-only unscoped single-deployment identity admission", () => {
    const fixed = makeV9TwoAssetFixedInput({ clockSec: CLOCK });
    const meta = reviewedResearchMeta("2026-10-01");
    delete meta.bridgeRouteRisk;
    meta.contracts = [{ chain: "ethereum", address: NATIVE_ADDRESS, decimals: 18 }];
    meta.mintAuthority!.upgradeability!.observedAt = "2026-10-01";
    meta.mintAuthority!.upgradeability!.observedBlock = 123;
    const extension = buildSafetyScoreV9BaselineExtension(fixed, { metaById: metaMap(meta, alphaMeta({ id: "beta" })) });
    expect(extension.assets.find((row) => row.assetId === "alpha")!.allocationScopeIdentityReview).toEqual({
      assetId: "alpha", registeredDeploymentKeys: [`ethereum:${NATIVE_ADDRESS}`],
      deployments: [{ codeKind: "immutable", chain: "ethereum", address: NATIVE_ADDRESS, observedAtSec: CLOCK,
        block: 123, sourceUrl: meta.mintAuthority!.upgradeability!.sources[0]!.url }],
    });
  });

  it("retains current exact source-bound bridge roots for immutable mutability and fixed-face accounting", () => {
    const input = fixture();
    expect(BridgeRouteRiskProfileSchema.safeParse(input.meta.bridgeRouteRisk).success).toBe(true);
    expect(input.wrapper.allocationScopeIdentityReview!.deployments).toHaveLength(2);
    const { facts, context } = input.build();
    expect(facts.facts.contractMutability).toMatchObject({ disposition: "reviewed", assessment: "none" });
    expect(facts.facts.contractMutability.evidenceRefIds).toHaveLength(2);
    expect(facts.facts.shareAccountingNavOracle).toMatchObject({ disposition: "reviewed", assessment: "none" });
    const bridgeEvidence = facts.facts.contractMutability.evidenceRefIds.map((id) => context.evidence.get(id)!)
      .find((evidence) => evidence.url === SOURCE.url);
    expect(bridgeEvidence).toMatchObject({ url: SOURCE.url, observedAtSec: CLOCK - 100, freshness: { state: "current", maxAgeSec } });
  });

  it("admits a reviewed proxy representation only for exact fixed-face accounting, not immutable-root credit", () => {
    const input = fixture(undefined, true);
    expect(input.wrapper.allocationScopeIdentityReview!.deployments[1]).toMatchObject({ codeKind: "proxy",
      implementation: "0x4444444444444444444444444444444444444444" });
    expect(input.build().facts.facts.contractMutability).toMatchObject({ disposition: "unresearched", assessment: null });
    expect(input.build().facts.facts.shareAccountingNavOracle).toMatchObject({ disposition: "reviewed", assessment: "none" });
  });

  it.each(["stale-route", "missing-route", "stale-identity", "future-route", "future-identity", "unknown-route",
    "missing-identity", "missing-block", "unbound-source", "wrong-chain", "wrong-address", "wrong-route-id", "wrong-block"] as const)(
    "blocks incomplete exhaustive review for %s without changing native identity", (fault) => {
      const input = fixture((route) => {
        switch (fault) {
          case "stale-route": route.observedAt = new Date((CLOCK - maxAgeSec - 1) * 1_000).toISOString(); break;
          case "missing-route": return false;
          case "stale-identity": route.deploymentIdentity!.observedAtSec = CLOCK - maxAgeSec - 1; break;
          case "future-route": route.observedAt = "2026-10-02"; break;
          case "future-identity": route.deploymentIdentity!.observedAtSec = CLOCK + 1; break;
          case "unknown-route": route.reviewDisposition = "unresolved"; break;
          case "missing-identity": delete route.deploymentIdentity; break;
          case "missing-block": delete route.observedBlock; break;
          case "unbound-source": route.deploymentIdentity!.sourceUrl = "https://example.com/unbound"; break;
          case "wrong-chain": route.deploymentIdentity!.chain = "arbitrum"; break;
          case "wrong-address": route.deploymentIdentity!.address = NATIVE_ADDRESS; break;
          case "wrong-route-id": route.id = `arbitrum:${BRIDGE_ADDRESS}`; break;
          case "wrong-block": route.deploymentIdentity!.block = 999; break;
        }
      });
      expect(input.wrapper.allocationScopeIdentityReview).toMatchObject({ registeredDeploymentKeys: [
        `base:${BRIDGE_ADDRESS}`, `ethereum:${NATIVE_ADDRESS}`,
      ], deployments: [{ codeKind: "immutable", chain: "ethereum", address: NATIVE_ADDRESS, block: 123, observedAtSec: CLOCK }] });
      expect(input.wrapper.allocationScopeIdentityReview!.deployments).toHaveLength(1);
      const { facts } = input.build();
      expect(facts.facts.contractMutability).toMatchObject({ disposition: "unresearched", assessment: null });
      expect(facts.facts.shareAccountingNavOracle).toMatchObject({ disposition: "unresearched", assessment: null });
    },
  );

  it("admits the existing reviewed-research budget inclusively", () => {
    const input = fixture((route) => {
      route.observedAt = new Date((CLOCK - maxAgeSec) * 1_000).toISOString();
      route.deploymentIdentity!.observedAtSec = CLOCK - maxAgeSec;
    });
    expect(input.wrapper.allocationScopeIdentityReview!.deployments).toHaveLength(2);
    expect(input.build().facts.facts.contractMutability.assessment).toBe("none");
  });
});

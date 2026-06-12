import { describe, expect, it } from "vitest";
import {
  buildL2BeatChainCoverageAudit,
  buildL2BeatStablecoinSafetyAudit,
  getL2BeatInfrastructureContext,
} from "../chains/l2beat-audit";

describe("L2BEAT audit helpers", () => {
  it("keeps explicit alias coverage internally consistent", () => {
    const audit = buildL2BeatChainCoverageAudit({ generatedAt: "2026-06-12T00:00:00.000Z" });

    expect(audit.summary).toMatchObject({
      matchedChainCount: 39,
      explicitAliasCount: 39,
      snapshotProjectCount: 39,
      aliasIssueCount: 0,
    });
    expect(audit.matchedChains.find((row) => row.chainId === "zksync")).toMatchObject({
      projectId: "zksync2",
      aliasStatus: "explicit",
    });
    expect(audit.matchedChains.find((row) => row.chainId === "polygon-zkevm")).toMatchObject({
      projectId: "polygonzkevm",
    });
  });

  it("exposes host-chain context for layer 3 deployments", () => {
    expect(getL2BeatInfrastructureContext("apechain")).toMatchObject({
      projectId: "apechain",
      layer: "layer3",
      hostChain: "Arbitrum One",
      hostChainId: "arbitrum",
    });
  });

  it("builds advisory Safety Score review rows without deployment-model mutation", () => {
    const audit = buildL2BeatStablecoinSafetyAudit({
      generatedAt: "2026-06-12T00:00:00.000Z",
      stablecoins: [
        { id: "base-native", symbol: "BASE", contracts: [{ chain: "base" }] },
        {
          id: "multi-route",
          symbol: "MULTI",
          contracts: [{ chain: "ethereum" }, { chain: "base" }],
          deploymentModel: "single-chain",
        },
        { id: "l3-token", symbol: "L3", contracts: [{ chain: "apechain" }] },
      ],
    });

    expect(audit.summary).toMatchObject({
      stablecoinCount: 3,
      stablecoinsWithL2BeatDeployments: 3,
      matchedDeploymentCount: 3,
    });
    expect(audit.reviewRows.find((row) => row.coinId === "base-native")).toMatchObject({
      suggestedChainTier: "stage1-l2",
      suggestedDeploymentModel: null,
      reasons: ["chain-tier-stage1-candidate"],
    });
    expect(audit.reviewRows.find((row) => row.coinId === "multi-route")).toMatchObject({
      reasons: ["deployment-model-multichain-review"],
      suggestedDeploymentModel: null,
    });
    expect(audit.reviewRows.find((row) => row.coinId === "l3-token")?.reasons).toContain("layer3-host-chain-review");
  });
});

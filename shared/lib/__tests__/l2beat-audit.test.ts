import { describe, expect, it } from "vitest";
import {
  buildL2BeatChainCoverageAudit,
  buildL2BeatBridgeRouteReviewAudit,
  buildL2BeatStablecoinSafetyAudit,
  getL2BeatInfrastructureContext,
} from "../chains/l2beat-audit";
import { findL2BeatInteropProtocolReferences } from "../chains/l2beat-interop";

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
      reasons: ["chain-tier-stage1-candidate"],
    });
    expect(audit.reviewRows.find((row) => row.coinId === "multi-route")).toMatchObject({
      reasons: ["deployment-model-multichain-review"],
    });
    expect(audit.reviewRows.find((row) => row.coinId === "l3-token")?.reasons).toContain("layer3-host-chain-review");
  });

  it("flags L2BEAT under-review deployments from structured context", () => {
    const audit = buildL2BeatStablecoinSafetyAudit({
      generatedAt: "2026-06-12T00:00:00.000Z",
      stablecoins: [
        { id: "celo-native", symbol: "CELO", contracts: [{ chain: "celo" }] },
      ],
    });

    expect(audit.reviewRows.find((row) => row.coinId === "celo-native")).toMatchObject({
      reasons: ["l2beat-under-review", "weak-l2beat-chain-environment"],
    });
  });

  it("builds bridge-route review rows from L2BEAT Interop protocol references", () => {
    const audit = buildL2BeatBridgeRouteReviewAudit({
      generatedAt: "2026-06-12T00:00:00.000Z",
      stablecoins: [
        {
          id: "ccip-token",
          name: "CCIP Token",
          symbol: "CCIPT",
          flags: {
            backing: "rwa-backed",
            pegCurrency: "USD",
            governance: "centralized",
            yieldBearing: false,
            rwa: false,
            navToken: false,
          },
          deploymentModel: "third-party-bridge",
          pegMechanism: "Cross-chain issuance uses Chainlink CCIP burn/mint pools.",
        },
        {
          id: "reviewed-native",
          name: "Reviewed Native",
          symbol: "RN",
          flags: {
            backing: "rwa-backed",
            pegCurrency: "USD",
            governance: "centralized",
            yieldBearing: false,
            rwa: false,
            navToken: false,
          },
          deploymentModel: "native-multichain",
          bridgeRouteRisk: {
            tier: "issuer-native-burn-mint",
            summary: "Issuer-native route.",
            reviewedAt: "2026-06-12",
            reviewer: "test",
            confidence: "verified",
            sourceFreeRationale: "Synthetic test fixture.",
          },
        },
      ],
    });

    expect(audit.summary).toMatchObject({
      stablecoinCount: 2,
      stablecoinsWithProtocolReferences: 1,
      stablecoinsWithBridgeRouteRisk: 1,
      reviewRowCount: 1,
    });
    expect(audit.reviewRows[0]).toMatchObject({
      coinId: "ccip-token",
      deploymentModel: "third-party-bridge",
      currentBridgeRouteTier: null,
      suggestedBridgeRouteTier: "external-lock-mint",
      reasons: ["bridge-route-risk-missing", "l2beat-protocol-reference", "third-party-bridge-review"],
    });
    expect(audit.reviewRows[0].protocols.map((protocol) => protocol.slug)).toContain("ccip");
  });

  it("does not match common protocol IDs as substrings inside ordinary prose", () => {
    const matches = findL2BeatInteropProtocolReferences(
      "Issuer route is burn/mint based, uses inked docs, relay status text, OFT-style prose, and CCTP v2.",
    );

    expect(matches.map((protocol) => protocol.id)).toContain("cctpv2");
    expect(matches.map((protocol) => protocol.id)).not.toEqual(expect.arrayContaining(["base", "ink", "layerzero", "relay"]));
  });

  it("still matches explicit protocol phrases for ambiguous one-token protocol names", () => {
    const matches = findL2BeatInteropProtocolReferences(
      "Bridge docs cite Base Canonical, Ink Canonical, LayerZero OFT, and the Relay protocol.",
    );

    expect(matches.map((protocol) => protocol.id)).toEqual(
      expect.arrayContaining(["base", "ink", "layerzero", "relay"]),
    );
  });
});

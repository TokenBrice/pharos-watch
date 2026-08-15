import { describe, expect, it } from "vitest";
import {
  collectCriticalControlIdentities,
  criticalControllerKey,
  findCommonCriticalControls,
} from "../control-identities";
import type { StablecoinMeta } from "../../types/core";

describe("critical control identities", () => {
  it("derives a stable chain-scoped address identity", () => {
    expect(criticalControllerKey("Ethereum", "0xAbC123")).toBe("address:ethereum:0xabc123");
    expect(criticalControllerKey("solana", "AbC123")).toBe("address:solana:AbC123");
  });

  it("uses canonical chain whitespace, alias, and unknown-label handling", () => {
    expect(criticalControllerKey(" OP Mainnet ", "0xAbC123")).toBe("address:optimism:0xabc123");
    expect(criticalControllerKey(" New Chain ", "AbC123")).toBe("address:new chain:AbC123");
  });

  it("detects an address reused by mint and upgrade paths plus reviewed common modes", () => {
    const meta = {
      id: "fixture",
      mintAuthority: {
        upgradeability: {
          model: "uups",
          canChangeMintLogic: true,
          controlRef: "Admin",
          sources: [{ label: "Explorer", url: "https://example.com/admin" }],
        },
        controls: [
          {
            chain: "ethereum",
            address: "0xABC",
            label: "Admin",
            role: "proxy-admin",
            authorityType: "eoa",
            directMintAbility: "upgrade-only",
            failureDomainKeys: ["operator:issuer"],
          },
        ],
      },
      bridgeRouteRisk: {
        routes: [
          {
            id: "route",
            destinationChain: "base",
            contractAddress: "0xDEF",
            protocol: "Bridge",
            issuanceModel: "bridge-representation",
            routeClass: "third-party",
            riskTier: "external-lock-mint",
            semantics: "lock-mint",
            scope: "global",
            reviewDisposition: "reviewed",
            failureDomainKeys: ["operator:issuer"],
          },
        ],
      },
    } as unknown as StablecoinMeta;

    expect(collectCriticalControlIdentities(meta)).toContainEqual({
      key: "address:ethereum:0xabc",
      path: "upgrade",
      label: "Admin",
    });
    expect(findCommonCriticalControls(meta)).toEqual([
      {
        key: "address:ethereum:0xabc",
        paths: ["mint", "upgrade"],
        labels: ["Admin"],
      },
      {
        key: "reviewed:operator:issuer",
        paths: ["bridge", "mint", "upgrade"],
        labels: ["Admin", "route"],
      },
    ]);
  });
});

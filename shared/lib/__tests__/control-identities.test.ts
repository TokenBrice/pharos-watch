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
  it("does not mistake repeated identities within one path for common control", () => {
    const meta = {
      mintAuthority: { controls: [
        { chain: "ethereum", address: "0xABC", label: "One", failureDomainKeys: ["issuer"] },
        { chain: "ethereum", address: "0xabc", label: "Two", failureDomainKeys: ["issuer", "issuer"] },
      ] },
    } as unknown as StablecoinMeta;
    expect(findCommonCriticalControls(meta)).toEqual([]);
  });

  it("keeps matching address bytes on different chains independent", () => {
    const meta = {
      mintAuthority: { controls: [{ chain: "ethereum", address: "0xABC", label: "Mint" }] },
      bridgeRouteRisk: { routes: [{ id: "Bridge", controllerChain: "base", controllerAddress: "0xabc" }] },
    } as unknown as StablecoinMeta;
    expect(findCommonCriticalControls(meta)).toEqual([]);
  });

  it("joins bridge controllers, oracle feeds, and reviewed oracle keys to mint controls", () => {
    const meta = {
      mintAuthority: { controls: [{
        chain: "ethereum", address: "0xABC", label: "Mint",
        failureDomainKeys: ["branch", "feed"],
      }] },
      bridgeRouteRisk: { routes: [{
        id: "Bridge", controllerChain: "ethereum", controllerAddress: "0xabc",
      }] },
      oracleRisk: { branches: [{
        label: "Oracle", failureDomainKeys: ["branch"],
        feeds: [{ chain: "ethereum", address: "0xabc", provider: "Feed", failureDomainKeys: ["feed"] }],
      }] },
    } as unknown as StablecoinMeta;
    expect(findCommonCriticalControls(meta)).toEqual([
      { key: "address:ethereum:0xabc", paths: ["bridge", "mint", "oracle"], labels: ["Bridge", "Mint", "Oracle: Feed"] },
      { key: "reviewed:branch", paths: ["mint", "oracle"], labels: ["Mint", "Oracle"] },
      { key: "reviewed:feed", paths: ["mint", "oracle"], labels: ["Mint", "Oracle: Feed"] },
    ]);
  });
});

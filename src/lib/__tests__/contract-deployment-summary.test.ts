import { describe, expect, it } from "vitest";
import {
  buildContractDeploymentAnchor,
  buildContractDeploymentParts,
} from "@/lib/contract-deployment-summary";
import type { StablecoinMeta } from "@shared/types";

type ContractDeployment = NonNullable<StablecoinMeta["contracts"]>[number];

function deployment(chain: string, address: string, decimals: number | null = 18): ContractDeployment {
  return { chain, address, decimals } as ContractDeployment;
}

function nativeDeployment(chain: string, address: string): ContractDeployment {
  return { chain, address, decimals: null, kind: "native-denom" } as ContractDeployment;
}

describe("buildContractDeploymentAnchor", () => {
  it("keeps two deployments on the same chain distinct", () => {
    const first = buildContractDeploymentAnchor(deployment("base", "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
    const second = buildContractDeploymentAnchor(deployment("base", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
    expect(first).not.toBe(second);
  });

  it("preserves address case", () => {
    const checksummed = buildContractDeploymentAnchor(
      deployment("ethereum", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
    );
    expect(checksummed).toContain("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    expect(checksummed).not.toContain("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
  });

  it("encodes native denomination punctuation into the anchor", () => {
    const anchor = buildContractDeploymentAnchor(
      nativeDeployment("injective", "factory/inj1abc:denom/inj1def"),
    );
    expect(anchor).toBe("contract-injective:factory%2Finj1abc%3Adenom%2Finj1def");
    // The anchor stays escaped; the fragment layer is what restores it exactly.
    expect(decodeURIComponent(anchor)).toBe("contract-injective:factory/inj1abc:denom/inj1def");
  });

  it("round-trips a literal percent through the fragment encoding", () => {
    const anchor = buildContractDeploymentAnchor(nativeDeployment("kava", "ibc/100%SHARE"));
    expect(anchor).toBe("contract-kava:ibc%2F100%25SHARE");
    expect(decodeURIComponent(encodeURIComponent(anchor))).toBe(anchor);
  });

  it("does not depend on array position", () => {
    const contracts = [
      deployment("ethereum", "0x1111111111111111111111111111111111111111"),
      deployment("base", "0x2222222222222222222222222222222222222222"),
      deployment("solana", "So11111111111111111111111111111111111111112"),
    ];
    const forwards = contracts.map(buildContractDeploymentAnchor);
    const backwards = [...contracts].reverse().map(buildContractDeploymentAnchor).reverse();
    expect(backwards).toEqual(forwards);
  });

  it("round-trips the fragment the detail page decodes exactly once", () => {
    const contracts = [
      deployment("ethereum", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
      nativeDeployment("injective", "factory/inj1abc/inj1def"),
      nativeDeployment("kava", "100%share"),
    ];

    for (const contract of contracts) {
      const anchor = buildContractDeploymentAnchor(contract);
      const href = `#${encodeURIComponent(anchor)}`;
      // The detail page reads `decodeURIComponent(window.location.hash.slice(1))`.
      expect(decodeURIComponent(href.slice(1))).toBe(anchor);
    }
  });
});

describe("buildContractDeploymentParts", () => {
  it("keeps the existing summary source output unchanged", () => {
    const contracts = [
      deployment("ethereum", "0x1111111111111111111111111111111111111111"),
      deployment("arbitrum", "0x2222222222222222222222222222222222222222"),
      deployment("base", "0x3333333333333333333333333333333333333333"),
      deployment("optimism", "0x4444444444444444444444444444444444444444"),
      deployment("polygon", "0x5555555555555555555555555555555555555555"),
      deployment("base", "0x6666666666666666666666666666666666666666"),
    ];

    expect(buildContractDeploymentParts(contracts)).toMatchObject({
      count: 6,
      chainNames: ["Ethereum", "Arbitrum", "Base", "Optimism"],
      remaining: 2,
      deploymentLabel: "deployments",
    });
    expect(buildContractDeploymentParts(contracts).sample).toHaveLength(4);
  });

  it("labels a single deployment singularly and treats absent contracts as empty", () => {
    const parts = buildContractDeploymentParts([deployment("ethereum", "0x1111111111111111111111111111111111111111")]);
    expect(parts).toMatchObject({ count: 1, remaining: 0, deploymentLabel: "deployment" });
    expect(buildContractDeploymentParts(undefined)).toMatchObject({ count: 0, chainNames: [], remaining: 0 });
  });
});

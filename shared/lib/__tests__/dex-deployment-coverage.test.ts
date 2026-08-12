import { describe, expect, it } from "vitest";
import { ACTIVE_STABLECOINS } from "../stablecoins/registry";
import {
  DEX_COVERAGE_WAIVERS,
  getActiveDexCoverageWaiver,
  getDexDiscoveryProviders,
  getGeckoTerminalDiscoveryTarget,
} from "../dex-deployment-coverage";

const REVIEW_AT_SEC = Date.UTC(2026, 6, 10) / 1000;

describe("DEX deployment coverage ownership", () => {
  it("classifies the audited unsupported deployment universe exactly", () => {
    const unsupported: Array<{ stablecoinId: string; chain: string; address: string }> = [];
    const exclusivelyUnsupported: string[] = [];

    for (const meta of ACTIVE_STABLECOINS) {
      const deployments = [...(meta.contracts ?? []), ...(meta.tradedContracts ?? [])];
      const inaccessible = deployments.filter(
        (deployment) => getDexDiscoveryProviders(deployment.chain, deployment.address).length === 0,
      );
      unsupported.push(
        ...inaccessible.map((deployment) => ({
          stablecoinId: meta.id,
          chain: deployment.chain,
          address: deployment.address,
        })),
      );
      if (deployments.length > 0 && inaccessible.length === deployments.length) {
        exclusivelyUnsupported.push(meta.id);
      }
    }

    expect(unsupported).toHaveLength(51);
    expect(new Set(unsupported.map((row) => row.stablecoinId)).size).toBe(31);
    expect(exclusivelyUnsupported).toHaveLength(5);
    expect(getDexDiscoveryProviders("stellar")).toEqual(["horizon"]);
  });

  it("registers only the exact supplemental GeckoTerminal deployment shapes", () => {
    expect(getGeckoTerminalDiscoveryTarget("starknet", "0xabc")).toEqual({
      network: "starknet-alpha",
      address: `0x${"abc".padStart(64, "0")}`,
    });
    expect(getGeckoTerminalDiscoveryTarget("stacks", "SP123.token")).toEqual({
      network: "stacks",
      address: "SP123.token",
    });
    expect(getGeckoTerminalDiscoveryTarget("mantra", "0x866A2BF4E572CBCF37D5071A7A58503BFB36BE1B")).toEqual({
      network: "mantra-evm",
      address: "0x866a2bf4e572cbcf37d5071a7a58503bfb36be1b",
    });
    expect(
      getGeckoTerminalDiscoveryTarget(
        "mantra",
        "ibc/6749D16BC09F419C090C330FC751FFF1C96143DB7A4D2FCAEC2F348A3E17618A",
      ),
    ).toBeNull();
    expect(getDexDiscoveryProviders("mantra")).toEqual([]);
  });

  it("gives every exclusively inaccessible coin an owned, unexpired waiver", () => {
    const exclusivelyUnsupported = ACTIVE_STABLECOINS.filter((meta) => {
      const deployments = [...(meta.contracts ?? []), ...(meta.tradedContracts ?? [])];
      return (
        deployments.length > 0 &&
        deployments.every(
          (deployment) => getDexDiscoveryProviders(deployment.chain, deployment.address).length === 0,
        )
      );
    });

    const missing = exclusivelyUnsupported.flatMap((meta) => {
      const chains = new Set([...(meta.contracts ?? []), ...(meta.tradedContracts ?? [])].map((row) => row.chain));
      return [...chains]
        .filter((chain) => getActiveDexCoverageWaiver(meta.id, chain, REVIEW_AT_SEC) == null)
        .map((chain) => `${meta.id}:${chain}`);
    });

    expect(missing).toEqual([]);
    expect(DEX_COVERAGE_WAIVERS).toHaveLength(5);
    expect(DEX_COVERAGE_WAIVERS.every((waiver) => waiver.owner.length > 0 && waiver.expiresAt > REVIEW_AT_SEC)).toBe(
      true,
    );
  });
});

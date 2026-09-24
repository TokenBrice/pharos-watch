import { describe, expect, it } from "vitest";
import usdcCircleCoin from "@shared/data/stablecoins/coins/usdc-circle.json";
import usdtTetherCoin from "@shared/data/stablecoins/coins/usdt-tether.json";
import usdeEthenaCoin from "@shared/data/stablecoins/coins/usde-ethena.json";
import { DWELLIR_CHAINS, buildChainRpcs, dwellirRpcUrl } from "../../chain-registry";
import { getPublicRpcUrl } from "../../public-rpc-registry";
import {
  RPC_PARITY_TARGETS,
  dwellirHostForChain,
  plannedRpcParityComparator,
  resolveRpcParityComparator,
  type RpcParityTarget,
} from "../targets";

const COIN_BY_ID: Record<string, { contracts?: readonly { chain?: string; address?: string }[] }> = {
  "usdc-circle": usdcCircleCoin,
  "usdt-tether": usdtTetherCoin,
  "usde-ethena": usdeEthenaCoin,
};

function target(chainId: string): RpcParityTarget {
  const found = RPC_PARITY_TARGETS.find((candidate) => candidate.chainId === chainId);
  if (!found) throw new Error(`missing parity target for ${chainId}`);
  return found;
}

describe("rpc parity targets", () => {
  it("covers every Dwellir chain exactly once, in the registry's own order", () => {
    const targetChains = RPC_PARITY_TARGETS.map((entry) => entry.chainId);
    expect(targetChains).toEqual(DWELLIR_CHAINS.map((entry) => entry.chainId));
    expect(new Set(targetChains).size).toBe(targetChains.length);
    for (const entry of DWELLIR_CHAINS) {
      // The stored host label must be the host of the URL the probe actually
      // calls, including avalanche's path suffix.
      expect(dwellirHostForChain(entry.chainId)).toBe(new URL(dwellirRpcUrl(entry)).host);
    }
  });

  it("tracks a contract that the named coin lists on that chain", () => {
    for (const entry of RPC_PARITY_TARGETS) {
      const coin = COIN_BY_ID[entry.coinId];
      expect(coin, `${entry.chainId} names a tracked coin`).toBeDefined();
      expect(entry.contract).toBe(entry.contract.toLowerCase());
      const deployment = coin.contracts?.find(
        (contract) => contract.chain === entry.chainId && contract.address?.toLowerCase() === entry.contract,
      );
      expect(deployment, `${entry.chainId} deploys ${entry.contract} in ${entry.coinId}`).toBeDefined();
    }
  });

  it("resolves registry comparators from the chain's first registry endpoint", () => {
    const unkeyed = resolveRpcParityComparator(target("base"), buildChainRpcs());
    expect(unkeyed?.url).toBe(getPublicRpcUrl("base"));
    expect(unkeyed?.ref).toEqual({ operator: "public", host: "mainnet.base.org", source: "registry" });

    const keyed = resolveRpcParityComparator(target("base"), buildChainRpcs("parity-test-alchemy-key"));
    expect(keyed?.ref.operator).toBe("alchemy");
    expect(keyed?.ref.host).toBe("base-mainnet.g.alchemy.com");
    // The comparator claim never carries the keyed URL's credential.
    expect(keyed?.ref.host).not.toContain("parity-test-alchemy-key");

    const drpcChain = resolveRpcParityComparator(target("celo"), buildChainRpcs(undefined, "parity-test-drpc-key"));
    expect(drpcChain?.ref.operator).toBe("drpc");

    const arc = resolveRpcParityComparator(target("arc"), buildChainRpcs());
    expect(arc?.ref).toEqual({ operator: "public", host: "rpc.mainnet.arc.io", source: "registry" });
  });

  it("falls back to the reviewed public pin for chains with no registry config", () => {
    const pinned = resolveRpcParityComparator(target("megaeth"), buildChainRpcs());
    expect(pinned?.url).toBe("https://mainnet.megaeth.com/rpc");
    expect(pinned?.ref).toEqual({ operator: "public", host: "mainnet.megaeth.com", source: "pin" });
    // A pin comparator does not depend on the registry map at all.
    expect(resolveRpcParityComparator(target("megaeth"), new Map())?.url).toBe(pinned?.url);
  });

  it("keeps every pin keyless and https", () => {
    for (const entry of RPC_PARITY_TARGETS) {
      if (entry.comparator.source !== "pin") continue;
      const url = new URL(entry.comparator.url);
      expect(url.protocol, entry.chainId).toBe("https:");
      expect(url.search, entry.chainId).toBe("");
    }
  });

  it("reports a planned comparator only for chains with no observation yet", () => {
    expect(plannedRpcParityComparator(target("base"))).toEqual({
      operator: "public",
      host: "mainnet.base.org",
      source: "registry",
    });
    expect(plannedRpcParityComparator(target("xdc"))).toEqual({
      operator: "public",
      host: "rpc.xdcrpc.com",
      source: "pin",
    });
  });

  it("returns no comparator for a registry target the runtime cannot read", () => {
    expect(resolveRpcParityComparator(target("base"), new Map())).toBeNull();
  });
});

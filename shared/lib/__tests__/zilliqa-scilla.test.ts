import { describe, expect, it } from "vitest";
import { onchainSupplyProbeFamily } from "@shared/lib/onchain-supply-probe";
import { getDexDiscoveryProviders } from "@shared/lib/dex-deployment-coverage";
import { resolveChainId } from "../../types/chain-identity";
import { buildExplorerUrl } from "@shared/lib/explorer";

describe("Zilliqa Scilla deployment boundaries", () => {
  it("resolves captured supply labels without dispatching hex-shaped Scilla tokens to EVM readers", () => {
    const chain = resolveChainId("Zilliqa")!;
    expect(chain).toBe("zilliqa");
    for (const address of ["zil1zu72vac254htqpg3mtywdcfm84l3dfd9qzww8t", "0x173ca6770aa56eb00511dac8e6e13b3d7f16a5a5"]) {
      expect(onchainSupplyProbeFamily({ chain, address, decimals: 6 })).toBeNull();
      expect(getDexDiscoveryProviders(chain, address)).toEqual([]);
      expect(buildExplorerUrl({ chainKey: chain, entityType: "contract", value: address })).toBe(`https://viewblock.io/zilliqa/address/${address}`);
    }
  });
});

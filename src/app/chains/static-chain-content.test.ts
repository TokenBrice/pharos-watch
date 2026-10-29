import { describe, expect, it } from "vitest";
import { getActiveChainIds } from "@shared/lib/chains";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import {
  getChainDirectoryEntries,
  getChainTrackedDeploymentCount,
  getTrackedDeploymentsForChain,
} from "./static-chain-content";

describe("getChainDirectoryEntries", () => {
  // The directory now derives per-chain deployment counts from a single
  // contract-count Map pass; pin that it matches the per-chain helper so the
  // optimization can't silently diverge. [audit S-020]
  it("reports deployment counts that match getChainTrackedDeploymentCount per chain", () => {
    const entries = getChainDirectoryEntries();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.deploymentCount).toBe(getChainTrackedDeploymentCount(entry.id));
    }
  });

});

describe("getTrackedDeploymentsForChain", () => {
  it("carries the exact filtered contract records and keeps the coin-level shape", () => {
    for (const chain of getActiveChainIds()) {
      const deployments = getTrackedDeploymentsForChain(chain);
      const expected = ACTIVE_STABLECOINS.flatMap((coin) =>
        (coin.contracts ?? [])
          .filter((contract) => contract.chain === chain)
          .map((contract) => ({ id: coin.id, contract })),
      );

      expect(
        deployments.flatMap((deployment) =>
          deployment.contracts.map((contract) => ({ id: deployment.id, contract })),
        ),
        chain,
      ).toEqual(expected);

      for (const deployment of deployments) {
        expect(deployment.contractCount, chain).toBe(deployment.contracts.length);
        expect(deployment.contracts.length, chain).toBeGreaterThan(0);
        expect(deployment.contracts.every((contract) => contract.chain === chain), chain).toBe(true);
      }
    }
  });

  it("keeps a coin with several same-chain addresses as one entry with distinct rows", () => {
    const multiAddressEntries = getActiveChainIds().flatMap((chain) =>
      getTrackedDeploymentsForChain(chain).filter((deployment) => deployment.contracts.length > 1),
    );

    expect(multiAddressEntries.length).toBeGreaterThan(0);
    for (const deployment of multiAddressEntries) {
      expect(deployment.contractCount).toBeGreaterThan(1);
      expect(new Set(deployment.contracts.map((contract) => contract.address)).size).toBe(
        deployment.contracts.length,
      );
    }
  });

  it("returns no entries for an unknown chain or an active chain with no recorded deployment", () => {
    expect(getTrackedDeploymentsForChain("not-a-chain")).toEqual([]);

    const emptyChain = getActiveChainIds().find((chain) => getChainTrackedDeploymentCount(chain) === 0);
    expect(emptyChain).toBeDefined();
    expect(getTrackedDeploymentsForChain(emptyChain!)).toEqual([]);
  });
});

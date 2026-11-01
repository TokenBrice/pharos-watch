import { describe, expect, it } from "vitest";
import { getActiveChainIds } from "@shared/lib/chains";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { CHAIN_META } from "@shared/types/chain-identity";
import { buildChainDirectoryJsonLd, buildChainProfileJsonLd } from "@/lib/chain-json-ld";
import { deploymentCountLabel } from "@/lib/chain-labels";
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

  it("names the active universe it counts and omits a zero deployment clause", () => {
    const entries = getChainDirectoryEntries();
    const empty = entries.find((entry) => entry.deploymentCount === 0);
    expect(empty).toBeDefined();
    expect(deploymentCountLabel(320)).toBe("320 active deployments");
    expect(deploymentCountLabel(1)).toBe("1 active deployment");

    const serializedDirectory = JSON.stringify(buildChainDirectoryJsonLd(entries));
    expect(serializedDirectory).not.toContain("tracked stablecoin deployment");
    expect(serializedDirectory).not.toContain('"description":"0 active stablecoin deployment');

    const ethereum = entries.find((entry) => entry.id === "ethereum")!;
    expect(JSON.stringify(buildChainDirectoryJsonLd([ethereum]))).toContain(
      `${ethereum.deploymentCount} active stablecoin deployments`,
    );

    const meta = CHAIN_META[empty!.id]!;
    const serializedProfile = JSON.stringify(
      buildChainProfileJsonLd({ chainId: empty!.id, meta, deployments: [] }),
    );
    expect(serializedProfile).not.toMatch(/0 active deployment/);
    expect(serializedProfile).toContain(`Stablecoin supply, composition, and Chain Health on ${meta.name}.`);
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

import { describe, expect, it } from "vitest";
import { ACTIVE_STABLECOINS } from "../stablecoins/registry";
import {
  DEX_COVERAGE_WAIVERS,
  getActiveDexCoverageWaiver,
  getDexDiscoveryProviders,
} from "../dex-deployment-coverage";

const REVIEW_AT_SEC = Date.UTC(2026, 6, 10) / 1000;

describe("DEX deployment coverage ownership", () => {
  it("classifies the audited unsupported deployment universe exactly", () => {
    const unsupported: Array<{ stablecoinId: string; chain: string; address: string }> = [];
    const exclusivelyUnsupported: string[] = [];

    for (const meta of ACTIVE_STABLECOINS) {
      const deployments = [...(meta.contracts ?? []), ...(meta.tradedContracts ?? [])];
      const inaccessible = deployments.filter((deployment) => getDexDiscoveryProviders(deployment.chain).length === 0);
      unsupported.push(...inaccessible.map((deployment) => ({
        stablecoinId: meta.id,
        chain: deployment.chain,
        address: deployment.address,
      })));
      if (deployments.length > 0 && inaccessible.length === deployments.length) {
        exclusivelyUnsupported.push(meta.id);
      }
    }

    expect(unsupported).toHaveLength(322);
    expect(new Set(unsupported.map((row) => row.stablecoinId)).size).toBe(118);
    expect(exclusivelyUnsupported).toHaveLength(20);
  });

  it("gives every exclusively inaccessible coin an owned, unexpired waiver", () => {
    const exclusivelyUnsupported = ACTIVE_STABLECOINS.filter((meta) => {
      const deployments = [...(meta.contracts ?? []), ...(meta.tradedContracts ?? [])];
      return deployments.length > 0 && deployments.every(
        (deployment) => getDexDiscoveryProviders(deployment.chain).length === 0,
      );
    });

    const missing = exclusivelyUnsupported.flatMap((meta) => {
      const chains = new Set([...(meta.contracts ?? []), ...(meta.tradedContracts ?? [])].map((row) => row.chain));
      return [...chains]
        .filter((chain) => getActiveDexCoverageWaiver(meta.id, chain, REVIEW_AT_SEC) == null)
        .map((chain) => `${meta.id}:${chain}`);
    });

    expect(missing).toEqual([]);
    expect(DEX_COVERAGE_WAIVERS).toHaveLength(20);
    expect(DEX_COVERAGE_WAIVERS.every((waiver) => waiver.owner.length > 0 && waiver.expiresAt > REVIEW_AT_SEC)).toBe(true);
  });
});

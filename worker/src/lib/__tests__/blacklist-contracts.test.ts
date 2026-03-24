import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import {
  CONTRACT_CONFIGS,
  getBlacklistEventBySignature,
  getBlacklistEventByTopic,
  getBlacklistTopicHashes,
} from "../blacklist-contracts";

describe("blacklist-contracts shared metadata alignment", () => {
  it("resolves each tracked contract from shared stablecoin metadata", () => {
    for (const config of CONTRACT_CONFIGS) {
      const meta = TRACKED_META_BY_ID.get(config.stablecoinId);
      expect(meta, `missing tracked metadata for ${config.stablecoinId}`).toBeDefined();

      const deployments = [
        ...(meta?.contracts ?? []),
        ...(meta?.tradedContracts ?? []),
      ].filter((deployment) => deployment.chain === config.chain.chainId);

      const matchingDeployment = deployments.find(
        (deployment) =>
          deployment.address.toLowerCase() === config.contractAddress.toLowerCase()
          && deployment.decimals === config.decimals,
      );

      expect(
        matchingDeployment,
        `expected ${config.stablecoinId} ${config.chain.chainId} blacklist contract to be declared in shared metadata`,
      ).toBeDefined();
    }
  });

  it("resolves blacklist event lookups by topic hash and bare signature name", () => {
    const ethereumUsdt = CONTRACT_CONFIGS.find((config) => config.stablecoinId === "usdt-tether" && config.chain.chainId === "ethereum");
    expect(ethereumUsdt).toBeDefined();

    const destroyEvent = getBlacklistEventByTopic(
      ethereumUsdt!,
      "0x61e6e66b0d6339b2980aecc6ccc0039736791f0ccde9ed512e789a7fbdd698c6",
    );
    expect(destroyEvent?.eventType).toBe("destroy");
    expect(destroyEvent?.hasAmount).toBe(true);

    const tronBlacklistEvent = getBlacklistEventBySignature(ethereumUsdt!, "AddedBlackList");
    expect(tronBlacklistEvent?.eventType).toBe("blacklist");
  });

  it("deduplicates blacklist topic hashes per contract config", () => {
    for (const config of CONTRACT_CONFIGS) {
      const topicHashes = getBlacklistTopicHashes(config);
      expect(new Set(topicHashes).size).toBe(topicHashes.length);
    }
  });
});

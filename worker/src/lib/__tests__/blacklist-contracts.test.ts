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

  it("includes first-wave blacklist expansion configs", () => {
    expect(CONTRACT_CONFIGS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stablecoinId: "usdg-paxos", chain: expect.objectContaining({ chainId: "ethereum" }) }),
        expect.objectContaining({ stablecoinId: "rlusd-ripple", chain: expect.objectContaining({ chainId: "ethereum" }) }),
        expect.objectContaining({ stablecoinId: "u-united-stables", chain: expect.objectContaining({ chainId: "ethereum" }) }),
        expect.objectContaining({ stablecoinId: "u-united-stables", chain: expect.objectContaining({ chainId: "bsc" }) }),
        expect.objectContaining({ stablecoinId: "usdtb-ethena", chain: expect.objectContaining({ chainId: "ethereum" }) }),
        expect.objectContaining({ stablecoinId: "a7a5-old-vector", chain: expect.objectContaining({ chainId: "ethereum" }) }),
      ]),
    );
  });

  it("resolves first-wave event families by topic", () => {
    const usdtb = CONTRACT_CONFIGS.find((config) => config.stablecoinId === "usdtb-ethena");
    expect(usdtb).toBeDefined();
    const usdtbBlocked = getBlacklistEventByTopic(
      usdtb!,
      "0x5444f9841c04ce78987f28701fa07fc4c112840c1c8439e8f52bda50c3788a87",
    );
    expect(usdtbBlocked).toMatchObject({
      eventType: "blacklist",
      addressArrayData: true,
    });

    const a7a5 = CONTRACT_CONFIGS.find((config) => config.stablecoinId === "a7a5-old-vector");
    expect(a7a5).toBeDefined();
    const deblacklisted = getBlacklistEventByTopic(
      a7a5!,
      "0x8e6c9e5ceff66044a0b27759779a9be2e7c99655252b235ff3f754efb6b8a616",
    );
    expect(deblacklisted?.eventType).toBe("unblacklist");

    const rlusd = CONTRACT_CONFIGS.find((config) => config.stablecoinId === "rlusd-ripple");
    expect(rlusd).toBeDefined();
    const accountPaused = getBlacklistEventBySignature(rlusd!, "AccountPaused");
    expect(accountPaused?.eventType).toBe("blacklist");
  });
});

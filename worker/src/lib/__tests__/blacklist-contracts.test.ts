import { describe, expect, it } from "vitest";
import {
  ACTIVE_STABLECOINS,
  TRACKED_META_BY_ID,
  TRACKED_STABLECOINS,
} from "@shared/lib/stablecoins/registry";
import { resolveBlacklistStatuses } from "@shared/lib/report-card-blacklist-matchers";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";
import {
  buildBlacklistCoverageManifest,
  getDeferredBlacklistCoverage,
} from "../blacklist-coverage-manifest";
import {
  CONTRACT_CONFIGS,
  PYUSD_EVENT_FAMILY,
  chainConfig,
  getBlacklistConfigsForSymbolAndChain,
  getBlacklistEventBySignature,
  getBlacklistEventByTopic,
  getBlacklistTopicHashes,
} from "../blacklist-contracts";
import { shouldPreferRpcLogScan } from "../../cron/blacklist/evm-source";

const trackedBlacklistStatuses = resolveBlacklistStatuses(
  TRACKED_STABLECOINS,
  { trackedMetaById: TRACKED_META_BY_ID },
);

describe("blacklist-contracts shared metadata alignment", () => {
  it("marks every blacklist-tracked stablecoin as directly freezable", () => {
    const mismatches = [...new Set(CONTRACT_CONFIGS.map((config) => config.stablecoinId))]
      .filter((stablecoinId) => trackedBlacklistStatuses.get(stablecoinId) !== true);

    expect(mismatches).toEqual([]);
  });

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

  it("keeps the coverage manifest aligned with tracker configs and deferred rows", () => {
    const manifest = buildBlacklistCoverageManifest(ACTIVE_STABLECOINS, CONTRACT_CONFIGS);
    const trackedManifestKeys = new Set(
      manifest
        .filter((entry) => entry.status === "tracked")
        .map((entry) => `${entry.chainId}-${entry.contractAddress?.toLowerCase()}`),
    );

    for (const config of CONTRACT_CONFIGS) {
      expect(
        trackedManifestKeys.has(`${config.chain.chainId}-${config.contractAddress.toLowerCase()}`),
        `missing manifest entry for ${config.configKey}`,
      ).toBe(true);
    }

    const deferred = getDeferredBlacklistCoverage();
    expect(deferred).toHaveLength(10);
    expect(manifest.filter((entry) => entry.status === "deferred")).toHaveLength(deferred.length);
  });

  it("represents every active direct-Yes assessment in the coverage manifest", () => {
    const resolved = resolveBlacklistStatuses(ACTIVE_STABLECOINS);
    const manifest = buildBlacklistCoverageManifest(ACTIVE_STABLECOINS, CONTRACT_CONFIGS);
    const manifestIds = new Set(manifest.map((entry) => entry.stablecoinId));
    const missing = ACTIVE_STABLECOINS
      .filter((meta) => resolved.get(meta.id) === true)
      .map((meta) => meta.id)
      .filter((id) => !manifestIds.has(id));

    expect(missing).toEqual([]);
  });

  it("separates enum support from live tracker coverage", () => {
    const trackedSymbols = new Set(CONTRACT_CONFIGS.map((config) => config.stablecoin));
    const deferredSymbols = new Set(getDeferredBlacklistCoverage().map((entry) => entry.symbol));
    const missing = BLACKLIST_STABLECOINS.filter(
      (symbol) => !trackedSymbols.has(symbol) && !deferredSymbols.has(symbol),
    );

    expect(missing).toEqual([]);
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

  it("includes direct EVM follow-up coverage configs", () => {
    expect(CONTRACT_CONFIGS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stablecoinId: "fdusd-first-digital", chain: expect.objectContaining({ chainId: "ethereum" }) }),
        expect.objectContaining({ stablecoinId: "fdusd-first-digital", chain: expect.objectContaining({ chainId: "bsc" }) }),
        expect.objectContaining({ stablecoinId: "fdusd-first-digital", chain: expect.objectContaining({ chainId: "arbitrum" }) }),
        expect.objectContaining({ stablecoinId: "brz-transfero", chain: expect.objectContaining({ chainId: "ethereum" }) }),
        expect.objectContaining({ stablecoinId: "brz-transfero", chain: expect.objectContaining({ chainId: "gnosis" }) }),
        expect.objectContaining({ stablecoinId: "ausd-agora", chain: expect.objectContaining({ chainId: "arbitrum" }) }),
        expect.objectContaining({ stablecoinId: "ausd-agora", chain: expect.objectContaining({ chainId: "base" }) }),
        expect.objectContaining({ stablecoinId: "euri-banking-circle", chain: expect.objectContaining({ chainId: "ethereum" }) }),
        expect.objectContaining({ stablecoinId: "euri-banking-circle", chain: expect.objectContaining({ chainId: "bsc" }) }),
        expect.objectContaining({ stablecoinId: "usdq-quantoz", chain: expect.objectContaining({ chainId: "ethereum" }) }),
        expect.objectContaining({ stablecoinId: "usdo-openeden", chain: expect.objectContaining({ chainId: "ethereum" }) }),
        expect.objectContaining({ stablecoinId: "usdo-openeden", chain: expect.objectContaining({ chainId: "base" }) }),
        expect.objectContaining({ stablecoinId: "usdx-hex-trust", chain: expect.objectContaining({ chainId: "ethereum" }) }),
        expect.objectContaining({ stablecoinId: "aid-gaib", chain: expect.objectContaining({ chainId: "ethereum" }) }),
        expect.objectContaining({ stablecoinId: "tgbp-tokenised", chain: expect.objectContaining({ chainId: "ethereum" }) }),
        expect.objectContaining({ stablecoinId: "tgbp-tokenised", chain: expect.objectContaining({ chainId: "avalanche" }) }),
        expect.objectContaining({ stablecoinId: "eurc-circle", chain: expect.objectContaining({ chainId: "ethereum" }) }),
        expect.objectContaining({ stablecoinId: "buidl-blackrock", chain: expect.objectContaining({ chainId: "ethereum" }) }),
      ]),
    );
  });

  it("uses corrected Arbitrum startBlocks for FDUSD/AUSD/BUIDL", () => {
    const getStartBlock = (stablecoinId: string, chainId: string) => {
      const config = CONTRACT_CONFIGS.find(
        (c) => c.stablecoinId === stablecoinId && c.chain.chainId === chainId,
      );
      return config?.startBlock;
    };
    expect(getStartBlock("fdusd-first-digital", "arbitrum")).toBe(336_278_229);
    expect(getStartBlock("ausd-agora", "arbitrum")).toBe(342_153_906);
    expect(getStartBlock("buidl-blackrock", "arbitrum")).toBe(270_969_308);
  });

  it("defines bootstrap startBlocks for every RPC-log blacklist config", () => {
    const missing = CONTRACT_CONFIGS
      .filter((config) => shouldPreferRpcLogScan(config.chain.chainId))
      .filter((config) => !Number.isFinite(config.startBlock) || (config.startBlock ?? 0) <= 0)
      .map((config) => config.configKey);

    expect(missing).toEqual([]);
  });

  it("resolves usdp-paxos on ethereum with PYUSD event family", () => {
    const config = CONTRACT_CONFIGS.find(
      (c) => c.stablecoinId === "usdp-paxos" && c.chain.chainId === "ethereum",
    );
    expect(config).toBeDefined();
    expect(config!.stablecoin).toBe("USDP");
    expect(config!.events).toEqual(PYUSD_EVENT_FAMILY.events);
  });

  it("tracks Avalon USDA blacklist events without a non-existent DestroyedBlackFunds event", () => {
    const config = CONTRACT_CONFIGS.find(
      (c) => c.stablecoinId === "usda-avalon" && c.chain.chainId === "ethereum",
    );

    expect(config).toBeDefined();
    expect(config!.events.map((event) => event.signature)).toEqual([
      "AddedBlackList(address)",
      "RemovedBlackList(address)",
    ]);
    expect(getBlacklistEventBySignature(config!, "DestroyedBlackFunds")).toBeUndefined();
  });

  it("throws when chainConfig is called with an unknown chainId", () => {
    expect(() => chainConfig("nonexistent-chain")).toThrow();
  });

  it("returns undefined for an unknown topic hash", () => {
    const config = CONTRACT_CONFIGS[0];
    expect(getBlacklistEventByTopic(config, "0xdeadbeef")).toBeUndefined();
    expect(getBlacklistEventByTopic(config, null)).toBeUndefined();
    expect(getBlacklistEventByTopic(config, undefined)).toBeUndefined();
  });

  it("matches topic hashes case-insensitively", () => {
    const config = CONTRACT_CONFIGS.find((c) => c.stablecoinId === "usdc-circle" && c.chain.chainId === "ethereum")!;
    const upper = "0xFFA4E6181777692565CF28528FC88FD1516EA86B56DA075235FA575AF6A4B855";
    expect(getBlacklistEventByTopic(config, upper)?.eventType).toBe("blacklist");
  });

  it("returns empty array when getBlacklistConfigsForSymbolAndChain has no match", () => {
    expect(getBlacklistConfigsForSymbolAndChain("USDC", "nowhere")).toEqual([]);
  });
});

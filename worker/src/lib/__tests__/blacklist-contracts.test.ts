import { describe, expect, it } from "vitest";
import { keccak256, toBytes } from "viem/utils";
import {
  ACTIVE_STABLECOINS,
  TRACKED_META_BY_ID,
  TRACKED_STABLECOINS,
} from "@shared/lib/stablecoins/registry";
import { resolveBlacklistStatuses } from "@shared/lib/report-card-blacklist-matchers";
import { BLACKLIST_STABLECOINS } from "@shared/types/blacklist";
import {
  BLACKLIST_CONTRACT_SPECS,
  BLACKLIST_TRACKED_STABLECOIN_ID_LIST,
  BLACKLIST_TRACKED_STABLECOIN_IDS as UPSTREAM_BLACKLIST_TRACKED_STABLECOIN_IDS,
  getBlacklistLedgerStablecoinById,
  getBlacklistStablecoinById,
  getBlacklistStablecoinIdBySymbol,
  hasBlacklistLedgerHistoryById,
  isBlacklistTrackedStablecoinId,
} from "@shared/lib/blacklist-contract-specs";
import {
  buildBlacklistCoverageManifest,
  getDeferredBlacklistCoverage,
} from "../blacklist-coverage-manifest";
import {
  BLACKLIST_TRACKED_STABLECOIN_IDS,
  CONTRACT_CONFIGS,
  getBlacklistConfigsForSymbolAndChain,
  getBlacklistEventBySignature,
  getBlacklistEventByTopic,
  getBlacklistTopicHashes,
} from "../blacklist-contracts";
import { parseEvmLogsWithCoverage, shouldPreferRpcLogScan } from "../../cron/blacklist/evm-source";

const trackedBlacklistStatuses = resolveBlacklistStatuses(TRACKED_STABLECOINS);

describe("blacklist-contracts shared metadata alignment", () => {
  it("keeps upstream declarative tracked IDs identical to resolved BLACKLIST_TRACKED_STABLECOIN_IDS", () => {
    const resolvedIds = [...BLACKLIST_TRACKED_STABLECOIN_IDS].sort();
    expect(CONTRACT_CONFIGS).toHaveLength(BLACKLIST_CONTRACT_SPECS.length);
    expect([...UPSTREAM_BLACKLIST_TRACKED_STABLECOIN_IDS].sort()).toEqual(resolvedIds);
    expect([...BLACKLIST_TRACKED_STABLECOIN_ID_LIST].sort()).toEqual(resolvedIds);
    expect(new Set(BLACKLIST_TRACKED_STABLECOIN_ID_LIST).size).toBe(BLACKLIST_TRACKED_STABLECOIN_ID_LIST.length);
  });

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

  it("matches every configured topic to its canonical ABI signature", () => {
    for (const config of CONTRACT_CONFIGS) {
      for (const event of config.events) {
        expect(event.topicHash, `${config.configKey}: ${event.signature}`).toBe(
          keccak256(toBytes(event.signature)),
        );
      }
    }
  });

  const makeIndexedLogs = (
    contractAddress: string,
    address: string,
    signatures: readonly string[],
    meta: { blockNumber: string; transactionHash: string; timeStamp: string },
    dataFor = (_index: number) => "0x",
  ) => signatures.map((signature, index) => ({
    address: contractAddress,
    topics: [keccak256(toBytes(signature)), `0x${address.slice(2).padStart(64, "0")}`],
    data: dataFor(index),
    logIndex: `0x${index.toString(16)}`,
    ...meta,
  }));

  it("decodes current and historical PAXG freeze events without duplicating wipe coverage", () => {
    const config = CONTRACT_CONFIGS.find((entry) => entry.stablecoinId === "paxg-paxos")!;
    const signatures = ["AddressFrozen(address)", "AddressUnfrozen(address)", "FreezeAddress(address)", "UnfreezeAddress(address)", "FrozenAddressWiped(address)"];
    expect(config.events.map((event) => event.signature).sort()).toEqual([...signatures].sort());
    const address = "0x8a82042fbf41f2cfbb05af8dbaea048adb900637";
    const parsed = parseEvmLogsWithCoverage(config, makeIndexedLogs(config.contractAddress, address, signatures, {
      blockNumber: "0x81938d", transactionHash: "0x78b7566124bb681f854084c2eee7491c739d043015f8d4af2d3417d5c3891f82", timeStamp: "0x5d716129",
    }));
    expect([parsed.failures, parsed.coverageCeiling]).toEqual([[], null]);
    expect(parsed.rows.map((r) => [r.address, r.event_type, r.amount_native])).toEqual([
      [address, "blacklist", null], [address, "unblacklist", null], [address, "blacklist", null], [address, "unblacklist", null], [address, "destroy", null],
    ]);
  });

  it("uses Avalanche USDT's indexed family for freeze, unfreeze, and emitted destroy amounts", () => {
    const config = getBlacklistConfigsForSymbolAndChain("USDT", "avalanche")[0]!;
    const signatures = ["BlockPlaced(address)", "BlockReleased(address)", "DestroyedBlockedFunds(address,uint256)"];
    expect(config.startBlock).toBe(4_663_628);
    expect(config.events.map((event) => event.signature)).toEqual(signatures);
    const address = "0xa8ba80e21271742f94bbc2e9937b9b94b6aed1b4";
    const parsed = parseEvmLogsWithCoverage(config, makeIndexedLogs(
      config.contractAddress, address, signatures,
      { blockNumber: "0x1311a04", transactionHash: "0xfe35ceaf6b8a4f3a29dd7a167f8c73b8cc8657deacb3e8dca931d23e86cda464", timeStamp: "0x6326e69b" },
      (i) => (i === 2 ? `0x${(12_500_000).toString(16).padStart(64, "0")}` : "0x"),
    ));
    expect([parsed.failures, parsed.coverageCeiling]).toEqual([[], null]);
    expect(parsed.rows.map((r) => [r.address, r.event_type, r.amount_native])).toEqual([
      [address, "blacklist", null], [address, "unblacklist", null], [address, "destroy", 12.5],
    ]);
  });

  it("does not scan Binance-Peg or legacy Optimism USDT as blacklist emitters", () => {
    expect(getBlacklistConfigsForSymbolAndChain("USDT", "bsc")).toEqual([]);
    const optimism = getBlacklistConfigsForSymbolAndChain("USDT", "optimism");
    expect(optimism).toHaveLength(1);
    expect(optimism[0].contractAddress.toLowerCase()).toBe("0x01bff41798a0bcf287b996046ca68b395dbc1071");
    expect(optimism[0].startBlock).toBe(133_193_269);
    expect(optimism[0].events.map((event) => event.signature)).toEqual([
      "BlockPlaced(address)", "BlockReleased(address)", "DestroyedBlockedFunds(address,uint256)",
    ]);
    const manifest = buildBlacklistCoverageManifest(ACTIVE_STABLECOINS, CONTRACT_CONFIGS);
    expect(manifest.some((entry) => entry.stablecoinId === "usdt-tether" && entry.chainId === "bsc"
      && entry.status === "tracked")).toBe(false);
    expect(manifest.some((entry) => entry.contractAddress?.toLowerCase()
      === "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58")).toBe(false);
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
    expect(deferred).toHaveLength(17);
    const deferredEntries = manifest.filter((entry) => entry.status === "deferred");
    expect(deferredEntries).toHaveLength(deferred.length);
    const wave1 = deferredEntries.filter((e) => e.stablecoinId === "usdf-falcon" || e.stablecoinId === "usdgo-osl");
    expect(wave1.map((e) => `${e.stablecoinId}:${e.chainId}`)).toEqual([
      "usdf-falcon:bsc", "usdf-falcon:base", "usdf-falcon:xdc", "usdf-falcon:solana", "usdgo-osl:solana", "usdgo-osl:morph-l2",
    ]);
    expect(wave1.every((e) => e.reviewedAt === "2026-11-26" && e.reviewer === "FreezeWatch Wave-1 Ethereum pilot review")).toBe(true);
  });

  it("names A7A5's material Tron deployment as explicitly deferred coverage", () => {
    const tronDeployment = TRACKED_META_BY_ID.get("a7a5-old-vector")?.contracts?.find(
      (contract) => contract.chain === "tron",
    );
    expect(tronDeployment?.address).toBe("TLeVfrdym8RoJreJ23dAGyfJDygRtiWKBZ");
    expect(CONTRACT_CONFIGS.some(
      (config) => config.stablecoinId === "a7a5-old-vector" && config.chain.chainId === "tron",
    )).toBe(false);

    // /api/blacklist-summary builds coverage.unsupportedDeferred from this manifest;
    // a deployment absent from both it and CONTRACT_CONFIGS is presented as out of scope.
    const manifest = buildBlacklistCoverageManifest(ACTIVE_STABLECOINS, CONTRACT_CONFIGS);
    expect(manifest).toContainEqual(expect.objectContaining({
      stablecoinId: "a7a5-old-vector",
      symbol: "A7A5",
      chainId: "tron",
      status: "deferred",
      reason: "deferred_tron_result_key_verification",
    }));
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

  it("resolves canonical live-tracked vs retired-archive FreezeWatch helpers without ticker collisions", () => {
    const ids = ["usdf-falcon", "usdgo-osl", "usda-avalon", "aeur-anchored-coins", "usdf-astherus", "usdf-flipcash", "usda-anzens"];
    expect(ids.map(getBlacklistStablecoinById)).toEqual(["USDF", "USDGO", null, null, null, null, null]);
    expect(ids.map(isBlacklistTrackedStablecoinId)).toEqual([true, true, false, false, false, false, false]);
    expect(ids.map(getBlacklistLedgerStablecoinById)).toEqual(["USDF", "USDGO", "USDA", "AEUR", null, null, null]);
    expect(ids.map(hasBlacklistLedgerHistoryById)).toEqual([true, true, true, true, false, false, false]);
    expect(["USDF", "USDGO", "USDA", "AEUR", "UNKNOWN"].map(getBlacklistStablecoinIdBySymbol)).toEqual([
      "usdf-falcon", "usdgo-osl", "usda-avalon", "aeur-anchored-coins", null,
    ]);
  });

  // Tracker curation is a reviewed per-deployment decision with no sound
  // metadata derivation; dropping a listed config would under-report coverage.
  it("includes first-wave, follow-up, and Wave-1 pilot coverage configs", () => {
    const pairs = CONTRACT_CONFIGS.map((c) => `${c.stablecoinId}:${c.chain.chainId}`);
    expect(pairs).toEqual(expect.arrayContaining([
      "usdg-paxos:ethereum", "rlusd-ripple:ethereum",
      "u-united-stables:ethereum", "u-united-stables:bsc",
      "usdtb-ethena:ethereum", "a7a5-old-vector:ethereum",
      "fdusd-first-digital:ethereum", "fdusd-first-digital:bsc", "fdusd-first-digital:arbitrum",
      "brz-transfero:ethereum", "brz-transfero:gnosis",
      "ausd-agora:arbitrum", "ausd-agora:base",
      "euri-banking-circle:ethereum", "euri-banking-circle:bsc",
      "usdq-quantoz:ethereum", "usdo-openeden:ethereum", "usdo-openeden:base",
      "usdx-hex-trust:ethereum", "aid-gaib:ethereum",
      "tgbp-tokenised:ethereum", "tgbp-tokenised:avalanche",
      "eurc-circle:ethereum", "buidl-blackrock:ethereum",
      "usdf-falcon:ethereum", "usdgo-osl:ethereum",
    ]));
    const byId = (id: string) => CONTRACT_CONFIGS.find((c) => c.stablecoinId === id)!;
    expect(byId("usdf-falcon")).toMatchObject({
      stablecoin: "USDF", startBlock: 21_818_184, decimals: 18,
      events: [{ signature: "AddressRestrictionSet(address,bool)", addressTopicIndex: 1, eventTypeFromDataBoolIndex: 0, hasAmount: false }],
    });
    expect(byId("usdgo-osl")).toMatchObject({ stablecoin: "USDGO", startBlock: 26_000_413, decimals: 6, events: byId("usdtb-ethena").events });
  });

  it("resolves first-wave topics, Arbitrum startBlocks, USDP, topic lookups, and RPC bootstrap blocks", () => {
    const byId = (id: string, chain?: string) => CONTRACT_CONFIGS.find((c) => c.stablecoinId === id && (!chain || c.chain.chainId === chain))!;
    expect(getBlacklistEventByTopic(byId("usdtb-ethena"), "0x5444f9841c04ce78987f28701fa07fc4c112840c1c8439e8f52bda50c3788a87")).toMatchObject({ eventType: "blacklist", addressArrayData: true });
    expect(getBlacklistEventByTopic(byId("a7a5-old-vector"), "0x8e6c9e5ceff66044a0b27759779a9be2e7c99655252b235ff3f754efb6b8a616")?.eventType).toBe("unblacklist");
    expect(getBlacklistEventBySignature(byId("rlusd-ripple"), "AccountPaused")?.eventType).toBe("blacklist");

    expect([byId("fdusd-first-digital", "arbitrum").startBlock, byId("ausd-agora", "arbitrum").startBlock, byId("buidl-blackrock", "arbitrum").startBlock]).toEqual([336_278_229, 342_153_906, 270_969_308]);
    expect(CONTRACT_CONFIGS.filter((c) => shouldPreferRpcLogScan(c.chain.chainId) && (!Number.isFinite(c.startBlock) || (c.startBlock ?? 0) <= 0))).toEqual([]);

    const usdp = byId("usdp-paxos", "ethereum");
    expect(usdp.stablecoin).toBe("USDP");
    expect(usdp.events).toEqual(byId("pyusd-paypal", "ethereum").events);

    expect([getBlacklistEventByTopic(CONTRACT_CONFIGS[0], "0xdeadbeef"), getBlacklistEventByTopic(CONTRACT_CONFIGS[0], null), getBlacklistEventByTopic(CONTRACT_CONFIGS[0], undefined)]).toEqual([undefined, undefined, undefined]);
    expect(getBlacklistEventByTopic(byId("usdc-circle", "ethereum"), "0xFFA4E6181777692565CF28528FC88FD1516EA86B56DA075235FA575AF6A4B855")?.eventType).toBe("blacklist");
    expect(getBlacklistConfigsForSymbolAndChain("USDC", "nowhere")).toEqual([]);
  });
});

describe("Dual-index freeze family split", () => {
  it("keeps FDUSD/EURI/U to 2 freeze events and USD1 to all 4 WLFI freeze+destroy events", () => {
    const wlfiDestroy = new Set(["FrozenAccountDrained(address,address,uint256)", "FrozenFundsReallocated(address,address,address,uint256)"]);
    for (const coin of ["FDUSD", "EURI", "U"] as const) {
      const cfgs = CONTRACT_CONFIGS.filter((c) => c.stablecoin === coin);
      expect(cfgs.length).toBeGreaterThan(0);
      for (const cfg of cfgs) {
        expect(cfg.events).toHaveLength(2);
        expect(cfg.events.some((e) => wlfiDestroy.has(e.signature))).toBe(false);
      }
    }
    const usd1 = CONTRACT_CONFIGS.filter((c) => c.stablecoin === "USD1");
    expect(usd1.length).toBeGreaterThan(0);
    for (const cfg of usd1) {
      expect(cfg.events).toHaveLength(4);
      expect(cfg.events.some((e) => e.signature.startsWith("FrozenAccountDrained"))).toBe(true);
    }
  });
});

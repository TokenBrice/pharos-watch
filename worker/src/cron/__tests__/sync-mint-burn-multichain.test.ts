import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import {
  makeMintBurnDb,
  makeMintBurnMintLog as makeMintLog,
  mintBurnEventInsertBinds,
  resetMintBurnMocks,
  seedMintBurnAdmissions,
  USDT_CONTRACT,
} from "./mint-burn.test-support";

// Stub MINT_BURN_CONFIGS with two critical configs on different chains so the
// orchestrator must produce distinct chain contexts and emit events for both.
vi.mock("../../lib/mint-burn-contracts", async () => {
  // The hoisted factory runs before static bindings; use the registry-free builder to avoid a mock import cycle.
  const { makeMintBurnConfig } = await import("../../test-helpers/__shared/mint-burn-config");
  return {
    MINT_BURN_CONFIGS: [
      makeMintBurnConfig({
        asset: {
          contractAddress: USDT_CONTRACT,
          tier: "critical",
        },
        adapter: "mixed",
        events: [
          {
            signature: "Transfer(address,address,uint256)",
            topicHash: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
            direction: "mint",
            amountEncoding: "transfer-value",
            filterTopic: {
              index: 1,
              value: "0x0000000000000000000000000000000000000000000000000000000000000000",
            },
          },
        ],
      }),
      makeMintBurnConfig({
        chain: {
          chainId: "arbitrum",
          chainName: "Arbitrum",
          evmChainId: 42_161,
          explorerUrl: "https://arbiscan.io",
        },
        asset: {
          stablecoinId: "usdai-usd-ai",
          symbol: "USDai",
          contractAddress: "0x2bd7d6b2e6bfcf61716bf5d7167e4c6b62a3f9c0",
          decimals: 18,
          startBlock: 249_000_000,
          tier: "critical",
        },
        adapter: "transfer-zero-address",
        events: [
          {
            signature: "Transfer(address,address,uint256)",
            topicHash: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
            direction: "mint",
            amountEncoding: "transfer-value",
            filterTopic: {
              index: 1,
              value: "0x0000000000000000000000000000000000000000000000000000000000000000",
            },
          },
        ],
      }),
    ],
  };
});

import { syncMintBurn } from "../sync-mint-burn";
import { MINT_BURN_CONFIGS } from "../../lib/mint-burn-contracts";
import {
  buildAlchemyUrl,
  fetchAlchemyLogs,
  getAlchemyBlockNumber,
  resolveBlockTimestamps,
} from "../../lib/alchemy-logs";
import { getMintBurnFinalizedHead, mintBurnAlchemyEndpoint } from "../../lib/mint-burn-pipeline/rpc";
import { batchExecute } from "../../lib/db";
import { recalcAffectedHours } from "../../lib/mint-burn-pipeline/persistence";
import type * as DbModule from "../../lib/db";
import type * as PersistenceModule from "../../lib/mint-burn-pipeline/persistence";
import type * as MintBurnRpcModule from "../../lib/mint-burn-pipeline/rpc";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { mintBurnScanFingerprint } from "../../lib/mint-burn-pipeline/scan-coverage";
import { upsertMintBurnSyncState } from "../../lib/mint-burn-pipeline/sync-state";

const sqliteFixtures = createLatestSchemaFixtureTracker();

function makeDb(): D1Database {
  return makeMintBurnDb({
    admittedConfigs: MINT_BURN_CONFIGS,
    syncRows: [
      { config_key: `ethereum-${USDT_CONTRACT}`, last_block: 21_999_999 },
      { config_key: "arbitrum-0x2bd7d6b2e6bfcf61716bf5d7167e4c6b62a3f9c0", last_block: 249_499_999 },
    ],
    priceRows: [
      { asset_id: "usdt-tether", price: 1.0 },
      { asset_id: "usdai-usd-ai", price: 1.0 },
    ],
  });
}

describe("syncMintBurn — multi-chain invariant", () => {
  beforeEach(() => {
    resetMintBurnMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    sqliteFixtures.closeAll();
  });

  it("builds per-chain Alchemy endpoints and ingests events for each chain", async () => {
    const db = makeDb();

    // One mint on Ethereum (USDT), one on Arbitrum (USDai). The remaining
    // fetch call resolves with an empty log set.
    vi.mocked(fetchAlchemyLogs).mockImplementation(async (_url, contract) => {
      if (contract === USDT_CONTRACT) {
        return {
          logs: [
            makeMintLog({
              contract,
              blockNumber: 22_000_000,
              txHash: "0xeth-mint",
            }),
          ],
          complete: true,
          scannedToBlock: 22_000_000,
          calls: 1,
          maxDepth: 0,
        };
      }
      if (contract === "0x2bd7d6b2e6bfcf61716bf5d7167e4c6b62a3f9c0") {
        return {
          logs: [
            makeMintLog({
              contract,
              blockNumber: 249_500_000,
              txHash: "0xarb-mint",
            }),
          ],
          complete: true,
          scannedToBlock: 249_500_000,
          calls: 1,
          maxDepth: 0,
        };
      }
      return { logs: [], complete: true, scannedToBlock: 0, calls: 1, maxDepth: 0 };
    });

    vi.mocked(resolveBlockTimestamps).mockImplementation(async (url: string) => {
      if (url.includes("ethereum")) return new Map([[22_000_000, 1_744_000_000]]);
      return new Map([[249_500_000, 1_744_000_100]]);
    });

    const result = await syncMintBurn(db, "alchemy-key");
    expect(result.status).toBe("ok");

    // buildAlchemyUrl must be called once per distinct chain id.
    const buildUrlChainIds = vi
      .mocked(buildAlchemyUrl)
      .mock.calls.map((call) => call[0]);
    expect(new Set(buildUrlChainIds)).toEqual(new Set(["ethereum", "arbitrum"]));

    // Alchemy endpoints must be queried via distinct per-chain URLs.
    const blockNumberUrls = vi
      .mocked(getAlchemyBlockNumber)
      .mock.calls.map((call) => call[0] as string);
    expect(blockNumberUrls.some((url) => url.includes("ethereum"))).toBe(true);
    expect(blockNumberUrls.some((url) => url.includes("arbitrum"))).toBe(true);

    // Log fetches must route to the correct chain's Alchemy endpoint.
    const logFetchCallsByChain = vi
      .mocked(fetchAlchemyLogs)
      .mock.calls.map((call) => ({
        url: call[0] as string,
        contract: call[1] as string,
      }));
    const ethLogCall = logFetchCallsByChain.find(
      (c) => c.contract === USDT_CONTRACT,
    );
    const arbLogCall = logFetchCallsByChain.find(
      (c) => c.contract === "0x2bd7d6b2e6bfcf61716bf5d7167e4c6b62a3f9c0",
    );
    expect(ethLogCall?.url).toContain("ethereum");
    expect(arbLogCall?.url).toContain("arbitrum");

    // The persistence layer must receive INSERT binds containing chain_id
    // values for BOTH chains (column index 3 on the insert tuple).
    const insertedChainIds = mintBurnEventInsertBinds.map((binds) => binds[3]);
    expect(insertedChainIds).toContain("ethereum");
    expect(insertedChainIds).toContain("arbitrum");

    // Metadata must carry chainHeads for both chains, proving the run-completion
    // path preserves multi-chain context rather than collapsing to Ethereum.
    const meta = JSON.parse(result.metadata);
    expect(meta.chainHeads).toMatchObject({
      ethereum: 22_000_000,
      arbitrum: 250_000_000,
    });
  });

  it.each([false, true])("publishes only finalized canonical rows and resumes without gaps (eventful=%s)", async (eventful) => {
    const { sqlite, db } = sqliteFixtures.open();
    seedMintBurnAdmissions(sqlite, MINT_BURN_CONFIGS);
    const actualDb = await vi.importActual<typeof DbModule>("../../lib/db");
    const actualPersistence = await vi.importActual<typeof PersistenceModule>("../../lib/mint-burn-pipeline/persistence");
    vi.mocked(batchExecute).mockImplementation(actualDb.batchExecute);
    vi.mocked(recalcAffectedHours).mockImplementation(actualPersistence.recalcAffectedHours);
    const key = `ethereum-${USDT_CONTRACT}`;
    const timestamp = Math.floor(Date.now() / 1000) - 60;
    sqlite.prepare("INSERT INTO mint_burn_sync_state (config_key, last_block) VALUES (?, ?)").run(key, 21_999_998);
    vi.mocked(getMintBurnFinalizedHead).mockResolvedValue({
      number: 21_999_999, timestamp, hash: `0x${"a".repeat(64)}`,
    });
    const canonical = { ...makeMintLog({ blockNumber: 22_000_000, txHash: "0xcanonical" }), blockHash: `0x${"c".repeat(64)}` };
    const orphan = { ...makeMintLog({ blockNumber: 22_000_000, txHash: "0xorphan" }), blockHash: `0x${"b".repeat(64)}` };
    const prior = makeMintLog({ blockNumber: 21_999_999, txHash: "0xprior" });
    vi.mocked(resolveBlockTimestamps).mockResolvedValue(new Map([[21_999_999, timestamp], [22_000_000, timestamp]]));
    // An over-returning provider exposes the provisional fork despite the bounded request.
    vi.mocked(fetchAlchemyLogs).mockResolvedValue({ logs: eventful ? [prior, orphan] : [orphan],
      complete: true, scannedToBlock: 22_000_000, calls: 1, maxDepth: 0 });
    const first = await syncMintBurn(db, "alchemy-key", { disabledConfigIds: ["usdai-usd-ai"] });
    expect(first.status).toBe("ok");
    expect(JSON.parse(first.metadata).configSamples[0]).toMatchObject({ scanTo: 21_999_999, advancedTo: 21_999_999 });
    expect(sqlite.prepare("SELECT tx_hash FROM mint_burn_events ORDER BY block_number").all())
      .toEqual(eventful ? [{ tx_hash: "0xprior" }] : []);
    expect(sqlite.prepare("SELECT SUM(mint_count) AS count FROM mint_burn_hourly").get())
      .toEqual({ count: eventful ? 1 : null });
    expect(sqlite.prepare(`SELECT chain_id, from_block, to_block, from_timestamp, to_timestamp, finality_tag
      FROM mint_burn_scan_coverage`).all()).toEqual([{ chain_id: "ethereum", from_block: 21_999_999,
      to_block: 21_999_999, from_timestamp: timestamp, to_timestamp: timestamp, finality_tag: "finalized" }]);

    vi.mocked(getMintBurnFinalizedHead).mockResolvedValue({
      number: 22_000_000, timestamp, hash: `0x${"c".repeat(64)}`,
    });
    vi.mocked(fetchAlchemyLogs).mockResolvedValue({ logs: [canonical], complete: true,
      scannedToBlock: 22_000_000, calls: 1, maxDepth: 0 });
    const resumed = await syncMintBurn(db, "alchemy-key", { disabledConfigIds: ["usdai-usd-ai"] });
    expect(JSON.parse(resumed.metadata).configSamples[0]).toMatchObject({ scanFrom: 22_000_000, advancedTo: 22_000_000 });
    expect(sqlite.prepare("SELECT tx_hash FROM mint_burn_events ORDER BY block_number").all())
      .toEqual([...(eventful ? [{ tx_hash: "0xprior" }] : []), { tx_hash: "0xcanonical" }]);
    expect(sqlite.prepare("SELECT SUM(mint_count) AS count FROM mint_burn_hourly").get()).toEqual({ count: eventful ? 2 : 1 });
    expect(sqlite.prepare("SELECT from_block, to_block FROM mint_burn_scan_coverage").all())
      .toEqual([{ from_block: 21_999_999, to_block: 22_000_000 }]);
  });

  it.each(["missing", "unsupported"])("names %s finality coverage immediately without blocking a healthy chain", async (failure) => {
    const { sqlite, db } = sqliteFixtures.open();
    seedMintBurnAdmissions(sqlite, MINT_BURN_CONFIGS);
    const actualDb = await vi.importActual<typeof DbModule>("../../lib/db");
    vi.mocked(batchExecute).mockImplementation(actualDb.batchExecute);
    const actualRpc = await vi.importActual<typeof MintBurnRpcModule>("../../lib/mint-burn-pipeline/rpc");
    const ethUrl = buildAlchemyUrl("ethereum", "alchemy-key")!;
    const chainRpcs = new Map<string, ChainRpcConfig>([["ethereum", {
      chainId: "ethereum", chainName: "Ethereum", type: "evm", explorerUrl: "https://etherscan.io",
      endpoints: [{ ...mintBurnAlchemyEndpoint(ethUrl), finalizedTagUnsupported: true }],
    }]]);
    sqlite.prepare("INSERT INTO mint_burn_sync_state (config_key, last_block) VALUES (?, ?)")
      .run(`ethereum-${USDT_CONTRACT}`, 21_999_999);
    sqlite.prepare("INSERT INTO mint_burn_sync_state (config_key, last_block) VALUES (?, ?)")
      .run("arbitrum-0x2bd7d6b2e6bfcf61716bf5d7167e4c6b62a3f9c0", 249_499_999);
    vi.mocked(getMintBurnFinalizedHead).mockImplementation(async (chain, endpoints, budget, signal) => chain === "ethereum"
      ? failure === "missing" ? null : actualRpc.getMintBurnFinalizedHead(chain, endpoints, budget, signal)
      : { number: 249_500_000, timestamp: 1_700_000_000, hash: `0x${"a".repeat(64)}` });
    vi.mocked(fetchAlchemyLogs).mockImplementation(async (_url, _address, _topics, _from, to) => ({
      logs: [], complete: true, scannedToBlock: to, calls: 1, maxDepth: 0,
    }));
    const result = await syncMintBurn(db, "alchemy-key", { chainRpcs });
    const metadata = JSON.parse(result.metadata);
    expect(result.status).toBe("degraded");
    expect(metadata.reason).toBe("finality-head-unavailable");
    expect(metadata.finality).toEqual({ tag: "finalized", unavailableChains: ["ethereum"] });
    expect(metadata.configSamples.find((summary: { chainId: string }) => summary.chainId === "ethereum"))
      .toMatchObject({ attempted: false, skippedReason: "finality-head-unavailable", advancedTo: null });
    expect(metadata.configSamples.find((summary: { chainId: string }) => summary.chainId === "arbitrum"))
      .toMatchObject({ attempted: true, advancedTo: 249_500_000 });
    expect(vi.mocked(fetchAlchemyLogs).mock.calls.every(([url]) => url.includes("arbitrum"))).toBe(true);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_events").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_hourly").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT last_block FROM mint_burn_sync_state WHERE config_key = ?")
      .get(`ethereum-${USDT_CONTRACT}`)).toEqual({ last_block: 21_999_999 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_scan_coverage WHERE chain_id = 'ethereum'").get())
      .toEqual({ count: 0 });
  });

  it("uses each chain's own finalized ceiling before querying logs", async () => {
    const { sqlite, db } = sqliteFixtures.open();
    seedMintBurnAdmissions(sqlite, MINT_BURN_CONFIGS);
    const actualDb = await vi.importActual<typeof DbModule>("../../lib/db");
    vi.mocked(batchExecute).mockImplementation(actualDb.batchExecute);
    sqlite.prepare("INSERT INTO mint_burn_sync_state (config_key, last_block) VALUES (?, ?)")
      .run(`ethereum-${USDT_CONTRACT}`, 21_999_990);
    sqlite.prepare("INSERT INTO mint_burn_sync_state (config_key, last_block) VALUES (?, ?)")
      .run("arbitrum-0x2bd7d6b2e6bfcf61716bf5d7167e4c6b62a3f9c0", 249_499_990);
    vi.mocked(getMintBurnFinalizedHead).mockImplementation(async (chain) => ({
      number: chain === "ethereum" ? 21_999_995 : 249_499_997,
      timestamp: 1_700_000_000, hash: `0x${"a".repeat(64)}`,
    }));
    vi.mocked(fetchAlchemyLogs).mockImplementation(async (_url, _address, _topics, _from, to) => ({
      logs: [], complete: true, scannedToBlock: to, calls: 1, maxDepth: 0,
    }));
    const result = await syncMintBurn(db, "alchemy-key");
    expect(result.status).toBe("ok");
    const summaries = JSON.parse(result.metadata).configSamples;
    expect(summaries.find((row: { chainId: string }) => row.chainId === "ethereum"))
      .toMatchObject({ scanFrom: 21_999_991, scanTo: 21_999_995, advancedTo: 21_999_995 });
    expect(summaries.find((row: { chainId: string }) => row.chainId === "arbitrum"))
      .toMatchObject({ scanFrom: 249_499_991, scanTo: 249_499_997, advancedTo: 249_499_997 });
    expect(vi.mocked(fetchAlchemyLogs).mock.calls.map(([url, , , from, to]) => ({
      chain: url.includes("ethereum") ? "ethereum" : "arbitrum", from, to,
    }))).toEqual([
      { chain: "ethereum", from: 21_999_991, to: 21_999_995 },
      { chain: "arbitrum", from: 249_499_991, to: 249_499_997 },
    ]);
  });

  it("holds a failed topic and automatically repairs an old-writer cursor gap", async () => {
    const { sqlite, db } = sqliteFixtures.open();
    seedMintBurnAdmissions(sqlite, MINT_BURN_CONFIGS);
    vi.mocked(batchExecute).mockImplementation((await vi.importActual<typeof DbModule>("../../lib/db")).batchExecute);
    const source = MINT_BURN_CONFIGS[0]!;
    const events = source.events;
    source.events = [...events, { ...events[0]!, direction: "burn",
      filterTopic: { index: 2, value: `0x${"0".repeat(64)}` } }];
    const key = `ethereum-${USDT_CONTRACT}`;
    const timestamp = Math.floor(Date.now() / 1000) - 60;
    sqlite.prepare("INSERT INTO mint_burn_sync_state (config_key, last_block) VALUES (?, ?)").run(key, 21_999_998);
    vi.mocked(resolveBlockTimestamps).mockImplementation(async (_url, blocks) => new Map(blocks.map((block) => [block, timestamp])));
    const quiet = async (_url: string, _address: string, _topics: unknown, _from: number, to: number) => ({
      logs: [], complete: true, scannedToBlock: to, calls: 1, maxDepth: 0,
    });
    try {
      vi.mocked(getMintBurnFinalizedHead).mockResolvedValue({ number: 21_999_999, timestamp, hash: `0x${"a".repeat(64)}` });
      vi.mocked(fetchAlchemyLogs).mockImplementation(quiet);
      await syncMintBurn(db, "alchemy-key", { disabledConfigIds: ["usdai-usd-ai"] });
      vi.mocked(getMintBurnFinalizedHead).mockResolvedValue({ number: 22_000_000, timestamp, hash: `0x${"a".repeat(64)}` });
      vi.mocked(fetchAlchemyLogs).mockImplementation(async (url, address, topics, from, to) =>
        topics.some((topic) => topic.index === 2) ? null : quiet(url, address, topics, from, to));
      await syncMintBurn(db, "alchemy-key", { disabledConfigIds: ["usdai-usd-ai"] });
      expect(sqlite.prepare("SELECT last_block FROM mint_burn_sync_state WHERE config_key = ?").get(key))
        .toEqual({ last_block: 21_999_999 });
      // A rolled-back/legacy writer can advance the cursor, but cannot create historical proof.
      sqlite.prepare("UPDATE mint_burn_sync_state SET last_block = 22000000 WHERE config_key = ?").run(key);
      vi.mocked(getMintBurnFinalizedHead).mockResolvedValue({ number: 22_000_001, timestamp, hash: `0x${"a".repeat(64)}` });
      vi.mocked(fetchAlchemyLogs).mockImplementation(quiet);
      await syncMintBurn(db, "alchemy-key", { disabledConfigIds: ["usdai-usd-ai"] });
      expect(sqlite.prepare("SELECT from_block, to_block FROM mint_burn_scan_coverage ORDER BY from_block").all())
        .toEqual([{ from_block: 21_999_999, to_block: 22_000_001 }]);
      expect(sqlite.prepare("SELECT last_block FROM mint_burn_sync_state WHERE config_key = ?").get(key))
        .toEqual({ last_block: 22_000_001 });
    } finally {
      source.events = events;
    }
  });

  it.each(["success", "headers", "materialization"])("replays eventful holes through the materialization fence: %s", async (outcome) => {
    const { sqlite, db } = sqliteFixtures.open();
    seedMintBurnAdmissions(sqlite, MINT_BURN_CONFIGS);
    vi.mocked(batchExecute).mockImplementation((await vi.importActual<typeof DbModule>("../../lib/db")).batchExecute);
    vi.mocked(recalcAffectedHours).mockImplementation(
      (await vi.importActual<typeof PersistenceModule>("../../lib/mint-burn-pipeline/persistence")).recalcAffectedHours);
    const source = MINT_BURN_CONFIGS[0]!;
    const key = `ethereum-${USDT_CONTRACT}`;
    const timestamp = Math.floor(Date.now() / 1000) - 600;
    for (const [fromBlock, toBlock] of [[21_999_998, 21_999_999], [22_000_001, 22_000_002]]) {
      await upsertMintBurnSyncState(db, key, toBlock!, "monotonic-max", {
        configKey: key, configFingerprint: mintBurnScanFingerprint(source), chainId: "ethereum",
        fromBlock: fromBlock!, toBlock: toBlock!, fromTimestamp: timestamp - 60,
        toTimestamp: timestamp + 60, finalizedBlock: 22_000_002, acceptedAt: timestamp + 600,
      });
    }
    vi.mocked(getMintBurnFinalizedHead).mockResolvedValue({ number: 22_000_002, timestamp, hash: `0x${"a".repeat(64)}` });
    vi.mocked(fetchAlchemyLogs).mockResolvedValue({ logs: [makeMintLog()], complete: true,
      scannedToBlock: 22_000_000, calls: 1, maxDepth: 0 });
    vi.mocked(resolveBlockTimestamps).mockImplementation(async (_url, blocks) =>
      outcome === "headers" ? new Map() : new Map(blocks.map((block) => [block, timestamp])));
    if (outcome === "materialization") vi.mocked(recalcAffectedHours).mockRejectedValue(new Error("hourly write failed"));
    const result = await syncMintBurn(db, "alchemy-key", { disabledConfigIds: ["usdai-usd-ai"] });
    const metadata = JSON.parse(result.metadata);
    expect(metadata.coverageRepairs[0]).toMatchObject({
      scanFrom: 22_000_000, scanTo: 22_000_000,
      repairReason: outcome === "headers" ? "scan-coverage-unproven"
        : outcome === "materialization" ? "materialization-failed" : "proof-committed",
    });
    expect(sqlite.prepare("SELECT last_block FROM mint_burn_sync_state WHERE config_key = ?").get(key))
      .toEqual({ last_block: 22_000_002 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_scan_coverage").get())
      .toEqual({ count: outcome === "success" ? 1 : 2 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_hourly").get())
      .toEqual({ count: outcome === "success" ? 1 : 0 });
    if (outcome === "success") {
      expect(sqlite.prepare("SELECT block_number FROM mint_burn_events").all()).toEqual([{ block_number: 22_000_000 }]);
    }
  });

  it("withholds staged proof and cursor when required hourly materialization fails", async () => {
    const { sqlite, db } = sqliteFixtures.open();
    seedMintBurnAdmissions(sqlite, MINT_BURN_CONFIGS);
    vi.mocked(batchExecute).mockImplementation((await vi.importActual<typeof DbModule>("../../lib/db")).batchExecute);
    const key = `ethereum-${USDT_CONTRACT}`;
    const timestamp = Math.floor(Date.now() / 1000) - 60;
    sqlite.prepare("INSERT INTO mint_burn_sync_state (config_key, last_block) VALUES (?, ?)").run(key, 21_999_999);
    vi.mocked(getMintBurnFinalizedHead).mockResolvedValue({ number: 22_000_000, timestamp, hash: `0x${"a".repeat(64)}` });
    vi.mocked(resolveBlockTimestamps).mockResolvedValue(new Map([[22_000_000, timestamp]]));
    vi.mocked(fetchAlchemyLogs).mockResolvedValue({ logs: [makeMintLog()], complete: true,
      scannedToBlock: 22_000_000, calls: 1, maxDepth: 0 });
    vi.mocked(recalcAffectedHours).mockRejectedValue(new Error("required materialization failed"));
    const result = await syncMintBurn(db, "alchemy-key", { disabledConfigIds: ["usdai-usd-ai"] });
    expect(JSON.parse(result.metadata).recalcFailed).toBe(true);
    expect(JSON.parse(result.metadata).outputPublishedAt).toBeNull();
    expect(sqlite.prepare("SELECT last_block FROM mint_burn_sync_state WHERE config_key = ?").get(key))
      .toEqual({ last_block: 21_999_999 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_scan_coverage").get()).toEqual({ count: 0 });
  });

  it.each(["recalc", "cursor-commit"])("commits admitted progress and retains pending replay inputs after pending %s failure", async (failure) => {
    const { sqlite, db } = sqliteFixtures.open();
    const [admitted, pending] = MINT_BURN_CONFIGS;
    seedMintBurnAdmissions(sqlite, [admitted!]);
    const admittedKey = `ethereum-${USDT_CONTRACT}`;
    const pendingKey = `arbitrum-${pending!.contractAddress}`;
    const timestamp = Math.floor(Date.now() / 1000) - 60;
    const hour = Math.floor(timestamp / 3600) * 3600;
    sqlite.prepare("INSERT INTO mint_burn_sync_state (config_key, last_block) VALUES (?, ?)").run(admittedKey, 21_999_999);
    sqlite.prepare("INSERT INTO mint_burn_sync_state (config_key, last_block) VALUES (?, ?)").run(pendingKey, 249_499_999);
    sqlite.prepare("INSERT INTO mint_burn_dirty_hours VALUES (?, ?, ?)").run(pending!.stablecoinId, "arbitrum", hour);
    if (failure === "cursor-commit") sqlite.exec(`CREATE TRIGGER fail_pending_proof BEFORE INSERT ON mint_burn_scan_coverage
      WHEN NEW.chain_id = 'arbitrum' BEGIN SELECT RAISE(ABORT, 'pending proof write failed'); END`);
    vi.mocked(batchExecute).mockImplementation((await vi.importActual<typeof DbModule>("../../lib/db")).batchExecute);
    const actualRecalc = (await vi.importActual<typeof PersistenceModule>("../../lib/mint-burn-pipeline/persistence")).recalcAffectedHours;
    vi.mocked(getMintBurnFinalizedHead).mockImplementation(async (chain) => ({
      number: chain === "ethereum" ? 22_000_000 : 249_500_000,
      timestamp, hash: `0x${"a".repeat(64)}`,
    }));
    vi.mocked(resolveBlockTimestamps).mockImplementation(async (_url, blocks) => new Map(blocks.map((block) => [block, timestamp])));
    vi.mocked(fetchAlchemyLogs).mockImplementation(async (_url, contract, _topics, _from, to) => ({
      logs: [makeMintLog({ contract, blockNumber: to, txHash: `0x${contract}-mint` })],
      complete: true, scannedToBlock: to, calls: 1, maxDepth: 0,
    }));
    vi.mocked(recalcAffectedHours).mockImplementation(async (database, hours, options) => {
      if ([...hours.values()].some((value) => value.chainId === "arbitrum")) {
        expect(sqlite.prepare("SELECT last_block FROM mint_burn_sync_state WHERE config_key = ?").get(admittedKey))
          .toEqual({ last_block: 22_000_000 });
        if (failure === "recalc") throw new Error("pending hourly write failed");
      }
      await actualRecalc(database, hours, options);
    });

    const result = await syncMintBurn(db, "alchemy-key");
    expect(result.status).toBe("ok");
    expect(JSON.parse(result.metadata)).toMatchObject({
      recalcFailed: false,
      pendingMaterialization: { failedCount: 1, failures: [{ key: pendingKey,
        reason: failure === "recalc" ? "pending-hourly-recalc-failed" : "pending-cursor-commit-failed" }] },
    });
    expect(sqlite.prepare("SELECT last_block FROM mint_burn_sync_state WHERE config_key = ?").get(admittedKey))
      .toEqual({ last_block: 22_000_000 });
    expect(sqlite.prepare("SELECT last_block FROM mint_burn_sync_state WHERE config_key = ?").get(pendingKey))
      .toEqual({ last_block: 249_499_999 });
    expect(sqlite.prepare("SELECT config_key FROM mint_burn_scan_coverage").all()).toEqual([{ config_key: admittedKey }]);
    expect(sqlite.prepare("SELECT chain_id FROM mint_burn_events ORDER BY chain_id").all())
      .toEqual([{ chain_id: "arbitrum" }, { chain_id: "ethereum" }]);
    expect(sqlite.prepare("SELECT chain_id FROM mint_burn_dirty_hours").all()).toEqual([{ chain_id: "arbitrum" }]);
    expect(sqlite.prepare("SELECT mint_count FROM mint_burn_hourly WHERE chain_id = 'ethereum'").get()).toEqual({ mint_count: 1 });

    if (failure === "cursor-commit") sqlite.exec("DROP TRIGGER fail_pending_proof");
    vi.mocked(recalcAffectedHours).mockImplementation(actualRecalc);
    await syncMintBurn(db, "alchemy-key");
    expect(sqlite.prepare("SELECT last_block FROM mint_burn_sync_state WHERE config_key = ?").get(pendingKey))
      .toEqual({ last_block: 249_500_000 });
    expect(sqlite.prepare("SELECT mint_count FROM mint_burn_hourly WHERE chain_id = 'arbitrum'").get()).toEqual({ mint_count: 1 });
  });

  it.each(["missing", "reversed", "future"])("never certifies an invalid boundary, but retries a smaller prefix: %s", async (failure) => {
    const { sqlite, db } = sqliteFixtures.open();
    seedMintBurnAdmissions(sqlite, MINT_BURN_CONFIGS);
    vi.mocked(batchExecute).mockImplementation((await vi.importActual<typeof DbModule>("../../lib/db")).batchExecute);
    const timestamp = Math.floor(Date.now() / 1000) - 60;
    sqlite.prepare("INSERT INTO mint_burn_sync_state (config_key, last_block) VALUES (?, ?)")
      .run(`ethereum-${USDT_CONTRACT}`, 21_999_998);
    vi.mocked(getMintBurnFinalizedHead).mockResolvedValue({ number: 22_000_000, timestamp, hash: `0x${"a".repeat(64)}` });
    vi.mocked(fetchAlchemyLogs).mockResolvedValue({ logs: [], complete: true,
      scannedToBlock: 22_000_000, calls: 1, maxDepth: 0 });
    vi.mocked(resolveBlockTimestamps).mockResolvedValue(failure === "missing" ? new Map() : new Map([
      [21_999_999, timestamp], [22_000_000, failure === "reversed" ? timestamp - 1 : timestamp + 120],
    ]));
    await syncMintBurn(db, "alchemy-key", { disabledConfigIds: ["usdai-usd-ai"] });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_scan_coverage").get())
      .toEqual({ count: failure === "missing" ? 0 : 1 });
    expect(sqlite.prepare("SELECT last_block FROM mint_burn_sync_state WHERE config_key = ?").get(`ethereum-${USDT_CONTRACT}`))
      .toEqual({ last_block: failure === "missing" ? 21_999_998 : 21_999_999 });
  });

  it.each(["end", "first"])("bounds persistent %s-header failure retries and commits only a certified prefix", async (failure) => {
    const { sqlite, db } = sqliteFixtures.open();
    seedMintBurnAdmissions(sqlite, MINT_BURN_CONFIGS);
    vi.mocked(batchExecute).mockImplementation((await vi.importActual<typeof DbModule>("../../lib/db")).batchExecute);
    const key = `ethereum-${USDT_CONTRACT}`;
    const timestamp = Math.floor(Date.now() / 1000) - 60;
    sqlite.prepare("INSERT INTO mint_burn_sync_state (config_key, last_block) VALUES (?, ?)").run(key, 21_999_992);
    vi.mocked(getMintBurnFinalizedHead).mockResolvedValue({ number: 22_000_000, timestamp, hash: `0x${"a".repeat(64)}` });
    vi.mocked(fetchAlchemyLogs).mockImplementation(async (_url, _address, _topics, _from, to) => ({
      logs: [], complete: true, scannedToBlock: to, calls: 1, maxDepth: 0,
    }));
    const failedBlock = failure === "end" ? 22_000_000 : 21_999_993;
    vi.mocked(resolveBlockTimestamps).mockImplementation(async (_url, blocks) =>
      new Map(blocks.filter((block) => block !== failedBlock).map((block) => [block, timestamp])));
    const result = await syncMintBurn(db, "alchemy-key", { disabledConfigIds: ["usdai-usd-ai"] });
    const summary = JSON.parse(result.metadata).configSamples.find((row: { key: string }) => row.key === key);
    expect(summary).toMatchObject({
      scanAttempts: failure === "end" ? 2 : 4,
      advancedTo: failure === "end" ? 21_999_996 : null,
      advanceReason: failure === "end" ? "partial-frontier" : "scan-coverage-unproven",
    });
    expect(sqlite.prepare("SELECT last_block FROM mint_burn_sync_state WHERE config_key = ?").get(key))
      .toEqual({ last_block: failure === "end" ? 21_999_996 : 21_999_992 });
    expect(sqlite.prepare("SELECT from_block, to_block FROM mint_burn_scan_coverage").all())
      .toEqual(failure === "end" ? [{ from_block: 21_999_993, to_block: 21_999_996 }] : []);
    if (failure === "first") {
      expect(summary.scanAttemptRanges.map((attempt: { scanTo: number }) => attempt.scanTo))
        .toEqual([22_000_000, 21_999_996, 21_999_994, 21_999_993]);
      const retry = await syncMintBurn(db, "alchemy-key", { disabledConfigIds: ["usdai-usd-ai"] });
      expect(JSON.parse(retry.metadata).configSamples[0]).toMatchObject({ scanAttempts: 4, advancedTo: null });
      expect(JSON.parse(retry.metadata)).toMatchObject({ scanCoverageUnproven: 1, degradedSignal: true });
      expect(retry.status).toBe("degraded");
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_scan_coverage").get()).toEqual({ count: 0 });
    }
  });

  it("commits the exact proven prefix before a persistent interior timestamp failure near the start", async () => {
    const { sqlite, db } = sqliteFixtures.open();
    seedMintBurnAdmissions(sqlite, MINT_BURN_CONFIGS);
    vi.mocked(batchExecute).mockImplementation((await vi.importActual<typeof DbModule>("../../lib/db")).batchExecute);
    const key = `ethereum-${USDT_CONTRACT}`;
    const timestamp = Math.floor(Date.now() / 1000) - 60;
    const failedBlock = 21_950_003;
    sqlite.prepare("INSERT INTO mint_burn_sync_state (config_key, last_block) VALUES (?, ?)").run(key, 21_950_000);
    vi.mocked(getMintBurnFinalizedHead).mockResolvedValue({ number: 22_000_000, timestamp, hash: `0x${"a".repeat(64)}` });
    vi.mocked(fetchAlchemyLogs).mockImplementation(async (_url, _address, _topics, from, to) => ({
      logs: from <= failedBlock && to >= failedBlock ? [makeMintLog({ blockNumber: failedBlock })] : [],
      complete: true, scannedToBlock: to, calls: 1, maxDepth: 0,
    }));
    vi.mocked(resolveBlockTimestamps).mockImplementation(async (_url, blocks) =>
      new Map(blocks.filter((block) => block !== failedBlock).map((block) => [block, timestamp])));
    const result = await syncMintBurn(db, "alchemy-key", { disabledConfigIds: ["usdai-usd-ai"] });
    expect(JSON.parse(result.metadata).configSamples[0]).toMatchObject({
      scanAttempts: 2, advancedTo: failedBlock - 1, earliestMissingTimestampBlock: failedBlock, advanceReason: "partial-frontier",
    });
    expect(sqlite.prepare("SELECT last_block FROM mint_burn_sync_state WHERE config_key = ?").get(key))
      .toEqual({ last_block: failedBlock - 1 });
    expect(sqlite.prepare("SELECT from_block, to_block FROM mint_burn_scan_coverage").all())
      .toEqual([{ from_block: 21_950_001, to_block: failedBlock - 1 }]);
    const retry = await syncMintBurn(db, "alchemy-key", { disabledConfigIds: ["usdai-usd-ai"] });
    expect(JSON.parse(retry.metadata).configSamples[0]).toMatchObject({
      scanFrom: failedBlock, scanAttempts: 1, advancedTo: null, advanceReason: "scan-coverage-unproven",
    });
    expect(sqlite.prepare("SELECT last_block FROM mint_burn_sync_state WHERE config_key = ?").get(key))
      .toEqual({ last_block: failedBlock - 1 });
  });
});

import { readJsonResponse } from "../../../src/test-helpers/__shared/auth";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import type { AlchemyLogEntry } from "../../../src/lib/alchemy-logs";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "../../../src/test-helpers/__shared/auth";
import { makeNoopD1 } from "../../../src/test-helpers/noop-d1";
import type * as AlchemyLogsModule from "../../../src/lib/alchemy-logs";
import type * as MintBurnRpcModule from "../../../src/lib/mint-burn-pipeline/rpc";

stubCryptoForAuth();

vi.mock("../../../src/lib/alchemy-logs", async (importOriginal) => ({
  ...(await importOriginal<typeof AlchemyLogsModule>()),
  buildAlchemyUrl: vi.fn((chainId: string) => chainId === "tron" ? null : "https://eth-mainnet.g.alchemy.com/v2/"),
  getAlchemyBlockNumber: vi.fn(async () => 22_000_000),
  getAlchemyTransactionContextBatchMany: vi.fn(async () => new Map()),
  fetchAlchemyLogs: vi.fn(async () => ({ logs: [], complete: true, scannedToBlock: 22_000_000, calls: 1, maxDepth: 0 })),
  resolveBlockTimestamps: vi.fn(async () => new Map()),
}));

vi.mock("../../../src/lib/mint-burn-pipeline/rpc", async (importOriginal) => ({
  ...(await importOriginal<typeof MintBurnRpcModule>()),
  getMintBurnFinalizedHead: vi.fn(async () => ({
    number: 22_000_000, timestamp: 1_700_000_000, hash: `0x${"a".repeat(64)}`,
  })),
}));

import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { handleBackfillMintBurn } from "../backfill-mint-burn";
import {
  buildAlchemyUrl,
  fetchAlchemyLogs,
  getAlchemyTransactionContextBatchMany,
  resolveBlockTimestamps,
} from "../../../src/lib/alchemy-logs";
import { getMintBurnFinalizedHead } from "../../../src/lib/mint-burn-pipeline/rpc";
import { MINT_BURN_CONFIGS } from "../../../src/lib/mint-burn-contracts";
import { BRIDGE_RECEIPTS, receiptContext } from "../../../src/lib/__tests__/mint-burn-bridge-classifier.test-support";

const TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

const mutableActiveIds = ACTIVE_IDS as Set<string>;

function makeBackfillDb() {
  return mockD1([
    { match: "mint_burn_sync_state", rows: [] },
    { match: "supply_history", rows: [] },
    { match: "price_cache", rows: [] },
    { match: "mint_burn", rows: [] },
  ]);
}

describe("handleBackfillMintBurn", () => {
  const originalActiveIds = new Set(ACTIVE_IDS);

  beforeEach(() => {
    vi.clearAllMocks();
    mutableActiveIds.clear();
    for (const id of originalActiveIds) mutableActiveIds.add(id);
  });

  it("auto-selects a config when configKey is omitted", async () => {
    const response = await handleBackfillMintBurn({ db: makeBackfillDb(), url: makeApiUrl("/api/backfill-mint-burn"), trustedAdmin: true, request: makeApiRequest("/api/backfill-mint-burn", {
        method: "POST",
        adminKey: "secret",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }), alchemyApiKey: "alchemy-key" });

    const body = (await readJsonResponse(response, 200)) as {
      configKey: string;
      selectedSymbol: string;
      selectionMode: string;
      autoSelectedReason: string | null;
    };
    expect(body.configKey).toBe("ethereum-0xdac17f958d2ee523a2206206994597c13d831ec7");
    expect(body.selectedSymbol).toBe("USDT");
    expect(body.selectionMode).toBe("auto");
    expect(body.autoSelectedReason).toBe("critical-first-most-behind");
    expect(vi.mocked(buildAlchemyUrl).mock.calls.every(([chainId]) => chainId !== "tron")).toBe(true);
    expect(vi.mocked(getMintBurnFinalizedHead).mock.calls.every(([chainId]) => chainId !== "tron")).toBe(true);
  });

  it("skips inactive configs during automatic selection", async () => {
    mutableActiveIds.delete("usdt-tether");

    const response = await handleBackfillMintBurn({ db: makeBackfillDb(), url: makeApiUrl("/api/backfill-mint-burn"), trustedAdmin: true, request: makeApiRequest("/api/backfill-mint-burn", {
        method: "POST",
        adminKey: "secret",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }), alchemyApiKey: "alchemy-key" });

    const body = (await readJsonResponse(response, 200)) as {
      configKey: string;
      selectedSymbol: string;
      selectionMode: string;
      autoSelectedReason: string | null;
    };
    expect(body.configKey).toBe("ethereum-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(body.selectedSymbol).toBe("USDC");
    expect(body.selectionMode).toBe("auto");
    expect(body.autoSelectedReason).toBe("critical-first-most-behind");
  });

  it("returns 404 for an unknown configKey", async () => {
    const response = await handleBackfillMintBurn({ db: makeNoopD1(), url: makeApiUrl("/api/backfill-mint-burn"), trustedAdmin: true, request: makeApiRequest("/api/backfill-mint-burn", {
        method: "POST",
        adminKey: "secret",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ configKey: "ethereum-0xdeadbeef" }),
      }), alchemyApiKey: "alchemy-key" });

    const body = (await readJsonResponse(response, 404)) as { error: string };
    expect(body.error).toContain("Unknown mint/burn configKey");
  });

  it("rejects explicit Tron backfill before credentials, provider reads or selection writes", async () => {
    const db = makeBackfillDb();
    const response = await handleBackfillMintBurn({ db, url: makeApiUrl("/api/backfill-mint-burn"), request: makeApiRequest("/api/backfill-mint-burn", {
      method: "POST", adminKey: "secret", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ configKey: `tron-${TRON_USDT}` }),
    }) });
    expect(await readJsonResponse(response, 400)).toEqual({ error: "mint-burn-operator-chain-unsupported: tron" });
    expect(db.getHistory()).toEqual([]);
    expect(buildAlchemyUrl).not.toHaveBeenCalled();
    expect(getMintBurnFinalizedHead).not.toHaveBeenCalled();
    expect(fetchAlchemyLogs).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON bodies", async () => {
    const response = await handleBackfillMintBurn({ db: makeNoopD1(), url: makeApiUrl("/api/backfill-mint-burn"), trustedAdmin: true, request: makeApiRequest("/api/backfill-mint-burn", {
        method: "POST",
        adminKey: "secret",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }), alchemyApiKey: "alchemy-key" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Invalid JSON body" });
  });

  it("rejects non-object JSON bodies", async () => {
    const response = await handleBackfillMintBurn({ db: makeNoopD1(), url: makeApiUrl("/api/backfill-mint-burn"), trustedAdmin: true, request: makeApiRequest("/api/backfill-mint-burn", {
        method: "POST",
        adminKey: "secret",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(["not-an-object"]),
      }), alchemyApiKey: "alchemy-key" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Invalid JSON body" });
  });

  it("returns done when requested range is empty", async () => {
    const request = makeApiRequest("/api/backfill-mint-burn", {
      method: "POST",
      adminKey: "secret",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        configKey: "ethereum-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        fromBlock: 100,
        toBlock: 90,
      }),
    });

    const response = await handleBackfillMintBurn({ db: makeBackfillDb(), url: makeApiUrl("/api/backfill-mint-burn"), trustedAdmin: true, request, alchemyApiKey: "alchemy-key" });

    const body = (await readJsonResponse(response, 200)) as {
      done: boolean;
      chunksProcessed: number;
      effectiveBurns: number;
      bridgeBurns: number;
      reviewBurns: number;
      txContextShortfalls: number;
    };
    expect(body.done).toBe(true);
    expect(body.chunksProcessed).toBe(0);
    expect(body.effectiveBurns).toBe(0);
    expect(body.bridgeBurns).toBe(0);
    expect(body.reviewBurns).toBe(0);
    expect(body.txContextShortfalls).toBe(0);
  });

  it("returns nextFromBlock when maxChunks stops before toBlock", async () => {
    const request = makeApiRequest("/api/backfill-mint-burn", {
      method: "POST",
      adminKey: "secret",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        configKey: "ethereum-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        fromBlock: 100,
        toBlock: 280,
        chunkSize: 50,
        maxChunks: 2,
      }),
    });

    const response = await handleBackfillMintBurn({ db: makeBackfillDb(), url: makeApiUrl("/api/backfill-mint-burn"), trustedAdmin: true, request, alchemyApiKey: "alchemy-key" });

    const body = (await readJsonResponse(response, 200)) as {
      done: boolean;
      nextFromBlock: number | null;
      chunksProcessed: number;
    };

    expect(body.done).toBe(false);
    expect(body.chunksProcessed).toBe(2);
    expect(body.nextFromBlock).toBe(200);
  });

  it("clamps a body-supplied out-of-range maxChunks to the allowed bounds", async () => {
    // readAdminIntegerParam only digit-checks, so a body maxChunks bypasses the
    // parseQueryParams max bound; the handler must re-clamp it (audit Q-234).
    // maxChunks: 0 would otherwise skip the loop entirely (0 chunks); clamped to
    // the min of 1, exactly one chunk runs over the single-chunk range.
    const request = makeApiRequest("/api/backfill-mint-burn", {
      method: "POST",
      adminKey: "secret",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        configKey: "ethereum-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        fromBlock: 100,
        toBlock: 140,
        chunkSize: 50,
        maxChunks: 0,
      }),
    });

    const response = await handleBackfillMintBurn({ db: makeBackfillDb(), url: makeApiUrl("/api/backfill-mint-burn"), trustedAdmin: true, request, alchemyApiKey: "alchemy-key" });

    const body = (await readJsonResponse(response, 200)) as { done: boolean; chunksProcessed: number };
    expect(body.chunksProcessed).toBe(1);
    expect(body.done).toBe(true);
  });

  it("updates an existing destination CCTP mint using MessageReceived and matching token mint evidence", async () => {
    const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const ZERO_TOPIC = "0x0000000000000000000000000000000000000000000000000000000000000000";
    const detection = MINT_BURN_CONFIGS.find((config) => config.stablecoinId === "usdc-circle" && config.chain.chainId === "ethereum")!.bridgeDetection!;
    if (detection.protocol !== "cctp") throw new Error("USDC must have CCTP detection");
    const receiveContext = receiptContext(BRIDGE_RECEIPTS.find((fixture) => fixture.name === "v2-receive")!);
    const transfer = receiveContext.receiptLogs!.find((log) => log.topics[0] === TRANSFER_TOPIC)!;
    const USDC_CONTRACT = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    const TX_HASH = "0xcctpbridgemint";
    const BLOCK_NUMBER = 21_950_000;
    const MINT_RECIPIENT = transfer.topics[2];

    vi.mocked(fetchAlchemyLogs).mockReset().mockImplementation(async (_url, _address, topics) => {
      const isMintTopic = topics.some(
        (t) => t.index === 1 && t.value === ZERO_TOPIC,
      );
      if (!isMintTopic) {
        return { logs: [], complete: true, scannedToBlock: BLOCK_NUMBER, calls: 1, maxDepth: 0 };
      }
      return {
        logs: [
          {
            address: USDC_CONTRACT,
            topics: [TRANSFER_TOPIC, ZERO_TOPIC, MINT_RECIPIENT],
            data: transfer.data,
            blockNumber: "0x" + BLOCK_NUMBER.toString(16),
            transactionHash: TX_HASH,
            transactionIndex: "0x0",
            blockHash: "0x0",
            logIndex: "0x1",
            removed: false,
          },
        ],
        complete: true,
        scannedToBlock: BLOCK_NUMBER,
        calls: 1,
        maxDepth: 0,
      };
    });

    vi.mocked(resolveBlockTimestamps)
      .mockReset()
      .mockResolvedValue(new Map([[BLOCK_NUMBER, 1_730_000_000]]));

    // Real-shaped destination receipt: no DepositForBurn or deposit selector.
    const txContext = {
      tx: {
        hash: TX_HASH,
        to: receiveContext.to,
        input: receiveContext.inputSelector!,
      },
      receipt: {
        transactionHash: TX_HASH,
        to: receiveContext.to,
        logs: receiveContext.receiptLogs!.map((log, index) => ({
          ...log,
          blockNumber: "0x" + BLOCK_NUMBER.toString(16),
          transactionHash: TX_HASH,
          transactionIndex: "0x0",
          blockHash: "0x0",
          logIndex: "0x" + index.toString(16),
          removed: false,
        })),
      },
    };
    vi.mocked(getAlchemyTransactionContextBatchMany)
      .mockReset()
      .mockResolvedValue(new Map([[TX_HASH, txContext]]));

    const db = makeBackfillDb();

    const response = await handleBackfillMintBurn({ db, url: makeApiUrl("/api/backfill-mint-burn"), trustedAdmin: true, request: makeApiRequest("/api/backfill-mint-burn", {
        method: "POST",
        adminKey: "secret",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          configKey: `ethereum-${USDC_CONTRACT}`,
          fromBlock: BLOCK_NUMBER,
          toBlock: BLOCK_NUMBER,
        }),
      }), alchemyApiKey: "alchemy-key" });

    const body = (await readJsonResponse(response, 200)) as {
      reclassified: { flowTypeChanges: number; burnTypeChanges: number };
    };

    expect(body.reclassified).toBeDefined();
    expect(body.reclassified.flowTypeChanges).toBeGreaterThanOrEqual(1);
    // Mint-only fixture: no burns should be counted on the burn column, even
    // though the unified UPDATE writes `burn_type = NULL` unconditionally.
    expect(body.reclassified.burnTypeChanges).toBe(0);
    // The classifier output ("bridge_transfer") must reach the UPDATE, and the
    // affected hour bucket must be queued for recalculation.
    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("UPDATE mint_burn_events") && entry.binds.includes("bridge_transfer"))).toBe(true);
    expect(history.filter((entry) => entry.sql.includes("mint_burn_hourly") && (entry.sql.includes("INSERT OR REPLACE") || entry.sql.includes("DELETE FROM"))).length).toBeGreaterThanOrEqual(1);
  });
});

const HEAD = 22_000_000;
const config = MINT_BURN_CONFIGS.find((entry) => entry.stablecoinId === "usdt-tether" && entry.chain.chainId === "ethereum")!;
const key = `ethereum-${config.contractAddress.toLowerCase()}`;
const fixtures = createLatestSchemaFixtureTracker();
let visibleLogs: AlchemyLogEntry[] = [];

function log(block: number, truncated = false): AlchemyLogEntry {
  return {
    address: config.contractAddress, topics: [config.events[0]!.topicHash],
    data: truncated ? "0x01" : `0x${(10_000_000n * 10n ** BigInt(config.decimals)).toString(16).padStart(64, "0")}`,
    blockNumber: `0x${block.toString(16)}`, transactionHash: `0x${block.toString(16).padStart(64, "0")}`,
    transactionIndex: "0x0", blockHash: `0x${"a".repeat(64)}`, logIndex: "0x0", removed: false,
  };
}

async function backfill(db: D1Database, range: Record<string, number>) {
  const request = makeApiRequest("/api/backfill-mint-burn", { method: "POST", adminKey: "secret",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ configKey: key, ...range }) });
  const response = await handleBackfillMintBurn({ db, url: makeApiUrl("/api/backfill-mint-burn"), request, alchemyApiKey: "test" });
  expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, unknown>>;
}

function lastBlock(sqlite: DatabaseSync) {
  return sqlite.prepare("SELECT last_block FROM mint_burn_sync_state WHERE config_key = ?").get(key)?.last_block;
}

beforeEach(() => {
  visibleLogs = [];
  vi.mocked(getMintBurnFinalizedHead).mockResolvedValue({
    number: HEAD, timestamp: 1_700_000_000, hash: `0x${"a".repeat(64)}`,
  });
  vi.mocked(fetchAlchemyLogs).mockImplementation(async (_url, _address, topics, from, to) => ({
    logs: topics[0]?.value === config.events[0]!.topicHash
      ? visibleLogs.filter((entry) => parseInt(entry.blockNumber, 16) >= from && parseInt(entry.blockNumber, 16) <= to) : [],
    complete: true, scannedToBlock: to, calls: 1, maxDepth: 0,
  }));
  vi.mocked(resolveBlockTimestamps).mockImplementation(async (_url, blocks) =>
    new Map(blocks.map((block) => [block, 1_790_000_000])));
});
afterEach(() => fixtures.closeAll());

describe("admin mint/burn safe retry frontiers", () => {
  it.each<Record<string, number>>([{}, { toBlock: HEAD }])("waits for finality before ingesting a replacement fork (%j)", async (range) => {
    const { db, sqlite } = fixtures.open();
    vi.mocked(getMintBurnFinalizedHead).mockResolvedValue({
      number: HEAD - 10, timestamp: 1_700_000_000, hash: `0x${"a".repeat(64)}`,
    });
    visibleLogs = [{ ...log(HEAD - 5), transactionHash: "0xorphan", blockHash: `0x${"b".repeat(64)}` }];
    const first = await backfill(db, { fromBlock: HEAD - 10, ...range });
    expect(first).toMatchObject({ done: true, rowsInserted: 0 });
    expect(lastBlock(sqlite)).toBe(HEAD - 10);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_events").get()?.count).toBe(0);
    vi.mocked(getMintBurnFinalizedHead).mockResolvedValue({
      number: HEAD, timestamp: 1_700_000_000, hash: `0x${"c".repeat(64)}`,
    });
    visibleLogs = [{ ...log(HEAD - 5), transactionHash: "0xcanonical", blockHash: `0x${"c".repeat(64)}` }];
    const second = await backfill(db, {});
    expect(second).toMatchObject({ done: true, rowsInserted: 1 });
    expect(lastBlock(sqlite)).toBe(HEAD);
    expect(sqlite.prepare("SELECT tx_hash FROM mint_burn_events").all()).toEqual([{ tx_hash: "0xcanonical" }]);
  });

  it("refuses a missing finalized head without writing raw events, hours or a cursor", async () => {
    const { db, sqlite } = fixtures.open();
    vi.mocked(getMintBurnFinalizedHead).mockResolvedValue(null);
    const request = makeApiRequest("/api/backfill-mint-burn", { method: "POST", adminKey: "secret",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ configKey: key, fromBlock: 100, toBlock: 110 }) });
    const response = await handleBackfillMintBurn({ db, url: makeApiUrl("/api/backfill-mint-burn"), request, alchemyApiKey: "test" });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "finality-head-unavailable: ethereum" });
    expect(lastBlock(sqlite)).toBeUndefined();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_events").get()?.count).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_hourly").get()?.count).toBe(0);
  });

  it("preserves explicit finalized historical range advancement", async () => {
    const { db, sqlite } = fixtures.open();
    visibleLogs = [log(100)];
    expect(await backfill(db, { fromBlock: 100, toBlock: 110 })).toMatchObject({ done: true, rowsInserted: 1 });
    expect(lastBlock(sqlite)).toBe(110);
  });

  it("persists valid peers while decode failures hold the frontier until bounded quarantine", async () => {
    const { db, sqlite } = fixtures.open();
    visibleLogs = [log(100), log(101, true)];
    const first = await backfill(db, { fromBlock: 100, toBlock: 102 });
    expect(first).toMatchObject({ rowsParsed: 1, rowsInserted: 1, rowsDropped: 1, rowsDroppedDecode: 1,
      rowsQuarantinedDecode: 0, earliestDecodeFailureBlock: 101, nextFromBlock: 101, done: false });
    expect(lastBlock(sqlite)).toBe(100);
    expect(await backfill(db, { toBlock: 102 })).toMatchObject({ rowsDroppedDecode: 1, nextFromBlock: 101, done: false });
    expect(lastBlock(sqlite)).toBe(100);
    const third = await backfill(db, { toBlock: 102 });
    expect(third).toMatchObject({ done: true, rowsDropped: 1, rowsDroppedDecode: 1, rowsQuarantinedDecode: 1,
      decodeQuarantines: [{ blockNumber: 101, reason: "amount-decode-retry-exhausted", attempts: 3 }] });
    expect(lastBlock(sqlite)).toBe(102);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_events").get()?.count).toBe(1);
    const retry = sqlite.prepare("SELECT value FROM cache WHERE key LIKE 'mint-burn:decode-retry:%'").get();
    expect(JSON.parse(String(retry?.value))).toMatchObject({ attempts: 3, quarantined: true });
  });

  it("ingests corrected amount data on the next observation without quarantine", async () => {
    const { db, sqlite } = fixtures.open();
    visibleLogs = [log(101, true)];
    expect(await backfill(db, { fromBlock: 100, toBlock: 102 })).toMatchObject({ done: false, nextFromBlock: 101 });
    visibleLogs = [log(101)];
    expect(await backfill(db, { toBlock: 102 })).toMatchObject({ done: true, rowsInserted: 1, rowsDroppedDecode: 0,
      rowsQuarantinedDecode: 0 });
    expect(lastBlock(sqlite)).toBe(102);
  });
});

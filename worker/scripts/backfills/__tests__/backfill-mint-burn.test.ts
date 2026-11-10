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

function backfillResponse(db: D1Database, request: Request, options: Partial<Parameters<typeof handleBackfillMintBurn>[0]> = {}) {
  return handleBackfillMintBurn({ db, request, url: makeApiUrl("/api/backfill-mint-burn"),
    trustedAdmin: true, alchemyApiKey: "alchemy-key", ...options });
}

function postBody(body: string) {
  return makeApiRequest("/api/backfill-mint-burn", { method: "POST", adminKey: "secret",
    headers: { "Content-Type": "application/json" }, body });
}

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

  it.each([
    ["auto-selects a config when configKey is omitted", false, "ethereum-0xdac17f958d2ee523a2206206994597c13d831ec7", "USDT"],
    ["skips inactive configs during automatic selection", true, "ethereum-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "USDC"],
  ] as const)("%s", async (_name, inactive, configKey, symbol) => {
    if (inactive) mutableActiveIds.delete("usdt-tether");
    const body = await readJsonResponse(await backfillResponse(makeBackfillDb(), postBody("{}")), 200);
    expect(body).toMatchObject({ configKey, selectedSymbol: symbol, selectionMode: "auto", autoSelectedReason: "critical-first-most-behind" });
    expect(vi.mocked(buildAlchemyUrl).mock.calls.every(([chainId]) => chainId !== "tron")).toBe(true);
    expect(vi.mocked(getMintBurnFinalizedHead).mock.calls.every(([chainId]) => chainId !== "tron")).toBe(true);
  });

  it("returns 404 for an unknown configKey", async () => {
    const response = await backfillResponse(makeNoopD1(), postBody(JSON.stringify({ configKey: "ethereum-0xdeadbeef" })));

    const body = (await readJsonResponse(response, 404)) as { error: string };
    expect(body.error).toContain("Unknown mint/burn configKey");
  });

  it("rejects explicit Tron backfill before credentials, provider reads or selection writes", async () => {
    const db = makeBackfillDb();
    const response = await backfillResponse(db, postBody(JSON.stringify({ configKey: `tron-${TRON_USDT}` })), { trustedAdmin: undefined, alchemyApiKey: undefined });
    expect(await readJsonResponse(response, 400)).toEqual({ error: "mint-burn-operator-chain-unsupported: tron" });
    expect(db.getHistory()).toEqual([]);
    expect(buildAlchemyUrl).not.toHaveBeenCalled();
    expect(getMintBurnFinalizedHead).not.toHaveBeenCalled();
    expect(fetchAlchemyLogs).not.toHaveBeenCalled();
  });

  it.each([
    ["rejects malformed JSON bodies", "{"],
    ["rejects non-object JSON bodies", JSON.stringify(["not-an-object"])],
  ])("%s", async (_name, body) => {
    const response = await backfillResponse(makeNoopD1(), postBody(body));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Invalid JSON body" });
  });

  it.each([
    { name: "returns done when requested range is empty", range: { fromBlock: 100, toBlock: 90 },
      expected: { done: true, chunksProcessed: 0, effectiveBurns: 0, bridgeBurns: 0, reviewBurns: 0, txContextShortfalls: 0 } },
    { name: "returns nextFromBlock when maxChunks stops before toBlock",
      range: { fromBlock: 100, toBlock: 280, chunkSize: 50, maxChunks: 2 },
      expected: { done: false, chunksProcessed: 2, nextFromBlock: 200 } },
    // Body maxChunks bypasses query validation: zero must clamp to one chunk.
    { name: "clamps a body-supplied out-of-range maxChunks to the allowed bounds",
      range: { fromBlock: 100, toBlock: 140, chunkSize: 50, maxChunks: 0 }, expected: { done: true, chunksProcessed: 1 } },
  ])("$name", async ({ range, expected }) => {
    const request = postBody(JSON.stringify({ configKey: "ethereum-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", ...range }));
    expect(await readJsonResponse(await backfillResponse(makeBackfillDb(), request), 200)).toMatchObject(expected);
  });

  it("updates an existing destination CCTP mint using MessageReceived and matching token mint evidence", async () => {
    const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const ZERO_TOPIC = "0x0000000000000000000000000000000000000000000000000000000000000000";
    const detection = MINT_BURN_CONFIGS.find((config) => config.stablecoinId === "usdc-circle" && config.chain.chainId === "ethereum")!.bridgeDetection!;
    if (detection.protocol !== "cctp") throw new Error("USDC must have CCTP detection");
    const receiveContext = receiptContext(BRIDGE_RECEIPTS.find((fixture) => fixture.name === "v2-receive")!);
    const transfer = receiveContext.receiptLogs!.find((log) => log.topics[0] === TRANSFER_TOPIC)!;
    const USDC_CONTRACT = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    const TX_HASH = `0x${"d".repeat(64)}`;
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
            blockHash: `0x${"a".repeat(64)}`,
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
      .mockResolvedValue(new Map([[BLOCK_NUMBER, Math.floor(Date.now() / 3_600_000) * 3600 - 3600]]));

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
          blockHash: `0x${"a".repeat(64)}`,
          logIndex: "0x" + index.toString(16),
          removed: false,
        })),
      },
    };
    vi.mocked(getAlchemyTransactionContextBatchMany)
      .mockReset()
      .mockResolvedValue(new Map([[TX_HASH, txContext]]));

    const db = makeBackfillDb();

    const response = await backfillResponse(db, postBody(JSON.stringify({
          configKey: `ethereum-${USDC_CONTRACT}`,
          fromBlock: BLOCK_NUMBER,
          toBlock: BLOCK_NUMBER,
        })));

    const body = (await readJsonResponse(response, 200)) as {
      reclassified: { flowTypeChanges: number; burnTypeChanges: number };
    };

    expect(body.reclassified).toBeDefined();
    expect(body.reclassified.flowTypeChanges).toBeGreaterThanOrEqual(1);
    // Mint-only fixture: no burns should be counted on the burn column, even
    // though the unified UPDATE writes `burn_type = NULL` unconditionally.
    expect(body.reclassified.burnTypeChanges).toBe(0);
    // The classifier output ("bridge_transfer") must reach the UPDATE, and the
    // retained hour must be rebuilt with the classified row.
    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("UPDATE mint_burn_events") && entry.binds.includes("bridge_transfer"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("DELETE FROM mint_burn_hourly"))).toBe(true);
  });
});

const HEAD = 22_000_000;
const config = MINT_BURN_CONFIGS.find((entry) => entry.stablecoinId === "usdt-tether" && entry.chain.chainId === "ethereum")!;
const key = `ethereum-${config.contractAddress.toLowerCase()}`;
const fixtures = createLatestSchemaFixtureTracker();
let visibleLogs: AlchemyLogEntry[] = [];

function log(block: number, truncated = false, source = config): AlchemyLogEntry {
  return {
    address: source.contractAddress, topics: [source.events[0]!.topicHash, `0x${"0".repeat(64)}`, `0x${"0".repeat(24)}${"1".repeat(40)}`],
    data: truncated ? "0x01" : `0x${(10_000_000n * 10n ** BigInt(source.decimals)).toString(16).padStart(64, "0")}`,
    blockNumber: `0x${block.toString(16)}`, transactionHash: `0x${block.toString(16).padStart(64, "0")}`,
    transactionIndex: "0x0", blockHash: `0x${"a".repeat(64)}`, logIndex: "0x0", removed: false,
  };
}

async function backfill(db: D1Database, range: Record<string, number | string>) {
  const request = postBody(JSON.stringify({ configKey: key, ...range }));
  const response = await backfillResponse(db, request, { trustedAdmin: undefined, alchemyApiKey: "test" });
  expect(response.status, await response.clone().text()).toBe(200);
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
    logs: visibleLogs.filter((entry) => topics.every((topic) => entry.topics[topic.index] === topic.value)
      && parseInt(entry.blockNumber, 16) >= from && parseInt(entry.blockNumber, 16) <= to),
    complete: true, scannedToBlock: to, calls: 1, maxDepth: 0,
  }));
  vi.mocked(resolveBlockTimestamps).mockImplementation(async (_url, blocks) =>
    new Map(blocks.map((block) => [block, Math.floor(Date.now() / 3_600_000) * 3600 - 3600])));
});
afterEach(() => fixtures.closeAll());

describe("admin mint/burn safe retry frontiers", () => {
  it.each(["pruned", "edge", "shared", "retained", "interior"])("guards %s hours across chunk boundaries", async (kind) => {
    const { db, sqlite } = fixtures.open();
    const source = kind === "shared" ? MINT_BURN_CONFIGS.find((c) => c.stablecoinId === "buidl-blackrock")! : config;
    const hour = Math.floor(Date.now() / 3_600_000) * 3600 - (kind === "retained" ? 3600 : 10 * 86400);
    sqlite.prepare(`INSERT INTO mint_burn_hourly (stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
      mint_volume_usd, burn_volume_usd, net_flow_usd) VALUES (?, ?, ?, 1, 1, 100, 90, 10)`)
      .run(source.stablecoinId, source.chain.chainId, hour);
    visibleLogs = [log(102, false, source)]; // Pruned 100 mint / 90 burn: replay only the mint.
    vi.mocked(resolveBlockTimestamps).mockImplementation(async (_url, blocks) => new Map(blocks.map((block) =>
      [block, block === 102 ? hour + 100 : block < 102 ? hour - 100 : block === 103 ? hour + 200 : hour + 3700])));
    const safe = kind === "retained" || kind === "interior";
    const result = await backfill(db, { configKey: `${source.chain.chainId}-${source.contractAddress}`,
      fromBlock: kind === "pruned" ? 102 : 100, toBlock: 104, chunkSize: 2,
      maxChunks: kind === "edge" ? 2 : 3 });
    expect(result).toMatchObject({ done: safe, hoursRebuilt: safe ? 1 : 0, rowsInserted: safe ? 1 : 0 });
    expect(sqlite.prepare("SELECT net_flow_usd FROM mint_burn_hourly").get()?.net_flow_usd).toBe(safe ? 0 : 10);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM mint_burn_dirty_hours").get()?.n).toBe(0);
    expect(result.skippedHours).toEqual(safe ? [] : [expect.objectContaining({ hourTs: hour,
      reason: kind === "shared" ? "shared-bucket-configs-not-scanned" : "raw-hour-incomplete" })]);
  });


  it.each<Record<string, number>>([{}, { toBlock: HEAD }])("waits for finality before ingesting a replacement fork (%j)", async (range) => {
    const { db, sqlite } = fixtures.open();
    vi.mocked(getMintBurnFinalizedHead).mockResolvedValue({
      number: HEAD - 10, timestamp: 1_700_000_000, hash: `0x${"a".repeat(64)}`,
    });
    visibleLogs = [{ ...log(HEAD - 5), transactionHash: `0x${"e".repeat(64)}`, blockHash: `0x${"b".repeat(64)}` }];
    const first = await backfill(db, { fromBlock: HEAD - 10, ...range });
    expect(first).toMatchObject({ done: true, rowsInserted: 0 });
    expect(lastBlock(sqlite)).toBe(HEAD - 10);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_events").get()?.count).toBe(0);
    vi.mocked(getMintBurnFinalizedHead).mockResolvedValue({
      number: HEAD, timestamp: 1_700_000_000, hash: `0x${"c".repeat(64)}`,
    });
    visibleLogs = [{ ...log(HEAD - 5), transactionHash: `0x${"f".repeat(64)}`, blockHash: `0x${"c".repeat(64)}` }];
    const second = await backfill(db, {});
    expect(second).toMatchObject({ done: true, rowsInserted: 1 });
    expect(lastBlock(sqlite)).toBe(HEAD);
    expect(sqlite.prepare("SELECT tx_hash FROM mint_burn_events").all()).toEqual([{ tx_hash: `0x${"f".repeat(64)}` }]);
  });

  it.each(["removed", "emitter", "direction"])("rejects %s response identity without backfill writes", async (kind) => {
    const { db, sqlite } = fixtures.open();
    const dai = MINT_BURN_CONFIGS.find((entry) => entry.stablecoinId === "dai-makerdao")!;
    const mint = dai.events.find((event) => event.direction === "mint")!;
    const word = (value: number) => `0x${value.toString(16).padStart(64, "0")}`;
    const badLog: AlchemyLogEntry = { address: dai.contractAddress, topics: [mint.topicHash, word(0), word(1)],
      data: word(20_000), blockNumber: "0x66", blockHash: word(12), transactionHash: word(20),
      transactionIndex: "0x0", logIndex: "0x0", removed: false };
    if (kind === "removed") badLog.removed = true;
    if (kind === "emitter") badLog.address = `0x${"1".repeat(40)}`;
    if (kind === "direction") badLog.topics = [mint.topicHash, word(1), word(0)];
    vi.mocked(fetchAlchemyLogs).mockImplementation(async (_url, _address, topics, _from, to) => ({
      logs: topics.some((topic) => topic.index === 1) ? [badLog] : [],
      complete: true, scannedToBlock: to, calls: 1, maxDepth: 0,
    }));
    const request = postBody(JSON.stringify({ configKey: `ethereum-${dai.contractAddress}`, fromBlock: 101, toBlock: 102 }));
    const response = await backfillResponse(db, request, { trustedAdmin: undefined, alchemyApiKey: "test" });
    expect(response.status).toBe(502);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_events").get()?.count).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_hourly").get()?.count).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_sync_state").get()?.count).toBe(0);
  });

  it("refuses a missing finalized head without writing raw events, hours or a cursor", async () => {
    const { db, sqlite } = fixtures.open();
    vi.mocked(getMintBurnFinalizedHead).mockResolvedValue(null);
    const request = postBody(JSON.stringify({ configKey: key, fromBlock: 100, toBlock: 110 }));
    const response = await backfillResponse(db, request, { trustedAdmin: undefined, alchemyApiKey: "test" });
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

  it("refuses incomplete ranges even after decode quarantine", async () => {
    const { db, sqlite } = fixtures.open();
    visibleLogs = [log(100), log(101, true)];
    const first = await backfill(db, { fromBlock: 100, toBlock: 102 });
    expect(first).toMatchObject({ rowsParsed: 1, rowsInserted: 0, rowsDropped: 1, rowsDroppedDecode: 1,
      rowsQuarantinedDecode: 0, earliestDecodeFailureBlock: 101, nextFromBlock: 100, done: false });
    expect(lastBlock(sqlite)).toBeUndefined();
    expect(await backfill(db, { fromBlock: 100, toBlock: 102 })).toMatchObject({ rowsDroppedDecode: 1, nextFromBlock: 100, done: false });
    expect(lastBlock(sqlite)).toBeUndefined();
    const third = await backfill(db, { fromBlock: 100, toBlock: 102 });
    expect(third).toMatchObject({ done: false, incompleteRange: true, rowsDropped: 1, rowsDroppedDecode: 1, rowsQuarantinedDecode: 1,
      decodeQuarantines: [{ blockNumber: 101, reason: "amount-decode-retry-exhausted", attempts: 3 }] });
    expect(lastBlock(sqlite)).toBeUndefined();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_events").get()?.count).toBe(0);
    const retry = sqlite.prepare("SELECT value FROM cache WHERE key LIKE 'mint-burn:decode-retry:%'").get();
    expect(JSON.parse(String(retry?.value))).toMatchObject({ attempts: 3, quarantined: true });
  });

  it("ingests corrected amount data on the next observation without quarantine", async () => {
    const { db, sqlite } = fixtures.open();
    visibleLogs = [log(101, true)];
    expect(await backfill(db, { fromBlock: 100, toBlock: 102 })).toMatchObject({ done: false, nextFromBlock: 100 });
    visibleLogs = [log(101)];
    expect(await backfill(db, { fromBlock: 100, toBlock: 102 })).toMatchObject({ done: true, rowsInserted: 1, rowsDroppedDecode: 0,
      rowsQuarantinedDecode: 0 });
    expect(lastBlock(sqlite)).toBe(102);
  });
});

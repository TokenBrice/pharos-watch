import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { makeApiRequest, makeApiUrl } from "../../../src/test-helpers/__shared/auth";
import type { AlchemyLogEntry } from "../../../src/lib/alchemy-logs";
import type * as AlchemyLogsModule from "../../../src/lib/alchemy-logs";

vi.mock("../../../src/lib/alchemy-logs", async (importOriginal) => ({
  ...(await importOriginal<typeof AlchemyLogsModule>()),
  buildAlchemyUrl: vi.fn(() => "https://rpc.test"),
  getAlchemyBlockNumber: vi.fn(async () => 22_000_000),
  fetchAlchemyLogs: vi.fn(),
  resolveBlockTimestamps: vi.fn(),
  getAlchemyTransactionContextBatchMany: vi.fn(async () => new Map()),
}));

import { fetchAlchemyLogs, resolveBlockTimestamps } from "../../../src/lib/alchemy-logs";
import { MINT_BURN_CONFIGS } from "../../../src/lib/mint-burn-contracts";
import { handleBackfillMintBurn } from "../backfill-mint-burn";

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
  it.each<Record<string, number>>([{}, { toBlock: HEAD }])("retries an empty near-head scan and ingests a late-visible event (%j)", async (range) => {
    const { db, sqlite } = fixtures.open();
    const first = await backfill(db, { fromBlock: HEAD - 10, ...range });
    expect(first).toMatchObject({ done: false, nextFromBlock: HEAD - 10, rowsInserted: 0 });
    expect(lastBlock(sqlite)).toBeUndefined();
    visibleLogs = [log(HEAD - 5)];
    const second = await backfill(db, { fromBlock: Number(first.nextFromBlock) });
    expect(second).toMatchObject({ done: false, nextFromBlock: HEAD - 4, rowsInserted: 1 });
    expect(lastBlock(sqlite)).toBe(HEAD - 5);
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

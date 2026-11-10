import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintBurnAlchemyEndpoint } from "../mint-burn-pipeline/rpc";

const alchemyMockHelpers = vi.hoisted(() => ({
  makeAlchemyContext: (txHash: string) => ({
    tx: {
      hash: txHash,
      to: "0xrouter",
      input: "0x96f4e9f9",
    },
    receipt: {
      transactionHash: txHash,
      to: "0xrouter",
      logs: [],
    },
  }),
}));

vi.mock("../alchemy-logs", () => ({
  getAlchemyTransactionContextBatchMany: vi.fn(async (_url: string, txHashes: string[]) =>
    new Map(txHashes.map((txHash) => [txHash, alchemyMockHelpers.makeAlchemyContext(txHash)])),
  ),
}));

vi.mock("../mint-burn-bridge-classifier", () => ({
  classifyBridgeAwareBurnRows: vi.fn((rows: Array<{ direction: string; tx_hash: string; burn_type: string | null; burn_review_reason: string | null }>) => {
    for (const row of rows) {
      if (row.direction !== "burn") continue;
      if (row.tx_hash.includes("bridge")) {
        row.burn_type = "bridge_burn";
        row.burn_review_reason = null;
      } else if (row.tx_hash.includes("review")) {
        row.burn_type = "review_required";
        row.burn_review_reason = "test-review";
      } else {
        row.burn_type = "effective_burn";
        row.burn_review_reason = null;
      }
    }
  }),
}));

import { getAlchemyTransactionContextBatchMany } from "../alchemy-logs";
import { classifyBridgeAwareBurnRows } from "../mint-burn-bridge-classifier";
import { classifyBridgeBurnRows } from "../mint-burn-pipeline/classification";
import { parseMintBurnLogs } from "../mint-burn-pipeline/parse";
import { applySupplyExcludedProtocolInternalFlows } from "../mint-burn-pipeline/reviewed-protocol-flows";
import { CURATED_ONCHAIN_SUPPLY_EXCLUSIONS } from "../onchain-supply-exclusions";
import {
  collectAffectedHours,
  insertMintBurnRows,
  persistMintBurnRows,
  recalcAffectedHours,
  updateEventClassifications,
} from "../mint-burn-pipeline/persistence";
import {
  readMintBurnSyncStateBatch,
  upsertMintBurnSyncState,
} from "../mint-burn-pipeline/sync-state";
import { sweepRecentRoundtrips } from "../mint-burn-pipeline/roundtrip-sweep";
import { reconcileAtomicRoundtripGroups } from "../mint-burn-pipeline/roundtrip-detection";
import type { MintBurnRow } from "../mint-burn-pipeline/types";
import { MINT_BURN_CONFIGS, type MintBurnEventDef } from "../mint-burn-contracts";
import { mintBurnConfigKey } from "../mint-burn-pipeline/sync-state";
import type { AlchemyLogEntry } from "../alchemy-logs";
import { makeMintBurnConfig } from "../../test-helpers/__shared/mint-burn-config";
import { makeMintBurnRow } from "../../test-helpers/__shared/fixtures";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { drainMintBurnMaterializationDebt } from "../mint-burn-pipeline/materialization-debt";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

function makeRow(overrides: Partial<MintBurnRow> = {}): MintBurnRow {
  return makeMintBurnRow({
    id: "id-1", amount: 100, amount_usd: 100, price_timestamp: 1_700_000_000,
    price_source: "price-cache-event-window", burn_type: null, counterparty: null,
    tx_hash: "0xtx-1", block_number: 22_000_000, timestamp: 1_718_650_752,
    ...overrides,
    amount_raw: overrides.amount_raw === undefined ? String(Math.round((overrides.amount ?? 100) * 1e6)) : overrides.amount_raw,
  });
}
const bridgeConfig = makeMintBurnConfig({
  asset: { contractAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7" },
  adapter: "transfer-zero-address",
  bridgeDetection: { protocol: "ccip", knownBridgePoolAddresses: ["0xpool"],
    tokenAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7" },
});
const rpc = [mintBurnAlchemyEndpoint("https://rpc.invalid")];

describe("mint-burn shared pipeline modules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tracks affected hours when inserts land even if the batch includes duplicates", async () => {
    const { db, sqlite } = fixtures.open();
    const first = makeRow({ id: "id-1", direction: "mint", timestamp: 3_605, flow_type: "standard" });
    await insertMintBurnRows(db, [first]);
    sqlite.exec("DELETE FROM mint_burn_dirty_hours");

    const affectedHours = new Map<string, { stablecoinId: string; chainId: string; hourTs: number }>();
    const result = await persistMintBurnRows(
      db,
      [
        first,
        makeRow({ id: "id-2", direction: "mint", timestamp: 7_205, flow_type: "standard" }),
      ],
      affectedHours,
    );

    expect(result.inserted).toBe(1);
    expect(affectedHours.size).toBe(2);
    expect(sqlite.prepare("SELECT hour_ts FROM mint_burn_dirty_hours").all()).toEqual([{ hour_ts: 7200 }]);
    for (const failure of ["enqueue", "insert"]) {
      const failingDb = createSqliteD1(sqlite, { onRun(sql) {
        if ((failure === "enqueue" && sql.includes("INSERT OR REPLACE INTO mint_burn_dirty_hours"))
          || (failure === "insert" && sql.includes("INSERT OR IGNORE INTO mint_burn_events"))) throw new Error("insert interrupted");
      } });
      await expect(insertMintBurnRows(failingDb, [makeRow({ id: "failed-insert", timestamp: 10_801 })]))
        .rejects.toThrow("insert interrupted");
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_events").get()).toEqual({ count: 2 });
      expect(sqlite.prepare("SELECT hour_ts FROM mint_burn_dirty_hours").all()).toEqual([{ hour_ts: 7200 }]);
    }
  });

  it("chunks event inserts below the D1 bind-variable ceiling", async () => {
    const { db, sqlite } = fixtures.open();
    const batch = vi.spyOn(db, "batch");

    await insertMintBurnRows(
      db,
      Array.from({ length: 56 }, (_, index) => makeRow({ id: `id-${index + 1}`, tx_hash: `0xtx-${index + 1}` })),
    );

    expect(batch.mock.calls.map(([statements]) => statements.length)).toEqual([100, 12]);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_events").get()).toEqual({ count: 56 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_dirty_hours").get()).toEqual({ count: 1 });
  });

  it("checks cancellation between atomic insert/debt batches", async () => {
    const { db, sqlite } = fixtures.open();
    const controller = new AbortController();
    const batch = db.batch.bind(db);
    db.batch = async <T = unknown>(statements: D1PreparedStatement[]) => {
      const result = await batch<T>(statements);
      controller.abort(new Error("stop after committed batch"));
      return result;
    };
    await expect(insertMintBurnRows(db, Array.from({ length: 51 }, (_, index) => makeRow({ id: `insert-${index}` })), {
      signal: controller.signal,
    })).rejects.toThrow("stop after committed batch");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_events").get()).toEqual({ count: 50 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_dirty_hours").get()).toEqual({ count: 1 });
  });

  it("does not start mint/burn insert batches after cancellation", async () => {
    const { db } = fixtures.open();
    const batch = vi.spyOn(db, "batch");
    const controller = new AbortController();
    controller.abort(new Error("stop mint/burn persistence"));

    await expect(insertMintBurnRows(db, [makeRow({ id: "id-1" })], { signal: controller.signal })).rejects.toThrow(
      "stop mint/burn persistence",
    );

    expect(batch).not.toHaveBeenCalled();
  });

  it("returns bridge/review/effective burn counters", async () => {
    const rows: MintBurnRow[] = [
      makeRow({ id: "mint-1", direction: "mint", tx_hash: "0xmint" }),
      makeRow({ id: "burn-bridge", direction: "burn", tx_hash: "0xbridge" }),
      makeRow({ id: "burn-review", direction: "burn", tx_hash: "0xreview" }),
      makeRow({ id: "burn-effective", direction: "burn", tx_hash: "0xeffective" }),
    ];

    const counters = await classifyBridgeBurnRows(
      rows,
      bridgeConfig,
      rpc,
      { count: 0, limit: 200 },
      new Map(),
    );

    expect(counters).toEqual({
      effectiveBurns: 1,
      bridgeBurns: 1,
      reviewBurns: 1,
      txContextShortfalls: 0,
      deferredTxHashes: [],
    });
    expect(vi.mocked(getAlchemyTransactionContextBatchMany)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(classifyBridgeAwareBurnRows)).toHaveBeenCalledTimes(1);
  });

  it("fetches tx contexts with bounded concurrency", async () => {
    let inflight = 0;
    let peak = 0;
    vi.mocked(getAlchemyTransactionContextBatchMany).mockImplementation(async (_url: string, txHashes: string[]) => {
      inflight++;
      peak = Math.max(peak, inflight);
      // Yield across two microtask ticks so the scheduler can start more workers
      // up to the concurrency limit before any of them complete.
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      inflight--;
      return new Map(txHashes.map((txHash) => [txHash, alchemyMockHelpers.makeAlchemyContext(txHash)]));
    });

    const rows: MintBurnRow[] = Array.from({ length: 80 }, (_, index) =>
      makeRow({ id: `burn-${index}`, direction: "burn", tx_hash: `0xtx-${index}` }),
    );

    await classifyBridgeBurnRows(
      rows,
      bridgeConfig,
      rpc,
      { count: 0, limit: 200 },
      new Map(),
    );

    // Four 20-tx batches, bounded by TX_CONTEXT_BATCH_CONCURRENCY in classification.ts.
    expect(peak).toBe(3);
    expect(vi.mocked(getAlchemyTransactionContextBatchMany)).toHaveBeenCalledTimes(4);
  });

  it("reports tx-context shortfalls without fabricating classifications for deferred rows", async () => {
    vi.mocked(getAlchemyTransactionContextBatchMany).mockResolvedValue(new Map());

    const rows: MintBurnRow[] = [
      makeRow({ id: "mint-bridge", direction: "mint", tx_hash: "0xbridge-mint" }),
      makeRow({ id: "burn-bridge", direction: "burn", tx_hash: "0xbridge-burn" }),
    ];

    const counters = await classifyBridgeBurnRows(
      rows,
      bridgeConfig,
      rpc,
      { count: 0, limit: 200 },
      new Map(),
    );

    expect(counters.txContextShortfalls).toBe(2);
    expect(counters.deferredTxHashes).toEqual(["0xbridge-mint", "0xbridge-burn"]);
    expect(counters.effectiveBurns).toBe(0);
    expect(counters.bridgeBurns).toBe(0);
    expect(counters.reviewBurns).toBe(0);
    expect(rows).toMatchObject([
      { id: "mint-bridge", flow_type: "standard", burn_type: null, burn_review_reason: null },
      { id: "burn-bridge", flow_type: "standard", burn_type: "bridge_burn", burn_review_reason: null },
    ]);
    expect(vi.mocked(classifyBridgeAwareBurnRows)).toHaveBeenCalledTimes(1);
  });

  it("retains request-denied context reasons when the scan requires a matching block hash", async () => {
    vi.mocked(getAlchemyTransactionContextBatchMany).mockResolvedValueOnce(new Map([
      ["0xdenied", { tx: null, receipt: null, unavailableReason: "rpc-request-not-started" }],
    ]));
    const counters = await classifyBridgeBurnRows(
      [makeRow({ direction: "burn", tx_hash: "0xdenied" })],
      makeMintBurnConfig({ bridgeDetection: {
        protocol: "ccip", knownBridgePoolAddresses: [], tokenAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7",
      } }),
      [mintBurnAlchemyEndpoint("https://rpc.invalid")], { count: 0, limit: 10 }, new Map(), undefined,
      { blockHashesByTx: new Map([["0xdenied", `0x${"1".repeat(64)}`]]) },
    );
    expect(counters).toMatchObject({ txContextShortfalls: 1, txContextRequestsNotStarted: 1, deferredTxHashes: ["0xdenied"] });
  });

  it.each(["non-array", "bad-data", "bad-index", "duplicate-index"] as const)("defers only the malformed transaction-context peer (%s)", async (mutation) => {
    const log = { address: "0x1111111111111111111111111111111111111111", topics: [], data: "0x01", logIndex: "0x0" };
    const logs = mutation === "non-array" ? {} : mutation === "bad-data" ? [{ ...log, data: "0xz" }]
      : mutation === "bad-index" ? [{ ...log, logIndex: undefined }] : [log, log];
    vi.mocked(getAlchemyTransactionContextBatchMany).mockResolvedValue(new Map([
      ["0xmalformed", {
        tx: { hash: "0xmalformed", to: "0xrouter", input: "0x96f4e9f9" },
        receipt: { transactionHash: "0xmalformed", to: "0xrouter", logs },
      }],
      ["0xeffective", alchemyMockHelpers.makeAlchemyContext("0xeffective")],
    ] as never));
    const rows: MintBurnRow[] = [
      makeRow({ id: "burn-malformed", direction: "burn", tx_hash: "0xmalformed" }),
      makeRow({ id: "burn-valid", direction: "burn", tx_hash: "0xeffective" }),
    ];

    const counters = await classifyBridgeBurnRows(
      rows,
      bridgeConfig,
      rpc,
      { count: 0, limit: 200 },
      new Map(),
    );

    expect(counters).toMatchObject({
      effectiveBurns: 1,
      txContextShortfalls: 1,
      deferredTxHashes: ["0xmalformed"],
    });
  });

  it("retains split dust burns so a 15000 mint and three 5000 burns conserve zero", async () => {
    const { db, sqlite } = fixtures.open();
    const config = makeMintBurnConfig({ asset: { stablecoinId: "split", startBlock: 1 } });
    const rows = [15000, 5000, 5000, 5000].flatMap((amount, index) => parseMintBurnLogs(config, {
      signature: "Transfer(address,address,uint256)", topicHash: "0x0", direction: index ? "burn" : "mint", amountEncoding: "transfer-value",
    }, [{ address: config.contractAddress, topics: [], data: `0x${BigInt(amount * 1e6).toString(16).padStart(64, "0")}`,
      transactionHash: "0xsplit", blockNumber: "0x1", logIndex: `0x${index}`, blockHash: "0x0", transactionIndex: "0x0", removed: false }],
    new Map([[1, 3601]]), { priceObservations: new Map([["split", { price: 1, observedAt: 3601, source: "binance", observedAtMode: "local_fetch" }]]), priceHistory: new Map() }).rows);
    const hours = collectAffectedHours(rows);
    await persistMintBurnRows(db, rows, hours);
    await recalcAffectedHours(db, hours);
    expect(sqlite.prepare("SELECT COUNT(*) AS events, SUM(below_display_threshold) AS dust FROM mint_burn_events").get()).toEqual({ events: 4, dust: 3 });
    expect(sqlite.prepare("SELECT net_flow_usd FROM mint_burn_hourly").get()).toEqual({ net_flow_usd: 0 });
  });

  it("requires accepted proof before an exact persisted burn can neutralize its mint", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.exec(`INSERT INTO mint_burn_supply_proofs
      (proof_id, config_key, config_fingerprint, from_block, to_block, status, evidence_json, checked_at)
      VALUES ('proof', 'config', 'fingerprint', 1, 1, 'proven', '{}', 1)`);
    const rows = [makeRow({ id: "mint", direction: "mint" }),
      makeRow({ id: "burn", direction: "burn", burn_type: "effective_burn", supply_proof_id: "proof" })];
    await insertMintBurnRows(db, rows);
    for (const lifecycle of ["pending", "accepted", "invalidated"]) {
      sqlite.prepare("UPDATE mint_burn_supply_proofs SET lifecycle = ?").run(lifecycle);
      await reconcileAtomicRoundtripGroups(db, rows, { configs: [] });
      await recalcAffectedHours(db, collectAffectedHours(rows));
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM mint_burn_events WHERE flow_type = 'atomic_roundtrip'").get())
        .toEqual({ n: lifecycle === "accepted" ? 2 : 0 });
      expect(sqlite.prepare("SELECT mint_count, burn_unresolved_event_count FROM mint_burn_hourly").get())
        .toEqual({ mint_count: lifecycle === "accepted" ? 0 : 1, burn_unresolved_event_count: lifecycle === "accepted" ? 0 : 1 });
    }
  });

  it("accounts for dust normally while excluding atomic, bridge and unresolved legs", async () => {
    const { db, sqlite } = fixtures.open();

    const rows = [
      makeRow({ id: "mint-standard", direction: "mint", amount_usd: 100, timestamp: 3_605, tx_hash: "0xmint-standard" }),
      makeRow({
        id: "burn-standard",
        direction: "burn",
        burn_type: "effective_burn",
        amount_usd: 25,
        timestamp: 3_610,
        tx_hash: "0xburn-standard",
      }),
      makeRow({
        id: "mint-roundtrip",
        direction: "mint",
        amount_usd: 999,
        timestamp: 3_615,
        tx_hash: "0xroundtrip",
        flow_type: "atomic_roundtrip",
      }),
      makeRow({
        id: "burn-roundtrip",
        direction: "burn",
        burn_type: "effective_burn",
        amount_usd: 777,
        timestamp: 3_620,
        tx_hash: "0xroundtrip",
        flow_type: "atomic_roundtrip",
      }),
      makeRow({
        id: "mint-bridge",
        direction: "mint",
        amount_usd: 999,
        timestamp: 3_615,
        tx_hash: "0xbridge-mint",
        flow_type: "bridge_transfer",
      }),
      makeRow({
        id: "burn-bridge",
        direction: "burn",
        burn_type: "bridge_burn",
        amount_usd: 777,
        timestamp: 3_620,
        tx_hash: "0xbridge-burn",
        flow_type: "bridge_transfer",
      }),
      makeRow({ id: "mint-unresolved", timestamp: 3610, burn_type: "review_required", amount_usd: 500, tx_hash: "0xreview-mint" }),
      makeRow({ id: "burn-unresolved", direction: "burn", timestamp: 3610, burn_type: "review_required", amount_usd: 500, tx_hash: "0xreview-burn" }),
    ];

    for (const row of rows) row.below_display_threshold = 1;
    await insertMintBurnRows(db, rows);
    await recalcAffectedHours(db, collectAffectedHours(rows));

    expect(sqlite.prepare("SELECT * FROM mint_burn_hourly").get()).toEqual({
      stablecoin_id: "usdt-tether",
      chain_id: "ethereum",
      hour_ts: 3600,
      mint_count: 1,
      burn_count: 1,
      mint_unpriced_event_count: 0,
      burn_unpriced_event_count: 0,
      mint_unresolved_event_count: 1,
      burn_unresolved_event_count: 1,
      mint_volume_usd: 100,
      burn_volume_usd: 25,
      net_flow_usd: 75,
    });
  });

  it("keeps a tagged atomic roundtrip when a later scan re-observes only its burn", async () => {
    const { db, sqlite } = fixtures.open();
    const timestamp = 3_610;
    const insert = sqlite.prepare(`INSERT INTO mint_burn_events
      (id, stablecoin_id, symbol, chain_id, direction, amount, amount_raw, amount_usd, burn_type, tx_hash, block_number,
       timestamp, explorer_tx_url, flow_type)
      VALUES (?, 'usdt-tether', 'USDT', 'ethereum', ?, 100, '1000000000000', 100, ?, '0xroundtrip', 1, ?, '', 'standard')`);
    insert.run("mint", "mint", null, timestamp);
    insert.run("burn", "burn", "effective_burn", timestamp);
    // The post-run sweep tags the cross-config pair while both sides are stored.
    await sweepRecentRoundtrips(db, timestamp + 1_000);
    expect(sqlite.prepare("SELECT direction, flow_type FROM mint_burn_events ORDER BY direction").all()).toEqual([
      { direction: "burn", flow_type: "atomic_roundtrip" },
      { direction: "mint", flow_type: "atomic_roundtrip" },
    ]);
    expect(sqlite.prepare("SELECT burn_count, net_flow_usd FROM mint_burn_hourly WHERE hour_ts = 3600").get())
      .toEqual({ burn_count: 0, net_flow_usd: 0 });

    // A coverage-repair / held-cursor replay re-observes one side only; the
    // in-memory detector cannot see the stored peer and reports it standard.
    const affectedHours = new Map<string, { stablecoinId: string; chainId: string; hourTs: number }>();
    await persistMintBurnRows(db, [
      makeRow({ id: "burn", direction: "burn", burn_type: "effective_burn", tx_hash: "0xroundtrip", timestamp }),
    ], affectedHours);
    await recalcAffectedHours(db, affectedHours);

    expect.soft(sqlite.prepare("SELECT direction, flow_type FROM mint_burn_events ORDER BY direction").all()).toEqual([
      { direction: "burn", flow_type: "atomic_roundtrip" },
      { direction: "mint", flow_type: "atomic_roundtrip" },
    ]);
    expect.soft(sqlite.prepare("SELECT mint_count, burn_count, burn_volume_usd, net_flow_usd FROM mint_burn_hourly WHERE hour_ts = 3600").get())
      .toEqual({ mint_count: 0, burn_count: 0, burn_volume_usd: 0, net_flow_usd: 0 });
  });

  it("waits for every shared-bucket config and uses the whole persisted transaction", async () => {
    const { db, sqlite } = fixtures.open();
    const [first, second] = MINT_BURN_CONFIGS.filter((config) => config.stablecoinId === "buidl-blackrock"
      && config.chain.chainId === "ethereum");
    const block = Math.max(first.startBlock, second.startBlock) + 1;
    const rows = [
      makeRow({ id: "class-a-mint", stablecoin_id: first.stablecoinId, tx_hash: "shared-classes", block_number: block }),
      makeRow({ id: "class-a-burn", stablecoin_id: first.stablecoinId, direction: "burn", burn_type: "effective_burn",
        tx_hash: "shared-classes", block_number: block }),
    ];
    const affected = new Map();
    // A complete first-config pair is insufficient while the sibling has not scanned this block.
    expect((await persistMintBurnRows(db, rows, affected, { knownCompleteConfigKey: mintBurnConfigKey(first) })).roundtripsDetected).toBe(0);
    sqlite.prepare("INSERT INTO mint_burn_sync_state (config_key, last_block) VALUES (?, ?)").run(mintBurnConfigKey(first), block);
    // The sibling contributes a real residual, so the earlier apparent pair stays standard.
    await persistMintBurnRows(db, [makeRow({ id: "class-b-mint", stablecoin_id: first.stablecoinId,
      tx_hash: "shared-classes", amount: 1, amount_usd: 1, block_number: block })], affected, { knownCompleteConfigKey: mintBurnConfigKey(second) });
    expect(sqlite.prepare("SELECT DISTINCT flow_type FROM mint_burn_events").all()).toEqual([{ flow_type: "standard" }]);
    await recalcAffectedHours(db, affected);
    expect(sqlite.prepare("SELECT net_flow_usd FROM mint_burn_hourly").get()).toEqual({ net_flow_usd: 1 });

    // A separate transaction split across configs cancels only once both populations are stored.
    await persistMintBurnRows(db, [makeRow({ id: "split-mint", stablecoin_id: first.stablecoinId,
      tx_hash: "split-classes", block_number: block })], affected, { knownCompleteConfigKey: mintBurnConfigKey(first) });
    const result = await persistMintBurnRows(db, [makeRow({ id: "split-burn", stablecoin_id: first.stablecoinId,
      tx_hash: "split-classes", direction: "burn", burn_type: "effective_burn", block_number: block })], affected,
    { knownCompleteConfigKey: mintBurnConfigKey(second) });
    expect(result.roundtripsDetected).toBe(2);
    expect(sqlite.prepare("SELECT DISTINCT flow_type FROM mint_burn_events WHERE tx_hash = 'split-classes'").all())
      .toEqual([{ flow_type: "atomic_roundtrip" }]);
  });

  it("removes stale hourly rows when an affected bucket has no rows left after recompute", async () => {
    const { db, sqlite } = fixtures.open();

    const burnRow = makeRow({
      id: "burn-effective",
      direction: "burn",
      burn_type: "effective_burn",
      amount_usd: 125,
      timestamp: 3_610,
    });

    await insertMintBurnRows(db, [burnRow]);
    await recalcAffectedHours(db, collectAffectedHours([burnRow]));
    expect(sqlite.prepare("SELECT * FROM mint_burn_hourly").get()).toEqual({
      stablecoin_id: "usdt-tether",
      chain_id: "ethereum",
      hour_ts: 3600,
      mint_count: 0,
      burn_count: 1,
      mint_unpriced_event_count: 0,
      burn_unpriced_event_count: 0,
      mint_unresolved_event_count: 0,
      burn_unresolved_event_count: 0,
      mint_volume_usd: 0,
      burn_volume_usd: 125,
      net_flow_usd: -125,
    });

    sqlite.exec("DELETE FROM mint_burn_events");
    await recalcAffectedHours(db, collectAffectedHours([burnRow]));

    expect(sqlite.prepare("SELECT * FROM mint_burn_hourly").all()).toEqual([]);
  });

  it("records unpriced counted events beside known subtotals instead of zero dollars", async () => {
    const { db, sqlite } = fixtures.open();
    // Mixed hour: one unpriced standard mint and one priced $1M effective burn.
    const unpricedMint = { ...makeRow({ id: "mint-unpriced", direction: "mint", timestamp: 3_605, tx_hash: "0xmint" }), amount_usd: null };
    const pricedBurn = makeRow({
      id: "burn-priced", direction: "burn", burn_type: "effective_burn", amount_usd: 1_000_000, timestamp: 3_610, tx_hash: "0xburn",
    });
    // All-unpriced hour.
    const unpricedBurn = {
      ...makeRow({ id: "burn-unpriced", direction: "burn", burn_type: "effective_burn", timestamp: 7_210, tx_hash: "0xburn-2" }),
      amount_usd: null,
    };
    const rows = [unpricedMint, pricedBurn, unpricedBurn];
    await insertMintBurnRows(db, rows);
    await recalcAffectedHours(db, collectAffectedHours(rows));

    const hourly = () => sqlite.prepare(
      `SELECT hour_ts, mint_count, burn_count, mint_unpriced_event_count, burn_unpriced_event_count,
              mint_volume_usd, burn_volume_usd, net_flow_usd
         FROM mint_burn_hourly ORDER BY hour_ts`,
    ).all();
    expect(hourly()).toEqual([
      {
        hour_ts: 3600, mint_count: 1, burn_count: 1, mint_unpriced_event_count: 1, burn_unpriced_event_count: 0,
        mint_volume_usd: 0, burn_volume_usd: 1_000_000, net_flow_usd: -1_000_000,
      },
      {
        hour_ts: 7200, mint_count: 0, burn_count: 1, mint_unpriced_event_count: 0, burn_unpriced_event_count: 1,
        mint_volume_usd: 0, burn_volume_usd: 0, net_flow_usd: 0,
      },
    ]);

    // Heal: the mint gains its valuation; one recalc rewrites count and subtotals together.
    sqlite.prepare("UPDATE mint_burn_events SET amount_usd = 3000000 WHERE id = 'mint-unpriced'").run();
    await recalcAffectedHours(db, collectAffectedHours([unpricedMint]));
    expect(hourly()[0]).toEqual({
      hour_ts: 3600, mint_count: 1, burn_count: 1, mint_unpriced_event_count: 0, burn_unpriced_event_count: 0,
      mint_volume_usd: 3_000_000, burn_volume_usd: 1_000_000, net_flow_usd: 2_000_000,
    });
  });

  it("ignores duplicate IDs, excludes unclassified burns, and persists reclassification", async () => {
    const { db, sqlite } = fixtures.open();
    const mint = makeRow({ id: "mint", timestamp: 3605 });
    const burn = makeRow({ id: "burn", direction: "burn", burn_type: null, timestamp: 3610 });
    expect(await insertMintBurnRows(db, [mint, burn, mint])).toEqual({ inserted: 2, ignored: 1 });
    await recalcAffectedHours(db, collectAffectedHours([mint, burn]));
    expect(sqlite.prepare("SELECT mint_count, burn_count, burn_unresolved_event_count, net_flow_usd FROM mint_burn_hourly").get())
      .toEqual({ mint_count: 1, burn_count: 0, burn_unresolved_event_count: 1, net_flow_usd: 100 });
    await updateEventClassifications(db, [{ ...burn, burn_type: "bridge_burn", burn_review_reason: "reviewed", flow_type: "bridge_transfer" }]);
    expect(sqlite.prepare("SELECT burn_type, burn_review_reason, flow_type FROM mint_burn_events WHERE id = 'burn'").get())
      .toEqual({ burn_type: "bridge_burn", burn_review_reason: "reviewed", flow_type: "bridge_transfer" });
    await recalcAffectedHours(db, collectAffectedHours([mint, burn]));
    expect(sqlite.prepare("SELECT mint_count, burn_count, burn_unresolved_event_count, net_flow_usd FROM mint_burn_hourly").get())
      .toEqual({ mint_count: 1, burn_count: 0, burn_unresolved_event_count: 0, net_flow_usd: 100 });
  });

  it("replays a reviewed protocol-internal burn out of counted flow and fails closed on amount drift", async () => {
    const { db, sqlite } = fixtures.open();
    const reviewedId = "arbitrum-0x46dc4ae95582c3d92d2ada242fc7445b6f4408284d271f69e2f98668993559d7-4";
    const base = {
      stablecoin_id: "usdai-usd-ai",
      chain_id: "arbitrum",
      direction: "burn" as const,
      burn_type: "effective_burn" as const,
      timestamp: 3_610,
    };
    const reviewed = makeRow({ ...base, id: reviewedId, amount: 128_895_244.1, amount_usd: 128_889_257.84 });
    const drifted = makeRow({ ...base, id: "arbitrum-0xother-1", amount: 50, amount_usd: 50 });

    // First ingestion predates the review: both burns count.
    await insertMintBurnRows(db, [reviewed, drifted]);
    await recalcAffectedHours(db, collectAffectedHours([reviewed, drifted]));
    expect(sqlite.prepare("SELECT burn_count, net_flow_usd FROM mint_burn_hourly").get())
      .toEqual({ burn_count: 2, net_flow_usd: -128_889_307.84 });

    // Replay re-parses the same logs; the reviewed event leaves counted flow.
    const affectedHours = new Map<string, { stablecoinId: string; chainId: string; hourTs: number }>();
    const result = await persistMintBurnRows(db, [{ ...reviewed }, { ...drifted }], affectedHours);
    await recalcAffectedHours(db, affectedHours);
    expect(result.reviewedProtocolInternal).toBe(1);
    expect(sqlite.prepare("SELECT id, flow_type FROM mint_burn_events ORDER BY id").all()).toEqual([
      { id: reviewedId, flow_type: "protocol_internal" },
      { id: "arbitrum-0xother-1", flow_type: "standard" },
    ]);
    expect(sqlite.prepare("SELECT burn_count, net_flow_usd FROM mint_burn_hourly").get())
      .toEqual({ burn_count: 1, net_flow_usd: -50 });

    // A reviewed id whose amount no longer matches its review stays economic.
    const mismatched = { ...reviewed, amount: 128_000_000 };
    await persistMintBurnRows(db, [mismatched]);
    expect(sqlite.prepare("SELECT flow_type FROM mint_burn_events WHERE id = ?").get(reviewedId))
      .toEqual({ flow_type: "standard" });
  });

  it("tags only the same coin and chain's supply-excluded counterparties, case-insensitively", () => {
    const exclusion = CURATED_ONCHAIN_SUPPLY_EXCLUSIONS["usg-tangent"];
    const base = { stablecoin_id: "usg-tangent", chain_id: exclusion.chain };
    const mint = makeRow({ ...base, counterparty: exclusion.holderAddresses[0].toUpperCase() });
    const burn = makeRow({ ...base, direction: "burn", burn_type: "effective_burn", counterparty: exclusion.holderAddresses[1] });
    const holder = makeRow({ ...base, counterparty: "0xholder" });
    const wrongChain = makeRow({ ...base, chain_id: "arbitrum", counterparty: mint.counterparty });
    const wrongCoin = makeRow({ counterparty: mint.counterparty });
    const missingCounterparty = makeRow({ ...base });

    applySupplyExcludedProtocolInternalFlows([mint, burn, holder, wrongChain, wrongCoin, missingCounterparty]);

    expect([mint, burn].map((row) => row.flow_type)).toEqual(["protocol_internal", "protocol_internal"]);
    expect(burn.burn_type).toBe("effective_burn");
    expect([holder, wrongChain, wrongCoin, missingCounterparty].map((row) => row.flow_type))
      .toEqual(["standard", "standard", "standard", "standard"]);
  });

  it("replays stored PegKeeper mints and burns out of hourly aggregates without removing ledger rows", async () => {
    const { db, sqlite } = fixtures.open();
    const exclusion = CURATED_ONCHAIN_SUPPLY_EXCLUSIONS["usg-tangent"];
    const base = { stablecoin_id: "usg-tangent", chain_id: exclusion.chain, timestamp: 3_610 };
    const mint = makeRow({ ...base, id: "pegkeeper-mint", counterparty: exclusion.holderAddresses[0], amount: 20_000_000, amount_usd: 20_000_000 });
    const burn = makeRow({ ...base, id: "pegkeeper-burn", direction: "burn", burn_type: "effective_burn", counterparty: exclusion.holderAddresses[1], amount: 18_500_000, amount_usd: 18_500_000 });
    const holderMint = makeRow({ ...base, id: "holder-mint" });
    const rows = [mint, burn, holderMint];
    await insertMintBurnRows(db, rows);
    await recalcAffectedHours(db, collectAffectedHours(rows));
    expect(sqlite.prepare("SELECT mint_count, burn_count, net_flow_usd FROM mint_burn_hourly").get())
      .toEqual({ mint_count: 2, burn_count: 1, net_flow_usd: 1_500_100 });

    const affectedHours = collectAffectedHours([]);
    const result = await persistMintBurnRows(db, rows.map((row) => ({ ...row })), affectedHours);
    await recalcAffectedHours(db, affectedHours);
    expect(result).toMatchObject({ inserted: 0, ignored: 3, flowTypeChanges: 2, reviewedProtocolInternal: 0 });
    expect(sqlite.prepare("SELECT id, flow_type, burn_type FROM mint_burn_events ORDER BY id").all()).toEqual([
      { id: "holder-mint", flow_type: "standard", burn_type: null },
      { id: "pegkeeper-burn", flow_type: "protocol_internal", burn_type: "effective_burn" },
      { id: "pegkeeper-mint", flow_type: "protocol_internal", burn_type: null },
    ]);
    expect(sqlite.prepare("SELECT mint_count, burn_count, net_flow_usd FROM mint_burn_hourly").get())
      .toEqual({ mint_count: 1, burn_count: 0, net_flow_usd: 100 });
  });

  it("atomically invalidates every classification change, reverses mint exclusions, and settles debt only with the hour", async () => {
    const { db, sqlite } = fixtures.open();
    const mint = makeRow({ id: "mint-replay", timestamp: 3605 });
    const burn = makeRow({ id: "burn-replay", direction: "burn", timestamp: 3610, burn_type: "effective_burn", amount_usd: 25 });
    await insertMintBurnRows(db, [mint, burn]);
    await recalcAffectedHours(db, collectAffectedHours([mint, burn]));
    for (const original of [mint, burn]) {
      const revisions = original.direction === "mint"
        ? [{ ...original, flow_type: "bridge_transfer" as const }, original,
          { ...original, flow_type: "protocol_internal" as const }, original]
        : [{ ...original, burn_type: "review_required" as const, burn_review_reason: "known-bridge-pool-without-bridge-signal" }, original];
      for (const revision of revisions) {
        const before = sqlite.prepare("SELECT flow_type, burn_type FROM mint_burn_events WHERE id = ?").get(original.id);
        for (const failure of ["enqueue", "update"]) {
          const failingDb = createSqliteD1(sqlite, { onRun(sql) {
            if ((failure === "enqueue" && sql.includes("INSERT OR REPLACE INTO mint_burn_dirty_hours"))
              || (failure === "update" && sql.includes("UPDATE mint_burn_events"))) throw new Error("classification interrupted");
          } });
          await expect(updateEventClassifications(failingDb, [revision])).rejects.toThrow("classification interrupted");
          expect(sqlite.prepare("SELECT flow_type, burn_type FROM mint_burn_events WHERE id = ?").get(original.id)).toEqual(before);
          expect(sqlite.prepare("SELECT * FROM mint_burn_dirty_hours").all()).toEqual([]);
        }
        expect(await updateEventClassifications(db, [revision])).toMatchObject({ rowsUpdated: 1 });
        expect(sqlite.prepare("SELECT hour_ts FROM mint_burn_dirty_hours").all()).toEqual([{ hour_ts: 3600 }]);
        const failingRebuild = createSqliteD1(sqlite, { onRun(sql) {
          if (sql.includes("DELETE FROM mint_burn_dirty_hours")) throw new Error("rebuild interrupted");
        } });
        await expect(drainMintBurnMaterializationDebt(failingRebuild)).rejects.toThrow("rebuild interrupted");
        expect(sqlite.prepare("SELECT hour_ts FROM mint_burn_dirty_hours").all()).toEqual([{ hour_ts: 3600 }]);
        await drainMintBurnMaterializationDebt(db);
        expect(sqlite.prepare("SELECT * FROM mint_burn_dirty_hours").all()).toEqual([]);
      }
    }
    expect(sqlite.prepare("SELECT mint_count, burn_count, net_flow_usd FROM mint_burn_hourly").get())
      .toEqual({ mint_count: 1, burn_count: 1, net_flow_usd: 75 });
  });

  it("skips identical classification rewrites and still lands genuine changes", async () => {
    const { db, sqlite } = fixtures.open();
    const burn = makeRow({ id: "burn-rewrite", direction: "burn", burn_type: "effective_burn" });
    const stored = () => sqlite.prepare(
      "SELECT burn_type, burn_review_reason, flow_type FROM mint_burn_events WHERE id = 'burn-rewrite'").get();
    await insertMintBurnRows(db, [burn]);

    // An unchanged re-observed row is not rewritten.
    expect(await updateEventClassifications(db, [{ ...burn }]))
      .toEqual({ flowTypeChanges: 0, burnTypeChanges: 1, rowsUpdated: 0 });
    expect(stored()).toEqual({ burn_type: "effective_burn", burn_review_reason: null, flow_type: "standard" });

    // A genuine revision lands and is counted.
    expect(await updateEventClassifications(db, [
      { ...burn, burn_type: "bridge_burn", burn_review_reason: "bridge-context" },
    ])).toMatchObject({ rowsUpdated: 1 });
    expect(stored()).toEqual({ burn_type: "bridge_burn", burn_review_reason: "bridge-context", flow_type: "standard" });

    // A standard-flow replay never revokes atomic_roundtrip, even while burn fields change.
    await updateEventClassifications(db, [
      { ...burn, flow_type: "atomic_roundtrip", burn_type: "bridge_burn", burn_review_reason: null },
    ]);
    await updateEventClassifications(db, [
      { ...burn, flow_type: "standard", burn_type: "effective_burn", burn_review_reason: "reviewed-supply-destruction" },
    ]);
    expect(stored()).toEqual({
      burn_type: "effective_burn", burn_review_reason: "reviewed-supply-destruction", flow_type: "atomic_roundtrip",
    });
  });

  it("keeps the high cursor in monotonic mode and permits rewind in replace mode", async () => {
    const { db, sqlite } = fixtures.open();
    await upsertMintBurnSyncState(db, "ethereum-0xabc", 456, "replace");
    await upsertMintBurnSyncState(db, "ethereum-0xabc", 123, "monotonic-max");
    expect(sqlite.prepare("SELECT last_block FROM mint_burn_sync_state").get()).toEqual({ last_block: 456 });
    await upsertMintBurnSyncState(db, "ethereum-0xabc", 100, "replace");
    expect(sqlite.prepare("SELECT last_block FROM mint_burn_sync_state").get()).toEqual({ last_block: 100 });
  });

  it("reads actual sync rows in chunks, preserving absent-config defaults", async () => {
    const { sqlite } = fixtures.open();
    const configs = Array.from({ length: 101 }, (_, i) => makeMintBurnConfig({
      asset: { contractAddress: `0x${i.toString(16).padStart(40, "0")}` },
    }));
    const key = mintBurnConfigKey(configs[0]);
    sqlite.prepare("INSERT INTO mint_burn_sync_state VALUES (?, ?)").run(key, 22_345_678);
    let reads = 0;
    const db = createSqliteD1(sqlite, { onAll() { reads++; } });
    const results = await readMintBurnSyncStateBatch(db, configs);
    expect(reads).toBe(2);
    expect(results.size).toBe(101);
    expect(results.get(key)).toBe(22_345_678);
    expect(results.get(mintBurnConfigKey(configs[100]))).toBe(configs[100].startBlock - 1);
  });
});

// Fake topic hash: parseMintBurnLogs does not validate log.topics[0] against
// eventDef.topicHash (topic filtering happens upstream in the fetch layer), so the
// value is inert for this test. Using a visibly-fake placeholder to avoid seeding
// a wrong-but-real-looking constant.
const FAKE_TOPIC = "0x" + "0".repeat(64);
const USER_DATA = "000000000000000000000000aaaa1111aaaa2222aaaa3333aaaa4444aaaa5555";
const TOKEN_DATA = "000000000000000000000000bbbb1111bbbb2222bbbb3333bbbb4444bbbb5555";
const AMOUNT_DATA = "0000000000000000000000000000000000000000000000000de0b6b3a7640000"; // 1e18

describe("parseMintBurnLogs — custom counterparty encoding", () => {
  it("extracts counterparty from data slot when counterpartyEncoding is set", () => {
    const config = makeMintBurnConfig({
      asset: { stablecoinId: "test", symbol: "TEST", contractAddress: "0xc0", decimals: 18, dustThreshold: 0, startBlock: 1 },
      adapter: "custom-events",
    });
    const eventDef: MintBurnEventDef = {
      signature: "Deposited(address,address,uint256)",
      topicHash: FAKE_TOPIC,
      direction: "mint",
      amountEncoding: "nth-data-uint256",
      dataSlot: 2,
      counterpartyEncoding: { source: "data", slot: 0 },
    };
    const logs: AlchemyLogEntry[] = [{
      address: "0xc0",
      topics: [FAKE_TOPIC],
      data: "0x" + USER_DATA + TOKEN_DATA + AMOUNT_DATA,
      blockNumber: "0x64",
      transactionHash: "0xtx",
      logIndex: "0x0",
      blockHash: "0xhash",
      transactionIndex: "0x0",
      removed: false,
    }];
    const { rows } = parseMintBurnLogs(
      config,
      eventDef,
      logs,
      new Map([[100, 1700000000]]),
      { priceObservations: new Map(), priceHistory: new Map() },
    );
    expect(rows[0].counterparty).toBe("0xaaaa1111aaaa2222aaaa3333aaaa4444aaaa5555");
  });
});

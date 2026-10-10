import { afterEach, describe, expect, it, vi } from "vitest";
import { insertBlacklistRows } from "../persistence";
import { makePendingBlacklistRow } from "./blacklist.test-support";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";
import { getBlacklistConfigsForSymbolAndChain } from "../../../lib/blacklist-contracts";
import { parseEvmLogsWithCoverage } from "../evm-source";
import { parseTronEvent } from "../tron-source";
import { buildBlacklistActiveRecords } from "@shared/lib/blacklist-active-records";
import { mapBlacklistEventRow } from "../../../lib/blacklist-api";
import { handleBlacklist } from "../../../api/blacklist";
import { materializeBlacklistSummarySnapshot, handleBlacklistSummary } from "../../../lib/blacklist-summary-service";
import { loadBlacklistCurrentBalanceMap } from "../../../lib/blacklist-current-balances";
import { reconcileBlacklistIdentities } from "../../../lib/blacklist/identity-reconciliation";
import type { BlacklistSummaryResponse } from "@shared/types/market";

const fixtures = createLatestSchemaFixtureTracker();

afterEach(() => {
  fixtures.closeAll();
  vi.useRealTimers();
});


describe("insertBlacklistRows", () => {
  it("canonicalizes EVM log spellings and reconciles retained duplicates without inflating public counts", async () => {
    const { db, sqlite } = fixtures.open();
    const [config] = getBlacklistConfigsForSymbolAndChain("USDC", "ethereum");
    const topic = config.events.find((event) => event.eventType === "blacklist")!.topicHash;
    const tx = "0x" + "ab".repeat(32);
    const word = "0x" + "0".repeat(24) + "11".repeat(20);
    const rows = ["0x1", "0x01", "1"].flatMap((logIndex, index) => parseEvmLogsWithCoverage(config, [{
      address: config.contractAddress, topics: [topic, word], data: word, blockNumber: "0x64",
      timeStamp: "0x65000000", transactionHash: index === 1 ? "0x" + "AB".repeat(32) : tx, logIndex,
    }]).rows);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.id))).toEqual(new Set([`ethereum-${tx}-0x1`]));
    // A pre-cutover spelling is retained as the durable event/repair-queue identity.
    const legacy = { ...rows[0]!, id: `ethereum-${tx}-0x01` };
    expect(await insertBlacklistRows(db, [legacy])).toBe(1);
    expect(await insertBlacklistRows(db, rows)).toBe(0);
    sqlite.prepare(`INSERT INTO blacklist_events
      (id, stablecoin, chain_id, chain_name, event_type, address, tx_hash, block_number, timestamp,
       config_key, contract_address, explorer_tx_url, explorer_address_url)
      VALUES (?, 'USDC', 'ethereum', 'Ethereum', 'blacklist', ?, ?, 100, ?, ?, ?, '', '')`)
      .run(`ethereum-0x${"AB".repeat(32)}-1`, rows[0]!.address, `0x${"AB".repeat(32)}`, rows[0]!.timestamp, config.configKey, config.contractAddress);
    const feed = await (await handleBlacklist(db, new URL("https://api.pharos.watch/api/blacklist?includeTotal=true"))).json() as { events: unknown[]; total: number };
    expect(feed.events).toHaveLength(1);
    expect(feed.total).toBe(1);
    await materializeBlacklistSummarySnapshot(db, rows[0]!.timestamp + 10, rows[0]!.timestamp + 10);
    const summary = await (await handleBlacklistSummary(db)).json() as BlacklistSummaryResponse;
    expect(summary.stats.usdcBlacklisted).toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM blacklist_events WHERE suppression_reason = 'duplicate_log_identity'").get()).toEqual({ n: 1 });
    expect(await insertBlacklistRows(db, rows)).toBe(0);
  });

  it("unifies validated Tron representations in history, folding and persisted snapshot keys", async () => {
    const { db, sqlite } = fixtures.open();
    const [config] = getBlacklistConfigsForSymbolAndChain("USDT", "tron");
    const hex = "0x2004662f694f30fd269e4cccba222654b5f0538b";
    const base58 = "TCtVtrdy8sSXGMx1QYUjMrAvau1pduC2Aa";
    const rows = [hex, `41${hex.slice(2)}`, base58].map((address, index) => parseTronEvent(config, {
      block_number: index + 1, block_timestamp: (100 + index) * 1000,
      transaction_id: String(index + 1).repeat(64), event_index: 0,
      event_name: ["AddedBlackList", "DestroyedBlackFunds", "RemovedBlackList"][index],
      result: { _blackListedUser: address, _balance: "1000000" },
    })!);
    expect(rows.map((row) => row.address)).toEqual([hex, hex, hex]);
    const legacyRows = rows.map((row, index) => ({ ...row, address: [hex, `41${hex.slice(2)}`, base58][index] }));
    expect(buildBlacklistActiveRecords(legacyRows.map((row) => mapBlacklistEventRow({ ...row, suppression_reason: null })))).toEqual([]);
    expect(await insertBlacklistRows(db, legacyRows)).toBe(3);
    for (const row of legacyRows) sqlite.prepare("UPDATE blacklist_events SET address = ? WHERE id = ?").run(row.address, row.id);
    const legacyId = `USDT:tron:${base58.toLowerCase()}`;
    const canonicalId = `USDT:tron:${hex}`;
    const insert = sqlite.prepare(`INSERT INTO blacklist_current_balances
      (id, stablecoin, chain_id, address, amount_native, amount_usd, source, status, observed_at)
      VALUES (?, 'USDT', 'tron', ?, ?, ?, 'current_balance', ?, ?)`);
    insert.run(legacyId, base58, 42, 42, "resolved", 200);
    insert.run(canonicalId, hex, null, null, "provider_failed", 300);
    expect([...await loadBlacklistCurrentBalanceMap(db)].map(([key, row]) => [key, row.amountNative])).toEqual([[canonicalId, 42]]);
    await reconcileBlacklistIdentities(db);
    await reconcileBlacklistIdentities(db);
    expect(sqlite.prepare("SELECT DISTINCT address FROM blacklist_events").all()).toEqual([{ address: hex }]);
    expect(sqlite.prepare("SELECT id, address, amount_native, observed_at FROM blacklist_current_balances").all())
      .toEqual([{ id: canonicalId, address: hex, amount_native: 42, observed_at: 200 }]);
    expect(() => parseTronEvent(config, {
      block_number: 4, block_timestamp: 104000, transaction_id: "4".repeat(64), event_index: 0,
      event_name: "AddedBlackList", result: { _blackListedUser: base58.toLowerCase() },
    })).toThrow("invalid-address");
  });

  // 2026-08-29 dropped the legacy `amount` column from the statement but left its
  // placeholder behind; production rejected every new event for four days with
  // `D1_ERROR: 26 values for 25 columns`. Run the real statement against the
  // migrated schema so bind/column arity drift fails here, not in the cron.
  it("persists rows through the migrated schema and ignores duplicates", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.exec("ALTER TABLE blacklist_events DROP COLUMN amount");
    const rows = [
      makePendingBlacklistRow({ id: "usdt:ethereum:0xa:0", amount_native: 1_000, amount_usd_at_event: 975 }),
      makePendingBlacklistRow({ id: "usdt:ethereum:0xb:0" }),
    ];

    await expect(insertBlacklistRows(db, rows)).resolves.toBe(2);
    await expect(insertBlacklistRows(db, [rows[1]!, makePendingBlacklistRow({ id: "usdt:ethereum:0xc:0" })])).resolves.toBe(1);

    expect(
      sqlite.prepare("SELECT id, amount_native, amount_usd_at_event, amount_status FROM blacklist_events ORDER BY id").all(),
    ).toEqual([
      { id: "usdt:ethereum:0xa:0", amount_native: 1_000, amount_usd_at_event: 975, amount_status: "recoverable_pending" },
      { id: "usdt:ethereum:0xb:0", amount_native: null, amount_usd_at_event: null, amount_status: "recoverable_pending" },
      { id: "usdt:ethereum:0xc:0", amount_native: null, amount_usd_at_event: null, amount_status: "recoverable_pending" },
    ]);
  });


  it("retries transient D1 overloads through batchExecute", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const db = makeNoopD1({
      prepare: () => ({
        bind: () => ({}),
      }),
      batch: async () => {
        attempts++;
        if (attempts === 1) throw new Error("D1 DB is overloaded");
        return [{ success: true, meta: { changes: 1 } }];
      },
    });

    const pending = insertBlacklistRows(db, [makePendingBlacklistRow()]);
    await vi.runAllTimersAsync();
    const inserted = await pending;

    expect(inserted).toBe(1);
    expect(attempts).toBe(2);
  });

  it("honors an already-aborted signal before preparing rows", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop-blacklist"));
    const prepare = vi.fn();
    const db = makeNoopD1({
      prepare,
      batch: async () => [],
    });

    await expect(insertBlacklistRows(db, [makePendingBlacklistRow()], controller.signal)).rejects.toThrow("stop-blacklist");
    expect(prepare).not.toHaveBeenCalled();
  });
});

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
import {
  buildBlacklistAmountAttemptUpdate, buildRecoveredBlacklistAmountPersistence,
  type BlacklistAmountSelectedState,
} from "../../../lib/blacklist/amount-persistence";
import { buildBlacklistAmountRepairQueueUpdate, refreshBlacklistAmountRepairQueue } from "../../../lib/blacklist/amount-repair-queue";

const fixtures = createLatestSchemaFixtureTracker();

afterEach(() => {
  fixtures.closeAll();
  vi.useRealTimers();
});


describe("insertBlacklistRows", () => {
  it.each(["eligible", "other-error", "destroy", "tron", "suppressed", "raced-error", "event-source", "derived-source", "provider-failed"] as const)(
    "only resolves the exact unsuppressed legacy EVM state (%s)", async (scenario) => {
      const { db, sqlite } = fixtures.open();
      const [config] = getBlacklistConfigsForSymbolAndChain("EURC", "ethereum");
      await insertBlacklistRows(db, [makePendingBlacklistRow({
        id: "legacy-review", stablecoin: "EURC", amount_status: "permanently_unavailable",
        amount_last_error_class: scenario === "other-error" ? "event_time_unreconciled" : "event_time_unproven",
        event_type: scenario === "destroy" ? "destroy" : "blacklist",
        chain_id: scenario === "tron" ? "tron" : "ethereum",
        config_key: config.configKey, contract_address: config.contractAddress,
      })]);
      await refreshBlacklistAmountRepairQueue(db, 100);
      const selectedState = sqlite.prepare("SELECT * FROM blacklist_events WHERE id = 'legacy-review'").get() as BlacklistAmountSelectedState;
      const persistence = buildRecoveredBlacklistAmountPersistence(db, {
        eventId: "legacy-review", eventType: "blacklist", config,
        amount: 0, amountUsd: null,
        amountSource: scenario === "event-source" ? "event" : scenario === "derived-source" ? "derived" : "historical_balance",
        amountStatus: scenario === "provider-failed" ? "provider_failed" : "resolved",
        attemptedAt: 200, lastErrorClass: null, lastProvider: "chain_rpc",
      }, { selectedState });
      if (scenario === "suppressed") {
        sqlite.prepare("UPDATE blacklist_events SET suppression_reason = 'operator-suppressed' WHERE id = 'legacy-review'").run();
      } else if (scenario === "raced-error") {
        sqlite.prepare("UPDATE blacklist_events SET amount_last_error_class = 'operator-reviewed' WHERE id = 'legacy-review'").run();
      }
      const before = sqlite.prepare("SELECT * FROM blacklist_events WHERE id = 'legacy-review'").get();
      const queueBefore = sqlite.prepare("SELECT * FROM blacklist_amount_repair_queue WHERE event_id = 'legacy-review'").get();
      const [result] = await db.batch([
        persistence.statement,
        buildBlacklistAmountRepairQueueUpdate(db, {
          eventId: "legacy-review", outcome: "resolved", attemptedAt: 200, priorAttempts: 0,
          errorClass: null, requireChangedEvent: true,
        }),
      ]);
      if (scenario === "eligible") {
        expect(result.meta.changes).toBe(1);
        expect(sqlite.prepare("SELECT * FROM blacklist_events WHERE id = 'legacy-review'").get()).toMatchObject({
          amount_native: 0, amount_usd_at_event: null, amount_status: "resolved",
          amount_source: "historical_balance", amount_last_error_class: null, suppression_reason: null,
        });
        expect(sqlite.prepare("SELECT * FROM blacklist_amount_repair_queue WHERE event_id = 'legacy-review'").get())
          .toMatchObject({ status: "resolved", attempt_count: 1 });
      } else {
        expect(result.meta.changes).toBe(0);
        expect(sqlite.prepare("SELECT * FROM blacklist_events WHERE id = 'legacy-review'").get()).toEqual(before);
        expect(sqlite.prepare("SELECT * FROM blacklist_amount_repair_queue WHERE event_id = 'legacy-review'").get()).toEqual(queueBefore);
      }
    },
  );

  it.each(["event", "historical_balance", "derived", "unavailable"] as const)(
    "persists EURC mirror suppression only for event-time zero proof (%s)",
    async (amountSource) => {
      const { db, sqlite } = fixtures.open();
      const [config] = getBlacklistConfigsForSymbolAndChain("EURC", "ethereum");
      await insertBlacklistRows(db, [makePendingBlacklistRow({
        id: "eurc-zero-proof", stablecoin: "EURC", config_key: config.configKey,
        contract_address: config.contractAddress,
      })]);
      await buildRecoveredBlacklistAmountPersistence(db, {
        eventId: "eurc-zero-proof", eventType: "blacklist", config,
        amount: 0, amountUsd: null, amountSource, amountStatus: "resolved",
        attemptedAt: 200, lastErrorClass: null, lastProvider: "event_receipt",
      }, { requireUnresolvedAmount: true }).statement.run();
      expect(sqlite.prepare(`SELECT amount_native, amount_usd_at_event, amount_status, suppression_reason
        FROM blacklist_events WHERE id = 'eurc-zero-proof'`).get()).toEqual({
        amount_native: 0, amount_usd_at_event: null,
        amount_status: amountSource === "event" ? "permanently_unavailable" : "resolved",
        suppression_reason: amountSource === "event" ? "circle_mirror_zero_balance" : null,
      });
    },
  );

  it.each([true, false])("fences provenance-only repairs against a newer operator generation (success=%s)", async (success) => {
    const { db, sqlite } = fixtures.open();
    const [config] = getBlacklistConfigsForSymbolAndChain("USDC", "ethereum");
    await insertBlacklistRows(db, [makePendingBlacklistRow({
      id: "provenance-race", amount_native: 50, amount_usd_at_event: 50,
      amount_status: "provider_failed", config_key: config.configKey, contract_address: config.contractAddress,
    })]);
    const selectedState = sqlite.prepare("SELECT * FROM blacklist_events WHERE id = 'provenance-race'").get() as BlacklistAmountSelectedState;
    const statement = success
      ? buildRecoveredBlacklistAmountPersistence(db, {
        eventId: "provenance-race", eventType: "blacklist", config,
        amount: 99, amountUsd: 99, amountSource: "historical_balance", amountStatus: "resolved",
        attemptedAt: 200, lastErrorClass: null, lastProvider: "chain_rpc",
      }, { selectedState }).statement
      : buildBlacklistAmountAttemptUpdate(db, {
        eventId: "provenance-race", attemptedAt: 200, errorClass: "provider_null",
        lastProvider: "chain_rpc", amountStatus: "provider_failed",
      }, { selectedState });
    sqlite.prepare(`UPDATE blacklist_events SET provenance_source = 'operator-verified',
      provenance_observed_at = 150 WHERE id = 'provenance-race'`).run();
    const before = sqlite.prepare("SELECT * FROM blacklist_events WHERE id = 'provenance-race'").get();
    expect((await statement.run()).meta.changes).toBe(0);
    expect(sqlite.prepare("SELECT * FROM blacklist_events WHERE id = 'provenance-race'").get()).toEqual(before);
  });

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

  it("persists observed Tron transaction order without replacing canonical event identities", async () => {
    const { db, sqlite } = fixtures.open();
    const [config] = getBlacklistConfigsForSymbolAndChain("USDT", "tron");
    const row = parseTronEvent(config, {
      block_number: 100, block_timestamp: 1_710_000_000_000,
      transaction_id: "ab".repeat(32), event_index: 1, event_name: "DestroyedBlackFunds",
      result: { _blackListedUser: "0x2004662f694f30fd269e4cccba222654b5f0538b", _balance: "12500000" },
    })!;
    row.transaction_index = 0;
    expect(await insertBlacklistRows(db, [row])).toBe(1);
    expect(await insertBlacklistRows(db, [{ ...row, id: `tron-${row.tx_hash}-0x1`, transaction_index: 99 }])).toBe(0);
    expect(sqlite.prepare("SELECT id, transaction_index, amount_native FROM blacklist_events").all())
      .toEqual([{ id: row.id, transaction_index: 0, amount_native: 12.5 }]);

    const fallback = { ...row, id: `tron-${"cd".repeat(32)}-1`, tx_hash: "cd".repeat(32) };
    delete fallback.transaction_index;
    expect(await insertBlacklistRows(db, [fallback])).toBe(1);
    expect(sqlite.prepare("SELECT transaction_index FROM blacklist_events WHERE id = ?").get(fallback.id))
      .toEqual({ transaction_index: null });
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

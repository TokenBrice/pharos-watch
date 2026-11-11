import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import {
  MINT_BURN_EVENT_RETENTION_SEC,
  MINT_BURN_HOURLY_RETENTION_SEC,
  pruneMintBurnRetention,
} from "../mint-burn/retention";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { MINT_BURN_CONFIGS } from "../../lib/mint-burn-pipeline/mint-burn-contracts";
import { mintBurnConfigKey } from "../../lib/mint-burn-pipeline/mint-burn-contract-identity";
import { upsertMintBurnSyncState } from "../../lib/mint-burn-pipeline/sync-state";
import { mintBurnScanCoverageAdmits, mintBurnScanFingerprint, readMintBurnScanCoverage } from "../../lib/mint-burn-pipeline/scan-coverage";
import { makeMintBurnConfig } from "../../test-helpers/__shared/mint-burn-config";
import { recalcAffectedHours } from "../../lib/mint-burn-pipeline/persistence";
import { repairHistoricalMintBurnPrices } from "../../lib/mint-burn-pipeline/mint-burn-historical-price-repair";
import {
  drainMintBurnMaterializationDebt,
  rebuildMintBurnMaterializationHours,
  seedMintBurnLegacyMaterializationDebt,
} from "../../lib/mint-burn-pipeline/materialization-debt";

const NOW_SEC = 1_800_000_000;
const HOUR_SEC = 3600;
const TAPE_CURSOR_KEY = "tape-projector:cursor:mint_burn.large_flow";
let sqlite: DatabaseSync;
let db: D1Database;

function setupDb(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = createLatestSchemaSqlite().sqlite;
  sqlite
    .prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
    .run(TAPE_CURSOR_KEY, String(NOW_SEC), NOW_SEC);
  for (const config of MINT_BURN_CONFIGS) {
    sqlite.prepare("INSERT OR IGNORE INTO mint_burn_sync_state (config_key, last_block) VALUES (?, ?)")
      .run(mintBurnConfigKey(config), 100);
  }
  return { sqlite, db: createSqliteD1(sqlite) };
}

function hourFor(timestamp: number): number {
  return Math.floor(timestamp / HOUR_SEC) * HOUR_SEC;
}

function insertEvent(
  id: string, timestamp: number,
  input: {
    amountUsd?: number | null;
    priceRepairStatus?: string | null;
    withHourly?: boolean;
  } = {},
): void {
  sqlite
    .prepare(
      `INSERT INTO mint_burn_events
        (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd,
         tx_hash, block_number, timestamp, explorer_tx_url, price_repair_status)
       VALUES (?, 'usdc-circle', 'USDC', 'ethereum', 'mint', 1, ?, ?, 1, ?,
               'https://etherscan.io/tx/0x0', ?)`,
    )
    .run(
      id,
      input.amountUsd === undefined ? 1 : input.amountUsd,
      `0x${id}`,
      timestamp,
      input.priceRepairStatus ?? null,
    );
  if (input.withHourly !== false) {
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO mint_burn_hourly
          (stablecoin_id, chain_id, hour_ts)
         VALUES ('usdc-circle', 'ethereum', ?)`,
      )
      .run(hourFor(timestamp));
  }
}

function eventIds(): string[] {
  return (sqlite.prepare("SELECT id FROM mint_burn_events ORDER BY id").all() as Array<{ id: string }>)
    .map((row) => row.id);
}

describe("mint/burn retention", () => {
  beforeEach(() => { ({ sqlite, db } = setupDb()); });
  afterEach(() => sqlite.close());

  it("matches a per-event oracle across protections without per-event sibling scans", async () => {
    const now = NOW_SEC + 123;
    const cutoff = now - MINT_BURN_EVENT_RETENTION_SEC;
    const hourlyCutoff = now - MINT_BURN_HOURLY_RETENTION_SEC;
    const kinds = ["clean", "dirty", "unpriced", "pending_aggregate", "frontier", "pending", "missing",
      "proof", "classification", "expired", "excluded", "stale", "cursor", "boundary", "recovered", "irreducible", "straddle"];
    const rows = kinds.flatMap((kind, i) => {
      const timestamp = kind === "expired" ? hourFor(hourlyCutoff) - HOUR_SEC
        : kind === "straddle" ? cutoff - 3 : kind === "cursor" ? cutoff - 1 : kind === "boundary" ? cutoff : hourFor(cutoff) - (i + 2) * HOUR_SEC;
      const coin = kind === "frontier" ? "usdc-circle" : kind === "pending" ? "dai-makerdao" : `coin-${i % 2}`;
      const chain = ["frontier", "pending"].includes(kind) || i % 2 ? "ethereum" : "arbitrum";
      return Array.from({ length: kind === "proof" ? 400 : 2 }, (_, j) =>
        ({ id: `${kind}-${j}`, kind, primary: j === 0, coin, chain, timestamp: timestamp + (kind === "straddle" ? j * 4 : j) }));
    });
    sqlite.prepare("UPDATE cache SET value = ? WHERE key = ?").run(String(cutoff - 2), TAPE_CURSOR_KEY);
    sqlite.exec(`INSERT INTO mint_burn_supply_proofs
      (proof_id, config_key, config_fingerprint, from_block, to_block, status, evidence_json, checked_at)
      VALUES ('unresolved', 'test', 'test', 1, 1, 'proven', '{}', 1)`);
    for (const row of rows) {
      const { id, kind, primary, coin, chain, timestamp } = row;
      const unpriced = (primary && ["unpriced", "recovered", "irreducible"].includes(kind)) || (kind === "straddle" && !primary);
      insertEvent(id, timestamp, { withHourly: false, amountUsd: unpriced ? null : 1,
        priceRepairStatus: primary && ["pending_aggregate", "recovered", "irreducible"].includes(kind) ? kind : null });
      sqlite.prepare("UPDATE mint_burn_events SET stablecoin_id = ?, chain_id = ?, below_display_threshold = 1 WHERE id = ?")
        .run(coin, chain, id);
      if (kind !== "missing") sqlite.prepare("INSERT OR IGNORE INTO mint_burn_hourly (stablecoin_id, chain_id, hour_ts) VALUES (?, ?, ?)")
        .run(coin, chain, hourFor(timestamp));
      if (!primary) continue;
      if (kind === "dirty") sqlite.prepare("INSERT INTO mint_burn_dirty_hours VALUES (?, ?, ?)").run(coin, chain, hourFor(timestamp));
      if (kind === "frontier") sqlite.prepare("UPDATE mint_burn_events SET block_number = 101 WHERE id = ?").run(id);
      if (["proof", "expired", "excluded"].includes(kind)) sqlite.prepare("UPDATE mint_burn_events SET supply_proof_id = 'unresolved', flow_type = ? WHERE id = ?")
        .run(kind === "excluded" ? "bridge_transfer" : "standard", id);
      if (kind === "classification") sqlite.prepare("UPDATE mint_burn_events SET burn_type = 'review_required' WHERE id = ?").run(id);
      if (kind === "stale") sqlite.prepare(`INSERT INTO tape_events
        (event_id, type, severity, ts, title, summary, payload_json, source_table, source_row_id, transition, created_at)
        VALUES ('stale', 'mint_burn.large_mint', 'warning', 1, 't', 's', '{}', 'mint_burn_events', ?, 'updated', 1)`).run(id);
    }
    const expected = rows.filter((row) => row.timestamp < cutoff && row.timestamp <= cutoff - 2
      && !(row.primary && row.kind === "stale") && row.kind !== "missing"
      && !rows.some((sibling) => sibling.coin === row.coin && sibling.chain === row.chain
        && hourFor(sibling.timestamp) === hourFor(row.timestamp)
        && ((sibling.kind === "straddle" && !sibling.primary) || (sibling.primary
          && (["dirty", "unpriced", "pending_aggregate", "frontier", "pending"].includes(sibling.kind)
            || (hourFor(row.timestamp) >= hourlyCutoff && ["proof", "classification"].includes(sibling.kind)))))))
      .map(({ id }) => id).sort();
    const sql: string[] = [];
    const observed = new Proxy(db, { get(target, key) {
      if (key !== "prepare") return Reflect.get(target, key);
      return (query: string) => { sql.push(query); return target.prepare(query); };
    } });
    const pending = MINT_BURN_CONFIGS.find((c) => c.stablecoinId === "dai-makerdao")!;
    const result = await pruneMintBurnRetention(observed, now, undefined,
      { repairRunLimit: 0, pendingAdmissionKeys: new Set([mintBurnConfigKey(pending)]) });
    expect(result.error).toBeNull();
    expect(rows.map(({ id }) => id).filter((id) => !eventIds().includes(id)).sort()).toEqual(expected);
    const queries = sql.filter((query) => query.includes("hour_status AS MATERIALIZED"));
    expect(queries).toHaveLength(3);
    for (const query of queries) {
      const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(cutoff, TAPE_CURSOR_KEY, hourlyCutoff, 1);
      const details = plan.map((step) => String(step.detail));
      expect(details).toContain("MATERIALIZE hour_status");
      expect(details.filter((detail) => detail.includes("idx_mbe_coin_chain_ts"))).toHaveLength(2);
      expect(details.some((detail) => /SEARCH event .*timestamp>\? AND timestamp<\?/.test(detail))).toBe(true);
      expect(details.some((detail) => /(?:SCAN|SEARCH) sibling/.test(detail))).toBe(false);
    }
  });

  it("honors cutoff boundaries and protects unpriced, unaggregated, and fresh event rows", async () => {
    const eventCutoff = NOW_SEC - MINT_BURN_EVENT_RETENTION_SEC;
    const hourlyCutoff = NOW_SEC - MINT_BURN_HOURLY_RETENTION_SEC;
    const noHourlyTimestamp = eventCutoff - 3 * HOUR_SEC;

    insertEvent("eligible-priced", eventCutoff - HOUR_SEC - 1);
    insertEvent("eligible-irreducible", eventCutoff - HOUR_SEC - 2, { amountUsd: null, priceRepairStatus: "irreducible" });
    insertEvent("protected-unpriced", eventCutoff - 3, { amountUsd: null });
    insertEvent("protected-pending-aggregate", eventCutoff - 4, { amountUsd: 123.45, priceRepairStatus: "pending_aggregate" });
    insertEvent("protected-no-hourly", noHourlyTimestamp, { amountUsd: null, withHourly: false });
    insertEvent("boundary", eventCutoff);
    insertEvent("fresh", eventCutoff + 1);

    sqlite
      .prepare(
        `INSERT INTO mint_burn_hourly
          (stablecoin_id, chain_id, hour_ts)
         VALUES ('old-hourly', 'ethereum', ?), ('boundary-hourly', 'ethereum', ?)`,
      )
      .run(hourlyCutoff - HOUR_SEC, hourlyCutoff);

    const result = await pruneMintBurnRetention(db, NOW_SEC);

    expect(eventIds()).toEqual([
      "boundary",
      "fresh",
      "protected-no-hourly",
      "protected-pending-aggregate",
      "protected-unpriced",
    ]);
    expect(result.eventRows).toMatchObject({
      cutoff: eventCutoff,
      deletedRows: 2,
      oldestRemainingAt: noHourlyTimestamp,
      oldestEligibleAt: null,
      cappedAtLimit: false,
      error: null,
    });
    expect(result.aggregationRepair).toMatchObject({
      cutoff: eventCutoff,
      repairedRows: 0,
      oldestRepairableAt: null,
      cappedAtLimit: false,
      error: null,
    });
    expect(result.hourlyRows).toMatchObject({
      cutoff: hourlyCutoff,
      deletedRows: 1,
      oldestRemainingAt: hourlyCutoff,
      oldestEligibleAt: null,
      cappedAtLimit: false,
      error: null,
    });
    expect(result.error).toBeNull();
    expect(MINT_BURN_EVENT_RETENTION_SEC).toBeGreaterThan(7 * 24 * HOUR_SEC);
  });

  it("protects every priced sibling of dirty and unresolved hours while pruning proven rows normally", async () => {
    const hour = hourFor(NOW_SEC - MINT_BURN_EVENT_RETENTION_SEC - 2 * HOUR_SEC);
    insertEvent("dirty-first", hour + 1);
    insertEvent("dirty-sibling", hour + 2);
    insertEvent("clean-next-hour", hour + HOUR_SEC + 1);
    sqlite.prepare(`INSERT INTO mint_burn_dirty_hours VALUES ('usdc-circle', 'ethereum', ?)`).run(hour);
    const protectedRun = await pruneMintBurnRetention(db, NOW_SEC);
    expect(eventIds()).toEqual(["dirty-first", "dirty-sibling"]);
    expect(protectedRun.eventRows.deletedRows).toBe(1);
    expect(protectedRun.aggregationRepair.repairedRows).toBe(0);
    await rebuildMintBurnMaterializationHours(db, new Map([
      ["dirty", { stablecoinId: "usdc-circle", chainId: "ethereum", hourTs: hour }],
    ]));
    expect(sqlite.prepare("SELECT mint_count, mint_volume_usd FROM mint_burn_hourly WHERE hour_ts = ?").get(hour))
      .toEqual({ mint_count: 2, mint_volume_usd: 2 });
    expect((await pruneMintBurnRetention(db, NOW_SEC)).eventRows.deletedRows).toBe(2);
    expect(eventIds()).toEqual([]);
    sqlite.exec("DELETE FROM mint_burn_hourly");
    const unresolvedStartHour = hour - 4 * HOUR_SEC;

    for (const [index, direction, burnType] of [
      [0, "burn", "review_required"], [1, "burn", null], [2, "burn", "unrecognized"], [3, "mint", "review_required"],
    ] as const) {
      const unresolvedHour = unresolvedStartHour + index * HOUR_SEC;
      insertEvent(`unresolved-${index}`, unresolvedHour + 1, { withHourly: false });
      insertEvent(`priced-sibling-${index}`, unresolvedHour + 2, { withHourly: false });
      sqlite.prepare("UPDATE mint_burn_events SET direction = ?, burn_type = ? WHERE id = ?")
        .run(direction, burnType, `unresolved-${index}`);
    }
    const retained = await pruneMintBurnRetention(db, NOW_SEC);
    expect(retained.error).toBeNull();
    expect(retained.aggregationRepair.repairedRows).toBe(4);
    expect(retained.eventRows.deletedRows).toBe(0);
    expect(sqlite.prepare(`SELECT mint_unresolved_event_count AS mints, burn_unresolved_event_count AS burns
      FROM mint_burn_hourly ORDER BY hour_ts`).all()).toEqual([
      { mints: 0, burns: 1 }, { mints: 0, burns: 1 }, { mints: 0, burns: 1 }, { mints: 1, burns: 0 },
    ]);
    for (let index = 0; index < 4; index++) {
      sqlite.prepare("INSERT INTO mint_burn_dirty_hours VALUES ('usdc-circle', 'ethereum', ?)")
        .run(unresolvedStartHour + index * HOUR_SEC);
    }
    await drainMintBurnMaterializationDebt(db);
    expect((await pruneMintBurnRetention(db, NOW_SEC)).eventRows.deletedRows).toBe(0);
    expect(sqlite.prepare("SELECT SUM(mint_unresolved_event_count + burn_unresolved_event_count) AS unresolved FROM mint_burn_hourly").get())
      .toEqual({ unresolved: 4 });
    const expired = await pruneMintBurnRetention(db, NOW_SEC + MINT_BURN_HOURLY_RETENTION_SEC);
    expect(expired.error).toBeNull();
    expect(expired.eventRows.deletedRows).toBe(8);
    expect(expired.hourlyRows.deletedRows).toBe(4);
    expect(eventIds()).toEqual([]);

    for (const [index, lifecycle] of ["pending", "accepted", "invalidated"].entries()) {
      const proofHour = hour - index * HOUR_SEC;
      const proofId = `proof-${lifecycle}`;
      sqlite.prepare(`INSERT INTO mint_burn_supply_proofs
        (proof_id, config_key, config_fingerprint, from_block, to_block, status, evidence_json, checked_at, lifecycle)
        VALUES (?, 'proof-config', 'old', 1, 1, 'proven', '{}', ?, ?)`)
        .run(proofId, proofHour, lifecycle);
      insertEvent(proofId, proofHour + 1, { withHourly: false });
      insertEvent(`proof-sibling-${index}`, proofHour + 2, { withHourly: false });
      sqlite.prepare("UPDATE mint_burn_events SET supply_proof_id = ?, flow_type = ? WHERE id = ?")
        .run(proofId, lifecycle === "accepted" ? "bridge_transfer" : "standard", proofId);
    }
    const proofProtected = await pruneMintBurnRetention(db, NOW_SEC);
    expect(proofProtected.error).toBeNull();
    expect(proofProtected.aggregationRepair.repairedRows).toBe(3);
    expect(proofProtected.eventRows.deletedRows).toBe(2);
    expect(proofProtected.proofRows.deletedRows).toBe(1);
    expect(eventIds()).toHaveLength(4);
    const proofExpired = await pruneMintBurnRetention(db, NOW_SEC + MINT_BURN_HOURLY_RETENTION_SEC);
    expect(proofExpired.error).toBeNull();
    expect(proofExpired.eventRows.deletedRows).toBe(4);
    expect(proofExpired.proofRows.deletedRows).toBe(2);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM mint_burn_supply_proofs").get()).toEqual({ n: 0 });
  });

  it.each([
    ["drain", 1], ["drain", 2], ["historical", 1], ["historical", 2],
  ] as const)("preserves settled history when stale %s resumes after retention deletes %i siblings", async (caller, deleted) => {
    const hour = hourFor(NOW_SEC - MINT_BURN_EVENT_RETENTION_SEC - 2 * HOUR_SEC);
    insertEvent("race-first", hour + 1, { amountUsd: 10, priceRepairStatus: "pending_aggregate" });
    insertEvent("race-sibling", hour + 2, { amountUsd: 20 });
    sqlite.prepare("INSERT INTO mint_burn_dirty_hours VALUES ('usdc-circle', 'ethereum', ?)").run(hour);
    const staleDb = createSqliteD1(sqlite);
    const batch = staleDb.batch.bind(staleDb);
    let interleaved = false;
    staleDb.batch = async <T = unknown>(statements: D1PreparedStatement[]) => {
      if (!interleaved) {
        interleaved = true;
        // Both callers selected the same key. The first settles it and releases
        // raw retention before the stale caller submits its rebuild transaction.
        expect(await drainMintBurnMaterializationDebt(db)).toBe(1);
        const retention = await pruneMintBurnRetention(db, NOW_SEC, undefined, {
          eventBatchLimit: deleted, eventRunLimit: deleted,
        });
        expect(retention.error).toBeNull();
        expect(retention.eventRows.deletedRows).toBe(deleted);
      }
      return batch<T>(statements);
    };
    if (caller === "historical") {
      const result = await repairHistoricalMintBurnPrices(staleDb, {
        dryRun: false, operatorRunId: "stale-repair", timeTravelBookmark: "stale-bookmark",
        nowSec: NOW_SEC,
      });
      expect(result.aggregateCoinsRebuilt).toEqual([]);
      expect(result.aggregateVerificationPassed).toBe(true);
    } else {
      await drainMintBurnMaterializationDebt(staleDb);
    }
    expect(interleaved).toBe(true);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_events").get()).toEqual({ count: 2 - deleted });
    expect(sqlite.prepare("SELECT mint_count, mint_volume_usd FROM mint_burn_hourly WHERE hour_ts = ?").get(hour))
      .toEqual({ mint_count: 2, mint_volume_usd: 30 });
    expect(sqlite.prepare("SELECT * FROM mint_burn_dirty_hours").all()).toEqual([]);
  });

  it("does not mistake dirty-hour raw rows for missing aggregation evidence", async () => {
    const hour = hourFor(NOW_SEC - MINT_BURN_EVENT_RETENTION_SEC - 2 * HOUR_SEC);
    insertEvent("dirty-no-bucket", hour + 1, { withHourly: false });
    sqlite.prepare(`INSERT INTO mint_burn_dirty_hours VALUES ('usdc-circle', 'ethereum', ?)`).run(hour);
    const result = await pruneMintBurnRetention(db, NOW_SEC);
    expect(result.aggregationRepair).toMatchObject({ repairedRows: 0, oldestRepairableAt: null, error: null });
    expect(result.eventRows.deletedRows).toBe(0);
    expect(eventIds()).toEqual(["dirty-no-bucket"]);
    expect(sqlite.prepare("SELECT * FROM mint_burn_hourly").all()).toEqual([]);
  });

  it("seeds retained legacy repairs idempotently and drains only a bounded set before retention", async () => {
    const hour = hourFor(NOW_SEC - MINT_BURN_EVENT_RETENTION_SEC - 4 * HOUR_SEC);
    for (let index = 0; index < 3; index++) {
      insertEvent(`legacy-${index}`, hour + index * HOUR_SEC + 1, { amountUsd: 10, priceRepairStatus: "pending_aggregate" });
      insertEvent(`sibling-${index}`, hour + index * HOUR_SEC + 2, { amountUsd: 5 });
    }
    await seedMintBurnLegacyMaterializationDebt(db, { limit: 2 });
    await seedMintBurnLegacyMaterializationDebt(db, { limit: 2 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_dirty_hours").get()).toEqual({ count: 3 });
    expect((await pruneMintBurnRetention(db, NOW_SEC)).eventRows.deletedRows).toBe(0);
    expect(await drainMintBurnMaterializationDebt(db, { limit: 1 })).toBe(1);
    expect(sqlite.prepare("SELECT mint_count, mint_volume_usd FROM mint_burn_hourly WHERE hour_ts = ?").get(hour))
      .toEqual({ mint_count: 2, mint_volume_usd: 15 });
    expect(sqlite.prepare("SELECT mint_unresolved_event_count, burn_unresolved_event_count FROM mint_burn_hourly WHERE hour_ts = ?").get(hour))
      .toEqual({ mint_unresolved_event_count: null, burn_unresolved_event_count: null });
    expect((await pruneMintBurnRetention(db, NOW_SEC)).eventRows.deletedRows).toBe(2);
    expect(eventIds()).toEqual(["legacy-1", "legacy-2", "sibling-1", "sibling-2"]);
    expect(await drainMintBurnMaterializationDebt(db, { limit: 1 })).toBe(1);
    expect(await drainMintBurnMaterializationDebt(db, { limit: 1 })).toBe(1);
    expect(await drainMintBurnMaterializationDebt(db, { limit: 1 })).toBe(0);
    expect((await pruneMintBurnRetention(db, NOW_SEC)).eventRows.deletedRows).toBe(4);
    expect(eventIds()).toEqual([]);
  });

  it("never deletes an event ahead of the persisted tape watermark", async () => {
    const cutoff = NOW_SEC - MINT_BURN_EVENT_RETENTION_SEC;
    sqlite
      .prepare("UPDATE cache SET value = ? WHERE key = ?")
      .run(String(cutoff - 2), TAPE_CURSOR_KEY);
    insertEvent("projected", cutoff - 3);
    insertEvent("not-projected", cutoff - 1);

    const result = await pruneMintBurnRetention(db, NOW_SEC);

    expect(eventIds()).toEqual(["not-projected"]);
    expect(result.eventRows.deletedRows).toBe(1);
    expect(result.eventRows.oldestEligibleAt).toBeNull();
  });

  it("keeps a corrected source until its unsuppressed Tape claim is republished or retracted", async () => {
    const cutoff = NOW_SEC - MINT_BURN_EVENT_RETENTION_SEC;
    insertEvent("corrected", cutoff - HOUR_SEC - 1, { amountUsd: 30_000_000 });
    insertEvent("reconciled", cutoff - HOUR_SEC - 2, { amountUsd: 30_000_000 });
    const claim = (id: string, amountUsd: number) => sqlite.prepare(
      `INSERT INTO tape_events (event_id, type, severity, ts, title, summary, payload_json, source_table,
         source_row_id, transition, created_at)
       VALUES (?, 'mint_burn.large_mint', 'warning', 1, 't', 's', ?, 'mint_burn_events', ?, 'updated', 1)`,
    ).run(`e-${id}`, JSON.stringify({ amountUsd, flowType: "standard", burnType: null }), id);
    claim("corrected", 20_000_000);
    claim("reconciled", 30_000_000);

    await pruneMintBurnRetention(db, NOW_SEC);
    expect(eventIds()).toEqual(["corrected"]);

    sqlite.prepare("UPDATE tape_events SET suppressed_at = 1 WHERE source_row_id = 'corrected'").run();
    await pruneMintBurnRetention(db, NOW_SEC);
    expect(eventIds()).toEqual([]);
  });

  it("protects all event rows when the tape watermark is absent", async () => {
    const cutoff = NOW_SEC - MINT_BURN_EVENT_RETENTION_SEC;
    sqlite.prepare("DELETE FROM cache WHERE key = ?").run(TAPE_CURSOR_KEY);
    insertEvent("awaiting-projector-bootstrap", cutoff - 1);

    const result = await pruneMintBurnRetention(db, NOW_SEC);

    expect(eventIds()).toEqual(["awaiting-projector-bootstrap"]);
    expect(result.eventRows.deletedRows).toBe(0);
    expect(result.eventRows.oldestEligibleAt).toBeNull();
  });

  it("continues in bounded batches and reports a remaining eligible backlog", async () => {
    const cutoff = NOW_SEC - MINT_BURN_EVENT_RETENTION_SEC;
    for (let index = 0; index < 5; index += 1) {
      insertEvent(`eligible-${index}`, cutoff - 100 + index);
    }

    const proofInsert = sqlite.prepare(`INSERT INTO mint_burn_supply_proofs
      (proof_id, config_key, config_fingerprint, from_block, to_block, status, evidence_json, checked_at)
      VALUES (?, 'cap', 'law', 1, 1, 'proven', ?, ?)`);
    for (let index = 0; index < 5; index++) proofInsert.run(`proof-${index}`,
      JSON.stringify({ closingTimestamp: cutoff - 100 + index }), NOW_SEC);
    const first = await pruneMintBurnRetention(db, NOW_SEC, undefined, {
      eventBatchLimit: 2,
      eventRunLimit: 3, proofBatchLimit: 2, proofRunLimit: 3,
      hourlyBatchLimit: 2,
      hourlyRunLimit: 2,
    });
    expect(first.eventRows.deletedRows).toBe(3);
    expect(first.proofRows).toMatchObject({ deletedRows: 3, cappedAtLimit: true });
    expect(first.eventRows.cappedAtLimit).toBe(true);
    expect(first.eventRows.oldestEligibleAt).not.toBeNull();
    expect(eventIds()).toHaveLength(2);

    const second = await pruneMintBurnRetention(db, NOW_SEC, undefined, {
      eventBatchLimit: 2,
      eventRunLimit: 3, proofBatchLimit: 2, proofRunLimit: 3,
      hourlyBatchLimit: 2,
      hourlyRunLimit: 2,
    });
    expect(second.eventRows.deletedRows).toBe(2);
    expect(second.proofRows).toMatchObject({ deletedRows: 2, cappedAtLimit: false });
    expect(second.eventRows.cappedAtLimit).toBe(false);
    expect(second.eventRows.oldestEligibleAt).toBeNull();
    expect(eventIds()).toEqual([]);
  });

  it("keeps old hourly evidence until a capped raw-event backlog drains", async () => {
    const oldTimestamp = NOW_SEC - MINT_BURN_HOURLY_RETENTION_SEC - HOUR_SEC;
    const oldHour = hourFor(oldTimestamp);
    for (let index = 0; index < 5; index += 1) {
      insertEvent(`old-eligible-${index}`, oldTimestamp + index);
    }

    const first = await pruneMintBurnRetention(db, NOW_SEC, undefined, {
      eventBatchLimit: 2,
      eventRunLimit: 3,
      hourlyBatchLimit: 2,
      hourlyRunLimit: 2,
    });

    expect(first.eventRows.deletedRows).toBe(3);
    expect(first.eventRows.cappedAtLimit).toBe(true);
    expect(first.hourlyRows.deletedRows).toBe(0);
    expect(first.hourlyRows.oldestEligibleAt).toBeNull();
    expect(eventIds()).toHaveLength(2);
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM mint_burn_hourly WHERE hour_ts = ?")
        .get(oldHour),
    ).toEqual({ count: 1 });

    const second = await pruneMintBurnRetention(db, NOW_SEC, undefined, {
      eventBatchLimit: 2,
      eventRunLimit: 3,
      hourlyBatchLimit: 2,
      hourlyRunLimit: 2,
    });

    expect(second.eventRows.deletedRows).toBe(2);
    expect(second.eventRows.cappedAtLimit).toBe(false);
    expect(second.hourlyRows.deletedRows).toBe(1);
    expect(second.hourlyRows.oldestEligibleAt).toBeNull();
    expect(eventIds()).toEqual([]);
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM mint_burn_hourly WHERE hour_ts = ?")
        .get(oldHour),
    ).toEqual({ count: 0 });
  });

  it("rebuilds missing terminal hourly evidence before pruning raw rows", async () => {
    const oldTimestamp = NOW_SEC - MINT_BURN_HOURLY_RETENTION_SEC - HOUR_SEC;
    insertEvent("stranded-terminal", oldTimestamp, { withHourly: false });

    const result = await pruneMintBurnRetention(db, NOW_SEC, undefined, {
      repairCandidateEventLimit: 2,
      repairRunLimit: 1,
      eventBatchLimit: 2,
      eventRunLimit: 2,
      hourlyBatchLimit: 2,
      hourlyRunLimit: 2,
    });

    expect(result.aggregationRepair).toMatchObject({
      repairedRows: 1,
      oldestRepairableAt: null,
      cappedAtLimit: false,
      error: null,
    });
    expect(result.eventRows.deletedRows).toBe(1);
    expect(result.hourlyRows.deletedRows).toBe(1);
    expect(eventIds()).toEqual([]);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_hourly").get()).toEqual({
      count: 0,
    });
  });

  it("does not rebuild or prune a missing hour with unresolved price debt", async () => {
    const oldTimestamp = NOW_SEC - MINT_BURN_HOURLY_RETENTION_SEC - HOUR_SEC;
    insertEvent("terminal-sibling", oldTimestamp, { withHourly: false });
    insertEvent("unresolved-sibling", oldTimestamp + 1, { amountUsd: null, withHourly: false });

    const result = await pruneMintBurnRetention(db, NOW_SEC);

    expect(result.aggregationRepair).toMatchObject({
      repairedRows: 0,
      oldestRepairableAt: null,
      cappedAtLimit: false,
      error: null,
    });
    expect(result.eventRows.deletedRows).toBe(0);
    expect(result.hourlyRows.deletedRows).toBe(0);
    expect(eventIds()).toEqual(["terminal-sibling", "unresolved-sibling"]);
  });

  it("retains priced siblings until historical repair rebuilds their complete existing hour", async () => {
    const timestamp = hourFor(NOW_SEC - MINT_BURN_EVENT_RETENTION_SEC - HOUR_SEC) + 10;
    insertEvent("priced-sibling", timestamp, { amountUsd: 100 });
    insertEvent("repair-sibling", timestamp + 1, { amountUsd: null });
    sqlite.prepare("UPDATE mint_burn_events SET amount = 20 WHERE id = 'repair-sibling'").run();
    const affected = new Map([["hour", { stablecoinId: "usdc-circle", chainId: "ethereum", hourTs: hourFor(timestamp) }]]);
    await recalcAffectedHours(db, affected);

    const retained = await pruneMintBurnRetention(db, NOW_SEC);
    expect(retained.eventRows.deletedRows).toBe(0);
    expect(eventIds()).toEqual(["priced-sibling", "repair-sibling"]);
    const repair = await repairHistoricalMintBurnPrices(db, {
      dryRun: false,
      operatorRunId: "retention-repair",
      timeTravelBookmark: "before-retention-repair",
      nowSec: NOW_SEC,
      sourceLoader: {
        loadCoinGecko: async () => ({ source: "cg", status: "available", points: [{ price: 1, timestamp }] }),
        loadDefiLlama: async ({ source }) => ({ source, status: "empty", points: [] }),
      },
    });
    expect(repair.aggregateVerificationPassed).toBe(true);
    expect(sqlite.prepare("SELECT mint_count, mint_volume_usd, mint_unpriced_event_count FROM mint_burn_hourly").get())
      .toEqual({ mint_count: 2, mint_volume_usd: 120, mint_unpriced_event_count: 0 });
    expect((await pruneMintBurnRetention(db, NOW_SEC)).eventRows.deletedRows).toBe(2);
  });

  it("protects all same-hour inputs while a matching config frontier is held", async () => {
    const timestamp = hourFor(NOW_SEC - MINT_BURN_EVENT_RETENTION_SEC - HOUR_SEC) + 10;
    insertEvent("committed", timestamp, { amountUsd: 100 });
    insertEvent("uncommitted", timestamp + 1, { amountUsd: 20 });
    sqlite.prepare("UPDATE mint_burn_events SET block_number = 101 WHERE id = 'uncommitted'").run();
    const retained = await pruneMintBurnRetention(db, NOW_SEC);
    expect(retained.eventRows.deletedRows).toBe(0);
    expect(eventIds()).toEqual(["committed", "uncommitted"]);
    const usdcConfigs = MINT_BURN_CONFIGS.filter((config) =>
      config.stablecoinId === "usdc-circle" && config.chain.chainId === "ethereum" && config.enabled !== false,
    );
    expect(retained.frontierProtection).toEqual({
      configs: usdcConfigs.map((config) => ({
        configKey: mintBurnConfigKey(config),
        stablecoinId: "usdc-circle",
        chainId: "ethereum",
        lastBlock: 100,
        highestProtectedBlock: 101,
        lagBlocks: 1,
        oldestProtectedHour: hourFor(timestamp),
        oldestProtectedAgeSeconds: NOW_SEC - hourFor(timestamp),
      })).sort((a, b) => a.configKey.localeCompare(b.configKey)),
      error: null,
    });
    sqlite.prepare("UPDATE mint_burn_sync_state SET last_block = 101").run();
    const affected = new Map([["hour", { stablecoinId: "usdc-circle", chainId: "ethereum", hourTs: hourFor(timestamp) }]]);
    await recalcAffectedHours(db, affected);
    const converged = await pruneMintBurnRetention(db, NOW_SEC);
    expect(converged.eventRows.deletedRows).toBe(2);
    expect(converged.frontierProtection).toEqual({ configs: [], error: null });
    expect(sqlite.prepare("SELECT mint_count, mint_volume_usd FROM mint_burn_hourly").get())
      .toEqual({ mint_count: 2, mint_volume_usd: 120 });
  });

  it("preserves an old pending backfill hour across mid-hour commits, retention, and continuation", async () => {
    const config = makeMintBurnConfig({ asset: { stablecoinId: "usdc-circle", startBlock: 1 } });
    const key = mintBurnConfigKey(config);
    const hour = hourFor(NOW_SEC - 90 * 24 * HOUR_SEC);
    const affected = new Map([["hour", { stablecoinId: "usdc-circle", chainId: "ethereum", hourTs: hour }]]);
    const options = { enabledConfigs: [config], pendingAdmissionKeys: new Set([key]) };
    const proof = { configKey: key, configFingerprint: mintBurnScanFingerprint(config), chainId: "ethereum",
      fromBlock: 1, toBlock: 100, fromTimestamp: hour, toTimestamp: hour + 1800,
      finalizedBlock: 200, acceptedAt: NOW_SEC };

    insertEvent("first-prefix", hour + 10, { amountUsd: 10, withHourly: false });
    sqlite.prepare("UPDATE mint_burn_events SET block_number = 100 WHERE id = 'first-prefix'").run();
    await recalcAffectedHours(db, affected);
    await upsertMintBurnSyncState(db, key, 100, "monotonic-max", proof);
    const firstPrune = await pruneMintBurnRetention(db, NOW_SEC, undefined, options);
    expect(firstPrune.error).toBeNull();
    expect(firstPrune.eventRows.deletedRows).toBe(0);
    expect(eventIds()).toEqual(["first-prefix"]);

    insertEvent("second-prefix", hour + 1803, { amountUsd: 20, withHourly: false });
    sqlite.prepare("UPDATE mint_burn_events SET block_number = 101 WHERE id = 'second-prefix'").run();
    await recalcAffectedHours(db, affected);
    await upsertMintBurnSyncState(db, key, 200, "monotonic-max", {
      ...proof, fromBlock: 101, toBlock: 200, fromTimestamp: hour + 1803, toTimestamp: hour + HOUR_SEC,
    });
    expect(mintBurnScanCoverageAdmits([config], await readMintBurnScanCoverage(db, [config], hour, hour + HOUR_SEC),
      hour, hour + HOUR_SEC)).toBe(true);
    expect((await pruneMintBurnRetention(db, NOW_SEC, undefined, options)).eventRows.deletedRows).toBe(2);
    expect(eventIds()).toEqual([]);
    expect(sqlite.prepare("SELECT mint_count, mint_volume_usd FROM mint_burn_hourly WHERE hour_ts = ?").get(hour))
      .toEqual({ mint_count: 2, mint_volume_usd: 30 });
  });

  it.each(["config-disabled", "operator-disabled"])("protects pending raw rows and skips retention repair when %s", async (disabled) => {
    const config = disabled === "config-disabled"
      ? makeMintBurnConfig({ asset: { stablecoinId: "usdc-circle", startBlock: 1, enabled: false } })
      : MINT_BURN_CONFIGS.find((item) => item.stablecoinId === "usdc-circle" && item.chain.chainId === "ethereum")!;
    const hour = hourFor(NOW_SEC - 90 * 24 * HOUR_SEC);
    insertEvent("pending-unmaterialized", hour + 10, { withHourly: false });
    insertEvent("pending-materialized", hour + HOUR_SEC + 10);
    const result = await pruneMintBurnRetention(db, NOW_SEC, undefined, {
      enabledConfigs: disabled === "config-disabled" ? [config] : [],
      pendingAdmissionKeys: new Set([mintBurnConfigKey(config)]),
    });
    expect(result.error).toBeNull();
    expect(result.aggregationRepair).toMatchObject({ repairedRows: 0, oldestRepairableAt: null });
    expect(result.eventRows).toMatchObject({ deletedRows: 0, oldestEligibleAt: null });
    expect(eventIds()).toEqual(["pending-materialized", "pending-unmaterialized"]);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_hourly WHERE hour_ts = ?").get(hour)).toEqual({ count: 0 });
  });

  it.each(["enabled", "config-disabled", "operator-disabled"])("prunes proven closed pending hours while protecting the frontier and later rows (%s)", async (mode) => {
    const config = mode === "operator-disabled"
      ? MINT_BURN_CONFIGS.find((item) => item.stablecoinId === "usdc-circle" && item.chain.chainId === "ethereum")!
      : makeMintBurnConfig({ asset: { stablecoinId: "usdc-circle", startBlock: 1, enabled: mode !== "config-disabled" } });
    const key = mintBurnConfigKey(config);
    const hour = hourFor(NOW_SEC - 90 * 24 * HOUR_SEC);
    insertEvent("closed-materialized", hour + 10);
    insertEvent("closed-needs-repair", hour + HOUR_SEC + 10, { withHourly: false });
    insertEvent("frontier", hour + 2 * HOUR_SEC + 10, { withHourly: false });
    insertEvent("later", hour + 3 * HOUR_SEC + 10, { withHourly: false });
    sqlite.prepare("UPDATE mint_burn_events SET block_number = ?").run(config.startBlock + 1);
    sqlite.prepare("UPDATE mint_burn_events SET block_number = ? WHERE id = 'frontier'").run(config.startBlock + 99);
    sqlite.prepare("UPDATE mint_burn_events SET block_number = ? WHERE id = 'later'").run(config.startBlock + 101);
    await upsertMintBurnSyncState(db, key, config.startBlock + 100, "monotonic-max", {
      configKey: key, configFingerprint: mintBurnScanFingerprint(config), chainId: config.chain.chainId,
      fromBlock: config.startBlock, toBlock: config.startBlock + 100, fromTimestamp: hour,
      toTimestamp: hour + 2 * HOUR_SEC + 1800, finalizedBlock: config.startBlock + 1000, acceptedAt: NOW_SEC,
    });

    const result = await pruneMintBurnRetention(db, NOW_SEC, undefined, {
      enabledConfigs: mode === "operator-disabled" ? [] : [config], pendingAdmissionKeys: new Set([key]),
    });
    expect(result.error).toBeNull();
    expect(result.aggregationRepair.repairedRows).toBe(1);
    expect(result.eventRows.deletedRows).toBe(2);
    expect(eventIds()).toEqual(["frontier", "later"]);
    expect(sqlite.prepare("SELECT hour_ts FROM mint_burn_hourly ORDER BY hour_ts").all())
      .toEqual([{ hour_ts: hour }, { hour_ts: hour + HOUR_SEC }]);
  });

  it.each(["missing", "old-fingerprint", "cursor-mismatch", "disjoint-tail"])("retains pending raw history when frontier proof is %s", async (kind) => {
    const config = makeMintBurnConfig({ asset: { stablecoinId: "usdc-circle", startBlock: 1 } });
    const key = mintBurnConfigKey(config);
    const hour = hourFor(NOW_SEC - 90 * 24 * HOUR_SEC);
    insertEvent("unproved", hour + 10, { withHourly: false });
    await upsertMintBurnSyncState(db, key, 200, "monotonic-max", kind === "missing" ? undefined : {
      configKey: key, configFingerprint: kind === "old-fingerprint" ? "old" : mintBurnScanFingerprint(config), chainId: "ethereum",
      fromBlock: kind === "disjoint-tail" ? 101 : 1, toBlock: 200,
      fromTimestamp: kind === "disjoint-tail" ? hour + HOUR_SEC : hour,
      toTimestamp: hour + 2 * HOUR_SEC, finalizedBlock: 1000, acceptedAt: NOW_SEC,
    });
    if (kind === "cursor-mismatch") await upsertMintBurnSyncState(db, key, 201, "monotonic-max");

    const result = await pruneMintBurnRetention(db, NOW_SEC, undefined, {
      enabledConfigs: [config], pendingAdmissionKeys: new Set([key]),
    });
    expect(result.error).toBeNull();
    expect(result.aggregationRepair.repairedRows).toBe(0);
    expect(result.eventRows.deletedRows).toBe(0);
    expect(eventIds()).toEqual(["unproved"]);
    expect(sqlite.prepare("SELECT * FROM mint_burn_hourly").all()).toEqual([]);
  });

  it.each([true, false])("only enabled secondary configs hold frontier protection (enabled=%s)", async (enabled) => {
    const primary = MINT_BURN_CONFIGS.find((config) =>
      config.stablecoinId === "usdc-circle" && config.chain.chainId === "ethereum" && config.enabled !== false,
    )!;
    const secondary = { ...primary, contractAddress: "0x0000000000000000000000000000000000000001", enabled };
    const timestamp = NOW_SEC - MINT_BURN_EVENT_RETENTION_SEC - HOUR_SEC;
    insertEvent("secondary-held", timestamp);
    sqlite.prepare("INSERT INTO mint_burn_sync_state (config_key, last_block) VALUES (?, 0)")
      .run(mintBurnConfigKey(secondary));

    const result = await pruneMintBurnRetention(db, NOW_SEC, undefined, { enabledConfigs: [primary, secondary] });
    expect(eventIds()).toEqual(enabled ? ["secondary-held"] : []);
    expect(result.eventRows.deletedRows).toBe(enabled ? 0 : 1);
    expect(result.frontierProtection).toEqual({
      configs: enabled ? [{
        configKey: mintBurnConfigKey(secondary),
        stablecoinId: primary.stablecoinId,
        chainId: primary.chain.chainId,
        lastBlock: 0,
        highestProtectedBlock: 1,
        lagBlocks: 1,
        oldestProtectedHour: hourFor(timestamp),
        oldestProtectedAgeSeconds: NOW_SEC - hourFor(timestamp),
      }] : [],
      error: null,
    });
  });

  it("reports missing active frontier state without inventing a block lag", async () => {
    const config = MINT_BURN_CONFIGS.find((candidate) =>
      candidate.stablecoinId === "usdc-circle" && candidate.chain.chainId === "ethereum" && candidate.enabled !== false,
    )!;
    sqlite.prepare("DELETE FROM mint_burn_sync_state WHERE config_key = ?").run(mintBurnConfigKey(config));
    insertEvent("missing-frontier", NOW_SEC - MINT_BURN_EVENT_RETENTION_SEC - HOUR_SEC);
    const result = await pruneMintBurnRetention(db, NOW_SEC, undefined, { enabledConfigs: [config] });
    expect(result.eventRows.deletedRows).toBe(0);
    expect(result.frontierProtection.configs).toEqual([expect.objectContaining({
      configKey: mintBurnConfigKey(config),
      lastBlock: null,
      highestProtectedBlock: 1,
      lagBlocks: null,
    })]);
  });

  it("ignores inactive configs and never reports fresh-only frontier debt as retention protection", async () => {
    const config = MINT_BURN_CONFIGS.find((candidate) =>
      candidate.stablecoinId === "usdc-circle" && candidate.chain.chainId === "ethereum" && candidate.enabled !== false,
    )!;
    const inactive = { ...config, stablecoinId: "inactive-retired-asset" };
    const cutoff = NOW_SEC - MINT_BURN_EVENT_RETENTION_SEC;
    insertEvent("inactive", cutoff - HOUR_SEC);
    sqlite.prepare("UPDATE mint_burn_events SET stablecoin_id = ? WHERE id = 'inactive'").run(inactive.stablecoinId);
    sqlite.prepare("UPDATE mint_burn_hourly SET stablecoin_id = ?").run(inactive.stablecoinId);
    insertEvent("fresh-only", cutoff + HOUR_SEC);
    sqlite.prepare("UPDATE mint_burn_events SET block_number = 101 WHERE id = 'fresh-only'").run();
    const result = await pruneMintBurnRetention(db, NOW_SEC, undefined, { enabledConfigs: [config, inactive] });
    expect(eventIds()).toEqual(["fresh-only"]);
    expect(result.frontierProtection).toEqual({ configs: [], error: null });
  });

  it("reports frontier diagnostic failure as unavailable without preventing cleanup", async () => {
    insertEvent("eligible", NOW_SEC - MINT_BURN_EVENT_RETENTION_SEC - HOUR_SEC);
    const failingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "prepare") return Reflect.get(target, property, receiver);
        return (sql: string) => {
          if (sql.includes("pharos:mint-burn:retention-frontier-protection")) {
            throw new Error("frontier diagnostic unavailable");
          }
          return target.prepare(sql);
        };
      },
    });
    const result = await pruneMintBurnRetention(failingDb, NOW_SEC);
    expect(result.eventRows.deletedRows).toBe(1);
    expect(result.frontierProtection).toEqual({ configs: null, error: "frontier diagnostic unavailable" });
    expect(result.error).toContain("frontierProtection: frontier diagnostic unavailable");
  });

  it("continues aggregation-evidence repair after its hourly limit is reached", async () => {
    const oldTimestamp = NOW_SEC - MINT_BURN_HOURLY_RETENTION_SEC - 4 * HOUR_SEC;
    for (let index = 0; index < 3; index += 1) {
      insertEvent(`stranded-hour-${index}`, oldTimestamp + index * HOUR_SEC, { withHourly: false });
    }

    const first = await pruneMintBurnRetention(db, NOW_SEC, undefined, {
      repairCandidateEventLimit: 3,
      repairRunLimit: 2,
      eventBatchLimit: 3,
      eventRunLimit: 3,
      hourlyBatchLimit: 3,
      hourlyRunLimit: 3,
    });

    expect(first.aggregationRepair.repairedRows).toBe(2);
    expect(first.aggregationRepair.cappedAtLimit).toBe(true);
    expect(first.aggregationRepair.oldestRepairableAt).not.toBeNull();
    expect(eventIds()).toEqual(["stranded-hour-2"]);

    const second = await pruneMintBurnRetention(db, NOW_SEC, undefined, {
      repairCandidateEventLimit: 3,
      repairRunLimit: 2,
      eventBatchLimit: 3,
      eventRunLimit: 3,
      hourlyBatchLimit: 3,
      hourlyRunLimit: 3,
    });

    expect(second.aggregationRepair.repairedRows).toBe(1);
    expect(second.aggregationRepair.cappedAtLimit).toBe(false);
    expect(second.aggregationRepair.oldestRepairableAt).toBeNull();
    expect(eventIds()).toEqual([]);
  });

  it.each(["event-retention-delete", "aggregation-evidence-repair"])("isolates %s failure", async (stage) => {
    insertEvent("eligible-after-error", NOW_SEC - MINT_BURN_EVENT_RETENTION_SEC - 1);
    const failingDb = {
      ...db,
      prepare(sql: string) {
        if (!sql.includes(`pharos:mint-burn:${stage}`)) {
          return db.prepare(sql);
        }
        const statement = {
          bind: () => statement as unknown as D1PreparedStatement,
          run: async () => {
            throw new Error("retention unavailable");
          },
        };
        return statement as unknown as D1PreparedStatement;
      },
    } as D1Database;

    const result = await pruneMintBurnRetention(failingDb, NOW_SEC);

    const failed = stage === "event-retention-delete" ? "eventRows" : "aggregationRepair";
    expect(result[failed].error).toBe("retention unavailable");
    expect(result.eventRows.deletedRows).toBe(stage === "event-retention-delete" ? 0 : 1);
    expect(result.hourlyRows.error).toBeNull();
    expect(result.error).toContain(`${failed}: retention unavailable`);
  });

  it("throws before D1 work when already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("mint/burn retention aborted"));

    await expect(
      pruneMintBurnRetention(db, NOW_SEC, controller.signal),
    ).rejects.toThrow("mint/burn retention aborted");
  });
});

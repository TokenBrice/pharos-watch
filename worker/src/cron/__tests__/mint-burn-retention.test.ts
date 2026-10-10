import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import {
  MINT_BURN_EVENT_RETENTION_SEC,
  MINT_BURN_HOURLY_RETENTION_SEC,
  pruneMintBurnRetention,
} from "../mint-burn/retention";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { MINT_BURN_CONFIGS } from "../../lib/mint-burn-contracts";
import { mintBurnConfigKey } from "../../lib/mint-burn-pipeline/sync-state";
import { recalcAffectedHours } from "../../lib/mint-burn-pipeline/persistence";
import { repairHistoricalMintBurnPrices } from "../../lib/mint-burn-historical-price-repair";

const NOW_SEC = 1_800_000_000;
const HOUR_SEC = 3600;
const TAPE_CURSOR_KEY = "tape-projector:cursor:mint_burn.large_flow";

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
  sqlite: DatabaseSync,
  input: {
    id: string;
    timestamp: number;
    amountUsd?: number | null;
    priceRepairStatus?: string | null;
    withHourly?: boolean;
  },
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
      input.id,
      input.amountUsd === undefined ? 1 : input.amountUsd,
      `0x${input.id}`,
      input.timestamp,
      input.priceRepairStatus ?? null,
    );
  if (input.withHourly !== false) {
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO mint_burn_hourly
          (stablecoin_id, chain_id, hour_ts)
         VALUES ('usdc-circle', 'ethereum', ?)`,
      )
      .run(hourFor(input.timestamp));
  }
}

function eventIds(sqlite: DatabaseSync): string[] {
  return (sqlite.prepare("SELECT id FROM mint_burn_events ORDER BY id").all() as Array<{ id: string }>)
    .map((row) => row.id);
}

describe("mint/burn retention", () => {
  let openDb: DatabaseSync | null = null;

  afterEach(() => {
    openDb?.close();
    openDb = null;
  });

  it("honors cutoff boundaries and protects unpriced, unaggregated, and fresh event rows", async () => {
    const { sqlite, db } = setupDb();
    openDb = sqlite;
    const eventCutoff = NOW_SEC - MINT_BURN_EVENT_RETENTION_SEC;
    const hourlyCutoff = NOW_SEC - MINT_BURN_HOURLY_RETENTION_SEC;
    const noHourlyTimestamp = eventCutoff - 3 * HOUR_SEC;

    insertEvent(sqlite, { id: "eligible-priced", timestamp: eventCutoff - HOUR_SEC - 1 });
    insertEvent(sqlite, {
      id: "eligible-irreducible",
      timestamp: eventCutoff - HOUR_SEC - 2,
      amountUsd: null,
      priceRepairStatus: "irreducible",
    });
    insertEvent(sqlite, {
      id: "protected-unpriced",
      timestamp: eventCutoff - 3,
      amountUsd: null,
    });
    insertEvent(sqlite, {
      id: "protected-pending-aggregate",
      timestamp: eventCutoff - 4,
      amountUsd: 123.45,
      priceRepairStatus: "pending_aggregate",
    });
    insertEvent(sqlite, {
      id: "protected-no-hourly",
      timestamp: noHourlyTimestamp,
      amountUsd: null,
      withHourly: false,
    });
    insertEvent(sqlite, { id: "boundary", timestamp: eventCutoff });
    insertEvent(sqlite, { id: "fresh", timestamp: eventCutoff + 1 });

    sqlite
      .prepare(
        `INSERT INTO mint_burn_hourly
          (stablecoin_id, chain_id, hour_ts)
         VALUES ('old-hourly', 'ethereum', ?), ('boundary-hourly', 'ethereum', ?)`,
      )
      .run(hourlyCutoff - HOUR_SEC, hourlyCutoff);

    const result = await pruneMintBurnRetention(db, NOW_SEC);

    expect(eventIds(sqlite)).toEqual([
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

  it("never deletes an event ahead of the persisted tape watermark", async () => {
    const { sqlite, db } = setupDb();
    openDb = sqlite;
    const cutoff = NOW_SEC - MINT_BURN_EVENT_RETENTION_SEC;
    sqlite
      .prepare("UPDATE cache SET value = ? WHERE key = ?")
      .run(String(cutoff - 2), TAPE_CURSOR_KEY);
    insertEvent(sqlite, { id: "projected", timestamp: cutoff - 3 });
    insertEvent(sqlite, { id: "not-projected", timestamp: cutoff - 1 });

    const result = await pruneMintBurnRetention(db, NOW_SEC);

    expect(eventIds(sqlite)).toEqual(["not-projected"]);
    expect(result.eventRows.deletedRows).toBe(1);
    expect(result.eventRows.oldestEligibleAt).toBeNull();
  });

  it("protects all event rows when the tape watermark is absent", async () => {
    const { sqlite, db } = setupDb();
    openDb = sqlite;
    const cutoff = NOW_SEC - MINT_BURN_EVENT_RETENTION_SEC;
    sqlite.prepare("DELETE FROM cache WHERE key = ?").run(TAPE_CURSOR_KEY);
    insertEvent(sqlite, { id: "awaiting-projector-bootstrap", timestamp: cutoff - 1 });

    const result = await pruneMintBurnRetention(db, NOW_SEC);

    expect(eventIds(sqlite)).toEqual(["awaiting-projector-bootstrap"]);
    expect(result.eventRows.deletedRows).toBe(0);
    expect(result.eventRows.oldestEligibleAt).toBeNull();
  });

  it("continues in bounded batches and reports a remaining eligible backlog", async () => {
    const { sqlite, db } = setupDb();
    openDb = sqlite;
    const cutoff = NOW_SEC - MINT_BURN_EVENT_RETENTION_SEC;
    for (let index = 0; index < 5; index += 1) {
      insertEvent(sqlite, {
        id: `eligible-${index}`,
        timestamp: cutoff - 100 + index,
      });
    }

    const first = await pruneMintBurnRetention(db, NOW_SEC, undefined, {
      eventBatchLimit: 2,
      eventRunLimit: 3,
      hourlyBatchLimit: 2,
      hourlyRunLimit: 2,
    });
    expect(first.eventRows.deletedRows).toBe(3);
    expect(first.eventRows.cappedAtLimit).toBe(true);
    expect(first.eventRows.oldestEligibleAt).not.toBeNull();
    expect(eventIds(sqlite)).toHaveLength(2);

    const second = await pruneMintBurnRetention(db, NOW_SEC, undefined, {
      eventBatchLimit: 2,
      eventRunLimit: 3,
      hourlyBatchLimit: 2,
      hourlyRunLimit: 2,
    });
    expect(second.eventRows.deletedRows).toBe(2);
    expect(second.eventRows.cappedAtLimit).toBe(false);
    expect(second.eventRows.oldestEligibleAt).toBeNull();
    expect(eventIds(sqlite)).toEqual([]);
  });

  it("keeps old hourly evidence until a capped raw-event backlog drains", async () => {
    const { sqlite, db } = setupDb();
    openDb = sqlite;
    const oldTimestamp = NOW_SEC - MINT_BURN_HOURLY_RETENTION_SEC - HOUR_SEC;
    const oldHour = hourFor(oldTimestamp);
    for (let index = 0; index < 5; index += 1) {
      insertEvent(sqlite, {
        id: `old-eligible-${index}`,
        timestamp: oldTimestamp + index,
      });
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
    expect(eventIds(sqlite)).toHaveLength(2);
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
    expect(eventIds(sqlite)).toEqual([]);
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM mint_burn_hourly WHERE hour_ts = ?")
        .get(oldHour),
    ).toEqual({ count: 0 });
  });

  it("rebuilds missing terminal hourly evidence before pruning raw rows", async () => {
    const { sqlite, db } = setupDb();
    openDb = sqlite;
    const oldTimestamp = NOW_SEC - MINT_BURN_HOURLY_RETENTION_SEC - HOUR_SEC;
    insertEvent(sqlite, {
      id: "stranded-terminal",
      timestamp: oldTimestamp,
      withHourly: false,
    });

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
    expect(eventIds(sqlite)).toEqual([]);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_hourly").get()).toEqual({
      count: 0,
    });
  });

  it("does not rebuild or prune a missing hour with unresolved price debt", async () => {
    const { sqlite, db } = setupDb();
    openDb = sqlite;
    const oldTimestamp = NOW_SEC - MINT_BURN_HOURLY_RETENTION_SEC - HOUR_SEC;
    insertEvent(sqlite, {
      id: "terminal-sibling",
      timestamp: oldTimestamp,
      withHourly: false,
    });
    insertEvent(sqlite, {
      id: "unresolved-sibling",
      timestamp: oldTimestamp + 1,
      amountUsd: null,
      withHourly: false,
    });

    const result = await pruneMintBurnRetention(db, NOW_SEC);

    expect(result.aggregationRepair).toMatchObject({
      repairedRows: 0,
      oldestRepairableAt: null,
      cappedAtLimit: false,
      error: null,
    });
    expect(result.eventRows.deletedRows).toBe(0);
    expect(result.hourlyRows.deletedRows).toBe(0);
    expect(eventIds(sqlite)).toEqual(["terminal-sibling", "unresolved-sibling"]);
  });

  it("retains priced siblings until historical repair rebuilds their complete existing hour", async () => {
    const { sqlite, db } = setupDb();
    openDb = sqlite;
    const timestamp = hourFor(NOW_SEC - MINT_BURN_EVENT_RETENTION_SEC - HOUR_SEC) + 10;
    insertEvent(sqlite, { id: "priced-sibling", timestamp, amountUsd: 100 });
    insertEvent(sqlite, { id: "repair-sibling", timestamp: timestamp + 1, amountUsd: null });
    sqlite.prepare("UPDATE mint_burn_events SET amount = 20 WHERE id = 'repair-sibling'").run();
    const affected = new Map([["hour", { stablecoinId: "usdc-circle", chainId: "ethereum", hourTs: hourFor(timestamp) }]]);
    await recalcAffectedHours(db, affected);

    const retained = await pruneMintBurnRetention(db, NOW_SEC);
    expect(retained.eventRows.deletedRows).toBe(0);
    expect(eventIds(sqlite)).toEqual(["priced-sibling", "repair-sibling"]);
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
    const { sqlite, db } = setupDb();
    openDb = sqlite;
    const timestamp = hourFor(NOW_SEC - MINT_BURN_EVENT_RETENTION_SEC - HOUR_SEC) + 10;
    insertEvent(sqlite, { id: "committed", timestamp, amountUsd: 100 });
    insertEvent(sqlite, { id: "uncommitted", timestamp: timestamp + 1, amountUsd: 20 });
    sqlite.prepare("UPDATE mint_burn_events SET block_number = 101 WHERE id = 'uncommitted'").run();
    const retained = await pruneMintBurnRetention(db, NOW_SEC);
    expect(retained.eventRows.deletedRows).toBe(0);
    expect(eventIds(sqlite)).toEqual(["committed", "uncommitted"]);
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

  it.each([true, false])("only enabled secondary configs hold frontier protection (enabled=%s)", async (enabled) => {
    const { sqlite, db } = setupDb();
    openDb = sqlite;
    const primary = MINT_BURN_CONFIGS.find((config) =>
      config.stablecoinId === "usdc-circle" && config.chain.chainId === "ethereum" && config.enabled !== false,
    )!;
    const secondary = { ...primary, contractAddress: "0x0000000000000000000000000000000000000001", enabled };
    const timestamp = NOW_SEC - MINT_BURN_EVENT_RETENTION_SEC - HOUR_SEC;
    insertEvent(sqlite, { id: "secondary-held", timestamp });
    sqlite.prepare("INSERT INTO mint_burn_sync_state (config_key, last_block) VALUES (?, 0)")
      .run(mintBurnConfigKey(secondary));

    const result = await pruneMintBurnRetention(db, NOW_SEC, undefined, { enabledConfigs: [primary, secondary] });
    expect(eventIds(sqlite)).toEqual(enabled ? ["secondary-held"] : []);
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
    const { sqlite, db } = setupDb();
    openDb = sqlite;
    const config = MINT_BURN_CONFIGS.find((candidate) =>
      candidate.stablecoinId === "usdc-circle" && candidate.chain.chainId === "ethereum" && candidate.enabled !== false,
    )!;
    sqlite.prepare("DELETE FROM mint_burn_sync_state WHERE config_key = ?").run(mintBurnConfigKey(config));
    insertEvent(sqlite, { id: "missing-frontier", timestamp: NOW_SEC - MINT_BURN_EVENT_RETENTION_SEC - HOUR_SEC });
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
    const { sqlite, db } = setupDb();
    openDb = sqlite;
    const config = MINT_BURN_CONFIGS.find((candidate) =>
      candidate.stablecoinId === "usdc-circle" && candidate.chain.chainId === "ethereum" && candidate.enabled !== false,
    )!;
    const inactive = { ...config, stablecoinId: "inactive-retired-asset" };
    const cutoff = NOW_SEC - MINT_BURN_EVENT_RETENTION_SEC;
    insertEvent(sqlite, { id: "inactive", timestamp: cutoff - HOUR_SEC });
    sqlite.prepare("UPDATE mint_burn_events SET stablecoin_id = ? WHERE id = 'inactive'").run(inactive.stablecoinId);
    sqlite.prepare("UPDATE mint_burn_hourly SET stablecoin_id = ?").run(inactive.stablecoinId);
    insertEvent(sqlite, { id: "fresh-only", timestamp: cutoff + HOUR_SEC });
    sqlite.prepare("UPDATE mint_burn_events SET block_number = 101 WHERE id = 'fresh-only'").run();
    const result = await pruneMintBurnRetention(db, NOW_SEC, undefined, { enabledConfigs: [config, inactive] });
    expect(eventIds(sqlite)).toEqual(["fresh-only"]);
    expect(result.frontierProtection).toEqual({ configs: [], error: null });
  });

  it("reports frontier diagnostic failure as unavailable without preventing cleanup", async () => {
    const { sqlite, db } = setupDb();
    openDb = sqlite;
    insertEvent(sqlite, { id: "eligible", timestamp: NOW_SEC - MINT_BURN_EVENT_RETENTION_SEC - HOUR_SEC });
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
    const { sqlite, db } = setupDb();
    openDb = sqlite;
    const oldTimestamp = NOW_SEC - MINT_BURN_HOURLY_RETENTION_SEC - 4 * HOUR_SEC;
    for (let index = 0; index < 3; index += 1) {
      insertEvent(sqlite, {
        id: `stranded-hour-${index}`,
        timestamp: oldTimestamp + index * HOUR_SEC,
        withHourly: false,
      });
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
    expect(eventIds(sqlite)).toEqual(["stranded-hour-2"]);

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
    expect(eventIds(sqlite)).toEqual([]);
  });

  it("reports a family cleanup error without preventing the other family", async () => {
    const { sqlite, db } = setupDb();
    openDb = sqlite;
    const failingDb = {
      ...db,
      prepare(sql: string) {
        if (!sql.includes("pharos:mint-burn:event-retention-delete")) {
          return db.prepare(sql);
        }
        const statement = {
          bind: () => statement as unknown as D1PreparedStatement,
          run: async () => {
            throw new Error("event retention unavailable");
          },
        };
        return statement as unknown as D1PreparedStatement;
      },
    } as D1Database;

    const result = await pruneMintBurnRetention(failingDb, NOW_SEC);

    expect(result.eventRows.error).toBe("event retention unavailable");
    expect(result.hourlyRows.error).toBeNull();
    expect(result.error).toContain("eventRows: event retention unavailable");
  });

  it("reports aggregation repair failure without preventing bounded deletion", async () => {
    const { sqlite, db } = setupDb();
    openDb = sqlite;
    const cutoff = NOW_SEC - MINT_BURN_EVENT_RETENTION_SEC;
    insertEvent(sqlite, { id: "eligible-after-repair-error", timestamp: cutoff - 1 });
    const failingDb = {
      ...db,
      prepare(sql: string) {
        if (!sql.includes("pharos:mint-burn:aggregation-evidence-repair")) {
          return db.prepare(sql);
        }
        const statement = {
          bind: () => statement as unknown as D1PreparedStatement,
          run: async () => {
            throw new Error("aggregation repair unavailable");
          },
        };
        return statement as unknown as D1PreparedStatement;
      },
    } as D1Database;

    const result = await pruneMintBurnRetention(failingDb, NOW_SEC);

    expect(result.aggregationRepair.error).toBe("aggregation repair unavailable");
    expect(result.eventRows.deletedRows).toBe(1);
    expect(result.eventRows.error).toBeNull();
    expect(result.hourlyRows.error).toBeNull();
    expect(result.error).toContain("aggregationRepair: aggregation repair unavailable");
  });

  it("throws before D1 work when already aborted", async () => {
    const { sqlite, db } = setupDb();
    openDb = sqlite;
    const controller = new AbortController();
    controller.abort(new Error("mint/burn retention aborted"));

    await expect(
      pruneMintBurnRetention(db, NOW_SEC, controller.signal),
    ).rejects.toThrow("mint/burn retention aborted");
  });
});

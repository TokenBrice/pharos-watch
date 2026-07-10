import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { describe, expect, it, vi } from "vitest";
import {
  repairHistoricalMintBurnPrices,
  resolveHistoricalMintPrice,
  type HistoricalMintPriceSourceLoader,
} from "../mint-burn-historical-price-repair";

const MIGRATIONS_DIR = join(process.cwd(), "worker/migrations");
const DAY = 86_400;

interface SqliteD1 extends D1Database {
  sqlite: DatabaseSync;
  close(): void;
}

function makeSqliteD1(): SqliteD1 {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((entry) => entry.endsWith(".sql"))
    .sort()) {
    // Test-only replay of repo-controlled migration files.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }

  function statement(sql: string, binds: unknown[] = []): D1PreparedStatement {
    return {
      bind: (...nextBinds: unknown[]) => statement(sql, nextBinds),
      run: async () => {
        const result = sqlite.prepare(sql).run(...(binds as never[]));
        return {
          success: true,
          meta: {
            changes: result.changes,
            last_row_id: Number(result.lastInsertRowid ?? 0),
          },
        };
      },
      first: async <T>() => (sqlite.prepare(sql).get(...(binds as never[])) ?? null) as T | null,
      all: async <T>() => ({
        results: sqlite.prepare(sql).all(...(binds as never[])) as T[],
        success: true,
        meta: {},
      }),
      raw: async () => sqlite.prepare(sql).all(...(binds as never[])) as unknown as unknown[][],
    } as unknown as D1PreparedStatement;
  }

  return {
    sqlite,
    prepare: (sql: string) => statement(sql),
    batch: async (statements: D1PreparedStatement[]) => {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const item of statements) results.push(await item.run());
        sqlite.exec("COMMIT");
        return results as Awaited<ReturnType<D1Database["batch"]>>;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
    dump: async () => new ArrayBuffer(0),
    close: () => sqlite.close(),
  } as SqliteD1;
}

function insertEvent(
  db: SqliteD1,
  input: { id: string; stablecoinId: string; timestamp: number; amount?: number },
): void {
  db.sqlite
    .prepare(
      `INSERT INTO mint_burn_events
       (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd,
        counterparty, tx_hash, block_number, timestamp, explorer_tx_url,
        price_used, price_timestamp, price_source, burn_type, burn_review_reason, flow_type)
       VALUES (?, ?, 'USDT', 'ethereum', 'mint', ?, NULL, NULL, ?, 1, ?, ?, NULL, NULL, NULL, NULL, NULL, 'standard')`,
    )
    .run(
      input.id,
      input.stablecoinId,
      input.amount ?? 100,
      `0x${input.id.padStart(64, "0")}`,
      input.timestamp,
      `https://etherscan.io/tx/${input.id}`,
    );
}

function availableLoader(price: number, timestamp: number): HistoricalMintPriceSourceLoader {
  return {
    loadCoinGecko: async () => ({
      source: "repair:coingecko-market-chart-event-day",
      status: "available",
      points: [{ timestamp, price }],
    }),
    loadDefiLlama: async ({ source }) => ({ source, status: "empty", points: [] }),
  };
}

describe("historical mint/burn price repair", () => {
  it("prefers an exact event-day supply snapshot over external event-day series", () => {
    const meta = TRACKED_META_BY_ID.get("usdt-tether");
    expect(meta).toBeDefined();
    const eventTimestamp = 1_800_000_000;
    const outcome = resolveHistoricalMintPrice({
      meta: meta!,
      eventTimestamp,
      supplyHistoryPrice: 0.998,
      sourceResults: [
        {
          source: "repair:coingecko-market-chart-event-day",
          status: "available",
          points: [{ timestamp: eventTimestamp, price: 1.01 }],
        },
      ],
    });

    expect(outcome.resolution).toEqual({
      price: 0.998,
      priceTimestamp: Math.floor(eventTimestamp / DAY) * DAY,
      priceSource: "repair:supply-history-event-day",
    });
  });

  it("chooses the nearest valid point on the event day and never uses an adjacent-day spot", () => {
    const meta = TRACKED_META_BY_ID.get("usdt-tether")!;
    const eventDay = 1_799_971_200;
    const eventTimestamp = eventDay + 12 * 3600;
    const outcome = resolveHistoricalMintPrice({
      meta,
      eventTimestamp,
      sourceResults: [
        {
          source: "repair:coingecko-market-chart-event-day",
          status: "available",
          points: [
            { timestamp: eventDay - 1, price: 0.9 },
            { timestamp: eventDay + 3 * 3600, price: 0.995 },
            { timestamp: eventDay + 11 * 3600, price: 1.001 },
            { timestamp: eventDay + DAY, price: 0.8 },
          ],
        },
      ],
    });

    expect(outcome.resolution).toMatchObject({
      price: 1.001,
      priceTimestamp: eventDay + 11 * 3600,
      priceSource: "repair:coingecko-market-chart-event-day",
    });
  });

  it("classifies a definitive empty event-day search as irreducible and transient provider failure as retryable", () => {
    const meta = TRACKED_META_BY_ID.get("usdt-tether")!;
    expect(
      resolveHistoricalMintPrice({
        meta,
        eventTimestamp: 1_800_000_000,
        sourceResults: [{ source: "cg", status: "empty", points: [] }],
      }),
    ).toMatchObject({
      resolution: null,
      disposition: "irreducible",
      reason: "no-valid-event-day-price:cg",
    });
    expect(
      resolveHistoricalMintPrice({
        meta,
        eventTimestamp: 1_800_000_000,
        sourceResults: [{ source: "cg", status: "unavailable", points: [], detail: "http-429" }],
      }),
    ).toMatchObject({
      resolution: null,
      disposition: "retry",
      reason: "event-day-source-temporarily-unavailable:cg:http-429",
    });
  });

  it("rebuilds and verifies hourly aggregates before finalizing recovery, then reruns idempotently", async () => {
    const db = makeSqliteD1();
    try {
      const timestamp = 1_800_000_000;
      insertEvent(db, { id: "event-1", stablecoinId: "usdt-tether", timestamp });
      db.sqlite.exec(`
        INSERT INTO mint_burn_hourly
          (stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
           mint_volume_usd, burn_volume_usd, net_flow_usd)
        VALUES ('usdt-tether', 'ethereum', ${Math.floor(timestamp / 3600) * 3600}, 1, 0, 0, 0, 0);
      `);

      const first = await repairHistoricalMintBurnPrices(db, {
        dryRun: false,
        operatorRunId: "repair-run-1",
        timeTravelBookmark: "bookmark-1",
        sourceLoader: availableLoader(0.997, timestamp - 60),
        nowSec: timestamp + DAY,
      });
      expect(first).toMatchObject({
        selected: 1,
        recovered: 1,
        classifiedIrreducible: 0,
        aggregateCoinsRebuilt: ["usdt-tether"],
        aggregateVerificationPassed: true,
      });
      expect(
        db.sqlite
          .prepare(
            `SELECT amount_usd, price_used, price_timestamp, price_source, price_repair_status
             FROM mint_burn_events WHERE id = 'event-1'`,
          )
          .get(),
      ).toEqual({
        amount_usd: 99.7,
        price_used: 0.997,
        price_timestamp: timestamp - 60,
        price_source: "repair:coingecko-market-chart-event-day",
        price_repair_status: "recovered",
      });
      expect(
        db.sqlite
          .prepare(
            `SELECT mint_count, mint_volume_usd, net_flow_usd
             FROM mint_burn_hourly WHERE stablecoin_id = 'usdt-tether'`,
          )
          .get(),
      ).toEqual({ mint_count: 1, mint_volume_usd: 99.7, net_flow_usd: 99.7 });

      const second = await repairHistoricalMintBurnPrices(db, {
        dryRun: false,
        operatorRunId: "repair-run-2",
        timeTravelBookmark: "bookmark-1",
        sourceLoader: availableLoader(1.1, timestamp),
        nowSec: timestamp + 2 * DAY,
      });
      expect(second).toMatchObject({ selected: 0, recovered: 0, aggregateCoinsRebuilt: [] });
      expect(db.sqlite.prepare("SELECT amount_usd FROM mint_burn_events WHERE id = 'event-1'").get()).toEqual({
        amount_usd: 99.7,
      });
      expect(
        db.sqlite
          .prepare("SELECT price_repair_run_id, price_repair_bookmark FROM mint_burn_events WHERE id = 'event-1'")
          .get(),
      ).toEqual({ price_repair_run_id: "repair-run-1", price_repair_bookmark: "bookmark-1" });
    } finally {
      db.close();
    }
  });

  it("resumes an interrupted pending-aggregate repair without refetching historical prices", async () => {
    const db = makeSqliteD1();
    try {
      const timestamp = 1_800_000_000;
      insertEvent(db, { id: "event-resume", stablecoinId: "usdt-tether", timestamp, amount: 10 });
      db.sqlite
        .prepare(
          `UPDATE mint_burn_events
           SET amount_usd = 9.9,
               price_used = 0.99,
               price_timestamp = ?,
               price_source = 'repair:coingecko-market-chart-event-day',
               price_repair_status = 'pending_aggregate'
           WHERE id = 'event-resume'`,
        )
        .run(timestamp - 30);
      const sourceLoader: HistoricalMintPriceSourceLoader = {
        loadCoinGecko: vi.fn(),
        loadDefiLlama: vi.fn(),
      };

      const result = await repairHistoricalMintBurnPrices(db, {
        dryRun: false,
        operatorRunId: "repair-resume",
        timeTravelBookmark: "bookmark-resume",
        sourceLoader,
        nowSec: timestamp + DAY,
      });

      expect(result).toMatchObject({
        selected: 0,
        recovered: 0,
        aggregateCoinsRebuilt: ["usdt-tether"],
        aggregateVerificationPassed: true,
        backlog: { pendingAggregate: 0 },
      });
      expect(sourceLoader.loadCoinGecko).not.toHaveBeenCalled();
      expect(sourceLoader.loadDefiLlama).not.toHaveBeenCalled();
      expect(
        db.sqlite.prepare("SELECT price_repair_status FROM mint_burn_events WHERE id = 'event-resume'").get(),
      ).toEqual({ price_repair_status: "recovered" });
    } finally {
      db.close();
    }
  });

  it("persists an explicit irreducible classification without inventing a current price", async () => {
    const db = makeSqliteD1();
    try {
      const timestamp = 1_800_000_000;
      insertEvent(db, { id: "event-2", stablecoinId: "usdt-tether", timestamp });
      const emptyLoader: HistoricalMintPriceSourceLoader = {
        loadCoinGecko: async () => ({ source: "cg", status: "empty", points: [] }),
        loadDefiLlama: async ({ source }) => ({ source, status: "empty", points: [] }),
      };

      const result = await repairHistoricalMintBurnPrices(db, {
        dryRun: false,
        operatorRunId: "repair-irreducible",
        timeTravelBookmark: "bookmark-irreducible",
        sourceLoader: emptyLoader,
        nowSec: timestamp + DAY,
      });
      expect(result).toMatchObject({
        selected: 1,
        recovered: 0,
        classifiedIrreducible: 1,
        aggregateCoinsRebuilt: [],
        backlog: { unclassified: 0, irreducible: 1, totalNullUsd: 1 },
      });
      const row = db.sqlite
        .prepare(
          `SELECT amount_usd, price_used, price_source, price_repair_status, price_repair_reason
           FROM mint_burn_events WHERE id = 'event-2'`,
        )
        .get();
      expect(row).toMatchObject({
        amount_usd: null,
        price_used: null,
        price_source: null,
        price_repair_status: "irreducible",
      });
      expect(String(row?.price_repair_reason)).toContain("no-valid-event-day-price");
    } finally {
      db.close();
    }
  });

  it("keeps dry-run read-only while reporting the bounded repair plan", async () => {
    const db = makeSqliteD1();
    try {
      const timestamp = 1_800_000_000;
      insertEvent(db, { id: "event-3", stablecoinId: "usdt-tether", timestamp });
      const result = await repairHistoricalMintBurnPrices(db, {
        dryRun: true,
        limit: 1,
        sourceLoader: availableLoader(1, timestamp),
      });
      expect(result).toMatchObject({
        dryRun: true,
        limit: 1,
        selected: 1,
        recovered: 1,
        aggregateCoinsRebuilt: ["usdt-tether"],
      });
      expect(
        db.sqlite.prepare("SELECT amount_usd, price_repair_status FROM mint_burn_events WHERE id = 'event-3'").get(),
      ).toEqual({ amount_usd: null, price_repair_status: null });
    } finally {
      db.close();
    }
  });
});

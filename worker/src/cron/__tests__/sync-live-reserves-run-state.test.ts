import { describe, expect, it } from "vitest";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { computeReserveCompositionOverview, resolveReserveResult } from "../../lib/live-reserves-store";
import { beginLiveReserveCheckpoint } from "../../lib/scheduled-recovery-checkpoint";
import {
  recordDeferredTail,
  selectConfiguredCoinRunQueue,
} from "../sync-live-reserves-run-state";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import { breakerKeyForConfig, type ConfiguredCoin } from "../sync-live-reserves-shared";

function makeCoin(id: string): ConfiguredCoin {
  return {
    id,
    liveReservesConfig: {
      adapter: "test-adapter",
      version: 1,
      semantics: "dynamic-mix",
      evidence: "independent",
      inputs: {
        primary: { kind: "static-json", value: {} },
      },
    },
  } as unknown as ConfiguredCoin;
}

function createDeferredStateHarness() {
  const sqlite = createLatestSchemaSqlite().sqlite;
  return { sqlite, db: createSqliteD1(sqlite) };
}

function makeBatchRecordingDb(
  batchSizes: number[],
  history: Array<{ sql: string; binds: unknown[] }> = [],
  batchError?: Error,
): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (...binds: unknown[]) => ({
        sql,
        binds,
        run: async () => {
          history.push({ sql, binds });
          return { success: true, meta: { changes: 1 } };
        },
        first: async () => {
          history.push({ sql, binds });
          return null;
        },
      }),
    }),
    batch: async (statements: D1PreparedStatement[]) => {
      batchSizes.push(statements.length);
      if (batchError) throw batchError;
      for (const statement of statements as unknown as Array<{ sql: string; binds: unknown[] }>) {
        history.push({ sql: statement.sql, binds: statement.binds });
      }
      return statements.map(() => ({ success: true, meta: { changes: 1 } }));
    },
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}


describe("selectConfiguredCoinRunQueue", () => {
  it("starts from the saved cursor when the coin is still configured", () => {
    const coins = [makeCoin("coin-a"), makeCoin("coin-b"), makeCoin("coin-c")];

    expect(selectConfiguredCoinRunQueue(coins, "coin-b").map((coin) => coin.id)).toEqual(["coin-b", "coin-c"]);
  });

  it("falls back to the full queue when the cursor is absent or stale", () => {
    const coins = [makeCoin("coin-a"), makeCoin("coin-b")];

    expect(selectConfiguredCoinRunQueue(coins, null).map((coin) => coin.id)).toEqual(["coin-a", "coin-b"]);
    expect(selectConfiguredCoinRunQueue(coins, "missing-coin").map((coin) => coin.id)).toEqual(["coin-a", "coin-b"]);
  });
});

describe("recordDeferredTail", () => {
  it("chunks deferred tail writes through the shared D1 batch executor", async () => {
    const batchSizes: number[] = [];
    const db = makeBatchRecordingDb(batchSizes);
    const coins = Array.from({ length: 61 }, (_value, index) => makeCoin(`coin-${index}`));

    const result = await recordDeferredTail(db, coins, 1_700_000_000);

    expect(result).toEqual({
      counts: { deferredCoins: 61 },
      deferredTail: {
        nextCursorStablecoinId: "coin-0",
        cursorTailState: "complete",
        cursorRecordedAt: 1_700_000_000,
        cursorTailCompletedAt: expect.any(Number),
        cursorTailFailedAt: null,
        cursorTailError: null,
        runBudgetTruncationCount: 1,
      },

      additionalBreakerKeys: expect.any(Set),
    });
    expect(result.additionalBreakerKeys.size).toBe(1);
    expect(batchSizes).toEqual([100, 22]);
  });
  it("surfaces deferred-tail persistence failures", async () => {
    const db = makeBatchRecordingDb([], [], new Error("batch unavailable"));

    await expect(recordDeferredTail(db, [makeCoin("coin-a")], 1_700_000_000))
      .rejects.toThrow("Failed to record deferred reserve tail state: batch unavailable");
  });


  it("keeps a recent authoritative snapshot fresh while recording deferral without inventing bootstrap authority", async () => {
    const { sqlite, db } = createDeferredStateHarness();
    try {
      const authoritativeCoin = ACTIVE_STABLECOINS.find((coin) => coin.id === "iusd-infinifi");
      expect(authoritativeCoin?.liveReservesConfig).toBeDefined();
      const configuredCoin = authoritativeCoin as ConfiguredCoin;
      const config = configuredCoin.liveReservesConfig!;
      const breakerKey = breakerKeyForConfig(config);
      const successAt = 1_700_000_000;
      const deferredAt = successAt + 60 * 60;
      const successAttemptId = "iusd-infinifi:success";

      sqlite.prepare(
        `INSERT INTO reserve_sync_state (
           stablecoin_id, adapter_key, breaker_key, last_attempted_at, last_success_at,
           last_status, warning_count, metadata, last_attempt_id, pending_attempt_id,
           last_success_attempt_id
         ) VALUES (?, ?, ?, ?, ?, 'ok', 0, '{}', ?, NULL, ?)`,
      ).run(
        configuredCoin.id,
        config.adapter,
        breakerKey,
        successAt,
        successAt,
        successAttemptId,
        successAttemptId,
      );
      sqlite.prepare(
        `INSERT INTO reserve_composition (
           stablecoin_id, slices, fetched_at, source, attempt_id, metadata,
           warning_count, adapter_source_model, adapter_evidence_class
         ) VALUES (?, ?, ?, ?, ?, ?, 0, 'dynamic-mix', 'independent')`,
      ).run(
        configuredCoin.id,
        JSON.stringify([{ name: "Verified reserves", pct: 100, risk: "low" }]),
        successAt,
        config.adapter,
        successAttemptId,
        JSON.stringify({ freshnessMode: "not-applicable" }),
      );

      const checkpoint = await beginLiveReserveCheckpoint(db, {
        slotStartedAt: deferredAt,
        invocationId: "reserve-run",
        nowSec: deferredAt,
      });
      sqlite.prepare(
        `UPDATE worker_scheduled_checkpoints
            SET next_item_key = ?, items_done = 0, items_total = 2
          WHERE slot_started_at = ? AND attempt_no = 1`,
      ).run(configuredCoin.id, checkpoint.slotStartedAt);

      await recordDeferredTail(
        db,
        [configuredCoin, makeCoin("bootstrap-coin")],
        deferredAt,
      );

      expect(sqlite.prepare(
        `SELECT last_attempted_at, last_success_at, last_status, last_attempt_id,
                pending_attempt_id, last_success_attempt_id
           FROM reserve_sync_state
          WHERE stablecoin_id = ?`,
      ).get(configuredCoin.id)).toEqual({
        last_attempted_at: successAt,
        last_success_at: successAt,
        last_status: "ok",
        last_attempt_id: successAttemptId,
        pending_attempt_id: null,
        last_success_attempt_id: successAttemptId,
      });
      expect(sqlite.prepare(
        `SELECT last_attempted_at, last_success_at, last_status, last_attempt_id,
                pending_attempt_id, last_success_attempt_id
           FROM reserve_sync_state
          WHERE stablecoin_id = 'bootstrap-coin'`,
      ).get()).toEqual({
        last_attempted_at: deferredAt,
        last_success_at: null,
        last_status: "skipped",
        last_attempt_id: null,
        pending_attempt_id: null,
        last_success_attempt_id: null,
      });
      expect(sqlite.prepare(
        "SELECT stablecoin_id, attempted_at, status, last_error FROM reserve_sync_attempt_history ORDER BY rowid",
      ).all()).toEqual([
        {
          stablecoin_id: configuredCoin.id,
          attempted_at: deferredAt,
          status: "skipped",
          last_error: "run-budget-exhausted",
        },
        {
          stablecoin_id: "bootstrap-coin",
          attempted_at: deferredAt,
          status: "skipped",
          last_error: "run-budget-exhausted",
        },
      ]);

      const resolved = await resolveReserveResult(db, configuredCoin.id, deferredAt + 60);
      expect(resolved).toMatchObject({
        mode: "live",
        liveAt: successAt,
        provenance: { scoringEligible: true },
        sync: {
          status: "ok",
          stale: false,
          lastAttemptedAt: successAt,
          lastSuccessAt: successAt,
        },
      });
      const overview = await computeReserveCompositionOverview(db, deferredAt + 60);
      expect(overview).toMatchObject({
        freshCoins: 1,
        cursorTailState: null,
        deferredCoins: 2,
        runBudgetTruncated: true,
        nextCursorStablecoinId: configuredCoin.id,
      });
    } finally {
      sqlite.close();
    }
  });

  it("keeps the checkpoint as the only resume pointer", async () => {
    const history: Array<{ sql: string; binds: unknown[] }> = [];
    const db = makeBatchRecordingDb([], history);

    const result = await recordDeferredTail(db, [makeCoin("coin-a")], 1_700_000_000);

    expect(result.deferredTail).toMatchObject({
      nextCursorStablecoinId: "coin-a",
      cursorTailState: "complete",
      runBudgetTruncationCount: 1,
    });
    expect(history.some((entry) => entry.sql.includes("cache"))).toBe(false);
    expect(history.filter((entry) => entry.sql.includes("reserve_sync_state"))).toHaveLength(1);
    expect(history.filter((entry) => entry.sql.includes("reserve_sync_attempt_history"))).toHaveLength(1);
  });
});

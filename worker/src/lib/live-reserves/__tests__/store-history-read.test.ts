import { describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import {
  loadReserveSyncAttemptTimeline,
  loadReserveSyncReliabilityRollup,
} from "../store-history-read";

function insertAttempt(
  sqlite: ReturnType<typeof createLatestSchemaSqlite>["sqlite"],
  args: {
    stablecoinId: string;
    attemptedAt: number;
    adapterKey: string;
    status: string;
    warnings?: string | null;
    lastError?: string | null;
    metadata?: string;
    attemptId?: string | null;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO reserve_sync_attempt_history
         (stablecoin_id, attempted_at, adapter_key, breaker_key, status, warnings, last_error, metadata, attempt_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.stablecoinId,
      args.attemptedAt,
      args.adapterKey,
      `live-reserves:${args.adapterKey}`,
      args.status,
      args.warnings ?? null,
      args.lastError ?? null,
      args.metadata ?? "{}",
      args.attemptId ?? null,
    );
}

describe("store-history-read", () => {
  it("returns the newest-N attempt timeline for one coin with parsed failure metadata", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      insertAttempt(sqlite, {
        stablecoinId: "usdc-circle",
        attemptedAt: 1000,
        adapterKey: "circle",
        status: "ok",
        metadata: JSON.stringify({ diag: { durationMs: 42 } }),
        attemptId: "a1",
      });
      insertAttempt(sqlite, {
        stablecoinId: "usdc-circle",
        attemptedAt: 1001,
        adapterKey: "circle",
        status: "error",
        warnings: JSON.stringify([{ code: "network", message: "down", severity: "warning", effect: "degraded" }]),
        lastError: "fetch failed",
        metadata: JSON.stringify({ failureCategory: "network", diag: { durationMs: 7 } }),
        attemptId: "a2",
      });
      insertAttempt(sqlite, {
        stablecoinId: "other-coin",
        attemptedAt: 1002,
        adapterKey: "other",
        status: "ok",
        attemptId: "a3",
      });

      const timeline = await loadReserveSyncAttemptTimeline(db, "usdc-circle");

      expect(timeline).toHaveLength(2);
      expect(timeline[0]).toEqual({
        stablecoinId: "usdc-circle",
        attemptedAt: 1001,
        adapterKey: "circle",
        breakerKey: "live-reserves:circle",
        attemptId: "a2",
        status: "error",
        failureCategory: "network",
        warningCodes: ["network"],
        lastError: "fetch failed",
        durationMs: 7,
      });
      expect(timeline[1]).toMatchObject({ attemptId: "a1", status: "ok", failureCategory: null, warningCodes: [], durationMs: 42 });
    } finally {
      sqlite.close();
    }
  });

  it("caps the timeline at the requested limit and treats malformed payloads as empty", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      for (let index = 0; index < 5; index++) {
        insertAttempt(sqlite, {
          stablecoinId: "usdc-circle",
          attemptedAt: 1000 + index,
          adapterKey: "circle",
          status: "ok",
          warnings: "{not-json",
          metadata: "{not-json",
        });
      }

      const timeline = await loadReserveSyncAttemptTimeline(db, "usdc-circle", 3);

      expect(timeline).toHaveLength(3);
      expect(timeline.map((entry) => entry.attemptedAt)).toEqual([1004, 1003, 1002]);
      expect(timeline[0].failureCategory).toBeNull();
      expect(timeline[0].warningCodes).toEqual([]);
      expect(timeline[0].durationMs).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("rolls up per-adapter reliability counts within the retention window", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      for (const status of ["ok", "ok", "degraded", "error"] as const) {
        insertAttempt(sqlite, {
          stablecoinId: `coin-${status}-${Math.random()}`,
          attemptedAt: 2000,
          adapterKey: "adapter-a",
          status,
        });
      }
      insertAttempt(sqlite, { stablecoinId: "coin-s1", attemptedAt: 2000, adapterKey: "adapter-b", status: "skipped" });
      insertAttempt(sqlite, { stablecoinId: "coin-s2", attemptedAt: 2000, adapterKey: "adapter-b", status: "skipped" });
      // Outside the window: excluded.
      insertAttempt(sqlite, { stablecoinId: "coin-old", attemptedAt: 999, adapterKey: "adapter-c", status: "ok" });

      const rollup = await loadReserveSyncReliabilityRollup(db, 3000, 1000);

      expect(rollup).toEqual([
        { adapterKey: "adapter-a", attempts: 4, ok: 2, degraded: 1, error: 1, skipped: 0, successRate: 0.5 },
        { adapterKey: "adapter-b", attempts: 2, ok: 0, degraded: 0, error: 0, skipped: 2, successRate: 0 },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("returns an empty rollup when no attempts fall inside the window", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      expect(await loadReserveSyncReliabilityRollup(db, 10_000, 1000)).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});

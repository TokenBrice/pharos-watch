import { describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import {
  loadLatestNonSkippedReserveAttempt,
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

  it("returns the newest non-skipped attempt so circuit skips cannot inherit an older failure", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      insertAttempt(sqlite, {
        stablecoinId: "stbt-matrixdock", attemptedAt: 1000, adapterKey: "matrixdock-stbt", status: "error",
        warnings: JSON.stringify([{ code: "stale-source-data", message: "old", severity: "warning", effect: "degraded" }]),
        lastError: "HTTP 403", metadata: JSON.stringify({ failureCategory: "http" }),
      });
      insertAttempt(sqlite, {
        stablecoinId: "stbt-matrixdock", attemptedAt: 1001, adapterKey: "matrixdock-stbt", status: "ok",
        metadata: JSON.stringify({ diag: { durationMs: 3 } }),
      });
      insertAttempt(sqlite, {
        stablecoinId: "stbt-matrixdock", attemptedAt: 1002, adapterKey: "matrixdock-stbt", status: "skipped",
        metadata: JSON.stringify({ failureCategory: "circuit-open" }),
      });

      const latest = await loadLatestNonSkippedReserveAttempt(db, "stbt-matrixdock");

      expect(latest).toMatchObject({ attemptedAt: 1001, status: "ok", failureCategory: null, warningCodes: [] });
      expect(await loadLatestNonSkippedReserveAttempt(db, "unknown-coin")).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it.each([
    ["metadata", { metadata: "{not-json" }],
    ["warnings", { warnings: "{not-json" }],
    ["warning entries", { warnings: JSON.stringify([{ message: "no code" }]) }],
  ])("refuses a latest attempt whose %s is malformed", async (_label, overrides) => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      insertAttempt(sqlite, {
        stablecoinId: "usdc-circle", attemptedAt: 1000, adapterKey: "circle", status: "error", ...overrides,
      });

      expect(await loadLatestNonSkippedReserveAttempt(db, "usdc-circle")).toBeNull();
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
        { adapterKey: "adapter-a", attempts: 4, ok: 2, degraded: 1, degradedByDesign: 0, error: 1, skipped: 0, successRate: 0.5 },
        { adapterKey: "adapter-b", attempts: 2, ok: 0, degraded: 0, degradedByDesign: 0, error: 0, skipped: 2, successRate: 0 },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("counts degraded attempts whose only degraded warnings are structural as by design", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const structural = { code: "nav-portfolio-composition-unverified", message: "m", severity: "warning", effect: "degraded" };
    const operational = { code: "source-stale", message: "m", severity: "warning", effect: "degraded" };
    const info = { code: "primary-fallback-used", message: "m", severity: "info", effect: "info" };
    try {
      const rows: Array<[string, string | null]> = [
        ["ok", null],
        ["degraded", JSON.stringify([structural])],
        ["degraded", JSON.stringify([structural, info])],
        ["degraded", JSON.stringify([structural, operational])],
        // Legacy rows without `effect` decode as degraded unless info severity.
        ["degraded", JSON.stringify([structural, { code: "source-stale", message: "m", severity: "warning" }])],
        ["degraded", JSON.stringify([structural, { code: "note", message: "m", severity: "info" }])],
        ["degraded", JSON.stringify([structural, { code: "no-message", severity: "info", effect: "info" }])],
        ["degraded", JSON.stringify([structural, { code: "blank", message: "\t\n", severity: "info", effect: "info" }])],
        ["degraded", JSON.stringify([operational])],
        ["degraded", JSON.stringify([{ ...structural, code: undefined }])],
        ["degraded", JSON.stringify(["nav-portfolio-composition-unverified"])],
        ["degraded", "not json"],
        ["degraded", null],
        ["error", JSON.stringify([structural])],
      ];
      rows.forEach(([status, warnings], index) => insertAttempt(sqlite, {
        stablecoinId: `coin-${index}`, attemptedAt: 2000, adapterKey: "chainlink-nav", status, warnings,
      }));

      const rollup = await loadReserveSyncReliabilityRollup(db, 3000, 1000);

      expect(rollup).toEqual([
        { adapterKey: "chainlink-nav", attempts: 14, ok: 1, degraded: 12, degradedByDesign: 3, error: 1, skipped: 0, successRate: 4 / 14 },
      ]);
    } finally {
      sqlite.close();
    }
  });
});

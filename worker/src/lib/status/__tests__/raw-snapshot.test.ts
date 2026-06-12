import { describe, expect, it } from "vitest";
import { mockD1 } from "../../../test-helpers/__shared/mock-d1";
import { STATUS_RAW_SNAPSHOT_CACHE_KEY, writeStatusRawSnapshot } from "../raw-snapshot";

describe("writeStatusRawSnapshot", () => {
  it("does not overwrite newer cache rows", async () => {
    const db = mockD1([
      {
        match: "INSERT INTO cache",
        rows: [],
        runMeta: { changes: 0 },
      },
    ], { requireMatch: true });
    const raw = { rawOverallStatus: "healthy" } as Parameters<typeof writeStatusRawSnapshot>[2];

    const written = await writeStatusRawSnapshot(db, 1_777_000_000, raw);

    expect(written).toBe(false);
    const write = db.getHistory()[0];
    expect(write.sql).toContain("ON CONFLICT(key) DO UPDATE");
    expect(write.sql).toContain("WHERE cache.updated_at <= excluded.updated_at");
    expect(write.binds[0]).toBe(STATUS_RAW_SNAPSHOT_CACHE_KEY);
    expect(write.binds[2]).toBe(1_777_000_000);
  });

  it("compacts cron run metadata before writing the raw snapshot", async () => {
    const db = mockD1([
      {
        match: "INSERT INTO cache",
        rows: [],
        runMeta: { changes: 1 },
      },
    ], { requireMatch: true });
    const raw = {
      rawOverallStatus: "healthy",
      crons: {
        "status-self-check": {
          healthy: false,
          lastRun: {
            startedAt: 1_777_000_000,
            durationMs: 16_500,
            status: "degraded",
            itemCount: 17,
            error: "x".repeat(2_200),
            metadata: {
              sampleCount: 17,
              slowestProbes: Array.from({ length: 50 }, (_, index) => ({ probe: `probe-${index}` })),
              detail: "y".repeat(2_200),
            },
          },
          recentRuns: Array.from({ length: 12 }, (_, index) => ({
            startedAt: 1_777_000_000 - index * 900,
            durationMs: 100 + index,
            status: index === 0 ? "degraded" : "ok",
            itemCount: 1,
            metadata: { oversized: "z".repeat(2_200) },
          })),
          staleArtifacts: Array.from({ length: 10 }, (_, index) => ({ key: `artifact-${index}` })),
        },
      },
    } as unknown as Parameters<typeof writeStatusRawSnapshot>[2];

    const written = await writeStatusRawSnapshot(db, 1_777_000_000, raw);

    expect(written).toBe(true);
    const payload = JSON.parse(String(db.getHistory()[0].binds[1])) as {
      raw: {
        crons: {
          "status-self-check": {
            lastRun: {
              error: string;
              metadata: { detail: string; slowestProbes: unknown[] };
            };
            recentRuns: Array<{ metadata?: Record<string, unknown> }>;
            staleArtifacts: unknown[];
          };
        };
      };
    };
    const cron = payload.raw.crons["status-self-check"];
    expect(cron.lastRun.error.length).toBeLessThan(2_200);
    expect(cron.lastRun.metadata.detail.length).toBeLessThan(2_200);
    expect(cron.lastRun.metadata.slowestProbes).toHaveLength(40);
    expect(cron.recentRuns).toHaveLength(10);
    expect(cron.recentRuns[0].metadata).toBeDefined();
    expect(cron.recentRuns[1].metadata).toBeUndefined();
    expect(cron.staleArtifacts).toHaveLength(8);
  });
});

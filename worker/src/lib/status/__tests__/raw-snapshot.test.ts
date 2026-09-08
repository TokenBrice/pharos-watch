import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(fixtures.closeAll);
import { mockD1 } from "@shared/test-utils/mock-d1";
import {
  loadStatusRawSnapshot,
  STATUS_RAW_SNAPSHOT_CACHE_KEY,
  writeStatusRawSnapshot,
} from "../raw-snapshot";

const NOW = 1_777_000_000;

function minimalRawStatus() {
  return {
    dbHealthy: true,
    availabilityStatus: "healthy",
    dataQualityStatus: "healthy",
    rawOverallStatus: "healthy",
    confidence: 1,
    causes: {},
    caches: {},
    crons: {},
    budgetOnlySurfaces: [],
    dataQuality: {},
    telegramBot: null,
    sectionErrors: {},
    datasetFreshness: {},
    summary: {},
    reserveComposition: {},
    freshnessDiagnostics: [],
  };
}

describe("writeStatusRawSnapshot", () => {
  it("fences stale writes while accepting equal and newer snapshots", async () => {
    const { db, sqlite } = fixtures.open();
    const raw = minimalRawStatus() as unknown as Parameters<typeof writeStatusRawSnapshot>[2];
    await expect(writeStatusRawSnapshot(db, NOW, raw)).resolves.toBe(true);
    const original = sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = ?").get(STATUS_RAW_SNAPSHOT_CACHE_KEY);
    await expect(writeStatusRawSnapshot(db, NOW - 1, { ...raw, confidence: 0.5 })).resolves.toBe(false);
    expect(sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = ?").get(STATUS_RAW_SNAPSHOT_CACHE_KEY)).toEqual(original);
    await expect(writeStatusRawSnapshot(db, NOW, { ...raw, confidence: 0.75 })).resolves.toBe(true);
    await expect(loadStatusRawSnapshot(db, NOW)).resolves.toMatchObject({ kind: "fresh", raw: { confidence: 0.75 } });
    await expect(writeStatusRawSnapshot(db, NOW + 1, { ...raw, confidence: 0.9 })).resolves.toBe(true);
    await expect(loadStatusRawSnapshot(db, NOW + 1)).resolves.toMatchObject({ kind: "fresh", updatedAt: NOW + 1, raw: { confidence: 0.9 } });
  });

  it("serves a cached payload that is within the freshness budget", async () => {
    const db = mockD1([{
      match: "SELECT value, updated_at FROM cache",
      rows: [],
      first: {
        value: JSON.stringify({ version: 1, producedAt: NOW, raw: minimalRawStatus() }),
        updated_at: NOW,
      },
    }], { requireMatch: true });

    const snapshot = await loadStatusRawSnapshot(db, NOW + 30);

    expect(snapshot).toMatchObject({
      kind: "fresh",
      updatedAt: NOW,
      ageSec: 30,
    });
  });

  it("distinguishes missing, unreadable, stale and failed reads without dropping valid raw supplements", async () => {
    const { db, sqlite } = fixtures.open();
    await expect(loadStatusRawSnapshot(db, NOW, 60)).resolves.toMatchObject({ kind: "missing", updatedAt: null });
    sqlite.prepare("INSERT INTO cache VALUES (?, ?, ?)").run(STATUS_RAW_SNAPSHOT_CACHE_KEY, "{", NOW);
    await expect(loadStatusRawSnapshot(db, NOW, 60)).resolves.toMatchObject({ kind: "unreadable", updatedAt: NOW });
    sqlite.prepare("UPDATE cache SET value = ?").run(JSON.stringify({
      version: 1, producedAt: NOW, raw: minimalRawStatus(), supplements: "invalid", publicHealth: [],
    }));
    await expect(loadStatusRawSnapshot(db, NOW + 60, 60)).resolves.toMatchObject({
      kind: "fresh", ageSec: 60, raw: minimalRawStatus(), supplements: undefined, publicHealth: undefined,
    });
    await expect(loadStatusRawSnapshot(db, NOW + 61, 60)).resolves.toMatchObject({ kind: "stale", updatedAt: NOW, ageSec: 61 });
    sqlite.exec("DROP TABLE cache");
    await expect(loadStatusRawSnapshot(db, NOW, 60)).resolves.toMatchObject({ kind: "read-error", updatedAt: null });
  });

  it("compacts cron run metadata before writing the raw snapshot", async () => {
    const { db } = fixtures.open();
    const raw = {
      ...minimalRawStatus(),
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

    const written = await writeStatusRawSnapshot(db, NOW, raw);

    expect(written).toBe(true);
    const snapshot = await loadStatusRawSnapshot(db, NOW);
    expect(snapshot.kind).toBe("fresh");
    if (snapshot.kind !== "fresh") throw new Error("Expected compacted snapshot");
    const payload = snapshot as unknown as {
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

  it("persists the public-health projection and status supplements alongside raw data", async () => {
    const { db } = fixtures.open();
    const publicHealth = {
      status: "healthy",
      timestamp: NOW,
      warnings: [],
      caches: {},
      blacklist: {},
      mintBurn: {},
      circuits: {},
    };
    const supplements = {
      telegramSummary: null,
      sectionErrors: {},
    };

    const written = await writeStatusRawSnapshot(
      db,
      NOW,
      minimalRawStatus() as unknown as Parameters<typeof writeStatusRawSnapshot>[2],
      { publicHealth, supplements } as never,
    );

    expect(written).toBe(true);
    await expect(loadStatusRawSnapshot(db, NOW)).resolves.toMatchObject({
      kind: "fresh", publicHealth, supplements,
    });
  });
});

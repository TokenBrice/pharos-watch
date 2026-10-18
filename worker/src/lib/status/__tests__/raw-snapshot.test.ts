import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { makeDataQuality, makeReserveComposition, makeStatusSummary, statusResponse } from "@shared/types/__tests__/status.test-support";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import type { RawStatusComputation } from "../../status-evaluation";
import { compactCronMetadataForPersistence } from "../../cron-metadata-persistence";
import { StatusCronDetailResponseSchema } from "@shared/types/status";
import { handleStatusCronDetailRoute } from "../../../api/status-cron-detail";
import { summarizeCronStatus } from "../cron-status-summary";
import {
  loadStatusPublicHealthSnapshot,
  STATUS_PUBLIC_HEALTH_SNAPSHOT_CACHE_KEY,
  writeStatusPublicHealthSnapshot,
} from "../public-health-snapshot";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => {
  fixtures.closeAll();
  vi.restoreAllMocks();
});
import { mockD1 } from "@shared/test-utils/mock-d1";
import {
  loadStatusRawSnapshot,
  STATUS_RAW_SNAPSHOT_CACHE_KEY,
  writeStatusRawSnapshot,
} from "../raw-snapshot";

const NOW = 1_777_000_000;

function minimalRawStatus(): RawStatusComputation {
  return {
    dbHealthy: true,
    availabilityStatus: "healthy",
    dataQualityStatus: "healthy",
    rawOverallStatus: "healthy",
    confidence: 1,
    causes: { availability: [], dataQuality: [], overall: [] },
    caches: {},
    crons: Object.fromEntries(Object.entries(CRON_INTERVALS).map(([job, expectedIntervalSec]) => [
      job, { expectedIntervalSec, healthy: true, confirmedOutputAt: null, runs: [] },
    ])),
    budgetOnlySurfaces: [],
    dataQuality: makeDataQuality(),
    telegramBot: null,
    sectionErrors: {},
    datasetFreshness: statusResponse().datasetFreshness,
    summary: makeStatusSummary(),
    reserveComposition: makeReserveComposition(),
    freshnessDiagnostics: [],
  };
}

function snapshotPayload(raw = minimalRawStatus(), producedAt = NOW) {
  const { crons, ...assessment } = raw;
  return { version: 2, producedAt, cronJobs: Object.keys(crons), raw: assessment };
}

async function cronDetail(db: D1Database, job: string) {
  vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
  const request = new Request(`https://ops-api.pharos.watch/api/status-cron-detail?job=${job}`);
  const response = await handleStatusCronDetailRoute({
    db, trustedAdmin: true, request, url: new URL(request.url),
  });
  expect(response.status).toBe(200);
  return StatusCronDetailResponseSchema.parse(await response.json()).cron;
}

describe("writeStatusRawSnapshot", () => {
  it.each([
    [NOW + 60, NOW + 60, "fresh"],
    [NOW + 61, NOW, "unreadable"],
    [NOW, NOW + 61, "unreadable"],
    [NOW + 86400, NOW, "unreadable"],
  ] as const)("checks cache %s and generation %s clocks", async (updatedAt, producedAt, kind) => {
    const db = mockD1([{
      match: "SELECT value, updated_at FROM cache", rows: [],
      first: { value: JSON.stringify(snapshotPayload(minimalRawStatus(), producedAt)), updated_at: updatedAt },
    }]);
    expect(await loadStatusRawSnapshot(db, NOW)).toMatchObject(kind === "fresh"
      ? { kind, ageSec: 0 }
      : { kind, ageSec: null, error: "future-timestamp" });
  });

  it.each(["extra", "missing", "duplicate"] as const)("rejects a %s registered cron cohort rather than retaining cached severity", async (mismatch) => {
    const raw = minimalRawStatus();
    raw.availabilityStatus = "degraded";
    raw.rawOverallStatus = "degraded";
    const payload = snapshotPayload(raw);
    if (mismatch === "extra") payload.cronJobs.push("retired-observer");
    else if (mismatch === "duplicate") payload.cronJobs.push(payload.cronJobs[0]);
    else payload.cronJobs.shift();
    const db = mockD1([{
      match: "SELECT value, updated_at FROM cache", rows: [],
      first: { value: JSON.stringify(payload), updated_at: NOW },
    }]);
    await expect(loadStatusRawSnapshot(db, NOW)).resolves.toMatchObject({
      kind: "unreadable", error: "status raw snapshot cron cohort mismatch",
    });
  });

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

  it("serves a cached payload within the freshness budget without cached scheduler liveness", async () => {
    const db = mockD1([{
      match: "SELECT value, updated_at FROM cache",
      rows: [],
      first: {
        value: JSON.stringify(snapshotPayload()),
        updated_at: NOW,
      },
    }]);

    const snapshot = await loadStatusRawSnapshot(db, NOW + 30);

    expect(snapshot).toMatchObject({
      kind: "fresh",
      updatedAt: NOW,
      ageSec: 30,
    });
  });

  it.each([
    { causes: {} },
    { causes: { availability: {}, dataQuality: [], overall: [] } },
    { causes: { availability: [null], dataQuality: [], overall: [] } },
    { caches: { stablecoins: {} } },
    { dataQuality: {} },
    { datasetFreshness: {} },
    { summary: {} },
    { telegramBot: {} },
    { sectionErrors: { statusState: {} } },
    { freshnessDiagnostics: [null] },
    { budgetOnlySurfaces: {} },
    { schedulerLiveness: {} },
  ])("rejects malformed required nested raw evidence %j", async (overrides) => {
    const db = mockD1([{
      match: "SELECT value, updated_at FROM cache", rows: [],
      first: { value: JSON.stringify({ ...snapshotPayload(), raw: { ...snapshotPayload().raw, ...overrides } }), updated_at: NOW },
    }]);
    await expect(loadStatusRawSnapshot(db, NOW)).resolves.toMatchObject({
      kind: "unreadable", error: "invalid status:raw-snapshot:v1 payload",
    });
  });

  it.each([undefined, {}, [null]])("rejects a malformed required cron cohort %j", async (cronJobs) => {
    const db = mockD1([{
      match: "SELECT value, updated_at FROM cache", rows: [],
      first: { value: JSON.stringify({ ...snapshotPayload(), cronJobs }), updated_at: NOW },
    }]);
    await expect(loadStatusRawSnapshot(db, NOW)).resolves.toMatchObject({
      kind: "unreadable", error: "invalid status:raw-snapshot:v1 payload",
    });
  });

  it("rejects the retired v1 operator envelope until a v2 assessment is published", async () => {
    const db = mockD1([{
      match: "SELECT value, updated_at FROM cache", rows: [],
      first: { value: JSON.stringify({ version: 1, producedAt: NOW, raw: minimalRawStatus() }), updated_at: NOW },
    }]);
    await expect(loadStatusRawSnapshot(db, NOW)).resolves.toMatchObject({ kind: "unreadable" });
  });

  it("defaults only absent optional budget surfaces on an otherwise valid snapshot", async () => {
    const raw: Partial<RawStatusComputation> = minimalRawStatus();
    delete raw.budgetOnlySurfaces;
    const db = mockD1([{
      match: "SELECT value, updated_at FROM cache", rows: [],
      first: { value: JSON.stringify(snapshotPayload(raw as RawStatusComputation)), updated_at: NOW },
    }]);
    await expect(loadStatusRawSnapshot(db, NOW)).resolves.toMatchObject({ kind: "fresh", raw: { budgetOnlySurfaces: [] } });
  });

  it("rejects cached reserve composition without the health cohort needed for current gates", async () => {
    const db = mockD1([{
      match: "SELECT value, updated_at FROM cache",
      rows: [],
      first: {
        value: JSON.stringify({
          ...snapshotPayload(),
          raw: { ...snapshotPayload().raw, reserveComposition: {} },
        }),
        updated_at: NOW,
      },
    }]);

    await expect(loadStatusRawSnapshot(db, NOW)).resolves.toMatchObject({
      kind: "unreadable",
      error: "invalid status:raw-snapshot:v1 payload",
    });
  });

  it("distinguishes missing, unreadable, stale and failed snapshot reads", async () => {
    const { db, sqlite } = fixtures.open();
    await expect(loadStatusRawSnapshot(db, NOW, 60)).resolves.toMatchObject({ kind: "missing", updatedAt: null });
    sqlite.prepare("INSERT INTO cache VALUES (?, ?, ?)").run(STATUS_RAW_SNAPSHOT_CACHE_KEY, "{", NOW);
    await expect(loadStatusRawSnapshot(db, NOW, 60)).resolves.toMatchObject({ kind: "unreadable", updatedAt: NOW });
    sqlite.prepare("UPDATE cache SET value = ?").run(JSON.stringify({
      ...snapshotPayload(), supplements: "invalid",
    }));
    await expect(loadStatusRawSnapshot(db, NOW + 60, 60)).resolves.toMatchObject({
      kind: "unreadable", updatedAt: NOW, ageSec: 60,
    });
    await expect(loadStatusRawSnapshot(db, NOW + 61, 60)).resolves.toMatchObject({ kind: "stale", updatedAt: NOW, ageSec: 61 });
    sqlite.exec("DROP TABLE cache");
    await expect(loadStatusRawSnapshot(db, NOW, 60)).resolves.toMatchObject({ kind: "read-error", updatedAt: null });
  });

  it("keeps cron histories out of the assessment and serves full metadata through job detail", async () => {
    const { db, sqlite } = fixtures.open();
    const metadata = {
      sampleCount: 17,
      slowestProbes: Array.from({ length: 50 }, (_, index) => ({ probe: `probe-${index}` })),
      detail: "y".repeat(2_200),
    };
    const insert = sqlite.prepare(`INSERT INTO cron_runs
      (job, started_at, duration_ms, status, item_count, error, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (let index = 0; index < 12; index++) {
      insert.run("status-self-check", NOW - index * 900, 100 + index,
        index === 0 ? "degraded" : "ok", 17, "x".repeat(2_200),
        JSON.stringify(index === 0 ? metadata : { oversized: "z".repeat(2_200) }));
    }
    const detail = await cronDetail(db, "status-self-check");
    const raw = minimalRawStatus();
    raw.crons["status-self-check"] = detail;
    expect(await writeStatusRawSnapshot(db, NOW, raw)).toBe(true);
    const snapshot = await loadStatusRawSnapshot(db, NOW);
    expect(snapshot.kind).toBe("fresh");
    if (snapshot.kind !== "fresh") throw new Error("Expected assessment snapshot");
    expect(snapshot.raw).not.toHaveProperty("crons");
    const persisted = JSON.parse(sqlite.prepare("SELECT value FROM cache WHERE key = ?")
      .get(STATUS_RAW_SNAPSHOT_CACHE_KEY)!.value as string);
    expect(persisted).toMatchObject({ version: 2, producedAt: NOW, cronJobs: Object.keys(CRON_INTERVALS) });
    expect(persisted.raw).not.toHaveProperty("crons");
    expect(persisted).not.toHaveProperty("publicHealth");
    expect(detail.runs).toHaveLength(10);
    expect(detail.runs[0].error).toHaveLength(2_200);
    expect(detail.runs[0].metadata).toEqual(metadata);
    expect(detail.runs[1].metadata).toEqual({ oversized: "z".repeat(2_200) });
    const summary = summarizeCronStatus("status-self-check", detail);
    expect(summary.runs[0].error!.length).toBeLessThan(2_200);
    expect(summary.runs.every((run) => !("metadata" in run))).toBe(true);
  });

  it("preserves all bounded reserve latency groups and histogram samples", async () => {
    const { db, sqlite } = fixtures.open();
    const groups = Array.from({ length: 89 }, (_, index) => ({
      adapterKey: `adapter-${index}`,
      elapsedMs: { count: 1, sumMs: index + 1, buckets: [0, 1, 1] },
    }));
    const adapterLatency = { schemaVersion: 1, groups, omittedGroups: 0, total: { elapsedMs: { sumMs: 4005 } } };
    sqlite.prepare(`INSERT INTO cron_runs (job, started_at, duration_ms, status, metadata)
      VALUES ('sync-live-reserves', ?, 0, 'ok', ?)`).run(NOW, JSON.stringify({ adapterLatency }));
    const detail = await cronDetail(db, "sync-live-reserves");
    expect(detail.runs[0].metadata?.adapterLatency).toEqual(adapterLatency);
    expect(await writeStatusRawSnapshot(db, NOW, minimalRawStatus())).toBe(true);
    const snapshot = await loadStatusRawSnapshot(db, NOW);
    expect(snapshot.kind).toBe("fresh");
    if (snapshot.kind !== "fresh") throw new Error("Expected assessment snapshot");
    expect(snapshot.raw).not.toHaveProperty("crons");
  });

  it("persists supplements with the operator assessment and public health in its independent snapshot", async () => {
    const { db, sqlite } = fixtures.open();
    const publicHealth = {
      status: "healthy" as const, timestamp: NOW, warnings: [], caches: {}, circuits: {},
      blacklist: { totalEvents: 0, missingAmounts: 0, recentMissingAmounts: 0, recentWindowSec: 86400, missingRatio: 0 },
      mintBurn: { totalEvents: 0, latestEventTs: null, latestHourlyTs: null, freshnessAgeSec: null,
        majorStaleCount: 0, staleMajorSymbols: [], sync: {
          lastSuccessfulSyncAt: null, freshnessStatus: "fresh" as const, warning: null, criticalLaneHealthy: true,
        } },
    };
    const supplements = {
      liquidityHealth: null,
      yieldHealth: null,
      publicationHealth: null,
      providerCircuitHealth: null,
      canaries: null,
      priceSourceHealth: null,
      coingeckoPriceDiff: null,
      d1Usage: null,
      mintBurnReconciliation: null,
      telegramSummary: null,
      sectionErrors: {},
    };

    const written = await writeStatusRawSnapshot(
      db,
      NOW,
      minimalRawStatus() as unknown as Parameters<typeof writeStatusRawSnapshot>[2],
      { supplements },
    );

    expect(written).toBe(true);
    await expect(loadStatusRawSnapshot(db, NOW)).resolves.toMatchObject({
      kind: "fresh", supplements,
    });
    expect(await writeStatusPublicHealthSnapshot(db, NOW, publicHealth)).toBe(true);
    await expect(loadStatusPublicHealthSnapshot(db, NOW)).resolves.toMatchObject({
      kind: "fresh", payload: { version: 1, producedAt: NOW, publicHealth },
    });
    const operator = JSON.parse(sqlite.prepare("SELECT value FROM cache WHERE key = ?")
      .get(STATUS_RAW_SNAPSHOT_CACHE_KEY)!.value as string);
    const publicSnapshot = JSON.parse(sqlite.prepare("SELECT value FROM cache WHERE key = ?")
      .get(STATUS_PUBLIC_HEALTH_SNAPSHOT_CACHE_KEY)!.value as string);
    expect(operator).not.toHaveProperty("publicHealth");
    expect(operator.raw).not.toHaveProperty("crons");
    expect(publicSnapshot).not.toHaveProperty("raw");
    expect(publicSnapshot).not.toHaveProperty("supplements");
  });
});

it("preserves watchdog generation clocks and budgets through persistence and job detail", async () => {
  const { db, sqlite } = fixtures.open();
  const stale = Array.from({ length: 50 }, (_, index) => ({
    laneKey: "dexLiquidity", cacheKey: "dex-liquidity", producerJob: `producer-${index}`,
    ageSeconds: 7201, publishedAt: NOW - 7201, generationId: `generation-${index}`, assessedAt: NOW,
    thresholdSec: 7200, producerThresholdSec: 7200, endpointThresholdSec: 14400,
    availabilityThresholdSec: 14400, availabilityImpacting: false,
  }));
  const original = { sources: { freshness: { observedAt: NOW, status: "degraded", metadata: { stale } } },
    oversized: "x".repeat(70_000) };
  const compacted = compactCronMetadataForPersistence(JSON.stringify(original), undefined, "cron-sentinel");
  expect(compacted.compacted).toBe(true);
  expect(compacted.persistedBytes).toBeLessThan(64 * 1024);
  sqlite.prepare(`INSERT INTO cron_runs (job, started_at, duration_ms, status, metadata)
    VALUES ('cron-sentinel', ?, 1, 'degraded', ?)`).run(NOW, compacted.metadata);
  const detail = await cronDetail(db, "cron-sentinel");
  expect(detail.runs[0].metadata).toMatchObject({
    sources: { freshness: { metadata: { stale } } },
  });
});

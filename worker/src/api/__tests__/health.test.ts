import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, describe, it, expect, vi } from "vitest";
import type { FreshnessStatus } from "@shared/lib/status-thresholds";
import type { MockTableConfig } from "@shared/test-utils/mock-d1";
import { handleHealth } from "../health";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { buildStatusD1Scenario, cleanupStatusTest } from "./status.test-support";
import { STATUS_PUBLIC_HEALTH_SNAPSHOT_CACHE_KEY } from "../../lib/status/public-health-snapshot";
import { mockD1 } from "@shared/test-utils/mock-d1";
import type { HealthResponse } from "@shared/types/status";
import { loadStablecoinsPublicationContinuity } from "../../cron/sync-stablecoins/publication";
import { buildStablecoinsSyncResult } from "../../cron/sync-stablecoins/metadata";
import { fxRatesCacheRows } from "../../lib/__tests__/fx-rate-state.test-support";
import { evaluateStablecoinActivePriceCoverage } from "../../lib/stablecoin-publication-coverage";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { assessD1Capacity } from "@shared/lib/d1-capacity";
type HealthDbOptions = {
  extraCacheRows?: Record<string, unknown>[];
  dexAge?: number;
  blacklistEntry?: MockTableConfig;
  publicationEntry?: MockTableConfig;
  symbolRows?: Record<string, unknown>[];
  statusStartedAt?: number;
  extras?: MockTableConfig[];
  yieldSentinelAge?: number | null;
  producerCronRows?: Record<string, unknown>[];
  producerCronError?: unknown;
};

function makePublicHealthSnapshotRow(now: number, publicHealth: HealthResponse) {
  return {
    key: STATUS_PUBLIC_HEALTH_SNAPSHOT_CACHE_KEY,
    updated_at: now - 60,
    value: JSON.stringify({ version: 1, producedAt: now - 60, publicHealth }),
  };
}

const STABLECOIN_COVERAGE_QUERY_MATCH =
  "metadata LIKE '%\"activePublicationCoverage\"%'";

function healthD1(tables: MockTableConfig[]) {
  return buildStatusD1Scenario({
    sections: ["sentinel"],
    overrides: [
      ...tables.map((table) => ({ ...table, allowUnused: true })),
      { match: STABLECOIN_COVERAGE_QUERY_MATCH, rows: [], first: null, allowUnused: true },
      { match: "FROM dex_liquidity", rows: [], first: { age: 60 }, allowUnused: true },
      { match: "FROM yield_data", rows: [], first: { age: 60 }, allowUnused: true },
      { match: "key LIKE 'circuit:%'", rows: [], allowUnused: true },
      { match: "blacklist-gap-metrics-cache-read", rows: [], first: null, allowUnused: true },
      { match: "blacklist-gap-metrics-cache-write", rows: [], allowUnused: true },
      {
        match: "status IN ('ok', 'degraded')",
        rows: [],
        first: { item_count: 0, metadata: null },
        allowUnused: true,
      },
      { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null, allowUnused: true },
      { match: "stamped_identity", rows: [], first: null, allowUnused: true },
      { match: "publication_identity", rows: [], first: null, allowUnused: true },
      { match: "telegram_subscribers", rows: [], first: { n: 0 }, allowUnused: true },
      { match: "telegram_deliveries", rows: [], first: null, allowUnused: true },
      { match: "dispatch-telegram-alerts", rows: [], first: null, allowUnused: true },
    ],
  });
}

function completePublicationEntry(
  now: number,
  activePriceCoverage: Record<string, unknown> = {
    complete: true,
    expectedActiveCount: ACTIVE_IDS.size,
    presentActiveCount: ACTIVE_IDS.size,
    pricedActiveCount: ACTIVE_IDS.size,
    missingPriceCount: 0,
    pricedActiveIds: [...ACTIVE_IDS],
    missingActiveIds: [],
    affectedMarketCapUsd: 0,
    missingActiveAssets: [],
    alertEligibleCount: 0,
    alertEligibleIds: [],
    maxConsecutiveMissingGenerations: 0,
  },
): MockTableConfig {
  return {
    match: STABLECOIN_COVERAGE_QUERY_MATCH,
    rows: [],
    first: {
      started_at: now - 30,
      metadata: JSON.stringify({
        activePublicationCoverage: {
          complete: true,
          expectedActiveCount: ACTIVE_IDS.size,
          presentActiveCount: ACTIVE_IDS.size,
          waivedActiveCount: 0,
          missingActiveIds: [],
          waivedActiveIds: [],
          expiredWaiverIds: [],
        },
        activePriceCoverage,
      }),
    },
  };
}

function dewsPublicationEntry(now: number): MockTableConfig {
  const updatedAt = now - 60;
  const row = {
    key: "dews:published-generation",
    updated_at: updatedAt,
    value: JSON.stringify({
      updatedAt,
      source: "compute-dews",
      publishStatus: "published",
      coverageVersion: 2,
      expectedRowCount: 1,
      stablecoinIdsDigest: "a".repeat(64),
    }),
  };
  return {
    match: "FROM cache WHERE key = ?",
    matchBinds: ["dews:published-generation"],
    rows: [row],
    first: row,
  };
}

function makeHealthyHealthDb(now: number, options: HealthDbOptions = {}) {
  const {
    extraCacheRows = [],
    dexAge = 60,
    blacklistEntry = { match: "blacklist_events", rows: [], first: { total: 0, missing: 0, missing_recent: 0 } },
    publicationEntry = completePublicationEntry(now),
    symbolRows = [{ symbol: "USDT", latest: now - 600 }],
    statusStartedAt = now - 300,
    extras = [],
    yieldSentinelAge = 60,
    producerCronRows = ["sync-dex-liquidity", "sync-yield-data", "compute-dews"].map((job) => ({
      job, started_at: now - 60, generation_id: "fixture-generation", degraded_runs_since_ok: 0,
    })),
    producerCronError,
  } = options;

  return healthD1([
    publicationEntry,
    dewsPublicationEntry(now),
    {
      match: "cache WHERE key IN",
      rows: [
        { key: "stablecoins", updated_at: now - 60, value: "{}" },
        { key: "stablecoin-charts", updated_at: now - 60, value: "{}" },
        { key: "usds-status", updated_at: now - 60, value: "{}" },
        ...fxRatesCacheRows(now - 60),
        { key: "bluechip-ratings", updated_at: now - 60, value: "{}" },
        // Sentinel-backed lanes attest their own published generation; without
        // one the reader can only fall back and must publish a degraded quality
        // verdict, so the steady-state fixture carries them.
        { key: "freshness:dex-liquidity", updated_at: now - dexAge, value: JSON.stringify({ updatedAt: now - dexAge, source: "sync-dex-liquidity", publishStatus: "ok", generationId: "fixture-generation" }), served_generation_id: "fixture-generation" },
        ...(yieldSentinelAge == null
          ? []
          : [{ key: "freshness:yield-data", updated_at: now - yieldSentinelAge, value: JSON.stringify({ updatedAt: now - yieldSentinelAge, source: "sync-yield-data", publishStatus: "ok", generationId: "fixture-generation" }), served_generation_id: "fixture-generation" }]),
        { key: "freshness:dews", updated_at: now - 60, value: JSON.stringify({ updatedAt: now - 60, source: "compute-dews", publishStatus: "ok", generationId: "fixture-generation" }), served_generation_id: "fixture-generation" },
        ...extraCacheRows,
      ],
    },
    { match: "dex_liquidity", rows: [], first: { age: dexAge } },
    { match: "yield_data", rows: [], first: { age: 60 } },
    { match: "stress_signals", rows: [], first: { age: 60 } },
    blacklistEntry,
    { match: "mint_burn_hourly", rows: [], first: { total: 1234 } },
    { match: "SELECT MAX(timestamp) as latest FROM mint_burn_events", rows: [], first: { latest: now - 30 } },
    { match: "SELECT MAX(hour_ts) as latest FROM mint_burn_hourly", rows: [], first: { latest: now - 3600 } },
    { match: "SELECT symbol, MAX(timestamp) as latest", rows: symbolRows },
    {
      match: "GROUP BY job",
      rows: producerCronRows,
      ...(producerCronError ? { throwError: producerCronError } : {}),
    },
    { match: "SELECT status", rows: [], first: { status: "ok" } },
    { match: "status = 'ok'", rows: [], first: { started_at: statusStartedAt } },
    ...extras,
    ...(extras.some((entry) => entry.matchBinds?.includes("ops:d1-capacity:v1")) ? [] : [{
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      matchBinds: ["ops:d1-capacity:v1"],
      rows: [],
      first: {
        value: JSON.stringify({ version: 1, assessment: assessD1Capacity({ observedAt: now, databaseSizeBytes: 1_000_000_000 }) }),
        updated_at: now,
      },
    }]),
    ...(extras.some((entry) => entry.matchBinds?.includes("report-cards:v9:publication-health")) ? [] : [{
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      matchBinds: ["report-cards:v9:publication-health"],
      rows: [],
      first: {
        value: stableJsonStringifyV1({
          schemaVersion: 2, status: "current", acceptedPublicationGenerationId: "fixture-safety-generation",
          acceptedAtSec: now - 60, attemptedAtSec: now - 60, heldSinceSec: null, reasons: [],
        }),
        updated_at: now - 60,
      },
    }]),
  ]);
}

describe("handleHealth", () => {
  afterEach(cleanupStatusTest);
  it.each(["nominal", "observed", "neither"] as const)(
    "keeps %s coverage distinct through the health handler",
    async (kind) => {
      const now = Math.floor(Date.now() / 1000);
      const id = [...ACTIVE_IDS][0]!;
      const nominalPriceReference = { price: 1, source: "protocol-par", mode: "nominal_reference" as const };
      const assets = [...ACTIVE_IDS].map((stablecoinId) => ({
        id: stablecoinId,
        price: stablecoinId !== id ? 1 : kind === "neither" ? null : kind === "observed" ? 0.97 : 1,
        priceObservedAtMode: stablecoinId === id && kind === "nominal" ? "nominal_reference" : "upstream",
        priceSource: stablecoinId === id && kind === "nominal" ? "protocol-par" : "coingecko",
        ...(stablecoinId === id && kind !== "neither" ? { nominalPriceReference } : {}),
        circulating: { peggedUSD: 200_000_000 },
      }));
      const prior = evaluateStablecoinActivePriceCoverage(
        [{ id, price: null }], [id], { nowSec: now },
      );
      prior.missingActiveAssets[0].consecutiveMissingGenerations = 800;
      const coverage = evaluateStablecoinActivePriceCoverage(assets, undefined, { previousCoverage: prior, nowSec: now });
      const body = await (await handleHealth(makeHealthyHealthDb(now, {
        publicationEntry: completePublicationEntry(now, coverage),
      }))).json() as HealthResponse;
      expect(body.activePriceCoverage).toMatchObject({
        status: kind === "neither" ? "incomplete" : "complete",
        pricedActiveCount: ACTIVE_IDS.size - (kind === "observed" ? 0 : 1),
        nominalReferenceCount: kind === "nominal" ? 1 : 0,
        nominalReferenceMarketCapUsd: kind === "nominal" ? 200_000_000 : 0,
        nominalReferenceIds: kind === "nominal" ? [id] : [],
        nominalReferenceReason: "reviewed-nominal-reference",
        missingActiveIds: kind === "neither" ? [id] : [],
        alertEligibleIds: kind === "neither" ? [id] : [],
      });
      if (kind === "neither") {
        expect(body.warnings).toContain(`active-price-coverage-incomplete:${id}`);
        expect(body.warnings).toContain(`active-price-coverage-critical-duration:${id}`);
      } else {
        expect(body.warnings.filter((warning) => warning.startsWith("active-price-coverage"))).toEqual([]);
        expect(body.activePriceCoverage!.missingActiveAssets).toEqual([]);
      }
    },
  );
  it.each(["read-error", "malformed", "missing"] as const)(
    "preserves publication continuity through the writer and health handler: %s",
    async (priorState) => {
      const now = Math.floor(Date.now() / 1000);
      const priorDb = mockD1([{
        match: "activePriceCoverage",
        rows: [],
        ...(priorState === "read-error" ? { throwError: new Error("read unavailable") }
          : { first: priorState === "missing" ? null : { metadata: '{"activePriceCoverage":{}}' } }),
      }]);
      const continuity = await loadStablecoinsPublicationContinuity(priorDb, now);
      const missingId = "usdt-tether";
      const assets = [...ACTIVE_IDS].map((id) => ({
        id, name: id, symbol: id, price: id === missingId ? null : 1,
        circulating: { peggedUSD: 200_000_000 },
      }));
      const written = buildStablecoinsSyncResult({
        assets, rawAssetCount: assets.length, droppedMalformedAssets: 0,
        canonicalDeduplication: { duplicateRows: 0, affectedIds: [] },
        enrichStats: {}, priceValidationStats: {}, providerDiagnostics: [], rejectedCount: 0,
        stalenessWarning: false, stalenessCheckFailed: false, gtProbe: { stats: {} as never },
        depegErrorCount: 0, depegErrors: [], syncStartSec: now,
        previousActivePriceCoverage: continuity.previousActivePriceCoverage,
      });
      const metadata = JSON.parse(written.metadata!);
      const body = await (await handleHealth(makeHealthyHealthDb(now, {
        publicationEntry: {
          match: STABLECOIN_COVERAGE_QUERY_MATCH, rows: [],
          first: { started_at: now, metadata: written.metadata },
        },
      }))).json() as HealthResponse;
      const gap = body.activePriceCoverage!.missingActiveAssets[0];
      if (priorState === "missing") {
        expect(gap.consecutiveMissingGenerations).toBe(1);
        expect(gap.alertEligible).toBe(false);
        expect(continuity.previousMissingGenerationsById.has(missingId)).toBe(false);
      } else {
        expect(metadata.activePriceCoverage.maxConsecutiveMissingGenerations).toBeNull();
        expect(gap.consecutiveMissingGenerations).toBeNull();
        expect(gap.streakUnavailableReason).toBe(
          priorState === "read-error" ? "previous-coverage-read-failed" : "previous-coverage-malformed",
        );
        expect(body.warnings).toContain(`active-price-coverage-incomplete:${missingId}`);
        expect(gap.alertEligible).toBe(true);
        expect(continuity.previousMissingGenerationsById.size).toBe(0);
      }
    },
  );

  it("publishes null rather than zero for unreadable affected market cap", async () => {
    const now = Math.floor(Date.now() / 1000);
    const publicationEntry = completePublicationEntry(now);
    const row = publicationEntry.first as { started_at: number; metadata: string };
    const metadata = JSON.parse(row.metadata);
    metadata.activePriceCoverage.affectedMarketCapUsd = "malformed";
    row.metadata = JSON.stringify(metadata);
    const body = await (await handleHealth(makeHealthyHealthDb(now, { publicationEntry }))).json() as HealthResponse;
    expect(body.activePriceCoverage).toMatchObject({
      status: "unknown", unavailableReason: "coverage-malformed", affectedMarketCapUsd: null,
    });
  });
  it("serves a fresh public-health projection from one snapshot read", async () => {
    // A healthy cached aggregate still reads delivery evidence on this request.
    // Pin the clock: the handler stamps its own response time, so a real
    // second boundary between the two handleHealth calls would flake.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now());
    const now = Math.floor(Date.now() / 1000);
    const publicHealth = await (await handleHealth(makeHealthyHealthDb(now))).json() as HealthResponse;
    expect(publicHealth.status).toBe("healthy");
    expect(publicHealth.caches["fx-rates"].healthy).toBe(true);
    expect(publicHealth.activePriceCoverage).toMatchObject({ status: "complete" });
    const row = makePublicHealthSnapshotRow(now, publicHealth);
    const db = buildStatusD1Scenario({
      sections: [],
      overrides: [{
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [STATUS_PUBLIC_HEALTH_SNAPSHOT_CACHE_KEY],
        rows: [],
        first: row,
      }],
    });

    const response = await handleHealth(db);
    const body = await response.json() as HealthResponse;

    expect(body).toMatchObject({ ...publicHealth, timestamp: now });
    expect(db.getHistory()).toHaveLength(2);
    db.assertAllMatchesUsed();
    vi.useRealTimers();
  });
  it.each([
    [4800, "healthy", "degraded", "delayed", true],
    [7200, "degraded", "stale", "degraded", false],
    [14400, "stale", "stale", "outage", false],
  ] as const)("ages cached evidence across the %ss band within snapshot TTL", async (band, before, after, state, healthy) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const now = Math.floor(Date.now() / 1000);
    const assessedAt = now - 60;
    const publicHealth = await (await handleHealth(makeHealthyHealthDb(now))).json() as HealthResponse;
    publicHealth.timestamp = assessedAt;
    publicHealth.status = before;
    for (const evidence of ["published", "legacy"] as const) {
      publicHealth.assessedAt = assessedAt;
      if (evidence === "legacy") delete publicHealth.assessedAt;
      // An earlier cache hit's response clock must not renew the assessment.
      publicHealth.timestamp = evidence === "published" ? now - 10 : assessedAt;
      publicHealth.caches.stablecoins = {
        ageSeconds: band - 30, maxAge: 600, healthy: band <= 7200,
        ...(evidence === "published" ? { publishedAt: assessedAt - band + 30, generationId: "retained-generation" } : {}),
      };
      const row = makePublicHealthSnapshotRow(now, publicHealth);
      const db = buildStatusD1Scenario({ sections: [], overrides: [{
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [STATUS_PUBLIC_HEALTH_SNAPSHOT_CACHE_KEY], rows: [], first: row,
      }] });
      const body = await (await handleHealth(db)).json() as HealthResponse;
      expect(body).toMatchObject({ status: after, timestamp: now, assessedAt });
      expect(body.caches.stablecoins).toMatchObject({ ageSeconds: band + 30, healthy, maxAge: 600 });
      if (evidence === "published") {
        expect(body.caches.stablecoins).toMatchObject({
          publishedAt: assessedAt - band + 30, generationId: "retained-generation",
        });
      }
      expect(body.components!.find((item) => item.id === "stablecoin-data")).toMatchObject({
        state, ageSeconds: band + 30, since: null,
      });
      expect(body.schedulerLiveness?.observedAt).toBe(now);
      db.assertAllMatchesUsed();
    }
  });
  describe("read-time freshness sentinel re-read", () => {
    const yieldInterval = 3_600;
    async function delayedYieldSnapshot(now: number, statusExcludingCacheFreshness?: HealthResponse["status"]) {
      const publicHealth = await (await handleHealth(makeHealthyHealthDb(now))).json() as HealthResponse;
      publicHealth.timestamp = now - 60;
      publicHealth.assessedAt = now - 60;
      publicHealth.status = "degraded";
      // Past 3x the hourly producer: Delayed in the stored projection.
      publicHealth.caches["yield-data"] = {
        ...publicHealth.caches["yield-data"], ageSeconds: 3 * yieldInterval + 600,
        publishedAt: now - 60 - 3 * yieldInterval - 600, healthy: false,
      };
      return {
        key: STATUS_PUBLIC_HEALTH_SNAPSHOT_CACHE_KEY,
        updated_at: now - 60,
        value: JSON.stringify({
          version: 1, producedAt: now - 60, publicHealth,
          ...(statusExcludingCacheFreshness ? { statusExcludingCacheFreshness } : {}),
        }),
      };
    }
    function sentinelDb(now: number, row: Record<string, unknown>, sentinel: MockTableConfig) {
      return buildStatusD1Scenario({ sections: [], overrides: [
        { match: "SELECT value, updated_at FROM cache WHERE key = ?", matchBinds: [STATUS_PUBLIC_HEALTH_SNAPSHOT_CACHE_KEY], rows: [], first: row },
        sentinel,
        { match: "GROUP BY job", rows: [{ job: "sync-yield-data", started_at: now - 30, generation_id: "recovered-generation", degraded_runs_since_ok: 0 }], allowUnused: true },
      ] });
    }
    const recoveredSentinel = (now: number): MockTableConfig => ({
      match: "cache WHERE key IN",
      rows: [{
        key: "freshness:yield-data", updated_at: now - 30, observed_at: now,
        value: JSON.stringify({ updatedAt: now - 30, source: "sync-yield-data", publishStatus: "ok", generationId: "recovered-generation" }),
        served_generation_id: "recovered-generation",
      }],
    });

    it("clears Delayed at once when the producer has published since the snapshot", async () => {
      vi.spyOn(Date, "now").mockReturnValue(Date.now());
      const now = Math.floor(Date.now() / 1000);
      const db = sentinelDb(now, await delayedYieldSnapshot(now, "healthy"), recoveredSentinel(now));
      const body = await (await handleHealth(db)).json() as HealthResponse;
      expect(body.caches["yield-data"]).toMatchObject({ ageSeconds: 30, publishedAt: now - 30, healthy: true });
      expect(body.status).toBe("healthy");
      expect(body.components!.find((item) => item.id === "yield")).toMatchObject({ state: "operational", reasons: [] });
      expect(body.components!.find((item) => item.id === "website-api")!.state).toBe("operational");
    });

    it("keeps a genuinely late producer Delayed and never re-reads healthy lanes", async () => {
      vi.spyOn(Date, "now").mockReturnValue(Date.now());
      const now = Math.floor(Date.now() / 1000);
      const stillLate = recoveredSentinel(now);
      const lateAt = now - 3 * yieldInterval - 660;
      stillLate.rows = [{ ...stillLate.rows![0], updated_at: lateAt,
        value: JSON.stringify({ updatedAt: lateAt, source: "sync-yield-data", publishStatus: "ok", generationId: "recovered-generation" }) }];
      const db = sentinelDb(now, await delayedYieldSnapshot(now, "healthy"), stillLate);
      const body = await (await handleHealth(db)).json() as HealthResponse;
      expect(body.status).toBe("degraded");
      expect(body.components!.find((item) => item.id === "yield")!.state).toBe("delayed");
      const sentinelReads = db.getHistory().filter((entry) => entry.sql.includes("FROM cache WHERE key IN"));
      expect(sentinelReads.map((entry) => entry.binds)).toEqual([["freshness:yield-data"]]);
    });

    it.each(["legacy snapshot", "read failure"] as const)("fails closed to the stored ages on a %s", async (kind) => {
      vi.spyOn(Date, "now").mockReturnValue(Date.now());
      const now = Math.floor(Date.now() / 1000);
      const sentinel = recoveredSentinel(now);
      if (kind === "read failure") sentinel.throwError = new Error("sentinel read failed");
      if (kind === "legacy snapshot") sentinel.allowUnused = true;
      const db = sentinelDb(now, await delayedYieldSnapshot(now, kind === "legacy snapshot" ? undefined : "healthy"), sentinel);
      const body = await (await handleHealth(db)).json() as HealthResponse;
      expect(body.status).toBe("degraded");
      expect(body.caches["yield-data"].ageSeconds).toBe(3 * yieldInterval + 660);
      expect(body.components!.find((item) => item.id === "yield")!.state).toBe("delayed");
    });
  });

  it.each([false, true])("retains independent raw and quality blockers (rejected clock: %s)", async (rejectedClock) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const now = Math.floor(Date.now() / 1000);
    const publicHealth = await (await handleHealth(makeHealthyHealthDb(now))).json() as HealthResponse;
    publicHealth.timestamp = now - 60;
    publicHealth.assessedAt = now - 60;
    publicHealth.status = "stale";
    publicHealth.warnings = ["independent-blocker"];
    publicHealth.caches.stablecoins = {
      ageSeconds: 30, maxAge: 600, publishedAt: now - 90, healthy: false,
      degraded: true, degradedReason: "retained-input-failure", streakDegradedRuns: 3,
    };
    if (rejectedClock) {
      publicHealth.caches["stablecoin-charts"] = {
        ageSeconds: null, maxAge: 3600, healthy: false,
        publishedAt: now - 30, timestampReason: "future-timestamp",
      };
    }
    const row = makePublicHealthSnapshotRow(now, publicHealth);
    const db = buildStatusD1Scenario({ sections: [], overrides: [{
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      matchBinds: [STATUS_PUBLIC_HEALTH_SNAPSHOT_CACHE_KEY], rows: [], first: row,
    }] });
    const body = await (await handleHealth(db)).json() as HealthResponse;
    expect(body).toMatchObject({ status: "stale", timestamp: now, assessedAt: now - 60 });
    expect(body.warnings).toContain("independent-blocker");
    expect(body.caches.stablecoins).toMatchObject({
      ageSeconds: 90, healthy: false, degraded: true,
      degradedReason: "retained-input-failure", streakDegradedRuns: 3,
    });
    if (rejectedClock) {
      expect(body.caches["stablecoin-charts"]).toMatchObject({
        ageSeconds: null, healthy: false, timestampReason: "future-timestamp",
      });
    }
    expect(body.schedulerLiveness).toMatchObject({ status: "healthy", observedAt: now });
    expect(body.components!.find((item) => item.id === "stablecoin-data")!.reasons)
      .toContain("cache:stablecoins:quality:retained-input-failure");
  });
  it("detects a stall from live starts despite a healthy fresh snapshot", async () => {
    const now = Math.floor(Date.now() / 1000);
    const publicHealth = await (await handleHealth(makeHealthyHealthDb(now))).json() as HealthResponse;
    const row = makePublicHealthSnapshotRow(now, publicHealth);
    const db = buildStatusD1Scenario({ sections: [], overrides: [
      { match: "SELECT value, updated_at FROM cache WHERE key = ?", matchBinds: [STATUS_PUBLIC_HEALTH_SNAPSHOT_CACHE_KEY], rows: [], first: row },
      { match: "AS last_any", rows: [], first: { observed_at: now, last_any: now - 1, reserve: now - 1201, telegram: now - 1201, digest: now - 1201, heavy: now - 30 } },
    ] });
    const body = await (await handleHealth(db)).json() as HealthResponse;
    expect(body.status).toBe("stale");
    expect(body.warnings).toContain("scheduled_delivery_stalled");
    expect(body.schedulerLiveness?.ageSeconds).toBe(1201);
  });
  it.each([
    [1801, "degraded", "heavy_scheduled_delivery_stalled"],
    [2701, "stale", "heavy_scheduled_delivery_stalled"],
    [null, "degraded", "heavy_scheduler_liveness_unavailable"],
  ] as const)("detects heavy delivery loss (%s) through a healthy cached projection", async (age, status, warning) => {
    // Keep the exact age assertion independent of a wall-clock second boundary.
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const now = Math.floor(Date.now() / 1000);
    const publicHealth = await (await handleHealth(makeHealthyHealthDb(now))).json() as HealthResponse;
    const row = makePublicHealthSnapshotRow(now, publicHealth);
    const db = buildStatusD1Scenario({ sections: [], overrides: [
      { match: "SELECT value, updated_at FROM cache WHERE key = ?", matchBinds: [STATUS_PUBLIC_HEALTH_SNAPSHOT_CACHE_KEY], rows: [], first: row },
      { match: "AS last_any", rows: [], first: {
        observed_at: now,
        last_any: now - 1, reserve: now - 30, telegram: now - 30, digest: now - 30,
        heavy: age == null ? null : now - age,
      } },
    ] });
    const body = await (await handleHealth(db)).json() as HealthResponse;
    expect(body.status).toBe(status);
    expect(body.schedulerLiveness?.status).toBe("healthy");
    expect(body.schedulerLiveness?.heavy.ageSeconds).toBe(age);
    expect(body.warnings).toContain(warning);
    expect(body.warnings).not.toContain("scheduled_delivery_stalled");
  });
  it("clears a cached heavy scheduler floor by recomputing independent blockers live", async () => {
    const now = Math.floor(Date.now() / 1000);
    const publicHealth = await (await handleHealth(makeHealthyHealthDb(now))).json() as HealthResponse;
    publicHealth.status = "stale";
    publicHealth.warnings = ["heavy_scheduled_delivery_stalled"];
    publicHealth.schedulerLiveness!.heavy.status = "stale";
    const row = makePublicHealthSnapshotRow(now, publicHealth);
    const body = await (await handleHealth(makeHealthyHealthDb(now, { dexAge: 1_000_000, extraCacheRows: [row] }))).json() as HealthResponse;
    expect(body.schedulerLiveness?.heavy.status).toBe("healthy");
    expect(body.warnings).not.toContain("heavy_scheduled_delivery_stalled");
    expect(body.status).toBe("stale");
  });
  it("clears a cached scheduler floor only through live recomputation, retaining independent stale caches", async () => {
    const now = Math.floor(Date.now() / 1000);
    const publicHealth = await (await handleHealth(makeHealthyHealthDb(now))).json() as HealthResponse;
    publicHealth.status = "stale";
    publicHealth.warnings = ["scheduled_delivery_stalled"];
    publicHealth.schedulerLiveness!.status = "stale";
    const row = makePublicHealthSnapshotRow(now, publicHealth);
    const db = makeHealthyHealthDb(now, { dexAge: 1_000_000, extraCacheRows: [row] });
    const body = await (await handleHealth(db)).json() as HealthResponse;
    expect(body.schedulerLiveness?.status).toBe("healthy");
    expect(body.warnings).not.toContain("scheduled_delivery_stalled");
    expect(body.status).toBe("stale");
  });
  const telegramCapacityRow = {
    total: 3,
    expired: 0,
    due: 2,
    deferred: 1,
    near_ttl: 0,
    oldest_pending_created_at: null,
    oldest_due_created_at: null,
    pending_sending: 0,
    pending_execution_unknown: 0,
    sent_cleanup: 0,
    oldest_pending_execution_unknown_at: null,
    fresh_sending: 0,
    fresh_execution_unknown: 0,
    oldest_fresh_execution_unknown_at: null,
    fresh_uncertain_sample_count: 0,
  };
  it("returns 200 with health status", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = healthD1([
      completePublicationEntry(now),
      dewsPublicationEntry(now),
      yieldHealthEntry(now),
      {
        match: "GROUP BY job",
        rows: ["sync-dex-liquidity", "sync-yield-data", "compute-dews"].map((job) => ({
          job, started_at: now - 60, generation_id: "fixture-generation", degraded_runs_since_ok: 0,
        })),
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["ops:d1-capacity:v1"],
        rows: [],
        first: {
          value: JSON.stringify({ version: 1, assessment: assessD1Capacity({ observedAt: now, databaseSizeBytes: 1_000_000_000 }) }),
          updated_at: now,
        },
      },
      {
        match: "cache WHERE key IN",
        rows: [
          { key: "freshness:dex-liquidity", updated_at: now - 60, value: JSON.stringify({ updatedAt: now - 60, source: "sync-dex-liquidity", publishStatus: "ok", generationId: "fixture-generation" }), served_generation_id: "fixture-generation" },
          { key: "freshness:yield-data", updated_at: now - 60, value: JSON.stringify({ updatedAt: now - 60, source: "sync-yield-data", publishStatus: "ok", generationId: "fixture-generation" }), served_generation_id: "fixture-generation" },
          { key: "freshness:dews", updated_at: now - 60, value: JSON.stringify({ updatedAt: now - 60, source: "compute-dews", publishStatus: "ok", generationId: "fixture-generation" }), served_generation_id: "fixture-generation" },
        ],
      },
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "mint_burn_hourly", rows: [], first: { total: 1234 } },
      { match: "SELECT status", rows: [], first: { status: "ok" } },
      { match: "status = 'ok'", rows: [], first: { started_at: now - 300 } },
      {
        match: "item_count, metadata",
        rows: [],
        first: { item_count: 4321, metadata: JSON.stringify({ rowCount: 4321 }) },
      },
    ]);
    const res = await handleHealth(db);
    const body = (await readJsonResponse(res, 200)) as {
      status: string;
      timestamp: number;
      warnings: string[];
      caches: Record<string, unknown>;
      blacklist: {
        totalEvents: number;
        missingAmounts: number;
        recentMissingAmounts: number;
        recentWindowSec: number;
        missingRatio: number;
      };
      mintBurn: {
        totalEvents: number | null;
        latestEventTs: number | null;
        latestHourlyTs: number | null;
        freshnessAgeSec: number | null;
        majorStaleCount: number;
        staleMajorSymbols: string[];
        sync: {
          lastSuccessfulSyncAt: number | null;
          freshnessStatus: FreshnessStatus;
          warning: string | null;
          criticalLaneHealthy: boolean;
        };
      };
      circuits: Record<string, unknown>;
    };
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("timestamp");
    expect(body).toHaveProperty("warnings");
    expect(body).toHaveProperty("caches");
    expect(body).toHaveProperty("blacklist");
    expect(body).toHaveProperty("mintBurn");
    expect(body).toHaveProperty("circuits");
    expect(body).not.toHaveProperty("d1Capacity");
    expect(body.blacklist).toMatchObject({
      totalEvents: 0,
      missingAmounts: 0,
      recentMissingAmounts: 0,
      missingRatio: 0,
    });
    expect(body.mintBurn.totalEvents).toBe(4321);
    expect(body.warnings).toEqual([]);
    expect(body.mintBurn).toHaveProperty("latestEventTs");
    expect(body.mintBurn).toHaveProperty("latestHourlyTs");
    expect(body.mintBurn).toHaveProperty("freshnessAgeSec");
    expect(body.mintBurn).toHaveProperty("majorStaleCount");
    expect(body.mintBurn).toHaveProperty("staleMajorSymbols");
    expect(body.mintBurn).toHaveProperty("sync");
    expect(["healthy", "degraded", "stale"]).toContain(body.status);
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM mint_burn_events"))).toBe(false);
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM mint_burn_hourly"))).toBe(false);
    expect(db.getHistory().some((entry) => entry.sql.includes("sqlite_sequence"))).toBe(false);
  });

  it("does not expose exact D1 capacity telemetry on the public response", async () => {
    const now = Math.floor(Date.now() / 1000);
    const assessment = {
      observedAt: now,
      databaseSizeBytes: 7_500_000_000,
      maximumSizeBytes: 10_000_000_000,
      utilizationRatio: 0.75,
      utilizationPercent: 75,
      thresholdState: "warning",
      crossedThresholdPercent: 75,
      nextThresholdPercent: 90,
      sampleCount: 72,
      forecastBasis: "linear-30d",
      forecastSpanHours: 71,
      growthBytesPerDay: 100_000_000,
      nextThresholdAt: now + 15 * 86_400,
      exhaustionAt: now + 25 * 86_400,
      daysUntilExhaustion: 25,
    };
    const db = makeHealthyHealthDb(now, {
      extras: [
        {
          match: "SELECT value, updated_at FROM cache WHERE key = ?",
          matchBinds: ["ops:d1-capacity:v1"],
          rows: [],
          first: {
            value: JSON.stringify({ version: 1, assessment }),
            updated_at: now,
          },
        },
      ],
    });

    const res = await handleHealth(db);
    const body = (await readJsonResponse(res, 200)) as {
      status: "healthy" | "degraded" | "stale";
      warnings: string[];
      d1Capacity?: unknown;
    };

    expect(body.status).toBe("degraded");
    expect(body).not.toHaveProperty("d1Capacity");
    expect(JSON.stringify(body)).not.toContain("databaseSizeBytes");
    expect(JSON.stringify(body)).not.toContain("daysUntilExhaustion");
    expect(body.warnings).toContain("d1-capacity-warning");
    expect(body.warnings.join(" ")).not.toContain("75");
  });

  it.each(["missing", "malformed", "expired", "future-clock"] as const)(
    "exposes only the sanitized unavailable capacity reason (%s)",
    async (reason) => {
      const now = Math.floor(Date.now() / 1000);
      const observedAt = reason === "expired" ? now - 26 * 3600 - 1 : reason === "future-clock" ? now + 3600 : now;
      const first = reason === "missing" ? null : {
        value: reason === "malformed" ? "{" : JSON.stringify({
          version: 1,
          assessment: assessD1Capacity({ observedAt, databaseSizeBytes: 1_000_000_000 }),
        }),
        updated_at: now,
      };
      const db = makeHealthyHealthDb(now, { extras: [{
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["ops:d1-capacity:v1"],
        rows: [],
        first,
      }] });
      const body = await (await handleHealth(db)).json() as HealthResponse;
      expect(body.status).toBe("degraded");
      expect(body.warnings).toContain(`d1-capacity-${reason}`);
      expect(body).not.toHaveProperty("d1Capacity");
      expect(JSON.stringify(body)).not.toContain("databaseSizeBytes");
    },
  );

  it("warns without degrading when a complete active publication has alert-eligible missing prices", async () => {
    const now = Math.floor(Date.now() / 1000);
    const activeIds = [...ACTIVE_IDS];
    const missingId = activeIds[0]!;
    const db = makeHealthyHealthDb(now, {
      publicationEntry: completePublicationEntry(now, {
        complete: false,
        expectedActiveCount: activeIds.length,
        presentActiveCount: activeIds.length,
        pricedActiveCount: activeIds.length - 1,
        missingPriceCount: 1,
        pricedActiveIds: activeIds.filter((stablecoinId) => stablecoinId !== missingId),
        missingActiveIds: [missingId],
        affectedMarketCapUsd: 88_000_000,
        missingActiveAssets: [{
          stablecoinId: missingId,
          symbol: "MISS",
          marketCapUsd: 88_000_000,
          currentPrice: null, currentSource: null, currentObservedAt: null, currentConfidence: null,
          lastAcceptedPrice: null, lastAcceptedSource: null, lastAcceptedObservedAt: null,
          consecutiveMissingGenerations: 2,
          rejectionReason: "no-accepted-price",
          alertEligible: true,
        }],
        alertEligibleCount: 1,
        alertEligibleIds: [missingId],
        maxConsecutiveMissingGenerations: 2,
      }),
    });

    const res = await handleHealth(db);
    const body = (await readJsonResponse(res, 200)) as {
      status: "healthy" | "degraded" | "stale";
      warnings: string[];
      stablecoinPublication: { status: string };
      activePriceCoverage: {
        status: string;
        missingActiveIds: string[];
        alertEligibleIds: string[];
      };
    };

    expect(body.status).toBe("healthy");
    expect(body.stablecoinPublication.status).toBe("complete");
    expect(body.activePriceCoverage).toMatchObject({
      status: "incomplete",
      missingActiveIds: [missingId],
      alertEligibleIds: [missingId],
    });
    expect(body.warnings).toContain(`active-price-coverage-incomplete:${missingId}`);
  });

  it("does not degrade public health for a transient (non-alert-eligible) price miss", async () => {
    const now = Math.floor(Date.now() / 1000);
    const activeIds = [...ACTIVE_IDS];
    const missingId = activeIds[0]!;
    const db = makeHealthyHealthDb(now, {
      publicationEntry: completePublicationEntry(now, {
        complete: false,
        expectedActiveCount: activeIds.length,
        presentActiveCount: activeIds.length,
        pricedActiveCount: activeIds.length - 1,
        missingPriceCount: 1,
        pricedActiveIds: activeIds.filter((stablecoinId) => stablecoinId !== missingId),
        missingActiveIds: [missingId],
        affectedMarketCapUsd: 88_000_000,
        missingActiveAssets: [{
          stablecoinId: missingId,
          symbol: "MISS",
          marketCapUsd: 88_000_000,
          currentPrice: null, currentSource: null, currentObservedAt: null, currentConfidence: null,
          lastAcceptedPrice: null, lastAcceptedSource: null, lastAcceptedObservedAt: null,
          consecutiveMissingGenerations: 1,
          rejectionReason: "no-accepted-price",
          alertEligible: false,
        }],
        alertEligibleCount: 0,
        alertEligibleIds: [],
        maxConsecutiveMissingGenerations: 1,
      }),
    });

    const res = await handleHealth(db);
    const body = (await readJsonResponse(res, 200)) as {
      status: "healthy" | "degraded" | "stale";
      warnings: string[];
      activePriceCoverage: {
        status: string;
        missingActiveIds: string[];
        alertEligibleCount: number;
      };
    };

    expect(body.status).toBe("healthy");
    expect(body.warnings.some((warning) => warning.startsWith("active-price-coverage-incomplete"))).toBe(false);
    // The public JSON payload keeps the exact miss for observability.
    expect(body.activePriceCoverage).toMatchObject({
      status: "incomplete",
      missingActiveIds: [missingId],
      alertEligibleCount: 0,
    });
  });

  it("returns the bounded realtime Cache-Control profile", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = healthD1([
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "mint_burn_hourly", rows: [], first: { total: 0 } },
      { match: "SELECT status", rows: [], first: { status: "ok" } },
      { match: "status = 'ok'", rows: [], first: { started_at: now - 300 } },
    ]);
    const res = await handleHealth(db);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=60, max-age=10");
  });

  it("does not mark quiet majors stale when the critical lane is syncing on time", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeHealthyHealthDb(now, {
      symbolRows: [
        { symbol: "USDT", latest: now - 2 * 3600 },
        { symbol: "GHO", latest: now - 8 * 3600 },
        { symbol: "BOLD", latest: now - 9 * 3600 },
        { symbol: "reUSD", latest: now - 12 * 3600 },
      ],
      statusStartedAt: now - 600,
    });

    const res = await handleHealth(db);

    const body = (await readJsonResponse(res, 200)) as {
      status: "healthy" | "degraded" | "stale";
      warnings: string[];
      mintBurn: {
        majorStaleCount: number;
        staleMajorSymbols: string[];
        sync: {
          freshnessStatus: FreshnessStatus;
          warning: string | null;
          criticalLaneHealthy: boolean;
        };
      };
    };

    expect(body.status).toBe("healthy");
    expect(body.warnings).toEqual([]);
    expect(body.mintBurn.majorStaleCount).toBe(0);
    expect(body.mintBurn.staleMajorSymbols).toEqual([]);
    expect(body.mintBurn.sync.freshnessStatus).toBe("fresh");
    expect(body.mintBurn.sync.warning).toBeNull();
    expect(body.mintBurn.sync.criticalLaneHealthy).toBe(true);
  });

  function stampedYieldIdentityJson(evaluationBuildDigest: string): string {
    return JSON.stringify({
      model: "v9",
      schemaVersion: 1,
      methodologyVersion: "9.28",
      policyId: "safety-score-v9",
      policyDigest: "c".repeat(64),
      evaluationBuildDigest,
      baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
      publicationGenerationId: `report-cards:v9:v1:${"a".repeat(64)}`,
    });
  }

  function publicationEnvelopeIdentityJson(evaluationBuildDigest: string, policyDigest = "c".repeat(64)): string {
    return JSON.stringify({
      candidateId: `safety-score-v9:v1:${"e".repeat(64)}`,
      policyVersion: "9.28",
      publicationGenerationId: `report-cards:v9:v1:${"f".repeat(64)}`,
      baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
      factSetDigest: "1".repeat(64),
      policyId: "safety-score-v9",
      policyDigest,
      evaluationBuildDigest,
      resultDigest: "2".repeat(64),
    });
  }

  function yieldHealthEntry(now: number, held = false, generationId = `report-cards:v9:v1:${"f".repeat(64)}`): MockTableConfig {
    const row = {
      updated_at: now,
      value: stableJsonStringifyV1({
        schemaVersion: 2, status: held ? "held" : "current",
        acceptedPublicationGenerationId: generationId, acceptedAtSec: now - 3600,
        attemptedAtSec: now, heldSinceSec: held ? now - 60 : null,
        reasons: held ? [{ code: "redemption-stale" }] : [],
      }),
    };
    return { match: "SELECT value, updated_at FROM cache WHERE key = ?", matchBinds: ["report-cards:v9:publication-health"], rows: [row], first: row };
  }

  it.each([
    [3600, 3600, "healthy"], [86400, 86400, "healthy"],
    [86401, 3600, "degraded"], [3600, 86401, "degraded"],
  ] as const)("keeps yield held-clock verdict %s/%s at %s while in-budget Safety Scores are held (notice)", async (yieldAge, safetyAge, status) => {
    // Fixture creation must not advance an inclusive 86400-second clock to 86401.
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const now = Math.floor(Date.now() / 1000);
    const identity = JSON.parse(stampedYieldIdentityJson("a".repeat(64)));
    const envelope = JSON.parse(publicationEnvelopeIdentityJson("a".repeat(64)));
    envelope.publicationGenerationId = identity.publicationGenerationId;
    const db = makeHealthyHealthDb(now, { extras: [
      { match: "stamped_identity", rows: [], first: { updated_at: now - yieldAge, stamped_identity: JSON.stringify(identity), safety_published_at: now - safetyAge } },
      { match: "publication_identity", rows: [], first: { publication_identity: JSON.stringify(envelope) } },
      yieldHealthEntry(now, true, identity.publicationGenerationId),
    ] });
    const body = await (await handleHealth(db)).json() as HealthResponse;
    expect(body.status).toBe(status);
    expect(body.components!.find((component) => component.id === "safety-scores")).toMatchObject({
      state: "operational", reasons: expect.arrayContaining(["safety-score-publication-held"]),
    });
    expect(body.components!.find((component) => component.id === "yield")!.state).toBe(status === "healthy" ? "operational" : "degraded");
    expect(body.warnings).toContain(status === "healthy"
      ? "yield-safety-publish-time-fallback:safety-snapshot-held"
      : "yield-safety-unrated-serving:safety-snapshot-held");
  });

  it.each(["missing", "malformed", "mismatch"] as const)("fails closed for %s publication health", async (kind) => {
    const now = Math.floor(Date.now() / 1000);
    const entry = yieldHealthEntry(now, false, "wrong-generation");
    if (kind === "malformed") entry.first = { updated_at: now, value: "{}" };
    if (kind === "missing") entry.first = null;
    const db = makeHealthyHealthDb(now, { extras: [
      { match: "stamped_identity", rows: [], first: { updated_at: now - 60, stamped_identity: stampedYieldIdentityJson("a".repeat(64)), safety_published_at: now - 60 } },
      { match: "publication_identity", rows: [], first: { publication_identity: publicationEnvelopeIdentityJson("a".repeat(64)) } },
      entry,
    ] });
    const body = await (await handleHealth(db)).json() as HealthResponse;
    expect(body.status).toBe("degraded");
    expect(body.warnings).toContain("yield-safety-availability-unknown");
  });

  it("keeps health green with a fallback warning while yield serves its publish-time safety snapshot", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeHealthyHealthDb(now, {
      extras: [
        yieldHealthEntry(now),
        {
          match: "stamped_identity",
          rows: [],
          first: { updated_at: now - 1800, stamped_identity: stampedYieldIdentityJson("a".repeat(64)), safety_published_at: now - 3600 },
        },
        {
          match: "publication_identity",
          rows: [],
          first: { publication_identity: publicationEnvelopeIdentityJson("d".repeat(64), "9".repeat(64)) },
        },
      ],
    });

    const res = await handleHealth(db);
    const body = (await res.json()) as { status: string; warnings: string[] };

    expect(body.status).toBe("healthy");
    expect(body.warnings).toContain("yield-safety-publish-time-fallback:safety-identity-mismatch");
  });

  it("raises no yield safety warning when only the evaluation-build digest rotated", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeHealthyHealthDb(now, {
      extras: [
        yieldHealthEntry(now),
        {
          match: "stamped_identity",
          rows: [],
          first: { updated_at: now - 1800, stamped_identity: stampedYieldIdentityJson("a".repeat(64)), safety_published_at: now - 3600 },
        },
        {
          match: "publication_identity",
          rows: [],
          first: { publication_identity: publicationEnvelopeIdentityJson("d".repeat(64)) },
        },
      ],
    });

    const body = (await (await handleHealth(db)).json()) as { status: string; warnings: string[] };

    expect(body.status).toBe("healthy");
    expect(body.warnings.filter((warning) => warning.startsWith("yield-safety-"))).toEqual([]);
  });

  it.each([25 * 3600, null, -60])("fails closed for unavailable stamped safety age %s despite a recent yield cache", async (safetyAge) => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeHealthyHealthDb(now, {
      extras: [yieldHealthEntry(now), {
        match: "stamped_identity", rows: [],
        first: {
          updated_at: now - 2 * 3600,
          stamped_identity: stampedYieldIdentityJson("a".repeat(64)),
          safety_published_at: safetyAge == null ? null : now - safetyAge,
        },
      }],
    });
    const body = await (await handleHealth(db)).json() as { status: string; warnings: string[] };
    expect(body.status).toBe("degraded");
    expect(body.warnings).toContain("yield-safety-unrated-serving:safety-snapshot-unavailable");
  });

  it("degrades health when yield rankings are serving unrated safety for lack of a stamped identity", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeHealthyHealthDb(now, {
      extras: [
        {
          match: "stamped_identity",
          rows: [],
          first: { updated_at: now - 1800, stamped_identity: null },
        },
      ],
    });

    const res = await handleHealth(db);
    const body = (await res.json()) as { status: string; warnings: string[] };

    expect(body.status).toBe("degraded");
    expect(body.warnings).toContain("yield-safety-unrated-serving:safety-identity-missing");
  });

  it("degrades health when a mismatched yield cache has aged past the stale-coherent window", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeHealthyHealthDb(now, {
      extras: [
        yieldHealthEntry(now),
        {
          match: "stamped_identity",
          rows: [],
          first: { updated_at: now - (24 * 3600 + 120), stamped_identity: stampedYieldIdentityJson("a".repeat(64)), safety_published_at: now - 3600 },
        },
        {
          match: "publication_identity",
          rows: [],
          first: { publication_identity: publicationEnvelopeIdentityJson("d".repeat(64), "9".repeat(64)) },
        },
      ],
    });

    const res = await handleHealth(db);
    const body = (await res.json()) as { status: string; warnings: string[] };

    expect(body.status).toBe("degraded");
    expect(body.warnings).toContain("yield-safety-unrated-serving:safety-identity-mismatch");
  });

  it("surfaces sentinel fallback metadata when a freshness sentinel is invalid", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeHealthyHealthDb(now, {
      dexAge: 45,
      extraCacheRows: [
        { key: "freshness:dex-liquidity", updated_at: now - 120, value: JSON.stringify({ updatedAt: now - 120, source: "sync-yield-data", publishStatus: "ok", generationId: "fixture-generation" }), served_generation_id: "fixture-generation" },
        { key: "freshness:yield-data", updated_at: now - 180, value: JSON.stringify({ updatedAt: now - 180, source: "sync-yield-data", publishStatus: "ok", generationId: "fixture-generation" }), served_generation_id: "fixture-generation" },
        { key: "freshness:dews", updated_at: now - 240, value: JSON.stringify({ updatedAt: now - 240, source: "compute-dews", publishStatus: "ok", generationId: "fixture-generation" }), served_generation_id: "fixture-generation" },
      ],
    });

    const res = await handleHealth(db);
    const body = (await readJsonResponse(res, 200)) as {
      warnings: string[];
      caches: Record<
        string,
        {
          ageSeconds: number | null;
          freshnessSource?: string;
          sentinelValidationReason?: string;
          warning?: string;
        }
      >;
    };

    expect(body.caches["dex-liquidity"]).toMatchObject({
      ageSeconds: 45,
      freshnessSource: "table-fallback",
      sentinelValidationReason: "wrong-source",
      warning: "dex-liquidity: freshness sentinel invalid (wrong-source); using table-fallback",
    });
    expect(body.warnings).toContain("dex-liquidity: freshness sentinel invalid (wrong-source); using table-fallback");
  });

  it("reports yield-data unhealthy when a fresh table fallback has no freshness sentinel", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeHealthyHealthDb(now, { yieldSentinelAge: null });

    const res = await handleHealth(db);
    const body = (await readJsonResponse(res, 200)) as {
      status: string;
      warnings: string[];
      caches: Record<string, {
        ageSeconds: number | null;
        freshnessSource?: string;
        degraded?: boolean;
        degradedReason?: string | null;
        streakDegradedRuns?: number | null;
        healthy: boolean;
      }>;
    };

    expect(body.status).toBe("degraded");
    expect(body.caches["yield-data"]).toMatchObject({
      ageSeconds: 60,
      freshnessSource: "table-fallback",
      degraded: true,
      degradedReason: "freshness-sentinel-missing",
      streakDegradedRuns: 0,
      healthy: false,
    });
    expect(body.warnings).toContain(
      "cache-quality-degraded: yield-data:freshness-sentinel-missing",
    );
  });

  it("reports yield-data unhealthy when its confirmed publication has degraded quality", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeHealthyHealthDb(now, {
      producerCronRows: [{
        job: "sync-yield-data",
        started_at: now - 60,
        degraded_runs_since_ok: 3,
        latest_reason: "yield-supplemental:family-degraded:aaveV3",
      }],
    });

    const res = await handleHealth(db);
    const body = (await readJsonResponse(res, 200)) as {
      status: string;
      warnings: string[];
      caches: Record<string, {
        degraded?: boolean;
        degradedReason?: string | null;
        streakDegradedRuns?: number | null;
        healthy: boolean;
      }>;
    };

    expect(body.status).toBe("degraded");
    expect(body.caches["yield-data"]).toMatchObject({
      degraded: true,
      degradedReason: "yield-supplemental:family-degraded:aaveV3",
      streakDegradedRuns: 3,
      healthy: false,
    });
    expect(body.warnings).toContain(
      "cache-quality-degraded: yield-data:yield-supplemental:family-degraded:aaveV3",
    );
  });

  it("cannot stay overall healthy without a warning when producer history is unreadable", async () => {
    const now = Math.floor(Date.now() / 1000);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const db = makeHealthyHealthDb(now, {
        producerCronError: new Error("cron lookup failed"),
      });

      const res = await handleHealth(db);
      const body = (await readJsonResponse(res, 200)) as {
        status: string;
        warnings: string[];
        caches: Record<string, {
          freshnessSource?: string;
          degraded?: boolean | null;
          degradedReason?: string | null;
          streakDegradedRuns?: number | null;
          healthy: boolean;
        }>;
      };

      expect(body.status).toBe("degraded");
      expect(body.caches["yield-data"]).toMatchObject({
        freshnessSource: "freshness-sentinel",
        degraded: null,
        degradedReason: "producer-history-unreadable",
        streakDegradedRuns: null,
        healthy: false,
      });
      expect(body.warnings.some((warning) =>
        warning.startsWith("cache-quality-unknown:")
        && warning.includes("yield-data:producer-history-unreadable"))).toBe(true);
      expect(body.warnings.some((warning) => warning.startsWith("cache-quality-degraded:"))).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("reports yield-data healthy again after a clean recovery run", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeHealthyHealthDb(now, {
      producerCronRows: ["sync-dex-liquidity", "sync-yield-data", "compute-dews"].map((job) => ({
        job, started_at: now - 60, degraded_runs_since_ok: 0,
      })),
    });

    const res = await handleHealth(db);
    const body = (await readJsonResponse(res, 200)) as {
      status: string;
      warnings: string[];
      caches: Record<string, {
        degraded?: boolean;
        degradedReason?: string | null;
        streakDegradedRuns?: number | null;
        healthy: boolean;
      }>;
    };

    expect(body.status).toBe("healthy");
    expect(body.caches["yield-data"]).toMatchObject({
      degraded: false,
      degradedReason: null,
      streakDegradedRuns: 0,
      healthy: true,
    });
    expect(body.warnings.some((warning) => warning.startsWith("cache-quality-degraded:"))).toBe(false);
  });

  it("returns stale with warnings when the DB health sentinel fails", async () => {
    const db = buildStatusD1Scenario({
      sections: ["sentinel"],
      overrides: [{ match: "SELECT 1", rows: [], throwError: new Error("db down") }],
    });

    const res = await handleHealth(db);
    const body = (await readJsonResponse(res, 200)) as {
      status: "healthy" | "degraded" | "stale";
      warnings: string[];
      caches: Record<string, unknown>;
    };

    expect(body.status).toBe("stale");
    expect(body.caches).toEqual({});
    expect(body.warnings).toContain("db-unhealthy");
  });

  it("degrades and surfaces warnings when subqueries fail", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeHealthyHealthDb(now, {
      blacklistEntry: { match: "blacklist_events", rows: [], throwError: new Error("blacklist failed") },
    });

    const res = await handleHealth(db);
    const body = (await readJsonResponse(res, 200)) as {
      status: "healthy" | "degraded" | "stale";
      warnings: string[];
    };

    expect(body.status).toBe("degraded");
    expect(body.warnings).toContain("blacklist-query-failed");
    expect(body.warnings.join(" ")).not.toContain("blacklist failed");
  });

  it("keeps health degraded rather than stale when FX is in repeated cached-fallback with fresh usable sync", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeHealthyHealthDb(now, {
      extraCacheRows: [
        {
          key: "fx-rates-meta",
          updated_at: now - 60,
          value: JSON.stringify({
            usableSyncAt: now - 60,
            mode: "cached-fallback",
            sourceUpdatedAtByPeg: { peggedEUR: now - 8 * 3600 },
            sourceModeByPeg: { peggedEUR: "cached" },
            sourceCadenceByPeg: { peggedEUR: "intraday" },
            consecutiveFallbackRuns: 4,
          }),
        },
      ],
    });

    const res = await handleHealth(db);
    const body = (await res.json()) as {
      status: string;
      warnings: string[];
      caches: Record<string, { mode?: string; sourceStatus?: string }>;
    };

    expect(body.status).toBe("degraded");
    expect(body.caches["fx-rates"]).toMatchObject({
      mode: "cached-fallback",
      sourceStatus: "degraded",
    });
    expect(body.warnings.some((warning) => warning.includes("cached fallback FX rates"))).toBe(true);
  });

  it("degrades when three or more circuit groups are open", async () => {
    const now = Math.floor(Date.now() / 1000);
    const openCircuitValue = (openedAt: number) =>
      JSON.stringify({
        state: "open",
        consecutiveFailures: 3,
        lastFailureAt: openedAt - 30,
        lastSuccessAt: null,
        openedAt,
      });
    const db = makeHealthyHealthDb(now, {
      extras: [
        {
          match: "key LIKE 'circuit:%'",
          rows: [
            { key: "circuit:defillama-stablecoins", value: openCircuitValue(now - 600) },
            { key: "circuit:coingecko-prices", value: openCircuitValue(now - 540) },
            { key: "circuit:dexscreener-prices", value: openCircuitValue(now - 480) },
          ],
        },
      ],
    });

    const res = await handleHealth(db);
    const body = (await res.json()) as {
      status: "healthy" | "degraded" | "stale";
      circuits: Record<string, { state: string }>;
    };

    expect(body.status).toBe("degraded");
    expect(Object.values(body.circuits).filter((circuit) => circuit.state === "open")).toHaveLength(3);
  });

  it("keeps public health healthy when only live-reserve circuit groups are open", async () => {
    const now = Math.floor(Date.now() / 1000);
    const openCircuitValue = (openedAt: number) =>
      JSON.stringify({
        state: "open",
        consecutiveFailures: 3,
        lastFailureAt: openedAt - 30,
        lastSuccessAt: null,
        openedAt,
      });
    const db = makeHealthyHealthDb(now, {
      extras: [
        {
          match: "key LIKE 'circuit:%'",
          rows: [
            { key: "circuit:live-reserves:ethena", value: openCircuitValue(now - 600) },
            { key: "circuit:live-reserves:feusd-felix", value: openCircuitValue(now - 540) },
            { key: "circuit:live-reserves:mtbill-midas", value: openCircuitValue(now - 480) },
          ],
        },
      ],
    });

    const res = await handleHealth(db);
    const body = (await res.json()) as {
      status: "healthy" | "degraded" | "stale";
      circuits: Record<string, { state: string }>;
    };

    expect(body.status).toBe("healthy");
    expect(Object.values(body.circuits).filter((circuit) => circuit.state === "open")).toHaveLength(3);
  });

  it("does not expose Telegram delivery lifecycle on the public response", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = healthD1([
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "mint_burn_hourly", rows: [], first: { total: 0 } },
      { match: "SELECT status", rows: [], first: { status: "ok" } },
      { match: "status = 'ok'", rows: [], first: { started_at: now - 300 } },
      { match: "telegram_subscribers", rows: [], first: { n: 42 } },
      { match: "telegram_deliveries", rows: [], first: telegramCapacityRow },
      {
        match: "dispatch-telegram-alerts",
        rows: [],
        first: {
          started_at: now - 120,
          status: "ok",
          metadata: JSON.stringify({ safetyAlertsSuppressed: false }),
        },
      },
    ]);
    const res = await handleHealth(db);
    const body = await res.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty("telegramSummary");
  });

  

  it("does not expose Telegram lifecycle warnings on the public response", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = healthD1([
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "mint_burn_hourly", rows: [], first: { total: 0 } },
      { match: "SELECT status", rows: [], first: { status: "ok" } },
      { match: "status = 'ok'", rows: [], first: { started_at: now - 300 } },
      { match: "telegram_subscribers", rows: [], first: { n: 42 } },
      { match: "telegram_deliveries", rows: [], throwError: new Error("capacity unavailable") },
      {
        match: "dispatch-telegram-alerts",
        rows: [],
        first: { started_at: now - 120, status: "ok", metadata: null },
      },
    ]);

    const response = await handleHealth(db);
    const body = await response.json() as { status: string; warnings: string[] };
    expect(body.status).toBe("stale");
    expect(body.warnings).not.toContain("telegram-delivery-lifecycle:unknown");
  });

  


  it("filters stale removed live-reserve circuit keys from the health payload", async () => {
    const now = Math.floor(Date.now() / 1000);
    const openCircuitValue = (openedAt: number) =>
      JSON.stringify({
        state: "open",
        consecutiveFailures: 3,
        lastFailureAt: openedAt - 30,
        lastSuccessAt: null,
        openedAt,
      });
    const db = makeHealthyHealthDb(now, {
      extras: [
        {
          match: "key LIKE 'circuit:%'",
          rows: [
            { key: "circuit:live-reserves:pmusd-precious-metals", value: openCircuitValue(now - 600) },
            { key: "circuit:live-reserves:ethena", value: openCircuitValue(now - 600) },
          ],
        },
      ],
    });

    const res = await handleHealth(db);
    const body = (await res.json()) as {
      circuits: Record<string, { state: string }>;
    };

    expect(body.circuits["live-reserves:pmusd-precious-metals"]).toBeUndefined();
    expect(body.circuits["live-reserves:ethena"]?.state).toBe("open");
  });
});

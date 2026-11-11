import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";
import { StatusCronDetailResponseSchema, StatusResponseSchema, type StatusResponse } from "@shared/types/status";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { makeHealthyHealthResponse } from "@shared/test-utils/health-fixtures";
import { summarizeCronStatus, projectCronRunOutcome, CRON_STATUS_LATEST_FACT_KEYS } from "../../lib/status/cron-status-summary";
import {
  loadStatusPublicHealthSnapshot,
  STATUS_PUBLIC_HEALTH_SNAPSHOT_CACHE_KEY,
  writeStatusPublicHealthSnapshot,
} from "../../lib/status/public-health-snapshot";
import { handleStatusCronDetailRoute } from "../status-cron-detail";
import { registerUnauthorizedEndpointContract } from "../../test-helpers/__shared/endpoint-contracts";
import { WORKER_ACTIVE_IDS } from "@shared/lib/stablecoins/worker-runtime-registry";
import { MINT_BURN_CONFIGS } from "../../lib/mint-burn-contracts";
import { mintBurnConservationCacheKey } from "../../lib/mint-burn-conservation";
import { isGrandfatheredMintBurnConfig } from "../../lib/mint-burn-publication";
import * as activeSafetyScoreSource from "../../lib/safety-score-active-source";
import { makeWorkerReportCardsV9Response } from "../../test-helpers/report-cards-v9";
import {
  handleStatus,
  STATUS_RAW_SNAPSHOT_CACHE_KEY,
  STATUS_RAW_SNAPSHOT_MAX_AGE_SEC,
  makeCacheRow,
  makeCronRow,
  makeRawStatusSnapshotRow,
  makeMinimalLiveStatusRows,
  cleanupStatusTest,
  buildStatusD1Scenario,
  fixtureMakeApiRequest,
  fixtureDependencyHealthModule,
  fixtureCRON_INTERVALS,
} from "./status.test-support";
import { TELEGRAM_PENDING_CAPACITY_SQL } from "../../telegram/outbox/pending-capacity";

function fixtureMockD1(
  overrides: NonNullable<Parameters<typeof buildStatusD1Scenario>[0]>["overrides"] = [],
) {
  return buildStatusD1Scenario({
    sections: ["sentinel", "publication", "derived", "reserves", "statusState", "cronState", "telegram"],
    overrides: [
      ...overrides,
      // Prefer this aggregate to the sentinel's "SELECT 1" substring, which
      // also appears inside the canonical blacklist mirror-event filter.
      { match: "blacklist-gap-aggregate", rows: [], allowUnused: true, first: {
        total: 0, missing: 0, missing_recent: 0, oldest_gap_age_sec: null,
        never_attempted: 0, repeated_failures: 0, unrecoverable: 0,
      } },
    ],
    sectionOverrides: {
      sentinel: [{ match: "SELECT 1", rows: [], first: { "1": 1 } }],
      derived: [
    { match: "WHERE key IN ('yield-rankings'", rows: [] },
    { match: "SELECT key, value FROM cache WHERE key IN (", rows: [] },
    { match: "SELECT key, LENGTH(value) as bytes FROM cache", rows: [] },
    { match: "FROM mint_burn_hourly INDEXED BY idx_mbh_ts", rows: [] },
    { match: "FROM mint_burn_admission", rows: [] },
    { match: "FROM mint_burn_publication_policy", rows: [] },
    { match: "pharos:mint-burn-scan-coverage:read", rows: [] },
    { match: "pharos:mint-burn-legacy-evidence", rows: [] },
    { match: "FROM (VALUES", rows: [] },
    { match: "SELECT MAX(snapshot_date) as latest FROM supply_history", rows: [], first: null },
    { match: "SELECT MAX(generated_at) as latest FROM daily_digest", rows: [], first: null },
    { match: "SELECT MAX(started_at) as latest", rows: [], first: null },
    { match: "blacklist-reconciliation-status-latest", rows: [], first: null },
    { match: "FROM blacklist_reconciliation_runs", rows: [], first: null },
    { match: "FROM worker_repair_tasks", rows: [], first: null },
    { match: "FROM onchain_supply", rows: [], first: { latest: null, tracked: 0 } },
      ],
      reserves: [
    { match: "FROM reserve_sync_state", rows: [] },
    { match: "FROM reserve_composition", rows: [] },
    { match: "JOIN reserve_sync_state", rows: [] },
      ],
      publication: [
    { match: "WHERE key IN", rows: [] },
    { match: "FROM worker_producer_heads", rows: [] },
    { match: "json_extract(value, '$.compressedBytes')", rows: [], first: null },
    { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
    { match: "SELECT updated_at FROM cache WHERE key = ?", rows: [], first: null },
    { match: "SELECT value FROM cache WHERE key = ?", rows: [], first: null },
    { match: "SELECT key, value, updated_at FROM cache WHERE key IN (", rows: [] },
    { match: "FROM dex_liquidity_publication_generations", rows: [], first: null },
    { match: "FROM yield_publication_generations", rows: [], first: null },
    { match: "FROM surface_publication_generations", rows: [], first: null },
    { match: "FROM stability_index_samples", rows: [], first: null },
      ],
      telegram: [
    { match: "FROM telegram_subscribers s", rows: [], first: {
      total_chats: 0,
      active_chats_30d: 0,
      active_chats_7d: 0,
      total_subscriptions: 0,
      explicit_subscriptions: 0,
      preset_implied_subscriptions: 0,
      dews_enabled_chats: 0,
      depeg_enabled_chats: 0,
      safety_enabled_chats: 0,
      launch_enabled_chats: 0,
      reserve_enabled_chats: 0,
      custom_preference_chats: 0,
      quiet_hours_enabled_chats: 0,
      active_preset_followers: 0,
    } },
    { match: "FROM telegram_subscriptions", rows: [] },
    { match: "FROM telegram_preset_subscriptions", rows: [] },
    { match: "FROM telegram_usage_daily", rows: [], first: null },
    { match: "SELECT snapshot_at FROM telegram_watcher_lifecycle_daily WHERE day = ?", rows: [], first: null },
    { match: "FROM telegram_watcher_lifecycle_daily", rows: [] },
      ],
      statusState: [
    { match: "SELECT COUNT(*) AS cnt FROM status_transitions", rows: [], first: { cnt: 0 } },
    { match: "SELECT scope, current_status, raw_status", rows: [], first: null },
    { match: "SELECT created_at, status, sample_count", rows: [], first: null },
    { match: "SELECT consecutive_divergent FROM status_discrepancy_state", rows: [], first: null },
    { match: "SELECT id, scope, previous_status", rows: [], first: null },
      ],
    },
  });
}

describe("handleStatus", () => {
  afterEach(cleanupStatusTest);
  registerUnauthorizedEndpointContract({
    name: "status",
    invoke: () => handleStatus({ db: fixtureMockD1([]) }),
    body: { error: "Unauthorized" },
  });


  it.each([
    { causes: {} },
    { causes: { availability: null, dataQuality: [], overall: [] } },
    { causes: { availability: [null], dataQuality: [], overall: [] } },
    { caches: { stablecoins: {} } },
    { summary: {} },
    { dataQuality: {} },
  ])("recomputes malformed nested evidence in a fresh healthy-scheduler snapshot %j", async (overrides) => {
    const now = Math.floor(Date.now() / 1000);
    const db = fixtureMockD1([
      { match: "FROM cache WHERE key = ?", matchBinds: [STATUS_RAW_SNAPSHOT_CACHE_KEY],
        rows: [makeRawStatusSnapshotRow(now, 60, overrides)] },
      { match: "FROM dex_liquidity_publication_generations", rows: [], first: null },
      { match: "FROM yield_publication_generations", rows: [], first: null },
      ...makeMinimalLiveStatusRows(now, null, true).filter((row) => row.match !== "dex_liquidity"),
    ]);
    const response = await handleStatus({ db, trustedAdmin: true });
    const body = StatusResponseSchema.parse(await readJsonResponse(response, 200));
    expect(body.sectionErrors.statusSnapshot?.code).toBe("status_snapshot_unreadable");
    expect(body.causes.availability).toBeInstanceOf(Array);
    expect(db.getHistory().some((entry) => entry.sql.includes("SELECT 1"))).toBe(true);
  });
  it.each([false, true])("recomputes an incompatible observer OOM snapshot without hiding current failure (%s)", async (currentProducerFails) => {
    const now = Math.floor(Date.now() / 1000);
    const job = "compute-safety-score-v9-workflow";
    const incompatibleRow = makeRawStatusSnapshotRow(now, 60, {
      availabilityStatus: "degraded", rawOverallStatus: "degraded",
      causes: { availability: [{ code: "observer-oom", message: "Worker exceeded memory limit" }], dataQuality: [], overall: [] },
    });
    const snapshot = JSON.parse(incompatibleRow.value);
    snapshot.cronJobs.push(job);
    incompatibleRow.value = JSON.stringify(snapshot);
    const liveRows = makeMinimalLiveStatusRows(now, null, true);
    if (currentProducerFails) {
      liveRows.unshift({ match: "cron_runs", rows: Object.keys(CRON_INTERVALS).map((id) =>
        makeCronRow(id, id === "sync-stablecoins" ? "error" : "ok", 30)) });
    }
    const db = fixtureMockD1([
      { match: "FROM cache WHERE key = ?", matchBinds: [STATUS_RAW_SNAPSHOT_CACHE_KEY],
        rows: [incompatibleRow] },
      ...liveRows,
    ]);
    const response = await handleStatus({ db, trustedAdmin: true });
    const body = await readJsonResponse<{
      crons: Record<string, unknown>; availabilityStatus: string; rawOverallStatus: string;
      causes: { availability: Array<{ code: string }> };
    }>(response, 200);
    expect(body.crons).not.toHaveProperty(job);
    expect(body.causes.availability.map((cause) => cause.code)).not.toContain("observer-oom");
    expect(body.availabilityStatus).toBe(currentProducerFails ? "degraded" : "healthy");
    expect(body.rawOverallStatus).toBe(currentProducerFails ? "degraded" : "healthy");
    expect(db.getHistory().some((entry) => entry.sql.includes("SELECT 1"))).toBe(true);
  });

  it.each([false, true])("reads both role markers outside cached status (heavy query failure: %s)", async (heavyFails) => {
    const now = Math.floor(Date.now() / 1000);
    const publicMarker = { worker: "public", scriptName: "stablecoin-api", workerVersion: "11111111-1111-1111-1111-111111111111", activatedAt: now - 100 };
    const heavyMarker = { worker: "heavy", scriptName: "stablecoin-heavy", workerVersion: "22222222-2222-2222-2222-222222222222", activatedAt: now - 50 };
    const db = fixtureMockD1([
      { match: "FROM cache WHERE key = ?", matchBinds: [STATUS_RAW_SNAPSHOT_CACHE_KEY], rows: [makeRawStatusSnapshotRow(now, 120)] },
      { match: "FROM cache WHERE key = ?", matchBinds: ["worker-active-version:public"],
        rows: [], first: { value: JSON.stringify(publicMarker), updated_at: publicMarker.activatedAt } },
      { match: "FROM cache WHERE key = ?", matchBinds: ["worker-active-version:heavy"],
        rows: [], first: { value: JSON.stringify(heavyMarker), updated_at: heavyMarker.activatedAt },
        ...(heavyFails ? { throwError: "heavy marker unavailable" } : {}) },
    ]);
    const res = await handleStatus({ db, trustedAdmin: true });
    const body = StatusResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body.workerVersions.public).toEqual({
      scriptName: publicMarker.scriptName, workerVersion: publicMarker.workerVersion, activatedAt: publicMarker.activatedAt,
    });
    expect(body.workerVersions.heavy).toEqual(heavyFails ? null : {
      scriptName: heavyMarker.scriptName, workerVersion: heavyMarker.workerVersion, activatedAt: heavyMarker.activatedAt,
    });
    expect(body.sectionErrors.workerVersions?.code).toBe(heavyFails ? "worker_versions_query_failed" : undefined);
    expect(body.schedulerLiveness?.lanes).toHaveLength(3);
  });

  it.each([
    [1801, "degraded", "heavy_scheduled_delivery_stalled", 0.83],
    [2701, "stale", "heavy_scheduled_delivery_stalled", 0.67],
    [null, "degraded", "heavy_scheduler_liveness_unavailable", 0.83],
  ] as const)("folds live heavy delivery loss (%s) into admin snapshot status", async (age, status, code, confidence) => {
    const now = Math.floor(Date.now() / 1000);
    const db = fixtureMockD1([
      { match: "FROM cache WHERE key = ?", matchBinds: [STATUS_RAW_SNAPSHOT_CACHE_KEY], rows: [makeRawStatusSnapshotRow(now, 120)] },
      { match: "AS last_any", rows: [], first: {
        observed_at: now,
        last_any: now - 30, reserve: now - 30, telegram: now - 30, digest: now - 30,
        heavy: age == null ? null : now - age,
      } },
    ]);
    const res = await handleStatus({ db, trustedAdmin: true });
    const body = StatusResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body.schedulerLiveness?.status).toBe("healthy");
    expect(body.schedulerLiveness?.heavy.ageSeconds).toBe(age);
    expect(body.availabilityStatus).toBe(status);
    expect(body.overallStatus).toBe(status);
    expect(body.causes.availability).toEqual(expect.arrayContaining([expect.objectContaining({ code, threshold: 1800 })]));
    expect(body.sectionErrors.schedulerLiveness?.code).toBe(age == null ? code : undefined);
    // The cached assessment (0.95) was scored while availability read healthy;
    // the live floor deducts the availability term so confidence matches the verdict.
    expect(body.confidence).toBe(confidence);
  });
  it("recomputes a pre-heavy cached scheduler rather than trusting public-only evidence", async () => {
    const now = Math.floor(Date.now() / 1000);
    const row = makeRawStatusSnapshotRow(now, 120);
    const snapshot = JSON.parse(row.value);
    delete snapshot.raw.schedulerLiveness.heavy;
    row.value = JSON.stringify(snapshot);
    const db = fixtureMockD1([
      { match: "FROM cache WHERE key = ?", matchBinds: [STATUS_RAW_SNAPSHOT_CACHE_KEY], rows: [row] },
    ]);
    const body = StatusResponseSchema.parse(await readJsonResponse(await handleStatus({ db, trustedAdmin: true }), 200));
    expect(body.schedulerLiveness?.heavy.status).toBe("healthy");
    expect(db.getHistory().some((entry) => entry.sql.includes("blacklist_events"))).toBe(true);
  });

  it("keeps missing and malformed role markers unavailable without producer inference", async () => {
    const db = fixtureMockD1([
      { match: "FROM cache WHERE key = ?", matchBinds: ["worker-active-version:public"],
        rows: [], first: { value: "not-json", updated_at: 100 } },
      { match: "FROM cache WHERE key = ?", matchBinds: ["worker-active-version:heavy"], rows: [], first: null },
    ]);
    const res = await handleStatus({ db, trustedAdmin: true });
    const body = StatusResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body.workerVersions).toEqual({ public: null, heavy: null });
    expect(body.sectionErrors.workerVersions).toBeUndefined();
  });
  it.each([false, true])("refreshes cron evidence independently of cached assessment (read failure: %s)", async (readFails) => {
    const now = Math.floor(Date.now() / 1000);
    const job = "reserve-recovery";
    const db = fixtureMockD1([
      { match: "FROM cache WHERE key = ?", matchBinds: [STATUS_RAW_SNAPSHOT_CACHE_KEY], rows: [
        makeRawStatusSnapshotRow(now, 120, {
          sectionErrors: {
            scheduledSlots: { code: "old-slot-error", message: "old snapshot error" },
            crons: { code: "cron-history-read-failed", message: "Cron history unavailable." },
          },
        }),
      ] },
      { match: "cron_runs", rows: [{ job, started_at: now - 30, duration_ms: 1000,
        status: "ok", error: null, item_count: 0, metadata: null }],
        ...(readFails ? { throwError: "cron history unavailable" } : {}),
      },
    ]);
    const res = await handleStatus({ db, trustedAdmin: true,
      request: fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" }) });
    const body = StatusResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body.crons[job].healthy).toBe(readFails ? null : true);
    expect(body.crons[job].telemetryUnknown).toBe(readFails);
    if (!readFails) expect(body.crons[job].runs[0]?.startedAt).toBe(now - 30);
    expect(body.sectionErrors.scheduledSlots).toBeUndefined();
    expect(body.summary.unhealthyCrons).toBe(readFails ? null : Object.values(body.crons)
      .filter((cron) => cron.healthy === false).length);
    expect(body.summary.cronHistoryUnavailableReason).toBe(readFails ? "cron-history-read-failed" : null);
    expect(body.sectionErrors.crons?.code).toBe(readFails ? "cron-history-read-failed" : undefined);
    expect(db.getHistory().some((entry) => entry.sql.includes("blacklist_events"))).toBe(false);
  });

  it("rebuilds cron-derived availability causes from the same live cron evidence as the summary", async () => {
    const now = Math.floor(Date.now() / 1000);
    const snapshotDegradedCause = {
      code: "degraded_cron_warning",
      layer: "availability",
      severity: "info",
      message: "2 cron job(s) are in fallback/degraded mode (warning-only).",
      metric: "degradedCrons",
      value: 2,
      threshold: 1,
    };
    const db = fixtureMockD1([
      { match: "FROM cache WHERE key = ?", matchBinds: [STATUS_RAW_SNAPSHOT_CACHE_KEY], rows: [
        makeRawStatusSnapshotRow(now, 120, {
          causes: {
            availability: [snapshotDegradedCause],
            dataQuality: [],
            overall: [snapshotDegradedCause],
          },
        }),
      ] },
      { match: "cron_runs", rows: Object.keys(CRON_INTERVALS).map((job) => makeCronRow(
        job,
        job === "sync-v9-supply-attribution" ? "degraded" : "ok",
        60,
      )) },
    ]);

    const res = await handleStatus({ db, trustedAdmin: true,
      request: fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" }) });
    const body = StatusResponseSchema.parse(await readJsonResponse(res, 200));

    expect(body.summary.degradedCrons).toBe(1);
    const degradedCause = body.causes.availability.find((cause) => cause.code === "degraded_cron_warning");
    expect(degradedCause?.value).toBe(1);
    expect(degradedCause?.message).toContain("1 cron job(s) have fresh degraded terminal attempts reporting incomplete required work.");
    expect(degradedCause?.message).not.toContain("output quality warnings");
    expect(body.causes.overall.find((cause) => cause.code === "degraded_cron_warning")?.value).toBe(1);
  });

  it("drops a cached expected-lane cause the live scheduler observation no longer supports", async () => {
    const now = Math.floor(Date.now() / 1000);
    const snapshotLaneCause = {
      code: "expected_scheduled_lane_unhealthy",
      layer: "availability",
      severity: "info",
      message: "1 scheduled slot lane(s) lack a start inside their delivery budget: daily0300Utc (stale 259201s; warn >172800s / stale >259200s).",
      metric: "unhealthyExpectedLanes",
      value: 1,
      threshold: 1,
    };
    const laneStarts = Object.fromEntries(
      Object.keys(SCHEDULED_SLOT_PLANS).map((scheduleKey) => [scheduleKey, now - 30]),
    );
    const db = fixtureMockD1([
      { match: "FROM cache WHERE key = ?", matchBinds: [STATUS_RAW_SNAPSHOT_CACHE_KEY], rows: [
        makeRawStatusSnapshotRow(now, 120, {
          causes: {
            availability: [snapshotLaneCause],
            dataQuality: [],
            overall: [snapshotLaneCause],
          },
        }),
      ] },
      { match: "AS last_any", rows: [], first: {
        observed_at: now,
        last_any: now - 30, reserve: now - 30, telegram: now - 30, digest: now - 30, heavy: now - 30,
        lanes: JSON.stringify(laneStarts),
      } },
      { match: "cron_runs", rows: Object.keys(CRON_INTERVALS).map((job) => makeCronRow(job, "ok", 60)) },
    ]);

    const res = await handleStatus({ db, trustedAdmin: true,
      request: fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" }) });
    const body = StatusResponseSchema.parse(await readJsonResponse(res, 200));

    // The live read has every expected lane inside its budget; the cached
    // cause must not survive beside healthy live evidence (R5).
    expect(body.schedulerLiveness?.expectedLanes?.every((lane) => lane.status === "healthy")).toBe(true);
    expect(body.causes.availability.some((cause) => cause.code === "expected_scheduled_lane_unhealthy")).toBe(false);
  });

  it.each([false, true])("keeps ok quality findings out of degraded counts (live refresh: %s)", async (live) => {
    const now = Math.floor(Date.now() / 1000);
    const db = fixtureMockD1([
      ...(!live ? [{ match: "FROM cache WHERE key = ?", matchBinds: [STATUS_RAW_SNAPSHOT_CACHE_KEY],
        rows: [makeRawStatusSnapshotRow(now, 120)] }] : []),
      { match: "cron_runs", rows: Object.keys(CRON_INTERVALS).map((job) => ({
        ...makeCronRow(job, "ok", 60),
        metadata: job === "cron-sentinel" ? JSON.stringify({ quality: { reason: "observed-staleness" } })
          : job === "sync-blacklist" ? JSON.stringify({ currentBalanceCacheFailed: 2, contractsSkipped: 1 }) : null,
      })) },
    ]);
    const res = await handleStatus({ db, trustedAdmin: true,
      request: fixtureMakeApiRequest(`/api/status${live ? "?refresh=live" : ""}`, { adminKey: "secret-key" }) });
    const body = StatusResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body.summary.degradedCrons).toBe(0);
    expect(body.crons["cron-sentinel"].runs[0]?.qualityReasons).toContain("observed-staleness");
    expect(body.crons["cron-sentinel"].runs[0]).not.toHaveProperty("metadata");
    const detailResponse = await handleStatusCronDetailRoute({
      db, trustedAdmin: true,
      request: fixtureMakeApiRequest("/api/status-cron-detail?job=cron-sentinel", { adminKey: "secret-key" }),
      url: new URL("https://ops-api.pharos.watch/api/status-cron-detail?job=cron-sentinel"),
    });
    const detail = await readJsonResponse<{ cron: { runs: Array<{ metadata?: Record<string, unknown> }> } }>(detailResponse, 200);
    expect(detail.cron.runs[0]?.metadata?.quality).toEqual({ reason: "observed-staleness" });
    expect(body.causes.availability.find((cause) => cause.code === "degraded_cron_warning")).toBeUndefined();
  });

  it("serves raw status fields from a fresh cron snapshot", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = fixtureMockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: [STATUS_RAW_SNAPSHOT_CACHE_KEY],
        rows: [
          makeRawStatusSnapshotRow(now, 60, {
            rawOverallStatus: "degraded",
            availabilityStatus: "degraded",
            confidence: 0.72,
            causes: {
              availability: [
                {
                  code: "snapshot-availability",
                  layer: "availability",
                  severity: "warning",
                  message: "from snapshot",
                },
              ],
              dataQuality: [],
              overall: [
                {
                  code: "snapshot-availability",
                  layer: "availability",
                  severity: "warning",
                  message: "from snapshot",
                },
              ],
            },
          }),
        ],
      },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request });

    const body = (await readJsonResponse(res, 200)) as {
      rawOverallStatus: string;
      availabilityStatus: string;
      overallStatus: string;
      confidence: number;
      causes: { availability: Array<{ code: string }> };
    };
    expect(body.rawOverallStatus).toBe("degraded");
    expect(body.availabilityStatus).toBe("degraded");
    expect(body.overallStatus).toBe("degraded");
    expect(body.confidence).toBe(0.72);
    expect(body.causes.availability[0]?.code).toBe("snapshot-availability");

    const batchCacheReads = db.getHistory().filter((entry) => entry.sql.includes("cache WHERE key IN"));
    const conservationReads = batchCacheReads.filter((entry) =>
      entry.binds.every((bind) => typeof bind === "string" && bind.startsWith("mint-burn:conservation:")));
    expect(conservationReads.length).toBeGreaterThan(0);
    expect(conservationReads.flatMap((entry) => entry.binds))
      .toEqual([...new Set(MINT_BURN_CONFIGS
        .filter((config) => WORKER_ACTIVE_IDS.has(config.stablecoinId) && isGrandfatheredMintBurnConfig(config))
        .map(mintBurnConservationCacheKey))]);
    const nonSupplementalBatchCacheReads = batchCacheReads.filter((entry) =>
      !entry.binds.every((bind) => typeof bind === "string" &&
        (bind.startsWith("circuit:") || bind.startsWith("cron:event:") || bind.startsWith("mint-burn:conservation:"))));
    expect(nonSupplementalBatchCacheReads).toEqual([]);
    const sql = db
      .getHistory()
      .map((entry) => entry.sql)
      .join("\n");
    expect(sql).not.toContain("blacklist_events");
  });

  it("preserves healthy, public-impact degraded, and publication-query-unavailable status tuples", async () => {
    const now = Math.floor(Date.now() / 1000);
    // Publication health also reads the V9 Safety Score cohort; keep that
    // surface healthy so the scenarios' publication outcome is the only one
    // their fixtures seed.
    vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreCohort").mockResolvedValue({
      kind: "v9",
      snapshot: makeWorkerReportCardsV9Response({ asOfSec: now - 60, updatedAt: now - 30 }),
    });
    const publicImpactCause = {
      code: "cache_ratio_degraded",
      layer: "availability",
      severity: "warning",
      message: "Public cache freshness exceeded the degraded threshold.",
    };
    // The fresh-snapshot path reads cron history live to rebuild `crons`,
    // `summary`, and the cron-derived availability causes; mock a successful
    // (empty) read so the scenarios exercise their intended tuples.
    const liveCronHistoryRead = { match: "cron_runs", rows: [] };
    const liveDeliveryLagRead = { match: "AS started_slots", rows: [{ started_slots: 0, late_slots: 0, max_lag_sec: null }] };
    const scenarios = [
      {
        name: "healthy",
        raw: {},
        tables: [],
        expected: { overallStatus: "healthy", causeCodes: [], sectionErrorCode: null, sectionErrorMessage: null },
      },
      {
        name: "degraded public impact",
        raw: {
          rawOverallStatus: "degraded",
          availabilityStatus: "degraded",
          causes: {
            availability: [publicImpactCause],
            dataQuality: [],
            overall: [publicImpactCause],
          },
        },
        tables: [],
        expected: { overallStatus: "degraded", causeCodes: ["cache_ratio_degraded"], sectionErrorCode: null, sectionErrorMessage: null },
      },
      {
        name: "supplement query unavailable",
        raw: {},
        tables: [{
          match: "FROM yield_publication_generations",
          rows: [],
          throwError: new Error("D1_ERROR: yield publication ledger unavailable"),
        }],
        expected: {
          overallStatus: "healthy",
          causeCodes: [],
          sectionErrorCode: "publication_health_partial_failure",
          sectionErrorMessage: "Publication health partially unavailable.",
        },
      },
    ];

    for (const scenario of scenarios) {
      const db = fixtureMockD1([
        {
          match: "FROM cache WHERE key = ?",
          matchBinds: [STATUS_RAW_SNAPSHOT_CACHE_KEY],
          rows: [makeRawStatusSnapshotRow(now, 60, scenario.raw)],
        },
        liveCronHistoryRead,
        liveDeliveryLagRead,
        ...scenario.tables,
      ]);
      const response = await handleStatus({ db, trustedAdmin: true, request: fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" }) });
      const payload = await response.json();
      const parsed = StatusResponseSchema.parse(payload);

      expect({
        overallStatus: parsed.overallStatus,
        causeCodes: parsed.causes.overall.map((cause) => cause.code),
        sectionErrorCode: parsed.sectionErrors.publicationHealth?.code ?? null,
        sectionErrorMessage: parsed.sectionErrors.publicationHealth?.message ?? null,
      }).toEqual(scenario.expected);
      if (scenario.name === "healthy") {
        const malformedPayload = structuredClone(payload) as Record<string, unknown>;
        delete malformedPayload.reserveComposition;
        expect(StatusResponseSchema.safeParse(malformedPayload).success).toBe(false);
      }
    }
  });

  it("adds canary counts to the live status summary", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = fixtureMockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: [STATUS_RAW_SNAPSHOT_CACHE_KEY],
        rows: [makeRawStatusSnapshotRow(now, 60)],
      },
      {
        match: "FROM worker_canary_runs",
        rows: [
          {
            check_id: "bad-check",
            status: "error",
            severity: "critical",
            observed_at: now - 30,
            duration_ms: 5,
            metadata_json: JSON.stringify({ label: "Bad check", description: "Failed invariant" }),
            error: "boom",
          },
          {
            check_id: "warn-check",
            status: "degraded",
            severity: "warning",
            observed_at: now - 40,
            duration_ms: 7,
            metadata_json: JSON.stringify({ label: "Warn check", description: "Soft invariant" }),
            error: null,
          },
          {
            check_id: "skip-check",
            status: "skipped",
            severity: "info",
            observed_at: now - 50,
            duration_ms: 1,
            metadata_json: JSON.stringify({ label: "Skip check", description: "Intentional skip" }),
            error: null,
          },
        ],
      },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request, workerCanaryMode: "status" });

    const body = (await readJsonResponse(res, 200)) as {
      summary: {
        canaryTotalChecks?: number;
        canaryErrorCount?: number;
        canaryDegradedCount?: number;
        canarySkippedCount?: number;
        canaryStaleCount?: number;
      };
      canaries: {
        errorCount: number;
        degradedCount: number;
        skippedCount: number;
        staleCount: number;
      } | null;
    };
    expect(body.summary).toMatchObject({
      canaryTotalChecks: 3,
      canaryErrorCount: 1,
      canaryDegradedCount: 1,
      canarySkippedCount: 1,
      canaryStaleCount: 0,
    });
    expect(body.canaries).toMatchObject({
      errorCount: 1,
      degradedCount: 1,
      skippedCount: 1,
      staleCount: 0,
    });
  });

  it("omits canary summary counts when canary status is unavailable", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = fixtureMockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: [STATUS_RAW_SNAPSHOT_CACHE_KEY],
        rows: [
          makeRawStatusSnapshotRow(now, 60, {
            summary: {
              unhealthyCrons: 0,
              availabilityImpactingUnhealthyCrons: 0,
              watchUnhealthyCrons: 0,
              degradedCrons: 0,
              cronErrors: 0,
              availabilityImpactingCronErrors: 0,
              availabilityImpactingConsecutiveCronErrors: 0,
              canaryTotalChecks: 0,
              canaryErrorCount: 0,
              canaryDegradedCount: 0,
              canarySkippedCount: 0,
              canaryStaleCount: 0,
              diagnosticIssueCount: 0,
              worstCacheRatio: 0,
              transitionsLast24h: 0,
            },
          }),
        ],
      },
      {
        match: "FROM worker_canary_runs",
        rows: [],
        throwError: new Error("D1_ERROR: no such table: worker_canary_runs"),
      },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request, workerCanaryMode: "status" });

    const body = (await readJsonResponse(res, 200)) as {
      summary: Record<string, unknown>;
      canaries: unknown;
      sectionErrors: Record<string, { code: string }>;
    };
    expect(body.canaries).toBeNull();
    expect(body.sectionErrors.canaries?.code).toBe("canary_status_query_failed");
    expect(body.summary).not.toHaveProperty("canaryTotalChecks");
    expect(body.summary).not.toHaveProperty("canaryErrorCount");
    expect(body.summary).not.toHaveProperty("canaryDegradedCount");
    expect(body.summary).not.toHaveProperty("canarySkippedCount");
    expect(body.summary).not.toHaveProperty("canaryStaleCount");
  });

  it("keeps status available when dependency-health computation fails", async () => {
    const dependencyHealthSpy = vi
      .spyOn(fixtureDependencyHealthModule, "buildDependencyHealth")
      .mockImplementationOnce(() => {
        throw new Error("dependency graph failed");
      });
    const now = Math.floor(Date.now() / 1000);
    const db = fixtureMockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: [STATUS_RAW_SNAPSHOT_CACHE_KEY],
        rows: [makeRawStatusSnapshotRow(now, 60)],
      },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request });

    const body = (await readJsonResponse(res, 200)) as {
      dependencyHealth: Record<string, unknown> | null;
      sectionErrors: Record<string, { code: string; message: string } | undefined>;
    };
    expect(dependencyHealthSpy).toHaveBeenCalledOnce();
    expect(body.dependencyHealth).toBeNull();
    expect(body.sectionErrors.dependencyHealth).toEqual({
      code: "dependency_health_computation_failed",
      message: "Dependency health unavailable.",
    });
  });

  it("falls back to live raw status when the cron snapshot is stale", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = fixtureMockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: [STATUS_RAW_SNAPSHOT_CACHE_KEY],
        rows: [
          makeRawStatusSnapshotRow(now, STATUS_RAW_SNAPSHOT_MAX_AGE_SEC + 60, {
            rawOverallStatus: "stale",
            availabilityStatus: "stale",
            causes: {
              availability: [
                {
                  code: "stale-snapshot-sentinel",
                  layer: "availability",
                  severity: "critical",
                  message: "must not be served",
                },
              ],
              dataQuality: [],
              overall: [
                {
                  code: "stale-snapshot-sentinel",
                  layer: "availability",
                  severity: "critical",
                  message: "must not be served",
                },
              ],
            },
          }),
        ],
      },
      ...makeMinimalLiveStatusRows(now),
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request });

    const body = (await readJsonResponse(res, 200)) as {
      rawOverallStatus: string;
      availabilityStatus: string;
      causes: { availability: Array<{ code: string }> };
      sectionErrors: Record<string, { code: string; message: string } | undefined>;
    };
    expect(["healthy", "degraded", "stale"]).toContain(body.rawOverallStatus);
    expect(["healthy", "degraded", "stale"]).toContain(body.availabilityStatus);
    expect(body.causes.availability.map((cause) => cause.code)).not.toContain("stale-snapshot-sentinel");
    expect(body.sectionErrors.statusSnapshot?.code).toBe("status_snapshot_stale");

    const sql = db
      .getHistory()
      .map((entry) => entry.sql)
      .join("\n");
    expect(sql).toContain("cache WHERE key IN");
    expect(sql).toContain("blacklist_events");
  });

  it("lets operators bypass a fresh cron snapshot with refresh=live", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = fixtureMockD1([
      ...makeMinimalLiveStatusRows(now),
    ]);

    const request = fixtureMakeApiRequest("/api/status?refresh=live", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request });

    const body = (await readJsonResponse(res, 200)) as {
      rawOverallStatus: string;
      availabilityStatus: string;
      causes: { availability: Array<{ code: string }> };
    };
    expect(["healthy", "degraded", "stale"]).toContain(body.rawOverallStatus);
    expect(["healthy", "degraded", "stale"]).toContain(body.availabilityStatus);
    expect(body.causes.availability.map((cause) => cause.code)).not.toContain("fresh-snapshot-sentinel");

    const history = db.getHistory();
    const sql = history.map((entry) => entry.sql).join("\n");
    expect(history.some((entry) => entry.binds[0] === STATUS_RAW_SNAPSHOT_CACHE_KEY)).toBe(false);
    expect(sql).toContain("cache WHERE key IN");
  });

  it("returns 200 with status body when authorized", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: ([
        ["usdt-tether", "USDT", ["coingecko", "defillama-list", "pyth"]],
        ["usdc-circle", "USDC", ["coingecko"]],
        ["pyusd-paypal", "PYUSD", ["coingecko", "defillama-list", "pyth", "binance", "coinbase"]],
      ] as const).map(([id, symbol, consensusSources]) => ({
        id, symbol, price: 1.0, consensusSources, circulating: { peggedUSD: 100_000_000 },
      })),
    });

    const db = fixtureMockD1([
      {
        match: "cache WHERE key IN",
        rows: [makeCacheRow("stablecoins"), makeCacheRow("stablecoin-charts")],
      },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      {
        match: "cron_runs",
        rows: [
          {
            ...makeCronRow("sync-stablecoins"),
            metadata: JSON.stringify({
              priceSourceHealth: {
                sourceDistribution: {
                  coingecko: 14, "coingecko+defillama-list": 118, defillama: 10, "defillama-list": 0,
                  "protocol-redeem": 1, "defillama-contract": 4, coinmarketcap: 2, dexscreener: 1,
                  jupiter: 0, pyth: 0, binance: 0, kraken: 0, bitstamp: 0, coinbase: 0, redstone: 0,
                  "curve-onchain": 0, "dex-promoted": 0, geckoterminal: 0, "pool-tvl-weighted": 0,
                  cached: 4, missing: 3,
                },
                confidenceDistribution: { high: 127, "single-source": 15, low: 8, fallback: 6 },
                totalAssets: 156,
                lastSync: now - 60,
              },
            }),
          },
          {
            ...makeCronRow("sync-dex-liquidity"),
            metadata: JSON.stringify({
              failedSources: ["defillama-yields"],
              sourceCoverage: {
                currentCoverage: 120,
                previousCoverage: 125,
                currentGlobalTvl: 123_000_000,
                previousGlobalTvl: 125_000_000,
                currentTop10CoveredTvl: 100_000_000,
                previousTop10CoveredTvl: 102_000_000,
                currentTop10GuardTvl: 100_000_000,
                previousTop10GuardTvl: 102_000_000,
                nearCoverageGuard: false,
                nearValueGuard: false,
                nearMajorCoverageGuard: false,
                currentCoverageClasses: { primary: 80, mixed: 20, fallback: 20, legacy: 0, unobserved: 36 },
                previousCoverageClasses: { primary: 82, mixed: 18, fallback: 25, legacy: 0, unobserved: 31 },
              },
            }),
          },
          makeCronRow("sync-stablecoin-charts"),
          makeCronRow("sync-blacklist"),
        ],
      },
      { match: "FROM cache WHERE key = ?", matchBinds: ["stablecoins"], rows: [], first: { value: stablecoinsCache, updated_at: now - 60 } },
      { match: "blacklist_events", rows: [], first: { total: 10, missing: 2 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request });

    const body = (await readJsonResponse(res, 200)) as StatusResponse;
    for (const key of [
      "timestamp", "dbHealthy", "overallStatus", "caches", "crons", "dataQuality", "telegramBot", "sectionErrors",
      "datasetFreshness", "state", "priceSourceHealth", "coingeckoPriceDiff", "d1Usage", "liquidityHealth", "yieldHealth",
      "publicationHealth", "dependencyHealth", "providerCircuitHealth", "canaries", "mintBurnReconciliation", "reserveComposition",
    ]) expect(body).toHaveProperty(key);
    expect(body.producerHeads!.length).toBeGreaterThan(0);
    expect(body.producerHeads!.every((head) =>
      !head.observed && head.invocationCount === 0 && head.productiveCount === 0,
    )).toBe(true);
    expect(body.sectionErrors).not.toHaveProperty("producerHistory");
    expect(body.reserveComposition).toMatchObject({
      cursorRecordedAt: null,
    });
    expect(typeof body.dbHealthy).toBe("boolean");
    expect(body.datasetFreshness).toHaveProperty("stablecoins");
    expect(body.datasetFreshness).toHaveProperty("mintBurn");
    expect(body.datasetFreshness).toHaveProperty("safetyGrades");
    expect(body.state).toMatchObject({
      scope: "global",
      thresholds: {
        escalateToDegraded: 2,
        escalateToStale: 1,
        recoverToDegraded: 2,
        recoverToHealthy: 3,
      },
      minDwellSec: 120,
      staleMinDwellSec: 180,
    });
    expect(body.priceSourceHealth).toMatchObject({
      totalAssets: 156,
      sourceDepthDistribution: {
        "0": 0,
        "1": 1,
        "2": 0,
        "3": 1,
        "4": 0,
        "5+": 1,
      },
    });
    expect(body.coingeckoPriceDiff).toBeNull();
    expect(body.liquidityHealth).toMatchObject({
      currentCoverage: 120,
      failedSources: ["defillama-yields"],
    });
    expect(["healthy", "degraded", "stale"]).toContain(body.overallStatus);
  });

  it("preserves named unavailable DEX baselines instead of projecting empty populations", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = fixtureMockD1([
      { match: "FROM cache WHERE key = ?", matchBinds: [STATUS_RAW_SNAPSHOT_CACHE_KEY],
        rows: [makeRawStatusSnapshotRow(now, 60)] },
      { match: "cron_runs", rows: [{ job: "sync-dex-liquidity", started_at: now - 30,
        duration_ms: 1000, status: "degraded", error: null, item_count: 120,
        metadata: JSON.stringify({ failedSources: [], sourceCoverage: {
          currentCoverage: 120, previousCoverage: null,
          currentGlobalTvl: 100, previousGlobalTvl: null,
          currentTop10CoveredTvl: null, previousTop10CoveredTvl: null,
          currentTop10GuardTvl: null, previousTop10GuardTvl: null,
          nearCoverageGuard: false, nearValueGuard: false, nearMajorCoverageGuard: false,
          currentCoverageClasses: { primary: 120, mixed: 0, fallback: 0, legacy: 0, unobserved: 0 },
          previousCoverageClasses: null,
          baselineReadFailures: ["cron-history-read-failed", "top-ten-read-failed", "coverage-classes-read-failed"],
        } }),
      }] },
    ]);
    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request });
    const body = await readJsonResponse<{ liquidityHealth: unknown }>(res, 200);
    expect(body.liquidityHealth).toMatchObject({
      currentCoverage: 120, previousCoverage: null,
      currentGlobalTvl: 100, previousGlobalTvl: null,
      currentTop10CoveredTvl: null, previousTop10CoveredTvl: null,
      currentTop10GuardTvl: null, previousTop10GuardTvl: null,
      previousCoverageClasses: null,
      baselineReadFailures: ["cron-history-read-failed", "top-ten-read-failed", "coverage-classes-read-failed"],
    });
  });

  it("rejects malformed liquidity coverage-class metadata without inventing counts", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = fixtureMockD1([
      { match: "FROM cache WHERE key = ?", matchBinds: [STATUS_RAW_SNAPSHOT_CACHE_KEY],
        rows: [makeRawStatusSnapshotRow(now, 60)] },
      { match: "cron_runs", rows: [{ job: "sync-dex-liquidity", started_at: now - 30,
        duration_ms: 1000, status: "ok", error: null, item_count: 120,
        metadata: JSON.stringify({ failedSources: [], sourceCoverage: {
          currentCoverage: 120, previousCoverage: 0,
          currentGlobalTvl: 0, previousGlobalTvl: 0,
          currentTop10CoveredTvl: 0, previousTop10CoveredTvl: 0,
          currentTop10GuardTvl: 0, previousTop10GuardTvl: 0,
          nearCoverageGuard: false, nearValueGuard: false, nearMajorCoverageGuard: false,
          currentCoverageClasses: { primary: "12", mixed: "not-a-number", fallback: "NaN", legacy: [] },
          previousCoverageClasses: { primary: "Infinity", mixed: "-Infinity", fallback: {}, legacy: "", unobserved: "7" },
        } }),
      }] },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request });

    const body = await readJsonResponse<{
      liquidityHealth: unknown;
      sectionErrors: Record<string, { code: string }>;
    }>(res, 200);
    expect(body.liquidityHealth).toBeNull();
    expect(body.sectionErrors.liquidityHealth?.code).toBe("liquidity_health_extraction_failed");
  });

  it("omits retired diagnostics from the status response", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });

    const db = fixtureMockD1([
      {
        match: "cache WHERE key IN",
        rows: [makeCacheRow("stablecoins"), makeCacheRow("stablecoin-charts")],
      },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      {
        match: "cron_runs",
        rows: [
          {
            ...makeCronRow("sync-stablecoins"),
            metadata: JSON.stringify({
              providerDiagnostics: [
                {
                  source: "binance",
                  stage: "primary",
                  endpoint: "api.binance.com/api/v3/ticker/price",
                  status: 403,
                  ok: false,
                  success: false,
                  errorClass: "HTTPError",
                  errorMessage: "Request blocked",
                  snippet: "Service unavailable from restricted location",
                },
                {
                  source: "jupiter",
                  stage: "primary",
                  endpoint: "price.jup.ag/v6/price",
                  status: 200,
                  ok: true,
                  success: true,
                  candidateCount: 5,
                  matchedCount: 3,
                },
              ],
              gtProbe: {
                updatedCount: 2,
                probed: 4,
                pricesObtained: 3,
                divergences500bps: 1,
                skippedLowTvl: 0,
                lookupMisses: 1,
                upstreamErrors: 0,
                publicFallbacks: 0,
                budgetExhausted: false,
                budgetSkipped: 0,
                transports: {
                  coingeckoOnchain: { attempted: 4, priced: 3, lookupMisses: 1, upstreamErrors: 0 },
                  geckoTerminalPublic: { attempted: 0, priced: 0, lookupMisses: 0, upstreamErrors: 0 },
                },
              },
            }),
          },
          makeCronRow("sync-stablecoin-charts"),
          makeCronRow("sync-blacklist"),
        ],
      },
      { match: "FROM cache WHERE key = ?", matchBinds: ["stablecoins"], rows: [], first: { value: stablecoinsCache, updated_at: now - 60 } },
      { match: "blacklist_events", rows: [], first: { total: 10, missing: 2 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request });

    const body = (await readJsonResponse(res, 200)) as Record<string, unknown>;

    for (const key of ["priceProviderDiagnostics", "gtProbe", "cacheBlobSizes", "alertBroker"]) {
      expect(body).not.toHaveProperty(key);
    }
    expect(body).toHaveProperty("priceSourceHealth");
    expect(body).toHaveProperty("coingeckoPriceDiff");
    expect(body).toHaveProperty("d1Usage");
    expect(body).toHaveProperty("mintBurnReconciliation");
  });

  it("keeps failed cron telemetry unknown and degrades unreadable mint/burn evidence", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const db = fixtureMockD1([
      {
        match: "WHERE key IN",
        rows: [
          makeCacheRow("stablecoins"),
          makeCacheRow("stablecoin-charts"),
          makeCacheRow("usds-status"),
          makeCacheRow("bluechip-ratings"),
          {
            key: "fx-rates",
            updated_at: now - 300,
            value: JSON.stringify({ peggedEUR: 1.08 }),
          },
          {
            key: "fx-rates-meta",
            updated_at: now - 300,
            value: JSON.stringify({
              usableSyncAt: now - 300,
              mode: "live",
              sourceUpdatedAtByPeg: { peggedEUR: now - 300 },
              sourceModeByPeg: { peggedEUR: "live" },
              sourceCadenceByPeg: { peggedEUR: "intraday" },
              sourceDateByPeg: { peggedEUR: null },
            }),
          },
        ],
      },
      { match: "cron_runs", rows: [], throwError: new Error("cron_runs unavailable") },
      { match: "cron_run_progress", rows: [] },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "FROM cache WHERE key = ?", matchBinds: ["stablecoins"], rows: [], first: { value: stablecoinsCache, updated_at: now - 60 } },
      ...makeMinimalLiveStatusRows(now).filter((entry) => entry.matchBinds?.includes("ops:d1-capacity:v1")),
      { match: "blacklist_events", rows: [], first: { total: 10, missing: 0, missing_recent: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request });

    const body = (await readJsonResponse(res, 200)) as {
      availabilityStatus: string;
      summary: { unhealthyCrons: number | null; cronErrors: number | null; cronHistoryUnavailableReason?: string | null };
      sectionErrors: Record<string, { code: string }>;
      crons: Record<string, { healthy: boolean | null; telemetryUnknown?: boolean; telemetryUnknownReason?: string }>;
      causes: { availability: Array<{ code: string }> };
    };

    expect(body.availabilityStatus).toBe("degraded");
    expect(body.summary.unhealthyCrons).toBeNull();
    expect(body.summary.cronErrors).toBeNull();
    expect(body.summary.cronHistoryUnavailableReason).toBe("cron-history-read-failed");
    expect(body.sectionErrors.crons?.code).toBe("cron-history-read-failed");
    expect(Object.values(body.crons).some((cron) => cron.healthy === true)).toBe(false);
    expect(body.crons["sync-stablecoins"]?.healthy).toBeNull();
    expect(body.crons["sync-stablecoins"]?.telemetryUnknown).toBe(true);
    expect(body.crons["sync-stablecoins"]?.telemetryUnknownReason).toBe("cron-history-query-failed");
    expect(body.causes.availability.some((cause) => cause.code === "cron_history_query_failed")).toBe(true);
    expect(body.causes.availability.some((cause) => cause.code === "mint_burn_health_query_failed")).toBe(true);
  });
});

const NOW = 1_800_000_000;

function detailRequest(job: string | null) {
  const request = new Request(`https://ops-api.pharos.watch/api/status-cron-detail${job ? `?job=${job}` : ""}`);
  return { trustedAdmin: true, request, url: new URL(request.url) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("handleStatusCronDetailRoute", () => {
  it("returns full run metadata for the requested job with summary outcome fields", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const metadata = { reason: "stale-slot-reconciled", childDisposition: "abandoned", progressUpdatedAt: NOW - 90,
        reconciledAt: NOW - 30, quality: { reason: "partial-cohort" }, bulky: "x".repeat(4_000) };
      sqlite.prepare(`INSERT INTO cron_runs (job, started_at, duration_ms, status, error, item_count, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run("sync-stablecoins", NOW - 120, 1_000, "error", "e".repeat(900), null, JSON.stringify(metadata));

      const res = await handleStatusCronDetailRoute({ db, ...detailRequest("sync-stablecoins") });
      expect(res.status).toBe(200);
      const body = StatusCronDetailResponseSchema.parse(await res.json());
      expect(body.job).toBe("sync-stablecoins");
      const latest = body.cron.runs[0]!;
      expect(latest.metadata).toMatchObject({ bulky: "x".repeat(4_000) });
      expect(latest.error).toHaveLength(900);
      expect(latest).toMatchObject({
        reason: "stale-slot-reconciled", childDisposition: "abandoned", progressUpdatedAt: NOW - 90,
        reconciledAt: NOW - 30, qualityReasons: ["partial-cohort"],
      });
    } finally {
      sqlite.close();
    }
  });

  it.each([
    [NOW + 61, "future-timestamp"],
    ["malformed", "invalid-timestamp"],
  ])("serves rejected progress as diagnostic evidence without changing clock field nullability (%s)", async (updatedAt, reason) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      sqlite.prepare(`INSERT INTO cron_runs (job, started_at, duration_ms, status, error)
        VALUES (?, ?, ?, ?, ?)`).run("sync-stablecoins", NOW - 60, 100, "error", "prior failure");
      sqlite.prepare(`INSERT INTO cron_leases (job, lease_owner, lease_until, heartbeat_at, updated_at)
        VALUES (?, ?, ?, ?, ?)`).run("sync-stablecoins", "owner", NOW + 300, NOW, NOW);
      sqlite.prepare(`INSERT INTO cron_run_progress (job, started_at, updated_at, stage, lease_owner)
        VALUES (?, ?, ?, ?, ?)`).run("sync-stablecoins", NOW - 30, updatedAt, "recovery", "owner");
      const res = await handleStatusCronDetailRoute({ db, ...detailRequest("sync-stablecoins") });
      const body = StatusCronDetailResponseSchema.parse(await res.json());
      expect(body.cron.healthy).toBe(false);
      expect(body.cron.runs[0].status).toBe("error");
      expect(body.cron.inFlight).toBeNull();
      expect(body.cron.inFlightUnavailable).toMatchObject({
        updatedAt, timestampReason: reason, stale: true, stage: "recovery", leaseOwner: "owner",
      });
      expect(summarizeCronStatus("sync-stablecoins", body.cron).inFlightUnavailable).toEqual(body.cron.inFlightUnavailable);
    } finally {
      sqlite.close();
    }
  });

  it("rejects missing and unknown jobs without reading history", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      expect((await handleStatusCronDetailRoute({ db, ...detailRequest(null) })).status).toBe(400);
      expect((await handleStatusCronDetailRoute({ db, ...detailRequest("not-a-job") })).status).toBe(404);
    } finally {
      sqlite.close();
    }
  });
});

describe("summarizeCronStatus", () => {
  const detail = {
    expectedIntervalSec: 300,
    healthy: true,
    telemetryUnknown: false,
    confirmedOutputAt: NOW - 60,
    inFlight: { startedAt: NOW - 10, updatedAt: NOW - 5, stale: false, metadata: { resourcePressure: undefined, cursor: "a" } },
    runs: [
      { startedAt: NOW - 60, durationMs: 10, status: "ok" as const, error: "y".repeat(800), reason: "r",
        metadata: { messagesSent: 3, pendingDrained: 3, freshSent: 0, perAlertType: { depeg: 0 }, authoritativePlanning: { big: true } } },
      { startedAt: NOW - 360, durationMs: 10, status: "error" as const, metadata: { large: "z".repeat(2_000) } },
    ],
  };

  it("drops metadata, bounds errors and keeps one latest-run fact set", () => {
    const summary = summarizeCronStatus("dispatch-telegram-alerts", detail);
    expect(summary.runs).toHaveLength(2);
    for (const run of summary.runs) expect(run).not.toHaveProperty("metadata");
    expect(summary.runs[0]!.error!.length).toBeLessThanOrEqual(501);
    expect(summary.runs[0]!.reason).toBe("r");
    expect(summary.latestRunFacts).toEqual({ messagesSent: 3, pendingDrained: 3 });
    expect(Object.keys(summary.latestRunFacts!).every((key) =>
      CRON_STATUS_LATEST_FACT_KEYS["dispatch-telegram-alerts"]!.includes(key))).toBe(true);
    expect(summary.inFlight).not.toHaveProperty("metadata");
    expect(summary).not.toHaveProperty("lastRun");
    expect(summary).not.toHaveProperty("recentRuns");
    expect(summary.confirmedOutputAt).toBe(NOW - 60);
  });

  it("projects a degraded reserve-sync reason into summary runs without full metadata", () => {
    const metadata = { reason: "reserve-adapter-or-persistence-failed", reasons: ["reserve-adapter-or-persistence-failed"], failed: 1, synced: 99, bulky: "x".repeat(4_000) };
    const summary = summarizeCronStatus("sync-live-reserves", {
      ...detail,
      runs: [{ startedAt: NOW - 60, durationMs: 10, status: "degraded" as const, ...projectCronRunOutcome(metadata), metadata }],
    });
    expect(summary.runs[0]).toMatchObject({ status: "degraded", reason: "reserve-adapter-or-persistence-failed" });
    expect(summary.runs[0]).not.toHaveProperty("metadata");
  });

  it("serves no facts for jobs outside the registry", () => {
    expect(summarizeCronStatus("sync-blacklist", detail)).not.toHaveProperty("latestRunFacts");
  });

  it("serves validated partition facts from only the selected run without changing its verdict", () => {
    const onchainPartition = { candidates: 8, entered: 1, retained: 1, carried: 1, divergent: 2,
      unreadable: 2, deadlineSkipped: 2, carryExpired: 1, divergences: [{ id: "coin-a", ratio: 1.2 }, { id: "coin-b", ratio: 0.8 }],
      divergencesTruncated: 0 };
    const run = { ...detail.runs[0], metadata: { onchainPartition } };
    const summary = summarizeCronStatus("sync-stablecoins", { ...detail, runs: [run] });
    expect(summary.latestRunFacts).toEqual({ onchainPartition });
    expect(summary.healthy).toBe(detail.healthy);
    expect(summary.confirmedOutputAt).toBe(detail.confirmedOutputAt);
    expect(summary.runs[0].status).toBe("ok");
    for (const value of [null, undefined, {}, { ...onchainPartition, entered: -1 }, { ...onchainPartition, divergent: "2" },
      { ...onchainPartition, divergencesTruncated: 1 }, { ...onchainPartition, divergences: [{ id: "coin-a", ratio: NaN }] }]) {
      const latest = { ...run, metadata: { onchainPartition: value } };
      expect(summarizeCronStatus("sync-stablecoins", { ...detail, runs: [latest, run] }).latestRunFacts)
        .toEqual({ onchainPartition: null });
    }
  });
});

describe("public health snapshot independence", () => {
  it("reads only its own key, never the operator envelope", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const health = makeHealthyHealthResponse();
      expect(await writeStatusPublicHealthSnapshot(db, NOW, health)).toBe(true);
      // An unreadable operator envelope must not affect public admission.
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(STATUS_RAW_SNAPSHOT_CACHE_KEY, "{", NOW);
      const loaded = await loadStatusPublicHealthSnapshot(db, NOW + 30);
      expect(loaded).toMatchObject({ kind: "fresh", updatedAt: NOW });
      expect(loaded.kind === "fresh" ? loaded.payload.publicHealth.status : null).toBe(health.status);
      const rows = sqlite.prepare("SELECT key FROM cache ORDER BY key").all() as Array<{ key: string }>;
      expect(rows.map((row) => row.key)).toEqual([STATUS_PUBLIC_HEALTH_SNAPSHOT_CACHE_KEY, STATUS_RAW_SNAPSHOT_CACHE_KEY].sort());
    } finally {
      sqlite.close();
    }
  });

  it("reports missing when only the operator envelope exists", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(STATUS_RAW_SNAPSHOT_CACHE_KEY, "{}", NOW);
      await expect(loadStatusPublicHealthSnapshot(db, NOW)).resolves.toMatchObject({ kind: "missing" });
    } finally {
      sqlite.close();
    }
  });
});

function telegramStatusMockD1(overrides: NonNullable<Parameters<typeof buildStatusD1Scenario>[0]>["overrides"] = [], healthyLive = false) {
  return buildStatusD1Scenario({
    sections: ["sentinel", "live", "publication", "derived", "reserves", "statusState", "cronState", "telegram"],
    overrides,
    healthyLive,
    sectionOverrides: {
      derived: [
        { match: "pharos:status-derived:mint-burn-24h", rows: [] },
        { match: "pharos:status-derived:mint-burn-first-hour-seek", rows: [] },
        { match: "/* blacklist-gap-metrics-cache-read */", rows: [], first: null },
        { match: "/* blacklist-gap-metrics-cache-write */", rows: [] },
        { match: "blacklist-reconciliation-status-latest", rows: [], first: null },
        { match: "FROM worker_repair_tasks", rows: [] },
        { match: "FROM onchain_supply", rows: [], first: null },
        { match: "FROM supply_history", rows: [], first: null },
        { match: "FROM daily_digest", rows: [], first: null },
      ],
    },
  });
}

describe("handleStatus telegram and cron surfaces", () => {
  afterEach(cleanupStatusTest);
  it("returns Cache-Control: no-store", async () => {
    const db = telegramStatusMockD1([
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request });

    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("includes only registered current cron health data", async () => {
    const db = telegramStatusMockD1([
      { match: "cache WHERE key IN", rows: [] },
      {
        match: "cron_runs",
        rows: [makeCronRow("sync-stablecoins", "ok", 100)],
      },
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request });
    const body = (await res.json()) as {
      crons: Record<string, { runs: unknown[]; healthy: boolean; expectedIntervalSec: number }>;
    };

    expect(body.crons).toHaveProperty("sync-stablecoins");
    const syncStablecoins = body.crons["sync-stablecoins"];
    expect(syncStablecoins.runs).toHaveLength(1);
    expect(syncStablecoins.runs[0]).toMatchObject({ status: "ok" });
    expect(syncStablecoins).not.toHaveProperty("lastRun");
    expect(syncStablecoins).not.toHaveProperty("recentRuns");
    expect(syncStablecoins.runs[0]).not.toHaveProperty("metadata");
    expect(syncStablecoins).toHaveProperty("healthy");
    expect(syncStablecoins).toHaveProperty("expectedIntervalSec");
    expect(body.crons["sync-blacklist"]?.expectedIntervalSec).toBe(6 * 3600);
    expect(body.crons["sync-dex-discovery"]?.expectedIntervalSec).toBe(6 * 3600);
    expect(body.crons["sync-live-reserves"]?.expectedIntervalSec).toBe(4 * 3600);
    expect(body.crons["sync-yield-data"]?.expectedIntervalSec).toBe(2 * 3600);
    expect(body.crons["sync-yield-supplemental"]?.expectedIntervalSec).toBe(4 * 3600);
    expect(body.crons["prune-status-probe-runs"]?.expectedIntervalSec).toBe(86400);
    expect(body.crons).not.toHaveProperty("compute-safety-score-v9-workflow");
  });

  it("includes budget-only scheduled surface telemetry in status", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = telegramStatusMockD1([
      {
        match: "FROM cache",
        matchBinds: [
          "cron:budget-surface:price-corroboration",
          "cron:budget-surface:telegram-registration-reconciliation",
          "cron:budget-surface:telegram-digest-outbox-drain",
          "cron:budget-surface:safety-map-producer-kick",
          "cron:budget-surface:digest-trigger-poll",
        ],
        rows: [
          {
            key: "cron:budget-surface:digest-trigger-poll",
            updated_at: now - 45,
            value: JSON.stringify({
              version: 1,
              surface: "digest-trigger-poll",
              checkedAt: now - 45,
              durationMs: 64,
              dueCount: 0,
              processedCount: 0,
              outcome: "skipped",
              skippedReason: "no-pending-request",
            }),
          },
        ],
      },
      { match: "cache WHERE key IN", rows: [makeCacheRow("stablecoins"), makeCacheRow("stablecoin-charts")] },
      { match: "FROM cache WHERE key = ?", matchBinds: ["stablecoins"], rows: [], first: { value: JSON.stringify({ peggedAssets: [] }), updated_at: now - 60 } },
    ]);

    const request = fixtureMakeApiRequest("/api/status?refresh=live", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request });

    const body = (await readJsonResponse(res, 200)) as {
      budgetOnlySurfaces: Array<{
        job: string;
        telemetryStatus: string;
        outcome: string;
        skippedReason?: string | null;
      }>;
      summary: { budgetOnlySurfaceCount?: number; budgetOnlySurfaceMissingTelemetry?: number };
    };
    expect(body.budgetOnlySurfaces).toEqual([
      expect.objectContaining({
        job: "price-corroboration",
        expectedIntervalSec: 900,
        telemetryStatus: "missing",
        outcome: "unknown",
      }),
      expect.objectContaining({
        job: "telegram-registration-reconciliation",
        telemetryStatus: "missing",
        outcome: "unknown",
      }),
      expect.objectContaining({
        job: "telegram-digest-outbox-drain",
        telemetryStatus: "missing",
        outcome: "unknown",
      }),
      expect.objectContaining({
        job: "safety-map-producer-kick",
        expectedIntervalSec: 86400,
        telemetryStatus: "missing",
        outcome: "unknown",
      }),
      expect.objectContaining({
        job: "digest-trigger-poll",
        telemetryStatus: "fresh",
        outcome: "skipped",
        skippedReason: "no-pending-request",
      }),
    ]);
    expect(body.summary.budgetOnlySurfaceCount).toBe(5);
    expect(body.summary.budgetOnlySurfaceMissingTelemetry).toBe(4);
  });

  it("includes in-flight cron progress when a leased job is still running", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = telegramStatusMockD1([
      { match: "cache WHERE key IN", rows: [] },
      { match: "cron_runs", rows: [makeCronRow("dispatch-telegram-alerts", "ok", 30)] },
      {
        match: "cron_leases",
        rows: [{ job: "dispatch-telegram-alerts", lease_owner: "lease-123", lease_until: now + 600 }],
      },
      {
        match: "cron_run_progress",
        rows: [
          {
            job: "dispatch-telegram-alerts",
            started_at: now - 120,
            updated_at: now - 10,
            stage: "pending-drain",
            items_done: 2,
            items_total: 7,
            message: "Draining due Telegram pending rows",
            lease_owner: "lease-123",
            metadata: JSON.stringify({
              providerFamily: "telegram-api",
              phase: "pending-drain",
              countTotals: { pendingAttempted: 2, pendingTotal: 7 },
              cursor: { queue: "telegram_deliveries" },
              deferredTail: { total: 7, due: 2, deferred: 5, oldestPendingAgeSec: 120 },
            }),
          },
        ],
      },
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request });
    const body = (await res.json()) as {
      crons: Record<
        string,
        {
          inFlight?: {
            stage?: string;
            stale: boolean;
            itemsDone?: number;
            itemsTotal?: number;
            metadata?: Record<string, unknown>;
          } | null;
        }
      >;
    };

    expect(body.crons["dispatch-telegram-alerts"]?.inFlight).toMatchObject({
      stage: "pending-drain",
      stale: false,
      itemsDone: 2,
      itemsTotal: 7,
    });
    expect(body.crons["dispatch-telegram-alerts"]?.inFlight).not.toHaveProperty("metadata");
    const detailResponse = await handleStatusCronDetailRoute({
      db, trustedAdmin: true,
      request: fixtureMakeApiRequest("/api/status-cron-detail?job=dispatch-telegram-alerts", { adminKey: "secret-key" }),
      url: new URL("https://ops-api.pharos.watch/api/status-cron-detail?job=dispatch-telegram-alerts"),
    });
    const detail = await readJsonResponse<{ cron: { inFlight: { metadata?: Record<string, unknown> } } }>(detailResponse, 200);
    expect(detail.cron.inFlight.metadata).toEqual({
      providerFamily: "telegram-api",
      phase: "pending-drain",
      countTotals: { pendingAttempted: 2, pendingTotal: 7 },
      cursor: { queue: "telegram_deliveries" },
      deferredTail: { total: 7, due: 2, deferred: 5, oldestPendingAgeSec: 120 },
    });
  });

  it("treats a fresh in-flight recovery run as healthy even if the last completed run errored", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const jobs = Object.keys(fixtureCRON_INTERVALS);
    const cronRows = [
      ...jobs.map((job) => makeCronRow(job, job === "sync-blacklist" ? "error" : "ok", 30)),
      makeCronRow("sync-redemption-backstops", "ok", 30),
    ];
    const db = telegramStatusMockD1([{ match: "cron_runs", rows: cronRows },
    {
      match: "cron_leases",
      rows: [{ job: "sync-blacklist", lease_owner: "lease-456", lease_until: now + 600 }],
    },
    {
      match: "cron_run_progress",
      rows: [
        {
          job: "sync-blacklist",
          started_at: now - 120,
          updated_at: now - 10,
          stage: "scan-config",
          items_done: 4,
          items_total: 7,
          message: "Scanning USDT on Ethereum",
          lease_owner: "lease-456",
          metadata: JSON.stringify({ budgetUsed: 31, budgetLimit: 900 }),
        },
      ],
    },
    { match: "FROM cache WHERE key = ?", matchBinds: ["stablecoins"], rows: [], first: { value: stablecoinsCache, updated_at: now - 60 } },
    { match: "blacklist_events", rows: [], first: { total: 1000, missing: 0, missing_recent: 0 } },
    { match: "MAX(updated_at) as latest", rows: [], first: { latest: now - 5 * 86400, tracked: 12 } },], true);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request });
    const body = (await res.json()) as {
      availabilityStatus: string;
      summary: { unhealthyCrons: number; cronErrors: number };
      crons: Record<string, { healthy: boolean }>;
    };

    expect(body.crons["sync-blacklist"]?.healthy).toBe(true);
    expect(body.summary.unhealthyCrons).toBe(0);
    expect(body.summary.cronErrors).toBe(0);
    expect(body.availabilityStatus).toBe("healthy");
  });

  it("ignores orphaned in-flight progress when the lease is no longer active", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = telegramStatusMockD1([
      { match: "cache WHERE key IN", rows: [] },
      { match: "cron_runs", rows: [makeCronRow("sync-blacklist", "error", 30)] },
      { match: "cron_leases", rows: [] },
      {
        match: "cron_run_progress",
        rows: [
          {
            job: "sync-blacklist",
            started_at: now - 120,
            updated_at: now - 10,
            stage: "scan-config",
            items_done: 4,
            items_total: 7,
            message: "Scanning USDT on Ethereum",
            lease_owner: "stale-lease",
            metadata: JSON.stringify({ budgetUsed: 31, budgetLimit: 900 }),
          },
        ],
      },
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request });
    const body = (await res.json()) as {
      crons: Record<string, { healthy: boolean; inFlight?: unknown | null }>;
      summary: { unhealthyCrons: number };
      availabilityStatus: string;
    };

    expect(body.crons["sync-blacklist"]?.inFlight).toBeNull();
    expect(body.crons["sync-blacklist"]?.healthy).toBe(false);
    expect(body.summary.unhealthyCrons).toBeGreaterThan(0);
    expect(body.availabilityStatus).toBe("stale");
  });

  it("keeps availability healthy when only a watch-tier cron is unhealthy", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const cronRows = Object.keys(fixtureCRON_INTERVALS).map((job) =>
      makeCronRow(job, job === "sync-live-reserves" ? "error" : "ok", 60),
    );
    const db = telegramStatusMockD1([{ match: "cron_runs", rows: cronRows },
    { match: "FROM cache WHERE key = ?", matchBinds: ["stablecoins"], rows: [], first: { value: stablecoinsCache, updated_at: now - 60 } },
    { match: "MAX(updated_at) as latest", rows: [], first: { latest: now - 5 * 86400, tracked: 12 } },], true);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request });
    const body = (await res.json()) as {
      availabilityStatus: string;
      summary: {
        unhealthyCrons: number;
        availabilityImpactingUnhealthyCrons: number;
        watchUnhealthyCrons: number;
        availabilityImpactingCronErrors: number;
      };
      causes: { availability: Array<{ code: string; severity: string }> };
    };

    expect(body.availabilityStatus).toBe("healthy");
    expect(body.summary.unhealthyCrons).toBe(1);
    expect(body.summary.availabilityImpactingUnhealthyCrons).toBe(0);
    expect(body.summary.watchUnhealthyCrons).toBe(1);
    expect(body.summary.availabilityImpactingCronErrors).toBe(0);
    expect(
      body.causes.availability.some(
        (cause) => cause.code === "watch_unhealthy_crons_present" && cause.severity === "info",
      ),
    ).toBe(true);
  });

  it("includes Telegram bot subscriber stats when Telegram tables are present", async () => {
    const db = telegramStatusMockD1([
      { match: "cache WHERE key IN", rows: [] },
      { match: "cron_runs", rows: [makeCronRow("dispatch-telegram-alerts", "ok", 60)] },
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      {
        match: "FROM telegram_subscribers s",
        rows: [],
        first: {
          total_chats: 12,
          alert_enabled_chats: 10,
          deliverable_chats: 9,
          subscribed_chats: 11,
          empty_alert_chats: 1,
          muted_chats_with_subscriptions: 2,
          dews_chats: 8,
          depeg_chats: 7,
          safety_chats: 6,
          launch_chats: 5,
          freeze_chats: 4,
          all_types_chats: 5,
          total_subscriptions: 37,
          avg_subscriptions_per_subscribed_chat: 3.36,
          last_subscriber_activity_at: 1772000000,
        },
      },
      {
        match: TELEGRAM_PENDING_CAPACITY_SQL,
        rows: [],
        first: {
          total: 4,
          expired: 0,
          due: 4,
          deferred: 0,
          near_ttl: 0,
          pending_sending: 0,
          pending_execution_unknown: 0,
          sent_cleanup: 0,
          fresh_sending: 0,
          fresh_execution_unknown: 0,
          fresh_uncertain_sample_count: 0,
        },
      },
      {
        match: "SELECT COUNT(*) AS pending_count FROM telegram_deliveries WHERE state IN ('pending', 'retry')",
        rows: [],
        first: { pending_count: 4 },
      },
      {
        match: "GROUP BY stablecoin_id",
        rows: [
          { stablecoin_id: "usdc-circle", subscribers: 7 },
          { stablecoin_id: "usde-ethena", subscribers: 4 },
        ],
      },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request });
    const body = (await res.json()) as {
      telegramBot: {
        totalChats: number;
        deliverableChats: number;
        totalSubscriptions: number;
        pendingDeliveries: number;
        deliverySli: {
          availability: string;
          quality: string;
          freshness: string;
          acceptanceDefinition: string;
          rollup: { evidence: { freshness: string } } | null;
        };
        customPreferenceChats: number;
        quietHoursEnabledChats: number;
        alertTypeChats: {
          dews: number;
          depeg: number;
          safety: number;
          launch: number;
          reserve: number;
          freeze: number;
          allTypes: number;
        };
        topStablecoins: Array<{
          stablecoinId: string;
          symbol: string;
          subscribers: number;
          explicitSubscribers: number;
          presetImpliedSubscribers: number;
        }>;
      } | null;
    };

    expect(body.telegramBot).not.toBeNull();
    expect(body.telegramBot?.totalChats).toBe(12);
    expect(body.telegramBot?.deliverableChats).toBe(9);
    expect(body.telegramBot?.totalSubscriptions).toBe(37);
    expect(body.telegramBot?.pendingDeliveries).toBe(4);
    expect(body.telegramBot?.deliverySli).toMatchObject({
      availability: "available",
      quality: "empty",
      freshness: "empty",
      acceptanceDefinition: "telegram_bot_api_accepted_not_user_receipt",
      rollup: { evidence: { freshness: "empty" } },
    });
    expect(body.telegramBot?.customPreferenceChats).toBe(0);
    expect(body.telegramBot?.quietHoursEnabledChats).toBe(0);
    expect(body.telegramBot?.alertTypeChats).toEqual({
      dews: 8,
      depeg: 7,
      safety: 6,
      launch: 5,
      reserve: 0,
      freeze: 4,
      allTypes: 5,
    });
    expect(body.telegramBot?.topStablecoins).toEqual([
      {
        stablecoinId: "usdc-circle",
        symbol: "USDC",
        subscribers: 7,
        explicitSubscribers: 7,
        presetImpliedSubscribers: 0,
      },
      {
        stablecoinId: "usde-ethena",
        symbol: "USDe",
        subscribers: 4,
        explicitSubscribers: 4,
        presetImpliedSubscribers: 0,
      },
    ]);
  });

  it("surfaces Telegram subsection loader failures through sectionErrors", async () => {
    const db = telegramStatusMockD1([
      { match: "cache WHERE key IN", rows: [] },
      { match: "cron_runs", rows: [makeCronRow("sync-stablecoins", "ok", 100)] },
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      {
        match: "FROM telegram_subscribers s",
        rows: [],
        throwError: "no such table: telegram_subscribers",
      },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request });
    const body = (await readJsonResponse(res, 200)) as {
      sectionErrors: Record<string, { code: string; message: string } | undefined>;
      telegramBot: unknown;
    };

    expect(body.telegramBot).toBeNull();
    expect(body.sectionErrors.telegramBot).toEqual({
      code: "telegram_bot_stats_query_failed",
      message: "Telegram bot diagnostics unavailable.",
    });
  });

  it("marks status degraded and skips data-quality queries when DB sentinel fails", async () => {
    const db = telegramStatusMockD1([
    ]) as D1Database & { prepare: (sql: string) => D1PreparedStatement };

    const seenSql: string[] = [];
    const originalPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      seenSql.push(sql);
      if (sql.trim() === "SELECT 1") {
        return {
          bind: () => ({
            all: async () => ({ results: [], success: true, meta: {} }),
            first: async () => {
              throw new Error("db down");
            },
            run: async () => ({ success: true, meta: {} }),
          }),
          all: async () => ({ results: [], success: true, meta: {} }),
          first: async () => {
            throw new Error("db down");
          },
          run: async () => ({ success: true, meta: {} }),
        } as unknown as D1PreparedStatement;
      }
      return originalPrepare(sql);
    }) as typeof db.prepare;

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request });
    const body = (await readJsonResponse(res, 200)) as {
      dbHealthy: boolean;
      rawOverallStatus: string;
      overallStatus: string;
    };

    expect(body.dbHealthy).toBe(false);
    expect(["degraded", "stale"]).toContain(body.rawOverallStatus);
    expect(["degraded", "stale"]).toContain(body.overallStatus);
    expect(seenSql.some((sql) => sql.includes("FROM depeg_events"))).toBe(false);
    expect(seenSql.some((sql) => sql.includes("FROM onchain_supply"))).toBe(false);
  });

  it("keeps cron healthy when latest run is skipped_locked but a fresh ok run exists", async () => {
    const db = telegramStatusMockD1([
      { match: "cache WHERE key IN", rows: [] },
      {
        match: "cron_runs",
        rows: [makeCronRow("sync-stablecoins", "skipped_locked", 30), makeCronRow("sync-stablecoins", "ok", 90)],
      },
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request });
    const body = (await res.json()) as {
      crons: Record<string, { healthy: boolean }>;
    };

    expect(body.crons["sync-stablecoins"]?.healthy).toBe(true);
  });

  it("treats fresh degraded cron runs with confirmed output as warning-only (not availability unhealthy)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const jobs = Object.keys(fixtureCRON_INTERVALS);
    const cronRows = [
      ...jobs.map((job) => ({
        ...makeCronRow(job, job === "fetch-tbill-rate" ? "degraded" : "ok", 30),
        metadata: JSON.stringify({ outputPublishedAt: now - 30 }),
      })),
      makeCronRow("sync-redemption-backstops", "ok", 30),
    ];
    const db = telegramStatusMockD1([{ match: "cron_runs", rows: cronRows },
    { match: "FROM cache WHERE key = ?", matchBinds: ["stablecoins"], rows: [], first: { value: stablecoinsCache, updated_at: now - 60 } },
    { match: "blacklist_events", rows: [], first: { total: 1000, missing: 1, missing_recent: 0 } },
    { match: "MAX(updated_at) as latest", rows: [], first: { latest: now - 5 * 86400, tracked: 12 } },], true);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request });
    const body = (await res.json()) as {
      availabilityStatus: string;
      summary: { unhealthyCrons: number; degradedCrons: number };
      crons: Record<string, { healthy: boolean }>;
    };

    expect(body.crons["fetch-tbill-rate"]?.healthy).toBe(true);
    expect(body.summary.unhealthyCrons).toBe(0);
    expect(body.summary.degradedCrons).toBe(1);
    expect(body.availabilityStatus).toBe("healthy");
  });
});

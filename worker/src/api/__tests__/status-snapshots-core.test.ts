import { readJsonResponse } from "./api-request-response.test-support";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatusResponseSchema } from "@shared/types/status";
import { registerUnauthorizedEndpointContract } from "../../test-helpers/__shared/endpoint-contracts";
import {
  handleStatus,
  STATUS_RAW_SNAPSHOT_CACHE_KEY,
  STATUS_RAW_SNAPSHOT_MAX_AGE_SEC,
  makeCacheRow,
  makeCronRow,
  makeRawStatusSnapshotRow,
  makeMinimalLiveStatusRows,
  cleanupStatusTest,
  fixtureMockD1 as baseFixtureMockD1,
  fixtureMakeApiRequest,
  fixtureDependencyHealthModule,
} from "./status.test-support";

function fixtureMockD1(
  tables: Parameters<typeof baseFixtureMockD1>[0] = [],
  options: Parameters<typeof baseFixtureMockD1>[1] = {},
) {
  return baseFixtureMockD1([
    ...tables,
    { match: "SELECT 1", rows: [], first: { "1": 1 } },
    { match: "WHERE key IN ('yield-rankings'", rows: [] },
    { match: "SELECT key, value FROM cache WHERE key IN (", rows: [] },
    { match: "SELECT key, LENGTH(value) as bytes FROM cache", rows: [] },
    { match: "FROM mint_burn_hourly INDEXED BY idx_mbh_ts", rows: [] },
    { match: "FROM (VALUES", rows: [] },
    { match: "FROM reserve_sync_state", rows: [] },
    { match: "FROM reserve_composition", rows: [] },
    { match: "JOIN reserve_sync_state", rows: [] },
    { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
    { match: "SELECT updated_at FROM cache WHERE key = ?", rows: [], first: null },
    { match: "SELECT value FROM cache WHERE key = ?", rows: [], first: null },
    { match: "SELECT key, value, updated_at FROM cache WHERE key IN (", rows: [] },
    { match: "FROM dex_liquidity_publication_generations", rows: [], first: null },
    { match: "FROM yield_publication_generations", rows: [], first: null },
    { match: "FROM surface_publication_generations", rows: [], first: null },
    { match: "FROM stability_index_samples", rows: [], first: null },
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
    { match: "SELECT COUNT(*) AS pending_count FROM telegram_pending_disambiguation", rows: [], first: { pending_count: 0 } },
    { match: "SELECT COUNT(*) AS pending_count FROM telegram_pending_alerts", rows: [], first: { pending_count: 0 } },
    { match: "FROM telegram_pending_alerts", rows: [], first: null },
    { match: "FROM telegram_alert_job_targets", rows: [], first: null },
    { match: "FROM telegram_processed_updates", rows: [], first: null },
    { match: "FROM telegram_recap_preferences", rows: [], first: null },
    { match: "FROM telegram_recap_targets", rows: [], first: null },
    { match: "FROM telegram_usage_daily", rows: [], first: null },
    { match: "SELECT snapshot_at FROM telegram_watcher_lifecycle_daily WHERE day = ?", rows: [], first: null },
    { match: "FROM telegram_watcher_lifecycle_daily", rows: [] },
    { match: "FROM onchain_supply", rows: [], first: { latest: null, tracked: 0 } },
    { match: "FROM blacklist_reconciliation_runs", rows: [], first: null },
    { match: "FROM worker_repair_tasks", rows: [], first: null },
    { match: "SELECT COUNT(*) AS cnt FROM status_transitions", rows: [], first: { cnt: 0 } },
    { match: "SELECT scope, current_status, raw_status", rows: [], first: null },
    { match: "SELECT created_at, status, sample_count", rows: [], first: null },
    { match: "SELECT consecutive_divergent FROM status_discrepancy_state", rows: [], first: null },
    { match: "SELECT id, scope, previous_status", rows: [], first: null },
    { match: "SELECT MAX(snapshot_date) as latest FROM supply_history", rows: [], first: null },
    { match: "SELECT MAX(generated_at) as latest FROM daily_digest", rows: [], first: null },
    { match: "SELECT MAX(started_at) as latest", rows: [], first: null },
    { match: "blacklist-reconciliation-status-latest", rows: [], first: null },
    { match: "FROM cron_leases", rows: [] },
    { match: "FROM cron_run_progress", rows: [] },
    { match: "FROM cron_slot_executions", rows: [] },
  ], options);
}

describe("handleStatus", () => {
  afterEach(cleanupStatusTest);
  registerUnauthorizedEndpointContract({
    name: "status",
    invoke: () => handleStatus({ db: fixtureMockD1([]) }),
    body: { error: "Unauthorized" },
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

    const nonCircuitBatchCacheReads = db
      .getHistory()
      .filter((entry) => entry.sql.includes("cache WHERE key IN"))
      .filter((entry) => !entry.binds.every((bind) => typeof bind === "string" && bind.startsWith("circuit:")));
    expect(nonCircuitBatchCacheReads).toEqual([]);
    const sql = db
      .getHistory()
      .map((entry) => entry.sql)
      .join("\n");
    expect(sql).not.toContain("blacklist_events");
  });

  it("preserves healthy, public-impact degraded, and publication-query-unavailable status tuples", async () => {
    const now = Math.floor(Date.now() / 1000);
    const publicImpactCause = {
      code: "cache_ratio_degraded",
      layer: "availability",
      severity: "warning",
      message: "Public cache freshness exceeded the degraded threshold.",
    };
    const scenarios = [
      {
        name: "healthy",
        raw: {},
        tables: [],
        expected: { overallStatus: "healthy", causeCodes: [], sectionErrorCode: null },
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
        expected: { overallStatus: "degraded", causeCodes: ["cache_ratio_degraded"], sectionErrorCode: null },
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
        ...scenario.tables,
      ]);
      const response = await handleStatus({ db, trustedAdmin: true, request: fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" }) });
      const payload = await response.json();
      const parsed = StatusResponseSchema.parse(payload);

      expect({
        overallStatus: parsed.overallStatus,
        causeCodes: parsed.causes.overall.map((cause) => cause.code),
        sectionErrorCode: parsed.sectionErrors.publicationHealth?.code ?? null,
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
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: [STATUS_RAW_SNAPSHOT_CACHE_KEY],
        rows: [
          makeRawStatusSnapshotRow(now, 60, {
            rawOverallStatus: "stale",
            availabilityStatus: "stale",
            causes: {
              availability: [
                {
                  code: "fresh-snapshot-sentinel",
                  layer: "availability",
                  severity: "critical",
                  message: "must not be served",
                },
              ],
              dataQuality: [],
              overall: [
                {
                  code: "fresh-snapshot-sentinel",
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

  it("treats malformed request URLs as normal snapshot-eligible status requests", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = fixtureMockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: [STATUS_RAW_SNAPSHOT_CACHE_KEY],
        rows: [],
        first: null,
      },
      ...makeMinimalLiveStatusRows(now),
    ]);

    const request = { url: "http://[" } as Request;
    const res = await handleStatus({ db, trustedAdmin: true, request });

    const body = (await readJsonResponse(res, 200)) as { rawOverallStatus: string };
    expect(["healthy", "degraded", "stale"]).toContain(body.rawOverallStatus);
    expect(db.getHistory().some((entry) => entry.binds[0] === STATUS_RAW_SNAPSHOT_CACHE_KEY)).toBe(true);
  });

  it("returns 200 with status body when authorized", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [
        {
          id: "usdt-tether",
          symbol: "USDT",
          price: 1.0,
          consensusSources: ["coingecko", "defillama-list", "pyth"],
          circulating: { peggedUSD: 100_000_000 },
        },
        {
          id: "usdc-circle",
          symbol: "USDC",
          price: 1.0,
          consensusSources: ["coingecko"],
          circulating: { peggedUSD: 100_000_000 },
        },
        {
          id: "pyusd-paypal",
          symbol: "PYUSD",
          price: 1.0,
          consensusSources: ["coingecko", "defillama-list", "pyth", "binance", "coinbase"],
          circulating: { peggedUSD: 100_000_000 },
        },
      ],
    });

    const db = fixtureMockD1([
      // buildCacheStatuses queries the cache table
      {
        match: "cache WHERE key IN",
        rows: [makeCacheRow("stablecoins"), makeCacheRow("stablecoin-charts")],
      },
      // Table freshness queries (dex-liquidity, yield-data, dews)
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      // cron_runs query
      {
        match: "cron_runs",
        rows: [
          {
            ...makeCronRow("sync-stablecoins"),
            metadata: JSON.stringify({
              priceSourceHealth: {
                sourceDistribution: {
                  coingecko: 14,
                  "coingecko+defillama-list": 118,
                  defillama: 10,
                  "defillama-list": 0,
                  "protocol-redeem": 1,
                  "defillama-contract": 4,
                  coinmarketcap: 2,
                  dexscreener: 1,
                  jupiter: 0,
                  pyth: 0,
                  binance: 0,
                  kraken: 0,
                  bitstamp: 0,
                  coinbase: 0,
                  redstone: 0,
                  "curve-onchain": 0,
                  "dex-promoted": 0,
                  geckoterminal: 0,
                  "pool-tvl-weighted": 0,
                  cached: 4,
                  missing: 3,
                },
                confidenceDistribution: {
                  high: 127,
                  "single-source": 15,
                  low: 8,
                  fallback: 6,
                },
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
                nearCoverageGuard: false,
                nearValueGuard: false,
                nearMajorCoverageGuard: false,
                currentCoverageClasses: {
                  primary: 80,
                  mixed: 20,
                  fallback: 20,
                  legacy: 0,
                  unobserved: 36,
                },
                previousCoverageClasses: {
                  primary: 82,
                  mixed: 18,
                  fallback: 25,
                  legacy: 0,
                  unobserved: 31,
                },
              },
            }),
          },
          makeCronRow("sync-stablecoin-charts"),
          makeCronRow("sync-blacklist"),
        ],
      },
      // Data quality: stablecoins cache for missing prices
      {
        match: "cache",
        rows: [],
        first: { value: stablecoinsCache, updated_at: now - 60 },
      },
      // Data quality: blacklist totals
      { match: "blacklist_events", rows: [], first: { total: 10, missing: 2 } },
      // Data quality: active depegs
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      // Data quality: stale on-chain supply
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      // Data quality: on-chain divergences (empty — no rows)
      { match: "onchain_supply WHERE updated_at >", rows: [] },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request });

    const body = (await readJsonResponse(res, 200)) as {
      timestamp: number;
      dbHealthy: boolean;
      overallStatus: string;
      caches: Record<string, unknown>;
      crons: Record<string, unknown>;
      dataQuality: Record<string, unknown>;
      telegramBot: Record<string, unknown> | null;
      sectionErrors: Record<string, { code: string; message: string } | undefined>;
      datasetFreshness: Record<string, number | null>;
      state: Record<string, unknown>;
      priceSourceHealth: Record<string, unknown> | null;
      coingeckoPriceDiff: Record<string, unknown> | null;
      d1Usage: Record<string, unknown> | null;
      liquidityHealth: Record<string, unknown> | null;
      yieldHealth: Record<string, unknown> | null;
      publicationHealth: Record<string, unknown> | null;
      dependencyHealth: Record<string, unknown> | null;
      providerCircuitHealth: Record<string, unknown> | null;
      canaries: Record<string, unknown> | null;
      mintBurnReconciliation: Record<string, unknown> | null;
      reserveComposition: Record<string, unknown>;
      producerHeads: Array<{
        observed: boolean;
        invocationCount: number;
        productiveCount: number;
      }>;
    };

    expect(body).toHaveProperty("timestamp");
    expect(body).toHaveProperty("dbHealthy");
    expect(body).toHaveProperty("overallStatus");
    expect(body).toHaveProperty("caches");
    expect(body).toHaveProperty("crons");
    expect(body).toHaveProperty("dataQuality");
    expect(body).toHaveProperty("telegramBot");
    expect(body).toHaveProperty("sectionErrors");
    expect(body).toHaveProperty("datasetFreshness");
    expect(body).toHaveProperty("state");
    expect(body).toHaveProperty("priceSourceHealth");
    expect(body).toHaveProperty("coingeckoPriceDiff");
    expect(body).toHaveProperty("d1Usage");
    expect(body).toHaveProperty("liquidityHealth");
    expect(body).toHaveProperty("yieldHealth");
    expect(body).toHaveProperty("publicationHealth");
    expect(body).toHaveProperty("dependencyHealth");
    expect(body).toHaveProperty("providerCircuitHealth");
    expect(body).toHaveProperty("canaries");
    expect(body).toHaveProperty("mintBurnReconciliation");
    expect(body).toHaveProperty("reserveComposition");
    expect(body.producerHeads.length).toBeGreaterThan(0);
    expect(body.producerHeads.every((head) =>
      !head.observed && head.invocationCount === 0 && head.productiveCount === 0,
    )).toBe(true);
    expect(body.sectionErrors).not.toHaveProperty("producerHistory");
    expect(body.reserveComposition).toMatchObject({
      cursorTailState: null,
      cursorTailError: null,
      cursorRecordedAt: null,
      cursorTailCompletedAt: null,
      cursorTailFailedAt: null,
      runBudgetTruncationCount: 0,
      historyWriteGaps: [],
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

  it("coerces malformed liquidity coverage-class metadata to zero", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = fixtureMockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: [STATUS_RAW_SNAPSHOT_CACHE_KEY],
        rows: [
          makeRawStatusSnapshotRow(now, 60, {
            crons: {
              "sync-dex-liquidity": {
                lastRun: {
                  status: "ok",
                  metadata: {
                    sourceCoverage: {
                      currentCoverage: 120,
                      currentCoverageClasses: {
                        primary: "12",
                        mixed: "not-a-number",
                        fallback: "NaN",
                        legacy: [],
                      },
                      previousCoverageClasses: {
                        primary: "Infinity",
                        mixed: "-Infinity",
                        fallback: {},
                        legacy: "",
                        unobserved: "7",
                      },
                    },
                  },
                },
                recentRuns: [],
                expectedIntervalSec: 1800,
                healthy: true,
              },
            },
          }),
        ],
      },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request });

    const body = (await readJsonResponse(res, 200)) as {
      liquidityHealth: {
        currentCoverageClasses: Record<string, number>;
        previousCoverageClasses: Record<string, number>;
      } | null;
    };

    expect(body.liquidityHealth).not.toBeNull();
    expect(body.liquidityHealth?.currentCoverageClasses).toEqual({
      primary: 12,
      mixed: 0,
      fallback: 0,
      legacy: 0,
      unobserved: 0,
    });
    expect(body.liquidityHealth?.previousCoverageClasses).toEqual({
      primary: 0,
      mixed: 0,
      fallback: 0,
      legacy: 0,
      unobserved: 7,
    });
  });

  it("surfaces providerDiagnostics and gtProbe from sync-stablecoins metadata", async () => {
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
      { match: "stress_signals", rows: [], first: { age: 300 } },
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
      {
        match: "cache",
        rows: [],
        first: { value: stablecoinsCache, updated_at: now - 60 },
      },
      { match: "blacklist_events", rows: [], first: { total: 10, missing: 2 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at >", rows: [] },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request });

    const body = (await readJsonResponse(res, 200)) as {
      priceProviderDiagnostics: Array<Record<string, unknown>> | null;
      gtProbe: Record<string, unknown> | null;
    };

    expect(body).toHaveProperty("priceProviderDiagnostics");
    expect(body).toHaveProperty("gtProbe");
    expect(body.priceProviderDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "binance", endpoint: expect.any(String), status: 403 }),
      ]),
    );
    expect(body.gtProbe).toEqual(
      expect.objectContaining({
        updatedCount: expect.any(Number),
        budgetExhausted: expect.any(Boolean),
        transports: expect.any(Object),
      }),
    );
  });

  it("treats cron history query failure as unknown telemetry instead of stale cron health", async () => {
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
      { match: "stress_signals", rows: [], first: { age: 300 } },
      { match: "cache", rows: [], first: { value: stablecoinsCache, updated_at: now - 60 } },
      { match: "blacklist_events", rows: [], first: { total: 10, missing: 0, missing_recent: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at >", rows: [] },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request });

    const body = (await readJsonResponse(res, 200)) as {
      availabilityStatus: string;
      summary: { unhealthyCrons: number };
      crons: Record<string, { healthy: boolean; telemetryUnknown?: boolean }>;
      causes: { availability: Array<{ code: string }> };
    };

    expect(body.availabilityStatus).toBe("healthy");
    expect(body.summary.unhealthyCrons).toBe(0);
    expect(body.crons["sync-stablecoins"]?.healthy).toBe(true);
    expect(body.crons["sync-stablecoins"]?.telemetryUnknown).toBe(true);
    expect(body.causes.availability.some((cause) => cause.code === "cron_history_query_failed")).toBe(true);
  });
});

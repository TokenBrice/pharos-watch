import { describe, expect, it, vi, afterEach } from "vitest";
import { attachDdrPublicRowHash, computeDdrPublicRowHash } from "@shared/lib/depeg-resolver/public-contract";
import type { DdrRow } from "@shared/types/depeg-resolver";
import { mockD1, type MockD1Database, type MockTableConfig } from "@shared/test-utils/mock-d1";
import type { DdrCanonicalIncident, DdrSealedPublicPrediction } from "../depeg-resolver-v2-contracts";
import { DDR_METHODOLOGY_VERSION, DDR_SNAPSHOT_CACHE_GENERATION } from "@shared/lib/methodology-versions/depeg-resolver";
import { buildDdrResponse } from "../depeg-resolver/public-projection";
import { sealEligibleLocks } from "../depeg-resolver/publication";
import type { DdrEventDbRow } from "../depeg-resolver/types";
import { computeDepegResolver, type DdrV2StoreContracts } from "../compute-depeg-resolver";
import { buildDewsStablecoinIdsDigest } from "../../lib/dews-publication-pointer";
import {
  makeDdrCanonicalIncident,
  makeDdrPublicationManifest,
  makeDdrResolverRow,
  makeDdrSealedPublicPrediction,
} from "./depeg-public-projection.test-support";

afterEach(() => {
  vi.useRealTimers();
});

describe("computeDepegResolver", () => {
  const NOW_SEC = 1_779_984_600;

  function activeEvent(overrides: Partial<DdrEventDbRow> = {}): DdrEventDbRow & Record<string, unknown> {
    return {
      id: 42,
      stablecoin_id: "lane-b-test",
      symbol: "LBT",
      peg_type: "peggedUSD",
      direction: "below",
      peak_deviation_bps: -250,
      started_at: NOW_SEC - 90_000,
      ended_at: null,
      recovery_price: null,
      peg_reference: 1,
      source: "live",
      confirmation_sources: null,
      pending_reason: null,
      provenance_replay_run_id: null,
      provenance_replay_version: null,
      ...overrides,
    } as DdrEventDbRow & Record<string, unknown>;
  }

  function resolverRow(overrides: Partial<DdrRow> = {}): DdrRow {
    return makeDdrResolverRow(overrides, {
      defaultAgeSec: 12 * 3600,
      factorLabel: "Fixture has hard collateral and redemption",
      name: "Lane B Test",
      stablecoinId: "lane-b-test",
      symbol: "LBT",
      nowSec: NOW_SEC,
    });
  }

  function canonicalIncident(overrides: Partial<DdrCanonicalIncident> = {}): DdrCanonicalIncident {
    return makeDdrCanonicalIncident(resolverRow(), {
      incidentKey: "ddr2:readiness0000000000000000000000",
      eligibleAt: NOW_SEC,
      rolloutActiveAtEnablement: false,
      ...overrides,
    });
  }

  function sealedFromInput(
    input: Parameters<DdrV2StoreContracts["sealPublicPrediction"]>[1],
    outcomeKind: DdrSealedPublicPrediction["outcomeKind"],
    id = 700,
  ): DdrSealedPublicPrediction {
    return makeDdrSealedPublicPrediction({
      id,
      incidentKey: input.incidentKey,
      eventId: input.eventId,
      assessmentId: id * 10,
      outcomeKind,
      predictionPolicyVersion: input.predictionPolicyVersion,
      predictionMethodologyVersion: input.methodologyVersion,
      predictionMethodologyVersionLabel: input.methodologyVersionLabel,
      resolutionRubricVersion: input.resolutionRubricVersion,
      durationModelVersion: input.durationModelVersion,
      incidentGroupingVersion: input.incidentGroupingVersion,
      supportRulesVersion: input.supportRulesVersion,
      policyDelaySec: input.policyDelaySec,
      eligibleAt: input.eligibleAt,
      lockedAt: input.lockedAt,
      eventAgeAtLockSec: input.eventAgeAtLockSec,
      lockTiming: input.lockTiming,
      lockTrigger: input.lockTrigger ?? null,
      forecastReadinessScore: input.forecastReadinessScore ?? null,
      forecastReadinessVersion: input.forecastReadinessVersion ?? null,
      readinessThreshold: input.readinessThreshold ?? null,
      backstopAt: input.backstopAt ?? null,
      backstopDelaySec: input.backstopDelaySec ?? null,
      rowHash: computeDdrPublicRowHash(input.sealedPayload),
      sealedPayload: attachDdrPublicRowHash(input.sealedPayload, computeDdrPublicRowHash(input.sealedPayload)),
    });
  }

  function stablecoinsCacheRow() {
    return {
      key: "stablecoins",
      value: JSON.stringify({
        peggedAssets: [
          {
            id: "unrelated-stablecoin",
            symbol: "UNR",
            name: "Unrelated",
            pegType: "peggedUSD",
            price: 1,
            circulating: { peggedUSD: 1_000_000 },
          },
        ],
      }),
      updated_at: NOW_SEC,
    };
  }

  function resolverDb(tables: MockTableConfig[]): MockD1Database {
    return mockD1([
      ...tables,
      { match: "FROM depeg_events WHERE ended_at IS NOT NULL", rows: [] },
      { match: "FROM supply_history", rows: [] },
      { match: "FROM dex_liquidity", rows: [] },
      { match: "FROM dex_liquidity_history", rows: [] },
      { match: "FROM redemption_backstop_runs", rows: [] },
      { match: "INSERT INTO cache", rows: [] },
      { match: "FROM depeg_events_with_provenance WHERE (provenance_audit_verdict", rows: [] },
      { match: "FROM depeg_events_with_provenance WHERE ended_at IS NULL", rows: [] },
    ]);
  }

  function healthyDewsPublicationTables() {
    const computedAt = NOW_SEC - 300;
    const stressRows = [
      {
        stablecoin_id: "lane-b-test",
        score: 22,
        band: "WATCH",
        signals_json: JSON.stringify({ price: { available: true, value: 22 } }),
        computed_at: computedAt,
      },
    ];
    const pointer = {
      key: "dews:published-generation",
      value: JSON.stringify({
        updatedAt: computedAt,
        source: "compute-dews",
        publishStatus: "published",
        coverageVersion: 2,
        expectedRowCount: stressRows.length,
        stablecoinIdsDigest: buildDewsStablecoinIdsDigest(stressRows.map((row) => row.stablecoin_id)),
      }),
      updated_at: computedAt,
    };
    return [
      { match: "FROM cache WHERE key = ?", rows: [stablecoinsCacheRow(), pointer] },
      {
        match: "pharos:stress-signals:published-exact",
        matchBinds: [computedAt],
        rows: stressRows,
      },
    ];
  }

  function readDdrSnapshotPayload(db: Pick<MockD1Database, "getHistory">) {
    const ddrCacheWrite = db
      .getHistory()
      .find(
        (entry) => entry.sql.includes("INSERT INTO cache") && entry.binds[0] === "depeg-resolver:snapshot",
      );
    if (!ddrCacheWrite) throw new Error("Missing DDR snapshot cache write");
    return JSON.parse(ddrCacheWrite.binds[1] as string).payload;
  }

  function storesFor(incidentKey = "ddr2:11111111111111111111111111111111") {
    const sealed = makeDdrSealedPublicPrediction({
      incidentKey,
      outcomeKind: "no_call",
      eligibleAt: NOW_SEC - 3_600,
      lockedAt: NOW_SEC,
      eventAgeAtLockSec: 90_000,
      lockTiming: "late_freeze",
      sealedPayload: {
        kind: "no_call",
        prediction: {},
      },
    });
    const stores: DdrV2StoreContracts = {
      closeRecoveredPreLockIncidents: vi.fn(async () => 0),
      ensureCanonicalIncidents: vi.fn(async (_db, inputs) => [
        {
          incidentKey,
          eventId: 42,
          currentEventId: 42,
          stablecoinId: "lane-b-test",
          pegCurrency: "USD",
          direction: "below" as const,
          startedAt: inputs.find((input: { eventId: number; startedAt: number }) => input.eventId === 42)?.startedAt ?? NOW_SEC - 90_000,
          eligibleAt: NOW_SEC - 3_600,
          policyUniverseIncluded: true,
          rolloutActiveAtEnablement: true,
          confirmedAt: null,
          lockState: null,
        },
      ]),
      loadCanonicalIncidents: vi.fn(async () => []),
      recordLockDeferral: vi.fn(async () => undefined),
      sealPublicPrediction: vi.fn(async () => {
        throw new Error("unexpected prediction seal");
      }),
      sealPublicNoCall: vi.fn(async (_db, input) => makeDdrSealedPublicPrediction({
        ...sealed,
        outcomeKind: "no_call",
        lockedAt: input.lockedAt,
        eventAgeAtLockSec: input.eventAgeAtLockSec,
        lockTiming: input.lockTiming,
        sealedPayload: input.sealedPayload,
      })),
      loadSealedPublicPredictions: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([sealed]),
      loadFirstPublicationMembership: vi.fn(
        async (): Promise<Awaited<ReturnType<DdrV2StoreContracts["loadFirstPublicationMembership"]>>> => [],
      ),
      loadPredictionErrata: vi.fn(
        async (): Promise<Awaited<ReturnType<NonNullable<DdrV2StoreContracts["loadPredictionErrata"]>>>> => [],
      ),
      writePublicationManifest: vi.fn(async () => makeDdrPublicationManifest({ publishedAt: NOW_SEC })),
    };
    return { sealed, stores };
  }

  async function runReviewerScenario(
    mode: "healthy" | "degraded" | "throw" | "abort",
    primarySafe = true,
    failure = new Error("review unavailable"),
  ) {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
    const event = activeEvent({ started_at: NOW_SEC - 72 * 3600 });
    const { stores, sealed } = storesFor();
    const created: DdrSealedPublicPrediction[] = [];
    const manifestPayloads: unknown[] = [];
    const controller = new AbortController();
    stores.sealPublicNoCall = vi.fn(async (_db, input) => {
      const prediction = sealedFromInput(input, "no_call", 7);
      created.push(prediction);
      return prediction;
    });
    stores.loadSealedPublicPredictions = vi.fn(async () => created);
    stores.loadCanonicalIncidents = vi.fn(async () => {
      if (mode === "abort") controller.abort(failure);
      if (mode === "throw" || mode === "abort") throw failure;
      return [canonicalIncident({
        incidentKey: sealed.incidentKey, startedAt: event.started_at, eligibleAt: NOW_SEC,
      })];
    });
    stores.writePublicationManifest = vi.fn(async (_db, input) => {
      manifestPayloads.push(input.basePayload);
      return makeDdrPublicationManifest({ publishedAt: NOW_SEC });
    });
    const db = resolverDb([
      { match: "FROM depeg_events_with_provenance WHERE (provenance_audit_verdict", rows: [event] },
      { match: "FROM depeg_events_with_provenance WHERE ended_at IS NULL", rows: [event] },
      ...(mode === "degraded" ? [{
        match: "FROM depeg_resolver_incident_event_links", rows: [],
        throwError: new Error("D1_ERROR: lineage query unavailable"),
      }] : []),
      { match: "INSERT OR IGNORE INTO depeg_resolver_assessments", rows: [] },
      { match: "INSERT INTO depeg_resolver_assessments", rows: [] },
      { match: "SELECT id, stablecoin_id, started_at, ended_at, recovery_price, close_reason", rows: [{ ...event, close_reason: null }] },
      { match: "FROM depeg_resolver_incident_event_links", rows: [] },
      { match: "FROM depeg_resolver_incident_lineage", rows: [] },
      { match: "SELECT COUNT(*) as row_count, MAX(ts)", rows: [{ row_count: 0, max_ts: null, max_id: null }] },
      { match: "FROM tape_events", rows: [] },
      ...healthyDewsPublicationTables(),
      { match: "FROM depeg_resolver_assessments", rows: [] },
    ]);
    const result = await computeDepegResolver({
      db, ddrRunId: "ddr:quarter-hour:1779984600:test", runAt: NOW_SEC, slot: "quarter-hour",
      stablecoinsCacheSafe: primarySafe, depegPipelineHealthy: true,
      storeContracts: stores, signal: controller.signal,
    });
    return {
      result,
      metadata: JSON.parse(result.metadata ?? "{}"),
      snapshot: readDdrSnapshotPayload(db),
      sealedBytes: JSON.stringify(created.map((prediction) => prediction.sealedPayload)),
      rowHashes: created.map((prediction) => prediction.rowHash),
      manifestBytes: JSON.stringify(manifestPayloads),
    };
  }

  it("reports ancillary review quality without changing successful canonical publication or sealed bytes", async () => {
    const healthy = await runReviewerScenario("healthy");
    const incomplete = await runReviewerScenario("degraded");

    expect(healthy.result.status ?? "ok").toBe("ok");
    expect(healthy.metadata).toMatchObject({
      v2PublicationAttempted: true, v2PublicationSucceeded: true,
      ddrrDegraded: false, ddrrDegradedReason: null,
    });
    expect(healthy.metadata.quality).toBeUndefined();
    expect(incomplete.result.status ?? "ok").toBe("ok");
    expect(incomplete.metadata).toMatchObject({
      v2PublicationAttempted: true, v2PublicationSucceeded: true,
      ddrrDegraded: true, ddrrDegradedReason: "incident-lineage-read-failed",
      quality: { reason: "ddrr-review-degraded" },
    });
    expect(incomplete.metadata.reviewRows).toBeGreaterThan(0);
    expect(incomplete.snapshot._meta.degraded).toBe(false);
    expect(incomplete.snapshot).toEqual(healthy.snapshot);
    expect(incomplete.rowHashes).toHaveLength(1);
    expect(incomplete.rowHashes).toEqual(healthy.rowHashes);
    expect(incomplete.sealedBytes).toBe(healthy.sealedBytes);
    expect(incomplete.manifestBytes).toBe(healthy.manifestBytes);
  });

  it("reports a thrown ancillary reviewer failure without failing canonical publication", async () => {
    const observed = await runReviewerScenario("throw");
    expect(observed.result.status ?? "ok").toBe("ok");
    expect(observed.metadata).toMatchObject({
      v2PublicationAttempted: true, v2PublicationSucceeded: true,
      ddrrDegraded: true, ddrrDegradedReason: "review unavailable",
      quality: { reason: "ddrr-review-failed" },
    });
    expect(observed.snapshot._meta.degraded).toBe(false);
    expect(observed.rowHashes).toHaveLength(1);
  });

  it("propagates reviewer cancellation rather than returning an ordinary quality warning", async () => {
    const failure = new Error("review cancelled");
    await expect(runReviewerScenario("abort", true, failure)).rejects.toBe(failure);
  });

  it("retains primary degradation while also reporting returned reviewer degradation", async () => {
    const observed = await runReviewerScenario("degraded", false);
    expect(observed.result.status).toBe("degraded");
    expect(observed.metadata).toMatchObject({
      degradedReason: "stablecoins-cache-unsafe", v2PublicationAttempted: false,
      ddrrDegraded: true, ddrrDegradedReason: "incident-lineage-read-failed",
      quality: { reason: "ddrr-review-degraded" },
    });
    expect(observed.rowHashes).toEqual([]);
    expect(observed.manifestBytes).toBe("[]");
  });

  it("excludes terminal lifecycle events from the live DDR snapshot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 4, 26, 12, 0, 0));
    const db = resolverDb([
      {
        match: "FROM depeg_events_with_provenance WHERE ended_at IS NULL",
        rows: [
          {
            id: 88045,
            stablecoin_id: "usr-resolv",
            symbol: "USR",
            peg_type: "peggedUSD",
            direction: "below",
            peak_deviation_bps: -9025,
            started_at: 1774145097,
            peg_reference: 0.99975,
          },
        ],
      },
      { match: "FROM depeg_resolver_assessments", rows: [] },
      { match: "INSERT INTO cache", rows: [] },
    ]);

    const { stores } = storesFor();
    delete stores.closeRecoveredPreLockIncidents;
    const result = await computeDepegResolver({ db, storeContracts: stores });
    const payload = readDdrSnapshotPayload(db);

    expect(result.itemCount).toBe(0);
    expect(JSON.parse(result.metadata ?? "{}").v2PreLockIncidentsClosed).toBe(0);
    expect(payload.rows).toEqual([]);
  });

  it.each([
    [false, true, "stablecoins-cache-unsafe"],
    [true, false, "depeg-pipeline-unhealthy"],
  ] as const)("preallocates a DDR run and defers locks when cacheSafe=%s pipelineHealthy=%s", async (cacheSafe, pipelineHealthy, reason) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
    const event = activeEvent();
    const { stores } = storesFor();
    stores.closeRecoveredPreLockIncidents = vi.fn(async () => 30);
    const db = resolverDb([
      { match: "FROM depeg_events_with_provenance WHERE (provenance_audit_verdict", rows: [event] },
      { match: "FROM depeg_events_with_provenance WHERE ended_at IS NULL", rows: [event] },
    ]);

    const result = await computeDepegResolver({
      db,
      runAt: NOW_SEC,
      slot: "quarter-hour",
      stablecoinsCacheSafe: cacheSafe,
      depegPipelineHealthy: pipelineHealthy,
      storeContracts: stores,
    });
    const metadata = JSON.parse(result.metadata ?? "{}");

    expect(result.status).toBe("degraded");
    expect(metadata.ddrRunId).toMatch(/^ddr:quarter-hour:1779984600:[0-9a-f]{12}$/);
    expect(metadata.v2PreLockIncidentsClosed).toBe(30);
    expect(stores.closeRecoveredPreLockIncidents).toHaveBeenCalledWith(db, { nowSec: NOW_SEC });
    expect(stores.recordLockDeferral).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        runId: metadata.ddrRunId,
        action: "deferred",
        reason,
      }),
    );
    expect(stores.sealPublicPrediction).not.toHaveBeenCalled();
    expect(stores.sealPublicNoCall).not.toHaveBeenCalled();
    const payload = readDdrSnapshotPayload(db);
    expect(payload._meta.degraded).toBe(true);
    expect(payload._meta.degradedReason).toBe(reason);
    expect(payload._meta.computedAt).toBe(NOW_SEC);
    expect(payload._meta.expiresAt).toBe(NOW_SEC + 900);
    expect(payload.rows).toEqual([]);
  });

  it("preserves cached rows as stale when scheduler health is degraded", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
    const event = activeEvent();
    const { stores } = storesFor();
    const previousSnapshot = buildDdrResponse({
      candidateRows: [resolverRow()],
      incidentsByEventId: new Map([[42, canonicalIncident()]]),
      sealed: [],
      firstPublication: [],
      manifest: null,
      errata: [],
      lineage: {
        trainingWindow: { start: NOW_SEC - 3600, end: NOW_SEC - 600 },
        eventCount: 1,
        incidentCount: 1,
        coinCount: 1,
        quarantinedCoins: 0,
      },
      nowSec: NOW_SEC - 600,
    });
    previousSnapshot.rows[0].live = {
      ...previousSnapshot.rows[0].live,
      stale: true,
      degradedReason: "previous-context-failure",
    };
    const db = resolverDb([
      { match: "FROM depeg_events_with_provenance WHERE (provenance_audit_verdict", rows: [event] },
      { match: "FROM depeg_events_with_provenance WHERE ended_at IS NULL", rows: [event] },
      {
        match: "FROM cache WHERE key = ?",
        rows: [
          {
            key: "depeg-resolver:snapshot",
            value: JSON.stringify({
              generation: DDR_SNAPSHOT_CACHE_GENERATION,
              methodologyVersion: DDR_METHODOLOGY_VERSION,
              payload: previousSnapshot,
            }),
            updated_at: NOW_SEC - 600,
          },
        ],
      },
      { match: "INSERT INTO cache", rows: [] },
    ]);

    await computeDepegResolver({
      db,
      runAt: NOW_SEC,
      slot: "quarter-hour",
      stablecoinsCacheSafe: false,
      depegPipelineHealthy: true,
      storeContracts: stores,
    });

    const payload = readDdrSnapshotPayload(db);
    expect(payload._meta.degraded).toBe(true);
    expect(payload._meta.degradedReason).toBe("stale-cache");
    expect(payload._meta.degradedReasonDetail).toBe("stablecoins-cache-unsafe");
    expect(payload._meta.lastRefreshAttemptAt).toBe(NOW_SEC);
    expect(payload._meta.computedAt).toBe(previousSnapshot._meta.computedAt);
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0].live).toMatchObject({
      stale: true,
      degradedReason: "stablecoins-cache-unsafe",
      updatedAt: NOW_SEC - 600,
    });
  });

  it("publishes degraded empty rows when context loading cannot use stablecoins cache", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
    const event = activeEvent();
    const { stores } = storesFor();
    const db = resolverDb([
      { match: "FROM depeg_events_with_provenance WHERE (provenance_audit_verdict", rows: [event] },
      { match: "FROM depeg_events_with_provenance WHERE ended_at IS NULL", rows: [event] },
      { match: "FROM cache WHERE key = ?", rows: [] },
      { match: "INSERT INTO cache", rows: [] },
    ]);

    const result = await computeDepegResolver({
      db,
      runAt: NOW_SEC,
      slot: "quarter-hour",
      stablecoinsCacheSafe: true,
      depegPipelineHealthy: true,
      storeContracts: stores,
    });
    const metadata = JSON.parse(result.metadata ?? "{}");

    expect(result.status).toBe("degraded");
    expect(metadata.degraded).toBe(true);
    expect(metadata.degradedReason).toBe("stablecoins-cache-missing-cache");
    expect(metadata.v2FreezeSkipped).toBe(true);
    expect(stores.sealPublicPrediction).not.toHaveBeenCalled();
    expect(stores.sealPublicNoCall).not.toHaveBeenCalled();
    const payload = readDdrSnapshotPayload(db);
    expect(payload._meta.degraded).toBe(true);
    expect(payload._meta.degradedReason).toBe("stablecoins-cache-missing-cache");
    expect(payload.rows).toEqual([]);
  });

  it("falls back to degraded empty rows when prior snapshot cache read fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
    const event = activeEvent();
    const { stores } = storesFor();
    const db = resolverDb([
      { match: "FROM depeg_events_with_provenance WHERE (provenance_audit_verdict", rows: [event] },
      { match: "FROM depeg_events_with_provenance WHERE ended_at IS NULL", rows: [event] },
      { match: "FROM cache WHERE key = ?", throwError: new Error("cache unavailable"), rows: [] },
      { match: "INSERT INTO cache", rows: [] },
    ]);

    await computeDepegResolver({
      db,
      runAt: NOW_SEC,
      slot: "quarter-hour",
      stablecoinsCacheSafe: false,
      depegPipelineHealthy: true,
      storeContracts: stores,
    });

    const payload = readDdrSnapshotPayload(db);
    expect(payload._meta.degraded).toBe(true);
    expect(payload._meta.degradedReason).toBe("stablecoins-cache-unsafe");
    expect(payload.rows).toEqual([]);
  });

  it("seals a backstop-eligible insufficient-signal incident as a no-call before publication", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
    const event = activeEvent({ started_at: NOW_SEC - 72 * 3600 });
    const { stores, sealed } = storesFor();
    const db = resolverDb([
      { match: "FROM depeg_events_with_provenance WHERE (provenance_audit_verdict", rows: [event] },
      { match: "FROM depeg_events_with_provenance WHERE ended_at IS NULL", rows: [event] },
      ...healthyDewsPublicationTables(),
      { match: "FROM depeg_resolver_assessments", rows: [] },
      { match: "INSERT INTO cache", rows: [] },
    ]);

    const result = await computeDepegResolver({
      db,
      ddrRunId: "ddr:quarter-hour:1779984600:test",
      runAt: NOW_SEC,
      slot: "quarter-hour",
      stablecoinsCacheSafe: true,
      depegPipelineHealthy: true,
      storeContracts: stores,
    });
    const metadata = JSON.parse(result.metadata ?? "{}");

    expect(stores.sealPublicNoCall).toHaveBeenCalledTimes(1);
    expect(stores.sealPublicNoCall).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        incidentKey: sealed.incidentKey,
        runId: "ddr:quarter-hour:1779984600:test",
        predictionPolicyVersion: "sticky-24h-v1",
        policyDelaySec: 72 * 3600,
        lockTrigger: "readiness_backstop",
      }),
    );
    expect(stores.writePublicationManifest).toHaveBeenCalledTimes(1);
    expect(metadata.v2LockedNoCalls).toBe(1);
    expect(metadata.v2PublicationSucceeded).toBe(true);
  });

  it("publishes first-sealed rows with manifest payload hashes matching sealed rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
    const event = activeEvent({ started_at: NOW_SEC - 72 * 3600 });
    const { stores, sealed } = storesFor();
    let created: typeof sealed | null = null;
    let createdRowHash: string | null = null;
    let manifestBasePayload: unknown = null;

    stores.sealPublicNoCall = vi.fn(async (_db, input) => {
      const rowHash = computeDdrPublicRowHash(input.sealedPayload);
      createdRowHash = rowHash;
      created = {
        ...sealed,
        eligibleAt: input.eligibleAt,
        lockedAt: input.lockedAt,
        eventAgeAtLockSec: input.eventAgeAtLockSec,
        lockTiming: input.lockTiming,
        policyDelaySec: input.policyDelaySec,
        rowHash,
        sealedPayload: attachDdrPublicRowHash(input.sealedPayload, rowHash),
      };
      return created;
    });
    stores.loadSealedPublicPredictions = vi.fn(async () => (created ? [created] : []));
    stores.writePublicationManifest = vi.fn(async (_db, input) => {
      manifestBasePayload = input.basePayload;
      return makeDdrPublicationManifest({ publishedAt: NOW_SEC });
    });
    const db = resolverDb([
      { match: "FROM depeg_events_with_provenance WHERE (provenance_audit_verdict", rows: [event] },
      { match: "FROM depeg_events_with_provenance WHERE ended_at IS NULL", rows: [event] },
      ...healthyDewsPublicationTables(),
      { match: "FROM depeg_resolver_assessments", rows: [] },
      { match: "INSERT INTO cache", rows: [] },
    ]);

    await computeDepegResolver({
      db,
      ddrRunId: "ddr:quarter-hour:1779984600:test",
      runAt: NOW_SEC,
      slot: "quarter-hour",
      stablecoinsCacheSafe: true,
      depegPipelineHealthy: true,
      storeContracts: stores,
    });

    const publishedRow = (manifestBasePayload as { rows?: Array<Record<string, unknown>> }).rows?.[0];
    const prediction = publishedRow?.prediction as Record<string, unknown> | undefined;
    expect(publishedRow?.kind).toBe("no_call");
    expect(prediction?.policyDelaySec).toBe(72 * 3600);
    expect(prediction?.lockTrigger).toBe("readiness_backstop");
    expect(computeDdrPublicRowHash(publishedRow)).toBe(createdRowHash);

    const payload = readDdrSnapshotPayload(db);
    expect(payload.rows[0].prediction.policyDelaySec).toBe(72 * 3600);
    expect(payload.rows[0].prediction.lockTrigger).toBe("readiness_backstop");
  });

  it("marks the public snapshot degraded when the manifest write fails after sealing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
    const event = activeEvent({ started_at: NOW_SEC - 72 * 3600 });
    const { stores, sealed } = storesFor();
    let created: typeof sealed | null = null;

    stores.sealPublicNoCall = vi.fn(async (_db, input) => {
      const rowHash = computeDdrPublicRowHash(input.sealedPayload);
      created = {
        ...sealed,
        eligibleAt: input.eligibleAt,
        lockedAt: input.lockedAt,
        eventAgeAtLockSec: input.eventAgeAtLockSec,
        lockTiming: input.lockTiming,
        policyDelaySec: input.policyDelaySec,
        rowHash,
        sealedPayload: attachDdrPublicRowHash(input.sealedPayload, rowHash),
      };
      return created;
    });
    stores.loadSealedPublicPredictions = vi.fn(async () => (created ? [created] : []));
    stores.writePublicationManifest = vi.fn(async () => {
      throw new Error("D1 manifest write exhausted");
    });
    const db = resolverDb([
      { match: "FROM depeg_events_with_provenance WHERE (provenance_audit_verdict", rows: [event] },
      { match: "FROM depeg_events_with_provenance WHERE ended_at IS NULL", rows: [event] },
      ...healthyDewsPublicationTables(),
      { match: "FROM depeg_resolver_assessments", rows: [] },
      { match: "INSERT INTO cache", rows: [] },
    ]);

    const result = await computeDepegResolver({
      db,
      ddrRunId: "ddr:quarter-hour:1779984600:test",
      runAt: NOW_SEC,
      slot: "quarter-hour",
      stablecoinsCacheSafe: true,
      depegPipelineHealthy: true,
      storeContracts: stores,
    });

    const payload = readDdrSnapshotPayload(db);
    expect(payload._meta.degraded).toBe(true);
    expect(payload._meta.degradedReason).toContain("publication-retry-pending:");
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      v2PublicationAttempted: true, v2PublicationSucceeded: false,
    });
  });

  it("projects first-published sealed no-calls as invalidated when errata exist", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
    const event = activeEvent();
    const { stores, sealed } = storesFor();
    stores.loadSealedPublicPredictions = vi.fn(async () => [sealed]);
    stores.loadFirstPublicationMembership = vi.fn(async () => [
      {
        publicPredictionId: 7,
        incidentKey: sealed.incidentKey,
        snapshotToken: "ddr-public-original",
        snapshotGeneration: 2,
        publishedAt: NOW_SEC - 600,
      },
    ]);
    stores.loadPredictionErrata = vi.fn(async () => [
      {
        id: 99,
        state: "invalidated" as const,
        publicPredictionId: 7,
        incidentKey: sealed.incidentKey,
        eventId: 42,
        assessmentId: 70,
        reason: "event_identity_error" as const,
        operatorNote: "Source event was repaired after first publication",
        replacementAssessmentId: null,
        replacementRowHash: null,
        rowHashBefore: sealed.rowHash,
        createdAt: NOW_SEC - 120,
        createdBy: "operator",
      },
    ]);
    let manifestBasePayload: unknown = null;
    stores.writePublicationManifest = vi.fn(async (_db, input) => {
      manifestBasePayload = input.basePayload;
      return makeDdrPublicationManifest({ publishedAt: NOW_SEC });
    });
    const db = resolverDb([
      { match: "FROM depeg_events_with_provenance WHERE (provenance_audit_verdict", rows: [event] },
      { match: "FROM depeg_events_with_provenance WHERE ended_at IS NULL", rows: [event] },
      ...healthyDewsPublicationTables(),
      { match: "FROM depeg_resolver_assessments", rows: [] },
      { match: "INSERT INTO cache", rows: [] },
    ]);

    await computeDepegResolver({
      db,
      ddrRunId: "ddr:quarter-hour:1779984600:test",
      runAt: NOW_SEC,
      slot: "quarter-hour",
      stablecoinsCacheSafe: true,
      depegPipelineHealthy: true,
      storeContracts: stores,
    });
    const payload = readDdrSnapshotPayload(db);

    expect(payload.rows[0]).toMatchObject({
      kind: "invalidated_prediction",
      originalKind: "no_call",
      prediction: {
        state: "invalidated",
        publicPredictionId: 7,
        publishedAt: NOW_SEC - 600,
        publicationSnapshotToken: "ddr-public-original",
        latestErratum: {
          id: 99,
          reason: "event_identity_error",
          operatorNote: "Source event was repaired after first publication",
        },
        errataCount: 1,
      },
      frozen: null,
    });
    expect(payload.rows[0].noCall).toBeTruthy();
    expect(payload.rows[0].prediction.errataHistory).toHaveLength(1);
    expect((manifestBasePayload as { rows?: Array<{ kind?: string }> }).rows?.[0]?.kind).toBe("invalidated_prediction");
  });

  it("uses durable pending promotion outcome time for late confirmation locks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
    const event = activeEvent({
      started_at: NOW_SEC - 73 * 3600,
      confirmation_sources: "dex:curve+dex:uniswap",
      pending_reason: "large-cap",
    });
    const confirmationAt = NOW_SEC - 1_200;
    const { stores } = storesFor();
    const db = resolverDb([
      { match: "FROM depeg_events_with_provenance WHERE (provenance_audit_verdict", rows: [event] },
      { match: "FROM depeg_events_with_provenance WHERE ended_at IS NULL", rows: [event] },
      {
        match: "FROM depeg_pending_outcomes",
        rows: [
          {
            stablecoin_id: "lane-b-test",
            peg_type: "peggedUSD",
            direction: "below",
            first_seen_at: event.started_at,
            outcome_at: confirmationAt,
          },
        ],
      },
      ...healthyDewsPublicationTables(),
      { match: "FROM depeg_resolver_assessments", rows: [] },
      { match: "INSERT INTO cache", rows: [] },
    ]);

    await computeDepegResolver({
      db,
      ddrRunId: "ddr:quarter-hour:1779984600:test",
      runAt: NOW_SEC,
      slot: "quarter-hour",
      stablecoinsCacheSafe: true,
      depegPipelineHealthy: true,
      storeContracts: stores,
    });

    expect(stores.recordLockDeferral).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: "confirmed_seen",
        confirmationAt,
        outcomeAt: confirmationAt,
        reason: "pending-outcome-promoted",
      }),
    );
    expect(stores.sealPublicNoCall).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        lockTiming: "late_confirmation",
      }),
    );
  });

  it("seals a policy-eligible prediction with canonical row hash metadata", async () => {
    const row = resolverRow();
    const incident = canonicalIncident();
    const db = mockD1([]);
    const stores = {
      ...storesFor(incident.incidentKey).stores,
      sealPublicPrediction: vi.fn(async (_db, input) => sealedFromInput(input, "prediction")),
      sealPublicNoCall: vi.fn(async () => {
        throw new Error("unexpected no-call seal");
      }),
    };

    const result = await sealEligibleLocks({
      stores,
      db,
      rows: [row],
      activeEventById: new Map([[42, activeEvent({ started_at: row.startedAt })]]),
      incidentsByEventId: new Map([[42, incident]]),
      existingSealed: [],
      nowSec: NOW_SEC,
      ddrRunId: "ddr:quarter-hour:1779984600:test",
      runAt: NOW_SEC,
    });

    const sealInput = stores.sealPublicPrediction.mock.calls[0]?.[1];
    expect(result.lockedCount).toBe(1);
    expect(result.noCallCount).toBe(0);
    expect(result.pendingCount).toBe(0);
    expect(sealInput?.sealedPayload).toMatchObject({
      kind: "prediction",
      prediction: {
        incidentKey: incident.incidentKey,
        eligibleAt: NOW_SEC,
        lockedAt: NOW_SEC,
        eventAgeAtLockSec: 12 * 3600,
        policyDelaySec: 12 * 3600,
        lockTrigger: "forecast_readiness",
      },
    });
    expect(result.sealed[0]?.rowHash).toBe(computeDdrPublicRowHash(sealInput!.sealedPayload));
  });

  it("seals public predictions with incident identity when registry peg metadata differs", async () => {
    const row = resolverRow({
      stablecoinId: "wbrl-ripio",
      symbol: "WBRL",
      name: "Ripio wBRL",
      pegCurrency: "BRL",
    });
    const incident = canonicalIncident({
      incidentKey: "ddr2:wbrlreal0000000000000000000000",
      stablecoinId: "wbrl-ripio",
      pegCurrency: "REAL",
      startedAt: row.startedAt,
    });
    const db = mockD1([]);
    const stores = {
      ...storesFor(incident.incidentKey).stores,
      sealPublicPrediction: vi.fn(async (_db, input) => sealedFromInput(input, "prediction")),
      sealPublicNoCall: vi.fn(async () => {
        throw new Error("unexpected no-call seal");
      }),
    };

    const result = await sealEligibleLocks({
      stores,
      db,
      rows: [row],
      activeEventById: new Map([
        [
          42,
          activeEvent({
            stablecoin_id: "wbrl-ripio",
            symbol: "WBRL",
            peg_type: "peggedREAL",
            started_at: row.startedAt,
          }),
        ],
      ]),
      incidentsByEventId: new Map([[42, incident]]),
      existingSealed: [],
      nowSec: NOW_SEC,
      ddrRunId: "ddr:quarter-hour:1779984600:test",
      runAt: NOW_SEC,
    });

    const sealInput = stores.sealPublicPrediction.mock.calls[0]?.[1];
    const sealedPayload = sealInput?.sealedPayload ?? {};
    const frozen = sealedPayload.frozen as { sourceRow?: Record<string, unknown> } | null;
    expect(sealInput).toMatchObject({
      identity: {
        stablecoinId: "wbrl-ripio",
        pegCurrency: "REAL",
        direction: "below",
        startedAt: row.startedAt,
      },
      eventAgeAtLockSec: 12 * 3600,
    });
    expect(sealedPayload).toMatchObject({
      eventId: 42,
      incidentKey: incident.incidentKey,
      stablecoinId: "wbrl-ripio",
      pegCurrency: "REAL",
      direction: "below",
      startedAt: row.startedAt,
      prediction: {
        eventAgeAtLockSec: 12 * 3600,
      },
    });
    expect(frozen?.sourceRow).toMatchObject({
      stablecoinId: "wbrl-ripio",
      pegCurrency: "BRL",
    });
    expect(computeDdrPublicRowHash(sealedPayload)).toBe(result.sealed[0]?.rowHash);
  });

  it("keeps a below-readiness incident pending when canonical eligibility has not arrived", async () => {
    const startedAt = NOW_SEC - 3600;
    const row = resolverRow({ startedAt, ageSec: 3600 });
    const incident = canonicalIncident({ startedAt, eligibleAt: startedAt + 72 * 3600 });
    const db = mockD1([]);
    const stores = storesFor(incident.incidentKey).stores;

    const result = await sealEligibleLocks({
      stores,
      db,
      rows: [row],
      activeEventById: new Map([[42, activeEvent({ started_at: row.startedAt })]]),
      incidentsByEventId: new Map([[42, incident]]),
      existingSealed: [],
      nowSec: NOW_SEC,
      ddrRunId: "ddr:quarter-hour:1779984600:test",
      runAt: NOW_SEC,
    });

    expect(result).toMatchObject({ lockedCount: 0, noCallCount: 0, pendingCount: 1 });
    expect(stores.recordLockDeferral).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: "pending",
        healthStatus: "healthy",
        eligibleAt: startedAt + 72 * 3600,
      }),
    );
    expect(stores.sealPublicPrediction).not.toHaveBeenCalled();
    expect(stores.sealPublicNoCall).not.toHaveBeenCalled();
  });

  it("uses a 72h canonical backstop eligibility to seal prediction and no-call outcomes", async () => {
    const startedAt = NOW_SEC - 72 * 3600;
    const db = mockD1([]);
    const predictionIncident = canonicalIncident({
      incidentKey: "ddr2:backstop-prediction000000000000",
      startedAt,
      eligibleAt: NOW_SEC,
    });
    const noCallIncident = canonicalIncident({
      incidentKey: "ddr2:backstop-nocall0000000000000000",
      eventId: 43,
      currentEventId: 43,
      startedAt,
      eligibleAt: NOW_SEC,
    });
    const predictionRow = resolverRow({ startedAt, ageSec: 72 * 3600 });
    const noCallRow = resolverRow({
      eventId: 43,
      startedAt,
      ageSec: 72 * 3600,
      resolution: {
        tier: "insufficient_signal",
        factors: [],
        insufficientReasons: ["missing live price"],
      },
      duration: {
        suppressed: true,
        suppressedReason: "insufficient_signal",
        stratum: null,
        medianSec: null,
        iqrSec: null,
        ageStatus: "data_issue",
        horizons: [],
      },
    });
    const stores = {
      ...storesFor(predictionIncident.incidentKey).stores,
      sealPublicPrediction: vi.fn(async (_db, input) => sealedFromInput(input, "prediction", 701)),
      sealPublicNoCall: vi.fn(async (_db, input) => sealedFromInput(input, "no_call", 702)),
    };

    const result = await sealEligibleLocks({
      stores,
      db,
      rows: [predictionRow, noCallRow],
      activeEventById: new Map([
        [42, activeEvent({ started_at: startedAt })],
        [43, activeEvent({ id: 43, started_at: startedAt })],
      ]),
      incidentsByEventId: new Map([
        [42, predictionIncident],
        [43, noCallIncident],
      ]),
      existingSealed: [],
      nowSec: NOW_SEC,
      ddrRunId: "ddr:quarter-hour:1779984600:test",
      runAt: NOW_SEC,
    });

    expect(result.lockedCount).toBe(1);
    expect(result.noCallCount).toBe(1);
    expect(stores.sealPublicPrediction).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        eventAgeAtLockSec: 72 * 3600,
        eligibleAt: NOW_SEC,
      }),
    );
    expect(stores.sealPublicNoCall).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        eventAgeAtLockSec: 72 * 3600,
        eligibleAt: NOW_SEC,
      }),
    );
  });

  it("does not duplicate-seal when a public outcome already exists for the incident", async () => {
    const row = resolverRow();
    const incident = canonicalIncident();
    const db = mockD1([]);
    const { stores } = storesFor(incident.incidentKey);
    const existing = makeDdrSealedPublicPrediction({
      id: 77,
      incidentKey: incident.incidentKey,
      eventId: 42,
      assessmentId: 770,
      outcomeKind: "prediction" as const,
      predictionPolicyVersion: "sticky-24h-v0",
      predictionMethodologyVersion: "1.1",
      policyDelaySec: 86_400,
      eligibleAt: NOW_SEC - 86_400,
      lockedAt: NOW_SEC - 80_000,
      eventAgeAtLockSec: 90_000,
      lockTiming: "late_freeze" as const,
      rowHash: "d".repeat(64),
      sealedPayload: { kind: "prediction" },
    });

    const result = await sealEligibleLocks({
      stores,
      db,
      rows: [row],
      activeEventById: new Map([[42, activeEvent({ started_at: row.startedAt })]]),
      incidentsByEventId: new Map([[42, incident]]),
      existingSealed: [existing],
      nowSec: NOW_SEC,
      ddrRunId: "ddr:quarter-hour:1779984600:test",
      runAt: NOW_SEC,
    });

    expect(result.lockedCount).toBe(0);
    expect(result.noCallCount).toBe(0);
    expect(result.sealed).toEqual([existing]);
    expect(stores.sealPublicPrediction).not.toHaveBeenCalled();
    expect(stores.sealPublicNoCall).not.toHaveBeenCalled();
  });

  it("quarantines a genuine canonical identity mismatch and completes publication for the remaining asset", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
    const startedAt = NOW_SEC - 72 * 3600;
    const events = [
      activeEvent({ started_at: startedAt }),
      activeEvent({ id: 43, started_at: startedAt }),
    ];
    const bad = canonicalIncident({ startedAt, pegCurrency: "EUR" });
    const good = canonicalIncident({ eventId: 43, currentEventId: 43, startedAt, incidentKey: "ddr2:healthy" });
    const db = resolverDb([
      { match: "FROM depeg_events_with_provenance WHERE (provenance_audit_verdict", rows: events },
      { match: "FROM depeg_events_with_provenance WHERE ended_at IS NULL", rows: events },
      ...healthyDewsPublicationTables(),
      { match: "INSERT INTO worker_repair_tasks", rows: [] },
      { match: "FROM depeg_resolver_assessments", rows: [] },
    ]);
    const outcomes: DdrSealedPublicPrediction[] = [];
    const { stores } = storesFor(good.incidentKey);
    stores.ensureCanonicalIncidents = vi.fn(async () => [bad, good]);
    stores.loadSealedPublicPredictions = vi.fn(async () => outcomes);
    stores.sealPublicNoCall = vi.fn(async (_db, input) => {
      if (input.eventId === 42) throw new Error("bad event reached the protected seal writer");
      const sealed = sealedFromInput(input, "no_call", 7);
      outcomes.push(sealed);
      return sealed;
    });
    const result = await computeDepegResolver({
      db, runAt: NOW_SEC, storeContracts: stores,
      stablecoinsCacheSafe: true, depegPipelineHealthy: true,
    });
    const metadata = JSON.parse(result.metadata ?? "{}");
    expect(result.itemCount).toBe(1);
    expect(metadata.repairRequiredEvents).toEqual([
      { eventId: 42, reason: expect.stringContaining("canonical-event-identity-mismatch") },
    ]);
    expect(metadata.v2PublicationSucceeded).toBe(true);
    expect(stores.sealPublicNoCall).toHaveBeenCalledWith(db, expect.objectContaining({ eventId: 43 }));
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO worker_repair_tasks"))).toBe(true);
    expect(readDdrSnapshotPayload(db).rows.map((row: { eventId: number }) => row.eventId)).toEqual([43]);
  });

  it("alerts once per newly quarantined event id and never re-alerts the same id", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const quarantiningStores = (eventIds: number[]) => {
      const { stores } = storesFor();
      stores.ensureCanonicalIncidents = vi.fn(async (_db, _events, options) => {
        for (const eventId of eventIds) options.onRepairRequired?.(eventId, "incident-conflict");
        return [];
      });
      return stores;
    };

    const quarantineDb = (markerValue: string | null) =>
      resolverDb([
        { match: "FROM depeg_events_with_provenance WHERE (provenance_audit_verdict", rows: [activeEvent()] },
        { match: "FROM depeg_events_with_provenance WHERE ended_at IS NULL", rows: [activeEvent()] },
        {
          match: "FROM cache WHERE key = ?",
          rows:
            markerValue == null
              ? []
              : [{ key: "ddr:quarantine-alerted-event-ids", value: markerValue, updated_at: NOW_SEC - 900 }],
        },
        { match: "INSERT INTO cache", rows: [] },
        {
          match: "INSERT INTO worker_repair_tasks",
          rows: [],
          throwError: new Error("repair task table unavailable"),
        },
      ]);

    const cacheWrites = (db: MockD1Database, keyPrefix: string) =>
      db
        .getHistory()
        .filter(
          (entry) =>
            entry.sql.includes("INSERT INTO cache") && String(entry.binds[0]).startsWith(keyPrefix),
        );

    const runOptions = {
      runAt: NOW_SEC,
      slot: "quarter-hour" as const,
      stablecoinsCacheSafe: true,
      depegPipelineHealthy: true,
    };

    // First run: the new quarantined id alerts and records the marker.
    const firstDb = quarantineDb(null);
    const firstResult = await computeDepegResolver({
      db: firstDb,
      ...runOptions,
      storeContracts: quarantiningStores([42]),
    });
    expect(firstResult.status).not.toBe("degraded");
    const firstMetadata = JSON.parse(firstResult.metadata ?? "{}") as {
      repairRequiredEventCount?: number;
      repairTaskPersistError?: string;
    };
    expect(firstMetadata.repairRequiredEventCount).toBe(1);
    expect(firstMetadata.repairTaskPersistError).toBe("repair task table unavailable");
    const firstAlert = cacheWrites(firstDb, "cron:event:compute-depeg-resolver:quarantine-repair-required");
    expect(firstAlert).toHaveLength(1);
    expect(String(firstAlert[0].binds[1])).toContain("#42");
    const firstMarker = cacheWrites(firstDb, "ddr:quarantine-alerted-event-ids");
    expect(firstMarker).toHaveLength(1);
    expect(firstMarker[0].binds[1]).toBe("[42]");
    expect(cacheWrites(firstDb, "ddr:repair-debt:v1")).toHaveLength(0);

    // Second run with the same id: no re-alert, marker untouched.
    const secondDb = quarantineDb("[42]");
    await computeDepegResolver({
      db: secondDb,
      ...runOptions,
      storeContracts: quarantiningStores([42]),
    });
    expect(cacheWrites(secondDb, "cron:event:")).toHaveLength(0);
    expect(cacheWrites(secondDb, "ddr:quarantine-alerted-event-ids")).toHaveLength(0);

    // Third run with an additional new id: alerts for the new id only.
    const thirdDb = quarantineDb("[42]");
    await computeDepegResolver({
      db: thirdDb,
      ...runOptions,
      storeContracts: quarantiningStores([42, 43]),
    });
    const thirdAlert = cacheWrites(thirdDb, "cron:event:compute-depeg-resolver:quarantine-repair-required");
    expect(thirdAlert).toHaveLength(1);
    expect(String(thirdAlert[0].binds[1])).toContain("#43");
    expect(String(thirdAlert[0].binds[1])).not.toContain("#42");
    const thirdMarker = cacheWrites(thirdDb, "ddr:quarantine-alerted-event-ids");
    expect(thirdMarker).toHaveLength(1);
    expect(thirdMarker[0].binds[1]).toBe("[42,43]");

    warn.mockRestore();
  });
});

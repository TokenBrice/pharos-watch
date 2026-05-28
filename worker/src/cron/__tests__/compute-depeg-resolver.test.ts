import { describe, expect, it, vi, afterEach } from "vitest";
import {
  attachDdrPublicRowHash,
  computeDdrPublicRowHash,
} from "@shared/lib/depeg-resolver/public-contract";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { computeDepegResolver, type DdrV2StoreContracts } from "../compute-depeg-resolver";

afterEach(() => {
  vi.useRealTimers();
});

describe("computeDepegResolver", () => {
  const NOW_SEC = 1_779_984_600;

  function activeEvent(overrides: Record<string, unknown> = {}) {
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
    };
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

  function storesFor(incidentKey = "ddr2:11111111111111111111111111111111") {
    const sealed = {
      id: 7,
      incidentKey,
      eventId: 42,
      assessmentId: 70,
      outcomeKind: "no_call" as const,
      predictionPolicyVersion: "sticky-24h-v1",
      predictionMethodologyVersion: "2.0",
      policyDelaySec: 86_400,
      eligibleAt: NOW_SEC - 3_600,
      lockedAt: NOW_SEC,
      eventAgeAtLockSec: 90_000,
      lockTiming: "late_freeze" as const,
      rowHash: "a".repeat(64),
      sealedPayload: {
        kind: "no_call",
        prediction: {},
      },
    };
    const stores: DdrV2StoreContracts = {
      ensureCanonicalIncidents: vi.fn(async () => [
        {
          incidentKey,
          eventId: 42,
          currentEventId: 42,
          stablecoinId: "lane-b-test",
          pegCurrency: "USD",
          direction: "below" as const,
          startedAt: NOW_SEC - 90_000,
          eligibleAt: NOW_SEC - 3_600,
          policyUniverseIncluded: true,
          rolloutActiveAtEnablement: true,
          confirmedAt: null,
          lockState: null,
        },
      ]),
      recordLockDeferral: vi.fn(async () => undefined),
      sealPublicPrediction: vi.fn(async () => {
        throw new Error("unexpected prediction seal");
      }),
      sealPublicNoCall: vi.fn(async (_db, input) => ({
        ...sealed,
        lockedAt: input.lockedAt,
        eventAgeAtLockSec: input.eventAgeAtLockSec,
        lockTiming: input.lockTiming,
        sealedPayload: input.sealedPayload,
      })),
      loadSealedPublicPredictions: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([sealed]),
      loadFirstPublicationMembership: vi.fn(async (): Promise<
        Awaited<ReturnType<DdrV2StoreContracts["loadFirstPublicationMembership"]>>
      > => []),
      loadPredictionErrata: vi.fn(async (): Promise<
        Awaited<ReturnType<NonNullable<DdrV2StoreContracts["loadPredictionErrata"]>>>
      > => []),
      writePublicationManifest: vi.fn(async () => ({
        snapshotToken: "ddr-public-1",
        snapshotGeneration: 2,
        snapshotSequence: 1,
        publishedAt: NOW_SEC,
        basePayloadHash: "b".repeat(64),
        publicPredictionIds: [7],
        firstPublishedPublicPredictionIds: [7],
      })),
    };
    return { sealed, stores };
  }

  it("excludes terminal lifecycle events from the live DDR snapshot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 4, 26, 12, 0, 0));
    const db = mockD1([
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
      { match: "INSERT OR REPLACE INTO cache", rows: [] },
    ]);

    const result = await computeDepegResolver({ db, storeContracts: null });
    const ddrCacheWrite = db
      .getHistory()
      .find((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache") && entry.binds[0] === "depeg-resolver:snapshot");
    const payload = JSON.parse(ddrCacheWrite?.binds[1] as string).payload;

    expect(result.itemCount).toBe(0);
    expect(payload.rows).toEqual([]);
  });

  it("preallocates a durable DDR run id and records degraded lock deferrals without freezing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
    const event = activeEvent();
    const { stores } = storesFor();
    const db = mockD1([
      { match: "FROM depeg_events_with_provenance WHERE (provenance_audit_verdict", rows: [event] },
      { match: "FROM depeg_events_with_provenance WHERE ended_at IS NULL", rows: [event] },
    ]);

    const result = await computeDepegResolver({
      db,
      runAt: NOW_SEC,
      slot: "quarter-hour",
      stablecoinsCacheSafe: false,
      depegPipelineHealthy: true,
      syncCapabilities: { depegPipeline: true },
      storeContracts: stores,
    });
    const metadata = JSON.parse(result.metadata ?? "{}");

    expect(metadata.ddrRunId).toMatch(/^ddr:quarter-hour:1779984600:[0-9a-f]{12}$/);
    expect(stores.recordLockDeferral).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        runId: metadata.ddrRunId,
        action: "deferred",
        reason: "stablecoins-cache-unsafe",
      }),
    );
    expect(stores.sealPublicPrediction).not.toHaveBeenCalled();
    expect(stores.sealPublicNoCall).not.toHaveBeenCalled();
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"))).toBe(false);
  });

  it("seals an eligible insufficient-signal incident as a no-call before publication", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
    const event = activeEvent();
    const { stores, sealed } = storesFor();
    const db = mockD1([
      { match: "FROM depeg_events_with_provenance WHERE (provenance_audit_verdict", rows: [event] },
      { match: "FROM depeg_events_with_provenance WHERE ended_at IS NULL", rows: [event] },
      { match: "FROM cache WHERE key = ?", rows: [stablecoinsCacheRow()] },
      { match: "FROM depeg_resolver_assessments", rows: [] },
      { match: "INSERT OR REPLACE INTO cache", rows: [] },
    ]);

    const result = await computeDepegResolver({
      db,
      ddrRunId: "ddr:quarter-hour:1779984600:test",
      runAt: NOW_SEC,
      slot: "quarter-hour",
      stablecoinsCacheSafe: true,
      depegPipelineHealthy: true,
      syncCapabilities: { depegPipeline: true },
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
        policyDelaySec: 86_400,
      }),
    );
    expect(stores.writePublicationManifest).toHaveBeenCalledTimes(1);
    expect(metadata.v2LockedNoCalls).toBe(1);
    expect(metadata.v2PublicationSucceeded).toBe(true);
  });

  it("publishes first-sealed rows with manifest payload hashes matching sealed rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
    const event = activeEvent();
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
      return {
        snapshotToken: "ddr-public-1",
        snapshotGeneration: 2,
        snapshotSequence: 1,
        publishedAt: NOW_SEC,
        basePayloadHash: "b".repeat(64),
        publicPredictionIds: [7],
        firstPublishedPublicPredictionIds: [7],
      };
    });
    const db = mockD1([
      { match: "FROM depeg_events_with_provenance WHERE (provenance_audit_verdict", rows: [event] },
      { match: "FROM depeg_events_with_provenance WHERE ended_at IS NULL", rows: [event] },
      { match: "FROM cache WHERE key = ?", rows: [stablecoinsCacheRow()] },
      { match: "FROM depeg_resolver_assessments", rows: [] },
      { match: "INSERT OR REPLACE INTO cache", rows: [] },
    ]);

    await computeDepegResolver({
      db,
      ddrRunId: "ddr:quarter-hour:1779984600:test",
      runAt: NOW_SEC,
      slot: "quarter-hour",
      stablecoinsCacheSafe: true,
      depegPipelineHealthy: true,
      syncCapabilities: { depegPipeline: true },
      storeContracts: stores,
    });

    const publishedRow = (manifestBasePayload as { rows?: Array<Record<string, unknown>> }).rows?.[0];
    const prediction = publishedRow?.prediction as Record<string, unknown> | undefined;
    expect(publishedRow?.kind).toBe("no_call");
    expect(prediction?.policyDelaySec).toBe(86_400);
    expect(computeDdrPublicRowHash(publishedRow)).toBe(createdRowHash);

    const ddrCacheWrite = db
      .getHistory()
      .find((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache") && entry.binds[0] === "depeg-resolver:snapshot");
    const payload = JSON.parse(ddrCacheWrite?.binds[1] as string).payload;
    expect(payload.rows[0].prediction.policyDelaySec).toBe(86_400);
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
        firstPublished: true,
      },
    ]);
    stores.loadPredictionErrata = vi.fn(async () => [
      {
        id: 99,
        publicPredictionId: 7,
        incidentKey: sealed.incidentKey,
        eventId: 42,
        assessmentId: 70,
        reason: "event_identity_error",
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
      return {
        snapshotToken: "ddr-public-1",
        snapshotGeneration: 2,
        snapshotSequence: 1,
        publishedAt: NOW_SEC,
        basePayloadHash: "b".repeat(64),
        publicPredictionIds: [7],
        firstPublishedPublicPredictionIds: [],
      };
    });
    const db = mockD1([
      { match: "FROM depeg_events_with_provenance WHERE (provenance_audit_verdict", rows: [event] },
      { match: "FROM depeg_events_with_provenance WHERE ended_at IS NULL", rows: [event] },
      { match: "FROM cache WHERE key = ?", rows: [stablecoinsCacheRow()] },
      { match: "FROM depeg_resolver_assessments", rows: [] },
      { match: "INSERT OR REPLACE INTO cache", rows: [] },
    ]);

    await computeDepegResolver({
      db,
      ddrRunId: "ddr:quarter-hour:1779984600:test",
      runAt: NOW_SEC,
      slot: "quarter-hour",
      stablecoinsCacheSafe: true,
      depegPipelineHealthy: true,
      syncCapabilities: { depegPipeline: true },
      storeContracts: stores,
    });
    const ddrCacheWrite = db
      .getHistory()
      .find((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache") && entry.binds[0] === "depeg-resolver:snapshot");
    const payload = JSON.parse(ddrCacheWrite?.binds[1] as string).payload;

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
      confirmation_sources: "dex:curve+dex:uniswap",
      pending_reason: "large-cap",
    });
    const confirmationAt = NOW_SEC - 1_200;
    const { stores } = storesFor();
    const db = mockD1([
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
      { match: "FROM cache WHERE key = ?", rows: [stablecoinsCacheRow()] },
      { match: "FROM depeg_resolver_assessments", rows: [] },
      { match: "INSERT OR REPLACE INTO cache", rows: [] },
    ]);

    await computeDepegResolver({
      db,
      ddrRunId: "ddr:quarter-hour:1779984600:test",
      runAt: NOW_SEC,
      slot: "quarter-hour",
      stablecoinsCacheSafe: true,
      depegPipelineHealthy: true,
      syncCapabilities: { depegPipeline: true },
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
});

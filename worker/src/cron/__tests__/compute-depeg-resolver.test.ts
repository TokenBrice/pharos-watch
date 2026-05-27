import { describe, expect, it, vi, afterEach } from "vitest";
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
    return {
      sealed,
      stores: {
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
        sealPublicNoCall: vi.fn(async () => sealed),
        loadSealedPublicPredictions: vi.fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([sealed]),
        loadFirstPublicationMembership: vi.fn(async () => []),
        writePublicationManifest: vi.fn(async () => ({
          snapshotToken: "ddr-public-1",
          snapshotGeneration: 2,
          snapshotSequence: 1,
          publishedAt: NOW_SEC,
          basePayloadHash: "b".repeat(64),
          publicPredictionIds: [7],
          firstPublishedPublicPredictionIds: [7],
        })),
      } satisfies DdrV2StoreContracts,
    };
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
});

import { describe, expect, it, vi, afterEach } from "vitest";
import {
  DDR_METHODOLOGY_VERSION,
  DDR_METHODOLOGY_VERSION_LABEL,
  DDR_V2_EFFECTIVE_AT,
} from "@shared/lib/methodology-versions/depeg-resolver";
import { DdrrResponseSchema } from "@shared/types/depeg-resolver-review";
import { mockD1, type MockTableConfig } from "@shared/test-utils/mock-d1";
import {
  buildDepegResolverReviewSnapshot,
  computeAndStoreDepegResolverReview,
} from "../compute-depeg-resolver-review";
import { buildEmptyDdrrSummary } from "../../lib/depeg-resolver-review-response";
import type { DdrV2StoreContracts } from "../compute-depeg-resolver";

afterEach(() => {
  vi.useRealTimers();
});

const STARTED_AT = 1_000_000;
const ASSESSED_AT = 1_010_000;
const ELIGIBLE_AT = STARTED_AT + 86_400;
const USR_FROZEN_AT = Math.floor(Date.UTC(2026, 3, 27, 0, 0, 0) / 1000);
const USR_FROZEN_EVENT_STARTED_AT = Math.floor(Date.UTC(2026, 3, 27, 12, 0, 0) / 1000);
const USR_FROZEN_ELIGIBLE_AT = USR_FROZEN_EVENT_STARTED_AT + 86_400;

function assessmentRow(overrides: Record<string, unknown> = {}) {
  return {
    event_id: 42,
    stablecoin_id: "lusd-liquity",
    symbol: "LUSD",
    name: "Liquity USD",
    peg_currency: "USD",
    governance: "decentralized",
    direction: "below",
    started_at: STARTED_AT,
    assessed_at: ASSESSED_AT,
    event_age_sec: ASSESSED_AT - STARTED_AT,
    checkpoint: "first",
    methodology_version: DDR_METHODOLOGY_VERSION,
    resolution_tier: "recovery_likely",
    duration_suppressed: 0,
    duration_suppressed_reason: null,
    median_remaining_sec: 3_600,
    iqr_low_remaining_sec: 1_800,
    iqr_high_remaining_sec: 7_200,
    stratum: "below - moderate - robust - USD",
    horizons_json: JSON.stringify([
      {
        horizon: "6h",
        state: "benchmarked",
        probability: 0.55,
        probabilityDisplay: "50-60%",
        probabilityInterval: { lower: 0.5, upper: 0.6 },
        rawAtRisk: 20,
        uniqueCoins: 12,
        intervalClosures: 11,
        intervalNonClosures: 9,
      },
    ]),
    factors_json: JSON.stringify([]),
    ...overrides,
  };
}

function durableStores(overrides: Partial<DdrV2StoreContracts> = {}): DdrV2StoreContracts {
  return {
    ensureCanonicalIncidents: vi.fn(async () => []),
    recordLockDeferral: vi.fn(async () => undefined),
    sealPublicPrediction: vi.fn(async () => {
      throw new Error("not used");
    }),
    sealPublicNoCall: vi.fn(async () => {
      throw new Error("not used");
    }),
    loadCanonicalIncidents: vi.fn(async () => []),
    loadSealedPublicPredictions: vi.fn(async () => []),
    loadFirstPublicationMembership: vi.fn(async () => []),
    writePublicationManifest: vi.fn(async () => {
      throw new Error("not used");
    }),
    loadPredictionErrata: vi.fn(async () => []),
    ...overrides,
  };
}

/** N distinct policy-universe incidents, each of which yields one DDRR coverage row. */
function coverageIncidents(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    incidentKey: `ddr2:coverage-${String(index).padStart(5, "0")}`,
    eventId: index + 1,
    currentEventId: index + 1,
    stablecoinId: "lusd-liquity",
    pegCurrency: "USD",
    direction: "below" as const,
    startedAt: STARTED_AT - index,
    eligibleAt: ELIGIBLE_AT - index,
    policyUniverseIncluded: true,
    incidentState: "active" as const,
    supersededByIncidentKey: null,
  }));
}

/**
 * mockD1 wired for the depeg_events read every review snapshot issues, so each
 * case shows only its event rows plus whatever extra tables it needs.
 */
function reviewDb(eventRows: Record<string, unknown>[], extra: MockTableConfig[] = []) {
  return mockD1([
    { match: "FROM depeg_events", rows: eventRows },
    ...extra,
    {
      match: "FROM tape_events",
      rows: [],
      first: null,
    },
  ]);
}

function incident(overrides: Record<string, unknown> = {}) {
  const eventId = typeof overrides.eventId === "number" ? overrides.eventId : 42;
  const currentEventId = typeof overrides.currentEventId === "number" ? overrides.currentEventId : eventId;
  return {
    incidentKey: "ddr2:22222222222222222222222222222222",
    eventId,
    currentEventId,
    stablecoinId: "lusd-liquity",
    pegCurrency: "USD",
    direction: "below" as const,
    startedAt: STARTED_AT,
    eligibleAt: ELIGIBLE_AT,
    policyUniverseIncluded: true,
    ...overrides,
  };
}

type ReviewSealedPrediction = Awaited<ReturnType<DdrV2StoreContracts["loadSealedPublicPredictions"]>>[number];
type ReviewFirstPublication = Awaited<ReturnType<DdrV2StoreContracts["loadFirstPublicationMembership"]>>[number];

function sealedPrediction(overrides: Partial<ReviewSealedPrediction> = {}): ReviewSealedPrediction {
  const { sealedPayload: payloadOverrides, ...recordOverrides } = overrides;
  return {
    id: 55,
    publicPredictionId: 55,
    incidentKey: incident().incidentKey,
    eventId: 42,
    assessmentId: 90,
    outcomeKind: "prediction",
    predictionPolicyVersion: "sticky-24h-v1",
    predictionMethodologyVersion: DDR_METHODOLOGY_VERSION,
    policyDelaySec: 86_400,
    eligibleAt: ELIGIBLE_AT,
    lockedAt: ELIGIBLE_AT,
    eventAgeAtLockSec: 86_400,
    lockTiming: "on_time",
    rowHash: "e".repeat(64),
    ...recordOverrides,
    sealedPayload: {
      symbol: "LUSD",
      name: "Liquity USD",
      pegCurrency: "USD",
      governance: "decentralized",
      frozen: {
        resolution: { tier: "recovery_likely", factors: [] },
        duration: {
          suppressed: false,
          suppressedReason: null,
          medianSec: 3_600,
          iqrSec: [1_800, 7_200],
          horizons: JSON.parse(assessmentRow().horizons_json as string),
          stratum: "below - moderate - robust - USD",
        },
      },
      ...payloadOverrides,
    },
  };
}

function firstPublication(overrides: Partial<ReviewFirstPublication> = {}): ReviewFirstPublication {
  return {
    publicPredictionId: 55,
    incidentKey: incident().incidentKey,
    snapshotToken: "ddr-public-55",
    snapshotGeneration: 1,
    publishedAt: ELIGIBLE_AT + 60,
    firstPublished: true,
    ...overrides,
  };
}

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    stablecoin_id: "lusd-liquity",
    started_at: STARTED_AT,
    ended_at: null,
    recovery_price: null,
    ...overrides,
  };
}

function chunkAbortDb(input: {
  controller: AbortController;
  abortOn: "actual-events" | "tape-events";
  eventRows: Array<Record<string, unknown>>;
  abortReason: string;
}) {
  let actualEventQueryCount = 0;
  let tapeEventQueryCount = 0;

  function statement(sql: string, boundValues: unknown[] = []) {
    const executeAll = async <T>() => {
      if (sql.includes("FROM depeg_events")) {
        actualEventQueryCount += 1;
        if (input.abortOn === "actual-events" && actualEventQueryCount === 1) {
          input.controller.abort(input.abortReason);
        }
        const ids = new Set(boundValues);
        return {
          results: input.eventRows.filter((row) => ids.has(row.id)) as T[],
          success: true,
          meta: {},
        };
      }
      if (sql.includes("SELECT coin_id, type, ts, payload_json")) {
        tapeEventQueryCount += 1;
        if (input.abortOn === "tape-events" && tapeEventQueryCount === 1) {
          input.controller.abort(input.abortReason);
        }
        return { results: [] as T[], success: true, meta: {} };
      }
      return { results: [] as T[], success: true, meta: {} };
    };

    const executeFirst = async <T>() => {
      if (sql.includes("COUNT(*) as row_count")) {
        return { row_count: 1, max_ts: 1, max_id: 1 } as T;
      }
      if (sql.includes("FROM cache WHERE key = ?")) {
        return null as T | null;
      }
      return null as T | null;
    };

    return {
      bind: (...args: unknown[]) => statement(sql, args),
      all: executeAll,
      first: executeFirst,
      run: async () => ({ success: true, meta: { changes: 1 } }),
    };
  }

  return {
    db: { prepare: (sql: string) => statement(sql) } as unknown as D1Database,
    actualEventQueryCount: () => actualEventQueryCount,
    tapeEventQueryCount: () => tapeEventQueryCount,
  };
}

describe("buildDepegResolverReviewSnapshot", () => {
  it("can build DDRR from durable first-publication exposure when the v2 scorer is provided", async () => {
    const db = mockD1([]);
    const stores = {
      ensureCanonicalIncidents: vi.fn(async () => []),
      recordLockDeferral: vi.fn(async () => undefined),
      sealPublicPrediction: vi.fn(async () => {
        throw new Error("not used");
      }),
      sealPublicNoCall: vi.fn(async () => {
        throw new Error("not used");
      }),
      loadCanonicalIncidents: vi.fn(async () => [
        {
          incidentKey: "ddr2:22222222222222222222222222222222",
          eventId: 42,
          currentEventId: 42,
          stablecoinId: "lusd-liquity",
          pegCurrency: "USD",
          direction: "below" as const,
          startedAt: STARTED_AT,
          eligibleAt: STARTED_AT + 86_400,
          policyUniverseIncluded: true,
        },
      ]),
      loadSealedPublicPredictions: vi.fn(async () => [
        {
          id: 9,
          incidentKey: "ddr2:22222222222222222222222222222222",
          eventId: 42,
          assessmentId: 90,
          outcomeKind: "prediction" as const,
          predictionPolicyVersion: "sticky-24h-v1",
          predictionMethodologyVersion: DDR_METHODOLOGY_VERSION,
          policyDelaySec: 86_400,
          eligibleAt: STARTED_AT + 86_400,
          lockedAt: ASSESSED_AT,
          eventAgeAtLockSec: ASSESSED_AT - STARTED_AT,
          lockTiming: "on_time" as const,
          rowHash: "c".repeat(64),
          sealedPayload: {},
        },
      ]),
      loadFirstPublicationMembership: vi.fn(async () => [
        {
          publicPredictionId: 9,
          incidentKey: "ddr2:22222222222222222222222222222222",
          snapshotToken: "ddr-public-1",
          snapshotGeneration: 2,
          publishedAt: ASSESSED_AT,
          firstPublished: true,
        },
      ]),
      writePublicationManifest: vi.fn(async () => {
        throw new Error("not used");
      }),
      loadPredictionErrata: vi.fn(async () => []),
    } satisfies DdrV2StoreContracts;
    const v2ReviewBuilder = vi.fn(async () => ({
      _meta: {
        computedAt: ASSESSED_AT,
        expiresAt: ASSESSED_AT + 1800,
        degraded: false,
        degradedReason: null,
        reviewerVersion: "ddr-reviewer-v3",
        publicWarning: "v2",
        assessedEventCount: 1,
        reviewedEventCount: 1,
        pendingEventCount: 0,
        durationScoredCount: 0,
        verdictScoredCount: 0,
        assessmentRowLimit: 20_000,
        assessmentRowsTruncated: false,
        incidentRowLimit: 20_000,
        incidentRowsTruncated: false,
        publicRowLimit: 400,
        publicRowsTruncated: false,
        methodologyVersions: [DDR_METHODOLOGY_VERSION],
      },
      summary: buildEmptyDdrrSummary(),
      rows: [],
      methodology: {
        key: "depeg-resolver",
        version: DDR_METHODOLOGY_VERSION,
        versionLabel: DDR_METHODOLOGY_VERSION_LABEL,
        currentVersion: DDR_METHODOLOGY_VERSION,
        currentVersionLabel: DDR_METHODOLOGY_VERSION_LABEL,
        changelogPath: "/methodology/depeg-resolver-changelog/",
        isCurrent: true,
        asOf: ASSESSED_AT,
      },
    }));

    await buildDepegResolverReviewSnapshot(db, ASSESSED_AT, undefined, {
      storeContracts: stores,
      v2ReviewBuilder,
    });

    expect(stores.loadCanonicalIncidents).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        predictionPolicyVersion: "sticky-24h-v1",
        policyUniverseIncluded: true,
        limit: 20_001,
      }),
    );
    expect(v2ReviewBuilder).toHaveBeenCalledWith(
      expect.objectContaining({
        firstPublication: [expect.objectContaining({ publicPredictionId: 9, firstPublished: true })],
        sealedPublicPredictions: [expect.objectContaining({ id: 9 })],
      }),
      undefined,
    );
  });

  it("stops durable v2 store loading when the cron signal aborts between loads", async () => {
    const controller = new AbortController();
    const db = mockD1([]);
    const stores = durableStores({
      loadCanonicalIncidents: vi.fn(async () => {
        controller.abort("ddrr store abort");
        return [incident()];
      }),
      loadSealedPublicPredictions: vi.fn(async () => []),
    });

    await expect(
      buildDepegResolverReviewSnapshot(db, ELIGIBLE_AT + 3600, controller.signal, {
        storeContracts: stores,
      }),
    ).rejects.toThrow("ddrr store abort");

    expect(stores.loadCanonicalIncidents).toHaveBeenCalledTimes(1);
    expect(stores.loadSealedPublicPredictions).not.toHaveBeenCalled();
  });

  it("stops durable v2 actual-event chunk loading when the cron signal aborts", async () => {
    const controller = new AbortController();
    const eventRows = Array.from({ length: 91 }, (_, index) => ({
      id: index + 1,
      stablecoin_id: `ddrr-test-${index + 1}`,
      started_at: STARTED_AT,
      ended_at: null,
      recovery_price: null,
    }));
    const incidents = eventRows.map((row) =>
      incident({
        incidentKey: `ddr2:chunked-actual-${String(row.id).padStart(3, "0")}`,
        eventId: row.id,
        currentEventId: row.id,
        stablecoinId: row.stablecoin_id,
      }),
    );
    const db = chunkAbortDb({
      controller,
      abortOn: "actual-events",
      eventRows,
      abortReason: "ddrr actual-event chunk abort",
    });
    const stores = durableStores({ loadCanonicalIncidents: vi.fn(async () => incidents) });

    await expect(
      buildDepegResolverReviewSnapshot(db.db, ELIGIBLE_AT + 3600, controller.signal, {
        storeContracts: stores,
      }),
    ).rejects.toThrow("ddrr actual-event chunk abort");

    expect(db.actualEventQueryCount()).toBe(1);
  });

  it("stops durable v2 tape-evidence chunk loading when the cron signal aborts", async () => {
    const controller = new AbortController();
    const eventRows = Array.from({ length: 91 }, (_, index) => ({
      id: index + 1,
      stablecoin_id: `ddrr-test-${index + 1}`,
      started_at: STARTED_AT,
      ended_at: null,
      recovery_price: null,
    }));
    const incidents = eventRows.map((row) =>
      incident({
        incidentKey: `ddr2:chunked-tape-${String(row.id).padStart(3, "0")}`,
        eventId: row.id,
        currentEventId: row.id,
        stablecoinId: row.stablecoin_id,
      }),
    );
    const db = chunkAbortDb({
      controller,
      abortOn: "tape-events",
      eventRows,
      abortReason: "ddrr tape-evidence chunk abort",
    });
    const stores = durableStores({ loadCanonicalIncidents: vi.fn(async () => incidents) });

    await expect(
      buildDepegResolverReviewSnapshot(db.db, ELIGIBLE_AT + 3600, controller.signal, {
        storeContracts: stores,
      }),
    ).rejects.toThrow("ddrr tape-evidence chunk abort");

    expect(db.actualEventQueryCount()).toBe(2);
    expect(db.tapeEventQueryCount()).toBe(1);
  });

  it("caps unfiltered durable v2 incident review loads and marks the envelope truncated", async () => {
    const incidents = Array.from({ length: 20_001 }, (_, index) => ({
      incidentKey: `ddr2:incident-${String(index).padStart(5, "0")}`,
      eventId: index + 1,
      currentEventId: index + 1,
      stablecoinId: "lusd-liquity",
      pegCurrency: "USD",
      direction: "below" as const,
      startedAt: STARTED_AT - index,
      eligibleAt: ELIGIBLE_AT - index,
      policyUniverseIncluded: true,
      incidentState: "active" as const,
      supersededByIncidentKey: null,
    }));
    const db = reviewDb([]);
    const stores = durableStores({ loadCanonicalIncidents: vi.fn(async () => incidents) });

    const snapshot = await buildDepegResolverReviewSnapshot(db, ELIGIBLE_AT + 3600, undefined, {
      storeContracts: stores,
    });

    expect(stores.loadCanonicalIncidents).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ limit: 20_001 }),
    );
    expect(snapshot._meta.assessedEventCount).toBe(20_000);
    expect(snapshot._meta.incidentRowLimit).toBe(20_000);
    expect(snapshot._meta.incidentRowsTruncated).toBe(true);
    expect(snapshot._meta.degraded).toBe(true);
    expect(snapshot._meta.degradedReason).toContain("incident-row-cap");
    expect(snapshot._meta.reviewedEventCount).toBe(20_000);
    expect(snapshot.rows).toHaveLength(400);
  });

  it("reviews published durable v2 prediction payloads", async () => {
    const reviewIncident = incident({ incidentKey: "ddr2:published-prediction" });
    const db = reviewDb([
      eventRow({ ended_at: ELIGIBLE_AT + 3_600, recovery_price: 1 }),
    ]);
    const stores = durableStores({
      loadCanonicalIncidents: vi.fn(async () => [reviewIncident]),
      loadSealedPublicPredictions: vi.fn(async () => [sealedPrediction({ incidentKey: reviewIncident.incidentKey })]),
      loadFirstPublicationMembership: vi.fn(async () => [firstPublication({ incidentKey: reviewIncident.incidentKey })]),
    });

    const snapshot = await buildDepegResolverReviewSnapshot(db, ELIGIBLE_AT + 7_200, undefined, {
      storeContracts: stores,
    });

    expect(snapshot.rows[0]).toMatchObject({
      kind: "prediction_review",
      incidentKey: reviewIncident.incidentKey,
      publicPredictionId: 55,
      actual: { kind: "recovered" },
      verdictReview: "correct_recoverable",
    });
    expect(snapshot.summary.headline.recoveryLikelihoodScoredCount).toBe(1);
  });

  it("annotates auto-repaired and split incident lineage from one bounded D1 batch", async () => {
    const autoRepairedIncident = incident({
      incidentKey: "ddr2:auto-repaired-lineage",
    });
    const splitIncident = incident({
      incidentKey: "ddr2:split-child-lineage",
      eventId: 43,
      currentEventId: 43,
      startedAt: STARTED_AT + 3_600,
      eligibleAt: ELIGIBLE_AT + 3_600,
    });
    const db = reviewDb([
      {
        id: 42,
        stablecoin_id: "lusd-liquity",
        started_at: STARTED_AT,
        ended_at: ELIGIBLE_AT + 3_600,
        recovery_price: 1,
      },
      {
        id: 43,
        stablecoin_id: "lusd-liquity",
        started_at: STARTED_AT + 3_600,
        ended_at: null,
        recovery_price: null,
      },
    ], [
      {
      match: "FROM depeg_resolver_incident_event_links",
      rows: [{
        incident_key: autoRepairedIncident.incidentKey,
        repair_sources: "ddr-worker:repair-task-runner-v1,ddr-worker:auto-sealed-tail",
      }],
    },
      {
      match: "FROM depeg_resolver_incident_lineage",
      rows: [{
        incident_key: splitIncident.incidentKey,
        parent_incident_key: "ddr2:split-parent-lineage",
      }],
    },
    ]);
    const batch = vi.spyOn(db, "batch");
    const stores = durableStores({
      loadCanonicalIncidents: vi.fn(async () => [autoRepairedIncident, splitIncident]),
      loadSealedPublicPredictions: vi.fn(async () => [
        {
          id: 55,
          publicPredictionId: 55,
          incidentKey: autoRepairedIncident.incidentKey,
          eventId: 42,
          assessmentId: 90,
          outcomeKind: "prediction" as const,
          predictionPolicyVersion: "sticky-24h-v1",
          predictionMethodologyVersion: DDR_METHODOLOGY_VERSION,
          policyDelaySec: 86_400,
          eligibleAt: ELIGIBLE_AT,
          lockedAt: ELIGIBLE_AT,
          eventAgeAtLockSec: 86_400,
          lockTiming: "on_time" as const,
          rowHash: "e".repeat(64),
          sealedPayload: {
            symbol: "LUSD",
            name: "Liquity USD",
            pegCurrency: "USD",
            governance: "decentralized",
            frozen: {
              resolution: {
                tier: "recovery_likely",
                factors: [],
              },
              duration: {
                suppressed: false,
                suppressedReason: null,
                medianSec: 3_600,
                iqrSec: [1_800, 7_200],
                horizons: JSON.parse(assessmentRow().horizons_json as string),
                stratum: "below - moderate - robust - USD",
              },
            },
          },
        },
      ]),
      loadFirstPublicationMembership: vi.fn(async () => [
        {
          publicPredictionId: 55,
          incidentKey: autoRepairedIncident.incidentKey,
          snapshotToken: "ddr-public-55",
          snapshotGeneration: 3,
          publishedAt: ELIGIBLE_AT + 60,
          firstPublished: true,
        },
      ]),
    });

    const snapshot = await buildDepegResolverReviewSnapshot(db, ELIGIBLE_AT + 7_200, undefined, {
      storeContracts: stores,
    });

    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]?.[0]).toHaveLength(2);
    expect(snapshot.rows.find((row) => row.incidentKey === autoRepairedIncident.incidentKey)).toMatchObject({
      kind: "prediction_review",
      lineage: {
        autoRepaired: true,
        repairSources: ["ddr-worker:auto-sealed-tail", "ddr-worker:repair-task-runner-v1"],
      },
    });
    expect(snapshot.rows.find((row) => row.incidentKey === splitIncident.incidentKey)).toMatchObject({
      kind: "coverage",
      lineage: { parentIncidentKey: "ddr2:split-parent-lineage" },
    });
    expect(DdrrResponseSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("marks the reviewer snapshot degraded when lineage reads fail", async () => {
    const lineageIncident = incident({ incidentKey: "ddr2:lineage-read-failure" });
    const db = reviewDb([{
      id: 42,
      stablecoin_id: "lusd-liquity",
      started_at: STARTED_AT,
      ended_at: null,
      recovery_price: null,
    }], [
      {
      match: "FROM depeg_resolver_incident_event_links",
      rows: [],
      throwError: new Error("D1_ERROR: lineage query unavailable"),
    },
    ]);
    const stores = durableStores({
      loadCanonicalIncidents: vi.fn(async () => [lineageIncident]),
    });

    const snapshot = await buildDepegResolverReviewSnapshot(db, ELIGIBLE_AT + 3_600, undefined, {
      storeContracts: stores,
    });

    expect(snapshot._meta.degraded).toBe(true);
    expect(snapshot._meta.degradedReason).toContain("incident-lineage-read-failed");
    expect(snapshot.rows[0]?.lineage).toBeUndefined();
  });

  it("reviews sealed repaired tails against the current source event without moving the lock-time start", async () => {
    const originalStartedAt = STARTED_AT;
    const lockedAt = originalStartedAt + 86_400;
    const tailStartedAt = lockedAt + 3_600;
    const recoveredAt = lockedAt + 10_000;
    const reviewIncident = incident({
      incidentKey: "ddr2:sealed-repaired-tail",
      currentEventId: 89,
      startedAt: tailStartedAt,
      eligibleAt: tailStartedAt + 86_400,
    });
    const db = reviewDb([
      eventRow({ started_at: originalStartedAt, ended_at: lockedAt + 60, recovery_price: 1 }),
      eventRow({ id: 89, started_at: tailStartedAt, ended_at: recoveredAt, recovery_price: 1 }),
    ]);
    const stores = durableStores({
      loadCanonicalIncidents: vi.fn(async () => [reviewIncident]),
      loadSealedPublicPredictions: vi.fn(async () => [sealedPrediction({
        id: 56,
        publicPredictionId: 56,
        incidentKey: reviewIncident.incidentKey,
        assessmentId: 91,
        eligibleAt: lockedAt,
        lockedAt,
        eventAgeAtLockSec: lockedAt - originalStartedAt,
        rowHash: "f".repeat(64),
        sealedPayload: { eventId: 42, startedAt: originalStartedAt },
      })]),
      loadFirstPublicationMembership: vi.fn(async () => [firstPublication({
        publicPredictionId: 56,
        incidentKey: reviewIncident.incidentKey,
        snapshotToken: "ddr-public-56",
        publishedAt: lockedAt + 60,
      })]),
    });

    const snapshot = await buildDepegResolverReviewSnapshot(db, recoveredAt + 1, undefined, {
      storeContracts: stores,
    });

    expect(snapshot.rows[0]).toMatchObject({
      kind: "prediction_review",
      eventId: 89,
      currentEventId: 89,
      incidentKey: reviewIncident.incidentKey,
      startedAt: originalStartedAt,
      eligibleAt: lockedAt,
      lockedAt,
      sourceEventState: "recovered",
      actual: { kind: "recovered", actualRemainingSec: recoveredAt - lockedAt },
      verdictReview: "correct_recoverable",
    });
    expect(snapshot.summary.headline.recoveryLikelihoodScoredCount).toBe(1);
  });

  it("keeps sealed repaired tails pending when the current source event starts after lock and remains open", async () => {
    const originalStartedAt = STARTED_AT;
    const lockedAt = originalStartedAt + 86_400;
    const tailStartedAt = lockedAt + 7_200;
    const reviewIncident = incident({
      incidentKey: "ddr2:sealed-open-tail",
      eventId: 43,
      currentEventId: 90,
      startedAt: tailStartedAt,
      eligibleAt: tailStartedAt + 86_400,
    });
    const db = reviewDb([
      eventRow({ id: 43, started_at: originalStartedAt, ended_at: lockedAt + 60, recovery_price: 1 }),
      eventRow({ id: 90, started_at: tailStartedAt }),
    ]);
    const stores = durableStores({
      loadCanonicalIncidents: vi.fn(async () => [reviewIncident]),
      loadSealedPublicPredictions: vi.fn(async () => [sealedPrediction({
        id: 57,
        publicPredictionId: 57,
        incidentKey: reviewIncident.incidentKey,
        eventId: 43,
        assessmentId: 92,
        eligibleAt: lockedAt,
        lockedAt,
        eventAgeAtLockSec: lockedAt - originalStartedAt,
        rowHash: "a".repeat(64),
        // Bad future payload start should fall back to lockedAt - eventAgeAtLockSec.
        sealedPayload: { eventId: 43, startedAt: tailStartedAt },
      })]),
      loadFirstPublicationMembership: vi.fn(async () => [firstPublication({
        publicPredictionId: 57,
        incidentKey: reviewIncident.incidentKey,
        snapshotToken: "ddr-public-57",
        publishedAt: lockedAt + 60,
      })]),
    });

    const snapshot = await buildDepegResolverReviewSnapshot(db, tailStartedAt + 3_600, undefined, {
      storeContracts: stores,
    });

    expect(snapshot.rows[0]).toMatchObject({
      kind: "prediction_review",
      eventId: 90,
      currentEventId: 90,
      startedAt: originalStartedAt,
      eligibleAt: lockedAt,
      lockedAt,
      sourceEventState: "active",
      actual: { kind: "still_open" },
      verdictReview: "pending",
      durationReview: "duration_unscored",
    });
    expect(snapshot.summary.headline.recoveryLikelihoodScoredCount).toBe(0);
  });

  it("reviews superseded duplicate tails through the canonical incident outcome", async () => {
    const originalStartedAt = STARTED_AT;
    const lockedAt = originalStartedAt + 86_400;
    const tailStartedAt = lockedAt + 7_200;
    const canonical = incident({
      incidentKey: "ddr2:canonical-open-tail",
      eventId: 43,
      currentEventId: 43,
      startedAt: originalStartedAt,
      eligibleAt: lockedAt,
      incidentState: "active",
      supersededByIncidentKey: null,
    });
    const duplicateAlias = incident({
      incidentKey: "ddr2:duplicate-open-tail",
      eventId: 90,
      currentEventId: 90,
      startedAt: tailStartedAt,
      eligibleAt: tailStartedAt + 86_400,
      incidentState: "superseded",
      supersededByIncidentKey: canonical.incidentKey,
    });
    const db = reviewDb([
      eventRow({ id: 43, started_at: originalStartedAt, ended_at: lockedAt + 60, recovery_price: 1 }),
      eventRow({ id: 90, started_at: tailStartedAt }),
    ]);
    const stores = durableStores({
      loadCanonicalIncidents: vi.fn(async () => [canonical, duplicateAlias]),
      loadSealedPublicPredictions: vi.fn(async () => [sealedPrediction({
        id: 58,
        publicPredictionId: 58,
        incidentKey: canonical.incidentKey,
        eventId: 43,
        assessmentId: 93,
        eligibleAt: lockedAt,
        lockedAt,
        eventAgeAtLockSec: lockedAt - originalStartedAt,
        rowHash: "b".repeat(64),
        sealedPayload: { eventId: 43, startedAt: originalStartedAt },
      })]),
      loadFirstPublicationMembership: vi.fn(async () => [firstPublication({
        publicPredictionId: 58,
        incidentKey: canonical.incidentKey,
        snapshotToken: "ddr-public-58",
        publishedAt: lockedAt + 60,
      })]),
    });

    const snapshot = await buildDepegResolverReviewSnapshot(db, tailStartedAt + 3_600, undefined, {
      storeContracts: stores,
    });

    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0]).toMatchObject({
      kind: "prediction_review",
      incidentKey: canonical.incidentKey,
      eventId: 90,
      currentEventId: 90,
      sourceEventState: "active",
      actual: { kind: "still_open" },
      verdictReview: "pending",
    });
    expect(snapshot.summary.headline.recoveryLikelihoodScoredCount).toBe(0);
  });

  it("classifies v2 missed-lock coverage at lock boundaries and after deferrals close", async () => {
    const incidents = [
      incident({ incidentKey: "ddr2:eq-recovered", eventId: 1, startedAt: STARTED_AT, eligibleAt: ELIGIBLE_AT }),
      incident({
        incidentKey: "ddr2:deferral-closed",
        eventId: 2,
        startedAt: STARTED_AT,
        eligibleAt: ELIGIBLE_AT,
        lockState: {
          eligibleAt: ELIGIBLE_AT,
          deferralCount: 1,
          lastDeferralReason: "cache stale",
          lastState: "lock_deferred",
        },
      }),
      incident({ incidentKey: "ddr2:terminal-unknown-time", eventId: 3, stablecoinId: "usr-resolv", startedAt: STARTED_AT, eligibleAt: ELIGIBLE_AT }),
    ];
    const db = reviewDb([
      eventRow({ id: 1, ended_at: ELIGIBLE_AT, recovery_price: 1 }),
      eventRow({ id: 2, ended_at: ELIGIBLE_AT + 1, recovery_price: 1 }),
      eventRow({ id: 3, stablecoin_id: "usr-resolv" }),
    ]);
    const stores = durableStores({ loadCanonicalIncidents: vi.fn(async () => incidents) });

    const snapshot = await buildDepegResolverReviewSnapshot(db, ELIGIBLE_AT + 3600, undefined, {
      storeContracts: stores,
    });
    const states = Object.fromEntries(snapshot.rows.map((row) => [row.incidentKey, row.predictionState]));

    expect(states["ddr2:eq-recovered"]).toBe("missed_lock_recovered");
    expect(states["ddr2:deferral-closed"]).toBe("missed_lock_recovered");
    expect(states["ddr2:terminal-unknown-time"]).toBe("missed_lock_terminal");
  });

  it("uses canonical dynamic eligibility when classifying DDRR coverage rows", async () => {
    const dynamicEligibleAt = STARTED_AT + 72 * 3600;
    const activeIncident = incident({ incidentKey: "ddr2:dynamic-active-pending", eventId: 11, startedAt: STARTED_AT, eligibleAt: dynamicEligibleAt });
    const recoveredIncident = incident({ incidentKey: "ddr2:dynamic-recovered-before-backstop", eventId: 12, startedAt: STARTED_AT, eligibleAt: dynamicEligibleAt });
    const db = reviewDb([
      eventRow({ id: 11 }),
      eventRow({ id: 12, ended_at: STARTED_AT + 48 * 3600, recovery_price: 1 }),
    ]);
    const stores = durableStores({
      loadCanonicalIncidents: vi.fn(async () => [activeIncident, recoveredIncident]),
    });

    const pendingSnapshot = await buildDepegResolverReviewSnapshot(db, STARTED_AT + 24 * 3600, undefined, {
      storeContracts: stores,
    });
    const pendingRow = pendingSnapshot.rows.find((row) => row.incidentKey === activeIncident.incidentKey);
    expect(pendingRow).toMatchObject({
      kind: "coverage",
      eligibleAt: dynamicEligibleAt,
      predictionState: "pending_lock",
      coverageCause: "active_pending_lock",
    });

    const recoveredSnapshot = await buildDepegResolverReviewSnapshot(db, dynamicEligibleAt + 1, undefined, {
      storeContracts: stores,
    });
    const recoveredRow = recoveredSnapshot.rows.find((row) => row.incidentKey === recoveredIncident.incidentKey);
    expect(recoveredRow).toMatchObject({
      kind: "coverage",
      eligibleAt: dynamicEligibleAt,
      predictionState: "resolved_before_prediction",
      coverageCause: "pre_lock_recovered",
      actualEndedAt: STARTED_AT + 48 * 3600,
    });
  });

  it("characterizes durable v2 coverage row states and headline counts", async () => {
    const nowSec = ELIGIBLE_AT + 3_600;
    const pendingEligibleAt = nowSec + 3_600;
    const terminalBeforeAt = ELIGIBLE_AT - 900;
    const terminalAfterAt = ELIGIBLE_AT + 600;
    const incidents = [
      ["matrix-missing-source", 201],
      ["matrix-pre-lock-recovered", 202],
      ["matrix-terminal-before", 203],
      ["matrix-pending", 204, pendingEligibleAt],
      ["matrix-missed-recovered", 205],
      ["matrix-orphan", 206],
      ["matrix-terminal-after", 207],
      ["matrix-system-deferral", 208],
      ["matrix-cron-gap", 209],
    ].map(([stablecoinId, eventId, eligibleAt]) => incident({
      incidentKey: `ddr2:${stablecoinId}`,
      eventId: eventId as number,
      stablecoinId: stablecoinId as string,
      startedAt: STARTED_AT,
      eligibleAt: (eligibleAt as number | undefined) ?? ELIGIBLE_AT,
      ...(eventId === 208 ? {
        lockState: {
          eligibleAt: ELIGIBLE_AT,
          lastState: "lock_deferred",
          lastDeferralReason: "cache stale",
          deferralCount: 2,
        },
      } : {}),
    }));
    const db = reviewDb([
      eventRow({ id: 202, stablecoin_id: "matrix-pre-lock-recovered", ended_at: ELIGIBLE_AT - 60, recovery_price: 1 }),
      eventRow({ id: 203, stablecoin_id: "matrix-terminal-before" }),
      eventRow({ id: 204, stablecoin_id: "matrix-pending" }),
      eventRow({ id: 205, stablecoin_id: "matrix-missed-recovered", ended_at: ELIGIBLE_AT + 60, recovery_price: 1 }),
      eventRow({ id: 206, stablecoin_id: "matrix-orphan", ended_at: ELIGIBLE_AT + 60 }),
      eventRow({ id: 207, stablecoin_id: "matrix-terminal-after" }),
      eventRow({ id: 208, stablecoin_id: "matrix-system-deferral" }),
      eventRow({ id: 209, stablecoin_id: "matrix-cron-gap" }),
    ], [
      {
        match: "FROM tape_events",
        rows: [
          {
            coin_id: "matrix-terminal-before",
            type: "lifecycle.tracked.frozen",
            ts: terminalBeforeAt * 1000,
            payload_json: JSON.stringify({}),
          },
          {
            coin_id: "matrix-terminal-after",
            type: "lifecycle.tracked.frozen",
            ts: terminalAfterAt * 1000,
            payload_json: JSON.stringify({}),
          },
        ],
      },
    ]);
    const stores = durableStores({ loadCanonicalIncidents: vi.fn(async () => incidents) });

    const snapshot = await buildDepegResolverReviewSnapshot(db, nowSec, undefined, {
      storeContracts: stores,
    });
    const rowsByIncident = new Map(snapshot.rows.map((row) => [row.incidentKey, row]));

    expect(rowsByIncident.get("ddr2:matrix-missing-source")).toMatchObject({
      kind: "coverage",
      sourceEventState: "missing",
      predictionState: "data_quality_gap",
      coverageCause: "data_quality_gap",
      reason: "source_event_missing",
    });
    expect(rowsByIncident.get("ddr2:matrix-pre-lock-recovered")).toMatchObject({
      predictionState: "resolved_before_prediction",
      coverageCause: "pre_lock_recovered",
      actualEndedAt: ELIGIBLE_AT - 60,
    });
    expect(rowsByIncident.get("ddr2:matrix-terminal-before")).toMatchObject({
      sourceEventState: "terminal",
      predictionState: "terminal_before_prediction",
      coverageCause: "pre_lock_terminal",
      terminalEvidenceAt: terminalBeforeAt,
    });
    expect(rowsByIncident.get("ddr2:matrix-pending")).toMatchObject({
      eligibleAt: pendingEligibleAt,
      predictionState: "pending_lock",
      coverageCause: "active_pending_lock",
    });
    expect(rowsByIncident.get("ddr2:matrix-missed-recovered")).toMatchObject({
      predictionState: "missed_lock_recovered",
      coverageCause: "lock_missed",
      operationalCoverageCause: "lock_missed",
    });
    expect(rowsByIncident.get("ddr2:matrix-orphan")).toMatchObject({
      sourceEventState: "orphan_closed",
      predictionState: "orphan_closed",
      coverageCause: "orphan_closed",
      outcomeQualityState: "orphan_closed",
    });
    expect(rowsByIncident.get("ddr2:matrix-terminal-after")).toMatchObject({
      sourceEventState: "terminal",
      predictionState: "missed_lock_terminal",
      coverageCause: "lock_missed",
      terminalEvidenceAt: terminalAfterAt,
    });
    expect(rowsByIncident.get("ddr2:matrix-system-deferral")).toMatchObject({
      predictionState: "lock_deferred",
      coverageCause: "active_lock_deferred",
      operationalCoverageCause: "system_deferral",
      reason: "cache stale",
    });
    expect(rowsByIncident.get("ddr2:matrix-cron-gap")).toMatchObject({
      predictionState: "lock_deferred",
      coverageCause: "cron_gap",
      operationalCoverageCause: "cron_gap",
      reason: "eligible_active_incident_without_public_prediction",
    });
    expect(snapshot.summary.headline).toMatchObject({
      policyUniverseIncidentCount: 9,
      pendingLockCount: 1,
      lockDeferredCount: 2,
      resolvedBeforePredictionCount: 1,
      terminalBeforePredictionCount: 1,
      dataQualityGapCount: 1,
      orphanClosedCount: 1,
      missedLockRecoveredCount: 1,
      missedLockTerminalCount: 1,
      missedNoPredictionCount: 2,
      missedOperationalLockCount: 4,
    });
    expect(snapshot._meta).toMatchObject({
      assessedEventCount: 9,
      reviewedEventCount: 9,
      pendingEventCount: 3,
      publicRowsTruncated: false,
    });
    expect(DdrrResponseSchema.safeParse(snapshot)).toMatchObject({ success: true });
  });

  it("classifies terminal_before_prediction from tracked frozenAt evidence", async () => {
    const incident = {
      incidentKey: "ddr2:usr-frozen-before-lock",
      eventId: 91,
      currentEventId: 91,
      stablecoinId: "usr-resolv",
      pegCurrency: "USD",
      direction: "below" as const,
      startedAt: USR_FROZEN_EVENT_STARTED_AT,
      eligibleAt: USR_FROZEN_ELIGIBLE_AT,
      policyUniverseIncluded: true,
    };
    const db = reviewDb([
      {
        id: 91,
        stablecoin_id: "usr-resolv",
        started_at: USR_FROZEN_EVENT_STARTED_AT,
        ended_at: null,
        recovery_price: null,
      },
    ]);
    const stores = durableStores({ loadCanonicalIncidents: vi.fn(async () => [incident]) });

    const snapshot = await buildDepegResolverReviewSnapshot(db, USR_FROZEN_ELIGIBLE_AT + 3600, undefined, {
      storeContracts: stores,
    });

    expect(snapshot.rows[0]).toMatchObject({
      kind: "coverage",
      incidentKey: incident.incidentKey,
      sourceEventState: "terminal",
      predictionState: "terminal_before_prediction",
      coverageCause: "pre_lock_terminal",
      terminalEvidenceAt: USR_FROZEN_AT,
      terminalEvidenceInterval: { start: USR_FROZEN_AT, end: USR_FROZEN_AT + 86_400 },
      terminalEvidencePrecision: "day",
      terminalEvidenceSourceDate: "2026-04-27",
    });
    expect(snapshot.summary.headline.terminalBeforePredictionCount).toBe(1);
    expect(snapshot.summary.headline.missedLockTerminalCount).toBe(0);
  });

  it("treats rollout-active terminal evidence before DDRv2 enablement as pre-lock coverage", async () => {
    const rolloutStartedAt = Math.floor(Date.UTC(2026, 2, 22, 2, 4, 57) / 1000);
    const rawEligibleAt = rolloutStartedAt + 72 * 3600;
    expect(rawEligibleAt).toBeLessThan(USR_FROZEN_AT);
    expect(USR_FROZEN_AT).toBeLessThan(DDR_V2_EFFECTIVE_AT);

    const incident = {
      incidentKey: "ddr2:usr-rollout-terminal-before-enable",
      eventId: 88045,
      currentEventId: 88045,
      stablecoinId: "usr-resolv",
      pegCurrency: "USD",
      direction: "below" as const,
      startedAt: rolloutStartedAt,
      eligibleAt: rawEligibleAt,
      policyUniverseIncluded: true,
      rolloutActiveAtEnablement: true,
    };
    const db = reviewDb([
      {
        id: 88045,
        stablecoin_id: "usr-resolv",
        started_at: rolloutStartedAt,
        ended_at: null,
        recovery_price: null,
      },
    ]);
    const stores = durableStores({ loadCanonicalIncidents: vi.fn(async () => [incident]) });

    const snapshot = await buildDepegResolverReviewSnapshot(db, DDR_V2_EFFECTIVE_AT + 3600, undefined, {
      storeContracts: stores,
    });

    expect(snapshot.rows[0]).toMatchObject({
      kind: "coverage",
      incidentKey: incident.incidentKey,
      eligibleAt: rawEligibleAt,
      sourceEventState: "terminal",
      predictionState: "terminal_before_prediction",
      coverageCause: "pre_lock_terminal",
      operationalCoverageCause: null,
      terminalEvidenceAt: USR_FROZEN_AT,
      terminalEvidenceInterval: { start: USR_FROZEN_AT, end: USR_FROZEN_AT + 86_400 },
      terminalEvidencePrecision: "day",
      terminalEvidenceSourceDate: "2026-04-27",
    });
    expect(snapshot.summary.headline.terminalBeforePredictionCount).toBe(1);
    expect(snapshot.summary.headline.missedLockTerminalCount).toBe(0);
  });

  it("uses tape lifecycle rows as terminal evidence when registry evidence is absent", async () => {
    const incident = {
      incidentKey: "ddr2:tape-terminal-before-lock",
      eventId: 92,
      currentEventId: 92,
      stablecoinId: "lusd-liquity",
      pegCurrency: "USD",
      direction: "below" as const,
      startedAt: STARTED_AT,
      eligibleAt: ELIGIBLE_AT,
      policyUniverseIncluded: true,
    };
    const terminalTs = STARTED_AT + 3600;
    const db = reviewDb([
      {
        id: 92,
        stablecoin_id: "lusd-liquity",
        started_at: STARTED_AT,
        ended_at: null,
        recovery_price: null,
      },
    ], [
      {
      match: "FROM tape_events",
      rows: [
        {
          coin_id: "lusd-liquity",
          type: "lifecycle.tracked.frozen",
          ts: terminalTs * 1000,
          payload_json: JSON.stringify({}),
        },
      ],
    },
    ]);
    const stores = durableStores({ loadCanonicalIncidents: vi.fn(async () => [incident]) });

    const snapshot = await buildDepegResolverReviewSnapshot(db, ELIGIBLE_AT + 3600, undefined, {
      storeContracts: stores,
    });

    expect(snapshot.rows[0]).toMatchObject({
      kind: "coverage",
      incidentKey: incident.incidentKey,
      sourceEventState: "terminal",
      predictionState: "terminal_before_prediction",
      terminalEvidenceAt: terminalTs,
      terminalEvidenceInterval: null,
      terminalEvidencePrecision: "unknown",
    });
    expect(snapshot.summary.headline.terminalBeforePredictionCount).toBe(1);
  });

  it("reuses cached tape terminal evidence when the tape token is unchanged", async () => {
    const incident = {
      incidentKey: "ddr2:tape-terminal-cache-hit",
      eventId: 96,
      currentEventId: 96,
      stablecoinId: "lusd-liquity",
      pegCurrency: "USD",
      direction: "below" as const,
      startedAt: STARTED_AT,
      eligibleAt: ELIGIBLE_AT,
      policyUniverseIncluded: true,
    };
    const terminalTs = STARTED_AT + 3600;
    const token = { rowCount: 1, maxTs: terminalTs * 1000, maxId: 7 };
    const db = reviewDb([
      {
        id: 96,
        stablecoin_id: "lusd-liquity",
        started_at: STARTED_AT,
        ended_at: null,
        recovery_price: null,
      },
    ], [
      {
      match: "COUNT(*) as row_count",
      rows: [{ row_count: token.rowCount, max_ts: token.maxTs, max_id: token.maxId }],
    },
      {
      match: "FROM cache WHERE key = ?",
      rows: [
        {
          key: "depeg-resolver-review:terminal-evidence:v1",
          value: JSON.stringify({
            version: 1,
            token,
            checkedStablecoinIds: ["lusd-liquity"],
            evidenceByStablecoinId: {
              "lusd-liquity": {
                terminalEvidenceAt: terminalTs,
                terminalEvidenceInterval: null,
                terminalEvidencePrecision: "unknown",
                terminalEvidenceSourceDate: null,
              },
            },
          }),
        },
      ],
    },
      {
      match: "SELECT coin_id, type, ts, payload_json",
      rows: [],
      throwError: new Error("unexpected tape row query"),
    },
    ]);
    const stores = durableStores({ loadCanonicalIncidents: vi.fn(async () => [incident]) });

    const snapshot = await buildDepegResolverReviewSnapshot(db, ELIGIBLE_AT + 3600, undefined, {
      storeContracts: stores,
    });

    expect(snapshot.rows[0]).toMatchObject({
      kind: "coverage",
      incidentKey: incident.incidentKey,
      sourceEventState: "terminal",
      predictionState: "terminal_before_prediction",
      terminalEvidenceAt: terminalTs,
    });
    expect(db.getHistory().some((entry) => entry.sql.includes("SELECT coin_id, type, ts, payload_json"))).toBe(false);
  });

  it("rejects YYYY-MM source date with year 0000 and falls back to tape timestamp (ddr-5 regression)", async () => {
    const incident = {
      incidentKey: "ddr2:year-zero-month-regression",
      eventId: 93,
      currentEventId: 93,
      stablecoinId: "lusd-liquity",
      pegCurrency: "USD",
      direction: "below" as const,
      startedAt: STARTED_AT,
      eligibleAt: ELIGIBLE_AT,
      policyUniverseIncluded: true,
    };
    const terminalTs = STARTED_AT + 3600;
    const db = reviewDb([
      {
        id: 93,
        stablecoin_id: "lusd-liquity",
        started_at: STARTED_AT,
        ended_at: null,
        recovery_price: null,
      },
    ], [
      {
      match: "FROM tape_events",
      rows: [
        {
          coin_id: "lusd-liquity",
          type: "lifecycle.tracked.frozen",
          ts: terminalTs * 1000,
          // "0000-01" previously produced epoch -2208988800 (year 1900);
          // the year < 1 guard now rejects it and falls through to ts.
          payload_json: JSON.stringify({ frozenAt: "0000-01" }),
        },
      ],
    },
    ]);
    const stores = durableStores({ loadCanonicalIncidents: vi.fn(async () => [incident]) });

    const snapshot = await buildDepegResolverReviewSnapshot(db, ELIGIBLE_AT + 3600, undefined, {
      storeContracts: stores,
    });

    expect(snapshot.rows[0]).toMatchObject({
      kind: "coverage",
      sourceEventState: "terminal",
      terminalEvidenceAt: terminalTs,
      terminalEvidenceInterval: null,
      terminalEvidencePrecision: "unknown",
    });
  });

  it("rethrows non-missing-table tape_events failures instead of failing open", async () => {
    const incident = {
      incidentKey: "ddr2:tape-query-fault",
      eventId: 94,
      currentEventId: 94,
      stablecoinId: "lusd-liquity",
      pegCurrency: "USD",
      direction: "below" as const,
      startedAt: STARTED_AT,
      eligibleAt: ELIGIBLE_AT,
      policyUniverseIncluded: true,
    };
    const db = reviewDb([
      { id: 94, stablecoin_id: "lusd-liquity", started_at: STARTED_AT, ended_at: null, recovery_price: null },
    ], [
      {
      match: "FROM tape_events",
      rows: [],
      throwError: new Error("D1_ERROR: database is locked"),
    },
    ]);
    const stores = durableStores({ loadCanonicalIncidents: vi.fn(async () => [incident]) });

    await expect(
      buildDepegResolverReviewSnapshot(db, ELIGIBLE_AT + 3600, undefined, { storeContracts: stores }),
    ).rejects.toThrow("D1_ERROR: database is locked");
  });

  it("surfaces a missing mandatory tape_events table", async () => {
    const incident = {
      incidentKey: "ddr2:tape-missing-table",
      eventId: 95,
      currentEventId: 95,
      stablecoinId: "lusd-liquity",
      pegCurrency: "USD",
      direction: "below" as const,
      startedAt: STARTED_AT,
      eligibleAt: ELIGIBLE_AT,
      policyUniverseIncluded: true,
    };
    const db = reviewDb([
      { id: 95, stablecoin_id: "lusd-liquity", started_at: STARTED_AT, ended_at: null, recovery_price: null },
    ], [
      {
      match: "FROM tape_events",
      rows: [],
      throwError: new Error("D1_ERROR: no such table: tape_events"),
    },
    ]);
    const stores = durableStores({ loadCanonicalIncidents: vi.fn(async () => [incident]) });

    await expect(
      buildDepegResolverReviewSnapshot(db, ELIGIBLE_AT + 3600, undefined, { storeContracts: stores }),
    ).rejects.toThrow("D1_ERROR: no such table: tape_events");
  });

  it("does not backdate overlapping day-precision terminal evidence before lock", async () => {
    const startedAt = USR_FROZEN_AT - 12 * 3600;
    const eligibleAt = startedAt + 86_400;
    const incident = {
      incidentKey: "ddr2:usr-frozen-overlaps-lock",
      eventId: 93,
      currentEventId: 93,
      stablecoinId: "usr-resolv",
      pegCurrency: "USD",
      direction: "below" as const,
      startedAt,
      eligibleAt,
      policyUniverseIncluded: true,
    };
    const db = reviewDb([{ id: 93, stablecoin_id: "usr-resolv", started_at: startedAt, ended_at: null, recovery_price: null }]);
    const stores = durableStores({ loadCanonicalIncidents: vi.fn(async () => [incident]) });

    const snapshot = await buildDepegResolverReviewSnapshot(db, eligibleAt + 3600, undefined, {
      storeContracts: stores,
    });

    expect(snapshot.rows[0]).toMatchObject({
      kind: "coverage",
      incidentKey: incident.incidentKey,
      predictionState: "missed_lock_terminal",
      terminalEvidenceAt: null,
      terminalEvidenceInterval: { start: USR_FROZEN_AT, end: USR_FROZEN_AT + 86_400 },
      terminalEvidencePrecision: "day",
    });
    expect(snapshot.summary.headline.terminalBeforePredictionCount).toBe(0);
    expect(snapshot.summary.headline.missedLockTerminalCount).toBe(1);
  });

  it("keeps interval-anchored terminal evidence when a recovery closes before the interval end", async () => {
    // Recovered event (ended_at + recovery_price) whose terminal-evidence
    // interval extends past ended_at. The publication-failed row reads
    // actual.terminalEvidenceAt directly, so the materialized at-timestamp must
    // stay anchored to the interval start instead of being zeroed out — that
    // zeroing previously made the failed-publication path disagree with the
    // propagated interval. (audit Q-169)
    const startedAt = USR_FROZEN_AT - 12 * 3600;
    const eligibleAt = USR_FROZEN_AT;
    const endedAt = USR_FROZEN_AT + 6 * 3600; // inside the interval, < interval.end
    const incident = {
      incidentKey: "ddr2:usr-frozen-recovered-before-interval-end",
      eventId: 95,
      currentEventId: 95,
      stablecoinId: "usr-resolv",
      pegCurrency: "USD",
      direction: "below" as const,
      startedAt,
      eligibleAt,
      policyUniverseIncluded: true,
    };
    const db = reviewDb([{ id: 95, stablecoin_id: "usr-resolv", started_at: startedAt, ended_at: endedAt, recovery_price: 1 }]);
    const stores = durableStores({
      loadCanonicalIncidents: vi.fn(async () => [incident]),
      loadSealedPublicPredictions: vi.fn(async () => [
        {
          id: 11,
          publicPredictionId: 11,
          incidentKey: incident.incidentKey,
          eventId: 95,
          assessmentId: 95,
          outcomeKind: "prediction" as const,
          predictionPolicyVersion: "sticky-24h-v1",
          predictionMethodologyVersion: DDR_METHODOLOGY_VERSION,
          policyDelaySec: 86_400,
          eligibleAt,
          lockedAt: eligibleAt,
          eventAgeAtLockSec: 86_400,
          lockTiming: "on_time" as const,
          rowHash: "d".repeat(64),
          sealedPayload: { kind: "prediction", symbol: "USR" },
        },
      ]),
    });

    const snapshot = await buildDepegResolverReviewSnapshot(db, endedAt + 3600, undefined, {
      storeContracts: stores,
    });

    expect(snapshot.rows[0]).toMatchObject({
      kind: "coverage",
      incidentKey: incident.incidentKey,
      predictionState: "publication_failed",
      sourceEventState: "terminal",
      // Regression guard: pre-fix this was zeroed to null because
      // interval.end > ended_at.
      terminalEvidenceAt: USR_FROZEN_AT,
      terminalEvidenceInterval: { start: USR_FROZEN_AT, end: USR_FROZEN_AT + 86_400 },
      terminalEvidencePrecision: "day",
    });
  });

  it("marks sealed unpublished rows as publication failed once the source closes", async () => {
    const incident = {
      incidentKey: "ddr2:sealed-unpublished",
      eventId: 42,
      currentEventId: 42,
      stablecoinId: "lusd-liquity",
      pegCurrency: "USD",
      direction: "below" as const,
      startedAt: STARTED_AT,
      eligibleAt: ELIGIBLE_AT,
      policyUniverseIncluded: true,
    };
    const db = reviewDb([
      {
        id: 42,
        stablecoin_id: "lusd-liquity",
        started_at: STARTED_AT,
        ended_at: ELIGIBLE_AT + 10,
        recovery_price: 1,
      },
    ]);
    const stores = durableStores({
      loadCanonicalIncidents: vi.fn(async () => [incident]),
      loadSealedPublicPredictions: vi.fn(async () => [
        {
          id: 9,
          publicPredictionId: 9,
          incidentKey: incident.incidentKey,
          eventId: 42,
          assessmentId: 90,
          outcomeKind: "prediction" as const,
          predictionPolicyVersion: "sticky-24h-v1",
          predictionMethodologyVersion: DDR_METHODOLOGY_VERSION,
          policyDelaySec: 86_400,
          eligibleAt: ELIGIBLE_AT,
          lockedAt: ELIGIBLE_AT,
          eventAgeAtLockSec: 86_400,
          lockTiming: "on_time" as const,
          rowHash: "c".repeat(64),
          sealedPayload: { kind: "prediction", symbol: "LUSD" },
        },
      ]),
    });

    const snapshot = await buildDepegResolverReviewSnapshot(db, ELIGIBLE_AT + 3600, undefined, {
      storeContracts: stores,
    });

    expect(snapshot.rows[0]).toMatchObject({
      kind: "coverage",
      incidentKey: incident.incidentKey,
      predictionState: "publication_failed",
      failedPublication: { publicPredictionId: 9, rowHash: "c".repeat(64) },
    });
    expect(snapshot.summary.headline.publicationFailedCount).toBe(1);
  });

  it("classifies active eligible lock deferrals without public predictions", async () => {
    const incident = {
      incidentKey: "ddr2:active-lock-deferred",
      eventId: 44,
      currentEventId: 44,
      stablecoinId: "lusd-liquity",
      pegCurrency: "USD",
      direction: "below" as const,
      startedAt: STARTED_AT,
      eligibleAt: ELIGIBLE_AT,
      policyUniverseIncluded: true,
      lockState: {
        eligibleAt: ELIGIBLE_AT,
        lastState: "lock_deferred" as const,
        lastDeferralReason: "strict_readiness_not_met",
        deferralCount: 1,
      },
    };
    const db = reviewDb([
      {
        id: 44,
        stablecoin_id: "lusd-liquity",
        started_at: STARTED_AT,
        ended_at: null,
        recovery_price: null,
      },
    ]);
    const stores = durableStores({ loadCanonicalIncidents: vi.fn(async () => [incident]) });

    const snapshot = await buildDepegResolverReviewSnapshot(db, ELIGIBLE_AT + 3600, undefined, {
      storeContracts: stores,
    });

    expect(snapshot.rows[0]).toMatchObject({
      kind: "coverage",
      incidentKey: incident.incidentKey,
      predictionState: "lock_deferred",
      coverageCause: "active_lock_deferred",
      operationalCoverageCause: "system_deferral",
      reason: "strict_readiness_not_met",
    });
    expect(snapshot.summary.headline.lockDeferredCount).toBe(1);
  });

  it("marks published sealed rows with unparsable payloads as data quality gaps", async () => {
    const incident = {
      incidentKey: "ddr2:published-bad-payload",
      eventId: 45,
      currentEventId: 45,
      stablecoinId: "lusd-liquity",
      pegCurrency: "USD",
      direction: "below" as const,
      startedAt: STARTED_AT,
      eligibleAt: ELIGIBLE_AT,
      policyUniverseIncluded: true,
    };
    const db = reviewDb([
      {
        id: 45,
        stablecoin_id: "lusd-liquity",
        started_at: STARTED_AT,
        ended_at: null,
        recovery_price: null,
      },
    ]);
    const stores = durableStores({
      loadCanonicalIncidents: vi.fn(async () => [incident]),
      loadSealedPublicPredictions: vi.fn(async () => [
        {
          id: 11,
          publicPredictionId: 11,
          incidentKey: incident.incidentKey,
          eventId: 45,
          assessmentId: 92,
          outcomeKind: "prediction" as const,
          predictionPolicyVersion: "sticky-24h-v1",
          predictionMethodologyVersion: DDR_METHODOLOGY_VERSION,
          policyDelaySec: 86_400,
          eligibleAt: ELIGIBLE_AT,
          lockedAt: ELIGIBLE_AT,
          eventAgeAtLockSec: 86_400,
          lockTiming: "on_time" as const,
          rowHash: "e".repeat(64),
          sealedPayload: { symbol: "LUSD" },
        },
      ]),
      loadFirstPublicationMembership: vi.fn(async () => [
        {
          publicPredictionId: 11,
          incidentKey: incident.incidentKey,
          snapshotToken: "ddr-public-bad-payload",
          snapshotGeneration: 3,
          publishedAt: ELIGIBLE_AT + 60,
          firstPublished: true,
        },
      ]),
    });

    const snapshot = await buildDepegResolverReviewSnapshot(db, ELIGIBLE_AT + 3600, undefined, {
      storeContracts: stores,
    });

    expect(snapshot.rows[0]).toMatchObject({
      kind: "coverage",
      incidentKey: incident.incidentKey,
      predictionState: "data_quality_gap",
      coverageCause: "data_quality_gap",
      outcomeQualityState: "data_quality_gap",
      reason: "sealed_payload_parse_failed",
      failedPublication: null,
    });
    expect(snapshot.summary.headline.dataQualityGapCount).toBe(1);
  });

  it("emits invalidated prediction rows when sealed public rows have errata", async () => {
    const incident = {
      incidentKey: "ddr2:invalidated-public-prediction",
      eventId: 43,
      currentEventId: 43,
      stablecoinId: "lusd-liquity",
      pegCurrency: "USD",
      direction: "below" as const,
      startedAt: STARTED_AT,
      eligibleAt: ELIGIBLE_AT,
      policyUniverseIncluded: true,
    };
    const originalNoCall = {
      lockedAt: ELIGIBLE_AT,
      eventAgeAtLockSec: 86_400,
      missingReasons: ["insufficient_signal"],
      relatedContext: {},
    };
    const db = reviewDb([
      {
        id: 43,
        stablecoin_id: "lusd-liquity",
        started_at: STARTED_AT,
        ended_at: null,
        recovery_price: null,
      },
    ]);
    const stores = durableStores({
      loadCanonicalIncidents: vi.fn(async () => [incident]),
      loadSealedPublicPredictions: vi.fn(async () => [
        {
          id: 10,
          publicPredictionId: 10,
          incidentKey: incident.incidentKey,
          eventId: 43,
          assessmentId: 91,
          outcomeKind: "no_call" as const,
          predictionPolicyVersion: "sticky-24h-v1",
          predictionMethodologyVersion: DDR_METHODOLOGY_VERSION,
          policyDelaySec: 86_400,
          eligibleAt: ELIGIBLE_AT,
          lockedAt: ELIGIBLE_AT,
          eventAgeAtLockSec: 86_400,
          lockTiming: "on_time" as const,
          rowHash: "d".repeat(64),
          sealedPayload: {
            symbol: "LUSD",
            name: "Liquity USD",
            pegCurrency: "USD",
            governance: "decentralized",
            noCall: originalNoCall,
          },
        },
      ]),
      loadFirstPublicationMembership: vi.fn(async () => [
        {
          publicPredictionId: 10,
          incidentKey: incident.incidentKey,
          snapshotToken: "ddr-public-2",
          snapshotGeneration: 3,
          publishedAt: ELIGIBLE_AT + 60,
          firstPublished: true,
        },
      ]),
      loadPredictionErrata: vi.fn(async () => [
        {
          id: 1,
          publicPredictionId: 10,
          incidentKey: incident.incidentKey,
          eventId: 43,
          assessmentId: 91,
          reason: "event_identity_error" as const,
          operatorNote: "Fixture invalidation",
          replacementAssessmentId: null,
          replacementRowHash: null,
          rowHashBefore: "d".repeat(64),
          createdAt: ELIGIBLE_AT + 120,
          createdBy: "test",
        },
      ]),
    });

    const snapshot = await buildDepegResolverReviewSnapshot(db, ELIGIBLE_AT + 3600, undefined, {
      storeContracts: stores,
    });
    const row = snapshot.rows.find((entry) => entry.kind === "invalidated_prediction");

    expect(row).toMatchObject({
      kind: "invalidated_prediction",
      incidentKey: incident.incidentKey,
      publicPredictionId: 10,
      assessmentId: 91,
      predictionState: "invalidated",
      originalKind: "no_call",
      originalOutcome: originalNoCall,
      latestErratum: expect.objectContaining({ state: "invalidated", reason: "event_identity_error" }),
      errataCount: 1,
    });
    expect(snapshot.summary.headline.invalidatedPredictionCount).toBe(1);
    expect(snapshot._meta.reviewedEventCount).toBe(1);
    expect(DdrrResponseSchema.safeParse(snapshot)).toMatchObject({ success: true });
  });

  it("caps public review rows at the published limit", async () => {
    const db = reviewDb([]);
    const stores = durableStores({ loadCanonicalIncidents: vi.fn(async () => coverageIncidents(401)) });

    const snapshot = await buildDepegResolverReviewSnapshot(db, ELIGIBLE_AT + 3600, undefined, {
      storeContracts: stores,
    });

    expect(snapshot._meta.reviewedEventCount).toBe(401);
    expect(snapshot._meta.publicRowLimit).toBe(400);
    expect(snapshot._meta.publicRowsTruncated).toBe(true);
    expect(snapshot.rows).toHaveLength(400);
  });

  it("serves more than 100 public review rows without truncation", async () => {
    const db = reviewDb([]);
    const stores = durableStores({ loadCanonicalIncidents: vi.fn(async () => coverageIncidents(101)) });

    const snapshot = await buildDepegResolverReviewSnapshot(db, ELIGIBLE_AT + 3600, undefined, {
      storeContracts: stores,
    });

    expect(snapshot._meta.reviewedEventCount).toBe(101);
    expect(snapshot._meta.publicRowLimit).toBe(400);
    expect(snapshot._meta.publicRowsTruncated).toBe(false);
    expect(snapshot.rows).toHaveLength(101);
  });

  it("stores a cache snapshot with headline DDRR stats", async () => {
    vi.useFakeTimers();
    vi.setSystemTime((ELIGIBLE_AT + 3600) * 1000);
    const db = reviewDb([], [
      { match: "INSERT OR REPLACE INTO cache", rows: [] },
    ]);
    const stores = durableStores({ loadCanonicalIncidents: vi.fn(async () => coverageIncidents(1)) });

    const result = await computeAndStoreDepegResolverReview(db, undefined, { storeContracts: stores });
    const cacheWrite = db.getHistory().find((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"));

    expect(result.itemCount).toBe(1);
    expect(cacheWrite?.binds[0]).toBe("depeg-resolver-review:snapshot");
    const payload = JSON.parse(cacheWrite?.binds[1] as string).payload;
    expect(payload._meta.reviewedEventCount).toBe(1);
    expect(payload.summary.headline).toMatchObject({
      recoveryLikelihoodScoredCount: 0,
    });
  });
});

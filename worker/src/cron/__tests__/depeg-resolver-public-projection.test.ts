import { describe, expect, it } from "vitest";
import { DDR_SNAPSHOT_CACHE_GENERATION } from "@shared/lib/depeg-resolver-version";
import {
  DdrResponseSchema,
  type DdrPredictionErratum,
  type DdrRow,
} from "@shared/types/depeg-resolver";
import {
  attachDdrPublicRowHash,
  computeDdrPublicRowHash,
  validateDdrPublicCacheContract,
} from "@shared/lib/depeg-resolver/public-contract";
import type {
  DdrCanonicalIncident,
  DdrFirstPublicationMembership,
  DdrSealedPublicPrediction,
} from "../depeg-resolver-v2-contracts";
import {
  buildDdrResponse,
  buildDiagnosticSnapshot,
  buildV2PublicationBasePayload,
  normalizeErratumRecord,
} from "../depeg-resolver/public-projection";

describe("depeg-resolver public projection", () => {
  const NOW_SEC = 1_779_984_600;
  const DAY_SEC = 24 * 3600;
  const READINESS_BACKSTOP_SEC = 72 * 3600;
  const LINEAGE = {
    trainingWindow: { start: NOW_SEC - 30 * DAY_SEC, end: NOW_SEC - DAY_SEC },
    eventCount: 8,
    incidentCount: 5,
    coinCount: 4,
    quarantinedCoins: 0,
  };

  function hashFor(seed: string): string {
    return seed.repeat(64).slice(0, 64);
  }

  function resolverRow(overrides: Partial<DdrRow> = {}): DdrRow {
    const startedAt = overrides.startedAt ?? NOW_SEC - 6 * 3600;
    return {
      stablecoinId: "projection-test",
      symbol: "PRJ",
      name: "Projection Test",
      pegCurrency: "USD",
      governance: "decentralized",
      status: "active",
      eventId: 42,
      startedAt,
      ageSec: NOW_SEC - startedAt,
      direction: "below",
      peakDeviationBps: -250,
      currentDeviationBps: -180,
      resolution: {
        tier: "recovery_likely",
        factors: [
          {
            code: "R2_hard_collateral_redemption",
            kind: "anchor",
            severity: "strong",
            label: "Fixture has a hard collateral recovery anchor",
          },
        ],
      },
      duration: {
        suppressed: false,
        suppressedReason: null,
        stratum: "below - moderate - robust - USD",
        medianSec: 3600,
        iqrSec: [1800, 7200],
        ageStatus: "ordinary",
        horizons: [
          {
            horizon: "6h",
            state: "benchmarked",
            probability: 0.75,
            probabilityDisplay: "70-80%",
            probabilityInterval: { lower: 0.7, upper: 0.8 },
            rawAtRisk: 20,
            uniqueCoins: 12,
            intervalClosures: 15,
            intervalNonClosures: 5,
          },
        ],
      },
      relatedContext: {
        dewsBand: "WATCH",
        dewsScore: 22,
        liquidityScore: 88,
        safetyGrade: "A",
        safetyScore: 91,
        supplyChange7dPct: 0,
        supplyChange30dPct: 0,
        mintSurge: false,
      },
      ...overrides,
    };
  }

  function insufficientSignalRow(overrides: Partial<DdrRow> = {}): DdrRow {
    return resolverRow({
      currentDeviationBps: null,
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
      ...overrides,
    });
  }

  function canonicalIncident(row: DdrRow, overrides: Partial<DdrCanonicalIncident> = {}): DdrCanonicalIncident {
    return {
      incidentKey: `ddr2:projection-${row.eventId}`,
      eventId: row.eventId,
      currentEventId: row.eventId,
      stablecoinId: row.stablecoinId,
      pegCurrency: row.pegCurrency,
      direction: row.direction,
      startedAt: row.startedAt,
      eligibleAt: row.startedAt + DAY_SEC,
      policyUniverseIncluded: true,
      rolloutActiveAtEnablement: true,
      confirmedAt: null,
      lockState: null,
      ...overrides,
    };
  }

  function sealedPrediction(
    row: DdrRow,
    incident: DdrCanonicalIncident,
    id: number,
    overrides: Partial<DdrSealedPublicPrediction> = {},
  ): DdrSealedPublicPrediction {
    const lockedAt = overrides.lockedAt ?? NOW_SEC - 60;
    const policyDelaySec = overrides.policyDelaySec ?? DAY_SEC;
    return {
      id,
      publicPredictionId: id,
      incidentKey: incident.incidentKey,
      eventId: row.eventId,
      assessmentId: id * 10,
      outcomeKind: "prediction",
      predictionPolicyVersion: "sticky-24h-v1",
      predictionMethodologyVersion: "2.0",
      policyDelaySec,
      eligibleAt: incident.eligibleAt,
      lockedAt,
      eventAgeAtLockSec: lockedAt - row.startedAt,
      lockTiming: "late_freeze",
      lockTrigger: "forecast_readiness",
      rowHash: hashFor(String(id)),
      sealedPayload: {
        kind: "prediction",
        prediction: {
          incidentKey: incident.incidentKey,
          eligibleAt: incident.eligibleAt,
          lockedAt,
          eventAgeAtLockSec: lockedAt - row.startedAt,
          lockTiming: "late_freeze",
          lockTrigger: "forecast_readiness",
          policyDelaySec,
          predictionPolicyVersion: "sticky-24h-v1",
          predictionMethodologyVersion: "2.0",
        },
      },
      ...overrides,
    };
  }

  function firstPublication(
    sealed: DdrSealedPublicPrediction,
    overrides: Partial<DdrFirstPublicationMembership> = {},
  ): DdrFirstPublicationMembership {
    return {
      publicPredictionId: sealed.publicPredictionId ?? sealed.id,
      incidentKey: sealed.incidentKey,
      snapshotToken: "ddr-public-original",
      snapshotGeneration: DDR_SNAPSHOT_CACHE_GENERATION,
      publishedAt: NOW_SEC - 120,
      firstPublished: true,
      ...overrides,
    };
  }

  function erratumFor(sealed: DdrSealedPublicPrediction): DdrPredictionErratum {
    return {
      id: 99,
      state: "invalidated",
      publicPredictionId: sealed.publicPredictionId ?? sealed.id,
      incidentKey: sealed.incidentKey,
      eventId: sealed.eventId,
      assessmentId: sealed.assessmentId,
      reason: "event_identity_error",
      createdAt: NOW_SEC - 30,
      operatorNote: "Source event was repaired after first publication",
      rowHashBefore: sealed.rowHash,
      replacementAssessmentId: null,
      replacementRowHash: null,
      createdBy: "operator",
    };
  }

  it("normalizes erratum rows from storage", () => {
    expect(normalizeErratumRecord({
      id: 99,
      public_prediction_id: 7,
      incident_key: "usdc-circle:42:below",
      event_id: 42,
      assessment_id: 70,
      reason: "event_identity_error",
      created_at: 1_779_984_600,
      operator_note: "Source event was repaired after first publication",
      row_hash_before: "a".repeat(64),
      replacement_assessment_id: 71,
      replacement_row_hash: "b".repeat(64),
      created_by: "operator",
    })).toEqual({
      id: 99,
      state: "invalidated",
      publicPredictionId: 7,
      incidentKey: "usdc-circle:42:below",
      eventId: 42,
      assessmentId: 70,
      reason: "event_identity_error",
      createdAt: 1_779_984_600,
      operatorNote: "Source event was repaired after first publication",
      rowHashBefore: "a".repeat(64),
      replacementAssessmentId: 71,
      replacementRowHash: "b".repeat(64),
      createdBy: "operator",
    });
  });

  it("drops malformed erratum rows", () => {
    expect(normalizeErratumRecord({
      id: 99,
      public_prediction_id: 7,
      incident_key: "usdc-circle:42:below",
      event_id: 42,
      assessment_id: 70,
      reason: "unknown_reason",
      created_at: 1_779_984_600,
      operator_note: "bad reason",
      created_by: "operator",
    })).toBeNull();
  });

  it("projects pending readiness and sealed publication fallbacks", () => {
    const backstopStartedAt = NOW_SEC - READINESS_BACKSTOP_SEC;
    const backstopPending = resolverRow({
      eventId: 1,
      startedAt: backstopStartedAt,
      ageSec: READINESS_BACKSTOP_SEC,
    });
    const scheduledPending = insufficientSignalRow({
      eventId: 2,
      startedAt: NOW_SEC - 1800,
      ageSec: 1800,
    });
    const retryRow = resolverRow({ eventId: 3 });
    const invalidatedRow = resolverRow({ eventId: 4 });
    const publishedRow = resolverRow({ eventId: 5 });

    const backstopIncident = canonicalIncident(backstopPending);
    const scheduledIncident = canonicalIncident(scheduledPending);
    const retryIncident = canonicalIncident(retryRow);
    const invalidatedIncident = canonicalIncident(invalidatedRow);
    const publishedIncident = canonicalIncident(publishedRow);
    const retrySealed = sealedPrediction(retryRow, retryIncident, 10, { rowHash: hashFor("a") });
    const publishedSealed = sealedPrediction(publishedRow, publishedIncident, 20, { rowHash: hashFor("b") });
    const invalidatedSealed = sealedPrediction(invalidatedRow, invalidatedIncident, 30, { rowHash: hashFor("c") });

    const response = buildDdrResponse({
      candidateRows: [backstopPending, scheduledPending, retryRow, invalidatedRow, publishedRow],
      incidentsByEventId: new Map([
        [1, backstopIncident],
        [2, scheduledIncident],
        [3, retryIncident],
        [4, invalidatedIncident],
        [5, publishedIncident],
      ]),
      sealed: [invalidatedSealed, retrySealed, publishedSealed],
      firstPublication: [firstPublication(publishedSealed)],
      manifest: {
        snapshotToken: "ddr-public-manifest",
        snapshotGeneration: DDR_SNAPSHOT_CACHE_GENERATION,
        snapshotSequence: 7,
        publishedAt: NOW_SEC - 60,
        basePayloadHash: hashFor("d"),
        publicPredictionIds: [20, 30],
        firstPublishedPublicPredictionIds: [30],
      },
      errata: [erratumFor(invalidatedSealed)],
      lineage: LINEAGE,
      nowSec: NOW_SEC,
      storageAvailable: true,
    });

    const byEventId = new Map(response.rows.map((row) => [row.eventId, row]));
    expect(response._meta.publicPredictionIds).toEqual([10, 20, 30]);
    expect(response._meta.publicPredictionRowHashes).toEqual({
      "10": retrySealed.rowHash,
      "20": publishedSealed.rowHash,
      "30": invalidatedSealed.rowHash,
    });

    expect(byEventId.get(1)).toMatchObject({
      kind: "pending",
      prediction: {
        state: "lock_deferred",
        lockTrigger: "readiness_backstop",
        eligibleAt: backstopStartedAt + READINESS_BACKSTOP_SEC,
        policyDelaySec: READINESS_BACKSTOP_SEC,
        backstop: { reached: true },
      },
    });
    expect(byEventId.get(2)).toMatchObject({
      kind: "pending",
      prediction: {
        state: "pending_lock",
        lockTrigger: "scheduled_24h",
        policyDelaySec: READINESS_BACKSTOP_SEC,
      },
    });
    expect(byEventId.get(3)).toMatchObject({
      kind: "pending",
      prediction: {
        state: "publication_retry_pending",
        publicPredictionId: 10,
        deferralReason: "publication-retry-pending",
        modelAsOf: retrySealed.lockedAt,
      },
    });
    expect(byEventId.get(4)).toMatchObject({
      kind: "invalidated_prediction",
      originalKind: "prediction",
      prediction: {
        state: "invalidated",
        publicPredictionId: 30,
        publicationSnapshotToken: "ddr-public-manifest",
        latestErratum: { id: 99 },
        errataCount: 1,
      },
      frozen: {
        duration: { remainingAsOf: invalidatedSealed.lockedAt },
      },
      originalOutcome: {
        duration: { remainingAsOf: invalidatedSealed.lockedAt },
      },
    });
    expect(byEventId.get(5)).toMatchObject({
      kind: "prediction",
      prediction: {
        state: "frozen",
        publicPredictionId: 20,
        publicationSnapshotToken: "ddr-public-original",
      },
      frozen: {
        duration: { remainingAsOf: publishedSealed.lockedAt },
      },
    });
  });

  it("preserves hash-addressed retired safety contexts in immutable sealed predictions", () => {
    const row = resolverRow({ eventId: 6 });
    const incident = canonicalIncident(row);
    const sealed = sealedPrediction(row, incident, 6);
    const publication = firstPublication(sealed);
    const fallback = buildDdrResponse({
      candidateRows: [row],
      incidentsByEventId: new Map([[row.eventId, incident]]),
      sealed: [sealed],
      firstPublication: [publication],
      manifest: null,
      errata: [],
      lineage: LINEAGE,
      nowSec: NOW_SEC,
      storageAvailable: true,
    }).rows[0];
    if (fallback?.kind !== "prediction") {
      throw new Error("Expected sealed prediction fixture");
    }
    const retiredContext = {
      status: "retired-identified",
      reason: null,
      identity: null,
    };
    const frozen = {
      ...fallback.frozen,
      relatedContext: {
        ...fallback.frozen.relatedContext,
        safetyContext: retiredContext,
      },
      sourceRow: {
        ...fallback.frozen.sourceRow,
        relatedContext: {
          ...fallback.frozen.sourceRow.relatedContext,
          safetyContext: retiredContext,
        },
      },
    };
    const { live: _live, ...sealedPayloadWithoutHash } = {
      ...fallback,
      frozen,
    };
    const rowHash = computeDdrPublicRowHash(sealedPayloadWithoutHash);
    const sealedWithRetiredContext = {
      ...sealed,
      rowHash,
      sealedPayload: attachDdrPublicRowHash(
        sealedPayloadWithoutHash,
        rowHash,
      ),
    };

    const response = buildDdrResponse({
      candidateRows: [row],
      incidentsByEventId: new Map([[row.eventId, incident]]),
      sealed: [sealedWithRetiredContext],
      firstPublication: [publication],
      manifest: null,
      errata: [],
      lineage: LINEAGE,
      nowSec: NOW_SEC,
      storageAvailable: true,
    });
    const projected = response.rows[0];
    if (projected?.kind !== "prediction") {
      throw new Error("Expected projected prediction");
    }

    expect(projected.frozen.relatedContext.safetyContext).toEqual(
      retiredContext,
    );
    expect(
      projected.frozen.sourceRow.relatedContext.safetyContext,
    ).toEqual(retiredContext);
    expect(DdrResponseSchema.safeParse(response).success).toBe(true);
    expect(validateDdrPublicCacheContract(response)).toMatchObject({
      ok: true,
    });
  });

  it("sorts public prediction ids in v2 publication base payloads", () => {
    const firstRow = resolverRow({ eventId: 7 });
    const secondRow = resolverRow({ eventId: 8 });
    const firstIncident = canonicalIncident(firstRow);
    const secondIncident = canonicalIncident(secondRow);
    const secondSealed = sealedPrediction(secondRow, secondIncident, 3, { rowHash: hashFor("e") });
    const firstSealed = sealedPrediction(firstRow, firstIncident, 2, { rowHash: hashFor("f") });
    const snapshot = buildDiagnosticSnapshot({ rows: [firstRow, secondRow], lineage: LINEAGE, nowSec: NOW_SEC });

    const basePayload = buildV2PublicationBasePayload({
      snapshot,
      incidentsByEventId: new Map([
        [7, firstIncident],
        [8, secondIncident],
      ]),
      sealed: [secondSealed, firstSealed],
      firstPublication: [firstPublication(secondSealed), firstPublication(firstSealed)],
      errata: [],
      snapshotToken: "ddr-public-next",
      nowSec: NOW_SEC,
    }) as { _meta: { publicPredictionIds: number[]; publicPredictionRowHashes: Record<string, string> } };

    expect(basePayload._meta.publicPredictionIds).toEqual([2, 3]);
    expect(basePayload._meta.publicPredictionRowHashes).toEqual({
      "2": firstSealed.rowHash,
      "3": secondSealed.rowHash,
    });
  });
});

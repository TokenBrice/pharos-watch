import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeDdrPublicRowHash } from "@shared/lib/depeg-resolver/public-contract";
import type {
  DdrFirstPublicationMembership,
  DdrSealedPublicPrediction,
  DdrSealInput,
} from "../../depeg-resolver-v2-contracts";
import {
  makeDdrPublicationManifest,
  makeDdrResolverRow,
  makeDdrSealedPublicPrediction,
} from "../../__tests__/depeg-public-projection.test-support";

const stores = vi.hoisted(() => ({
  closeRecoveredPreLockIncidents: vi.fn(),
  ensureCanonicalIncidents: vi.fn(),
  loadCanonicalIncidents: vi.fn(),
  recordLockDeferral: vi.fn(),
  recordLockOpportunity: vi.fn(),
  loadFirstPublicationMembership: vi.fn(),
  loadLatestPublicationManifest: vi.fn(),
  loadPredictionErrata: vi.fn(),
  loadSealedPublicPredictions: vi.fn(),
  sealPublicNoCall: vi.fn(),
  sealPublicPrediction: vi.fn(),
  writePublicationManifest: vi.fn(),
}));

vi.mock("../../../lib/depeg-resolver-incident-store", () => ({
  closeRecoveredPreLockIncidents: stores.closeRecoveredPreLockIncidents,
  ensureCanonicalIncidents: stores.ensureCanonicalIncidents,
  loadCanonicalIncidents: stores.loadCanonicalIncidents,
  recordLockDeferral: stores.recordLockDeferral,
  recordLockOpportunity: stores.recordLockOpportunity,
}));

vi.mock("../../../lib/depeg-resolver-publication-store", () => ({
  loadFirstPublicationMembership: stores.loadFirstPublicationMembership,
  loadLatestPublicationManifest: stores.loadLatestPublicationManifest,
  loadSealedPublicPredictions: stores.loadSealedPublicPredictions,
  sealPublicNoCall: stores.sealPublicNoCall,
  sealPublicPrediction: stores.sealPublicPrediction,
  writePublicationManifest: stores.writePublicationManifest,
}));

vi.mock("../../../lib/depeg-resolver-errata-store", () => ({
  loadPredictionErrata: stores.loadPredictionErrata,
}));

import {
  DEFAULT_DDR_V2_STORE_CONTRACTS,
  firstPublicationByPredictionId,
  sealedByIncident,
} from "../storage-adapters";

const db = {} as D1Database;

const STORE_INCIDENT = {
  incidentKey: "ddr:usdc:below",
  eventId: 41,
  currentEventId: 42,
  stablecoinId: "usdc-circle",
  pegCurrency: "USD",
  direction: "below",
  startedAt: 1_700_000_000,
  eligibleAt: 1_700_086_400,
  policyUniverseIncluded: true,
  rolloutActiveAtEnablement: false,
  incidentState: "active",
  closedPreLockAt: null,
  supersededByIncidentKey: null,
  confirmedAt: 1_700_000_100,
  lockState: null,
};

const STORE_SEALED = makeDdrSealedPublicPrediction({
  id: 77,
  incidentKey: "ddr:usdc:below",
  eventId: 42,
  assessmentId: 101,
  predictionPolicyVersion: "ddr-policy-v1",
  predictionMethodologyVersion: "v4.0",
  eligibleAt: 1_700_086_400,
  lockedAt: 1_700_086_500,
  eventAgeAtLockSec: 86_500,
  lockTrigger: "forecast_readiness",
  forecastReadinessScore: 0.9,
  forecastReadinessVersion: "v1",
  readinessThreshold: 0.8,
});

const STORE_MANIFEST = makeDdrPublicationManifest({
  snapshotToken: "snapshot-1",
  snapshotGeneration: 4,
  snapshotSequence: 8,
  publishedAt: 1_800_000_000,
  publicPredictionIds: [77],
});

function sealInput(tier: "recovery_likely" | "insufficient_signal"): DdrSealInput {
  const row = tier === "insufficient_signal"
    ? makeDdrResolverRow({
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
          ageStatus: null,
          horizons: [],
        },
      })
    : makeDdrResolverRow();
  const lockedAt = 1_700_086_500;
  const prediction: DdrSealInput["sealedPayload"]["prediction"] = {
    incidentKey: "ddr:usdc:below",
    eligibleAt: 1_700_086_400,
    lockedAt,
    eventAgeAtLockSec: 86_500,
    lockTiming: "on_time",
    lockTrigger: "forecast_readiness",
    policyDelaySec: 86_400,
    predictionPolicyVersion: "ddr-policy-v1",
    predictionMethodologyVersion: "v4.0",
    predictionMethodologyVersionLabel: "v4.0",
    resolutionRubricVersion: "resolution-rubric-v2",
    durationModelVersion: "duration-landmark-v2",
    incidentGroupingVersion: "incident-group-v2",
    supportRulesVersion: "support-rules-v2",
  };
  const basePayload = {
    eventId: 42,
    incidentKey: "ddr:usdc:below",
    stablecoinId: "usdc-circle",
    symbol: row.symbol,
    name: row.name,
    pegCurrency: "USD",
    governance: row.governance,
    status: row.status,
    direction: "below" as const,
    startedAt: 1_700_000_000,
    prediction,
  };
  const sealedPayload: DdrSealInput["sealedPayload"] = tier === "insufficient_signal"
    ? {
        ...basePayload,
        kind: "no_call",
        noCall: {
          lockedAt,
          eventAgeAtLockSec: 86_500,
          missingReasons: row.resolution.insufficientReasons ?? [],
          relatedContext: row.relatedContext,
        },
        frozen: null,
      }
    : {
        ...basePayload,
        kind: "prediction",
        frozen: {
          resolution: row.resolution,
          duration: {
            ...row.duration,
            remainingAsOf: lockedAt,
            medianResolveAt: lockedAt + 3600,
            iqrResolveAt: [lockedAt + 1800, lockedAt + 7200],
            horizons: row.duration.horizons.map((cell) => ({
              ...cell,
              horizonEndAt: lockedAt + ({ "6h": 21600, "24h": 86400, "7d": 604800, "30d": 2592000 } as const)[cell.horizon],
              anchoredLabel: `within ${cell.horizon} of lock`,
            })),
          },
          relatedContext: row.relatedContext,
          sourceRow: row,
        },
      };
  return {
    incidentKey: "ddr:usdc:below",
    eventId: 42,
    identity: {
      stablecoinId: "usdc-circle",
      pegCurrency: "USD",
      direction: "below",
      startedAt: 1_700_000_000,
    },
    runId: "run-1",
    lockedAt,
    eligibleAt: 1_700_086_400,
    eventAgeAtLockSec: 86_500,
    lockTiming: "on_time",
    predictionPolicyVersion: "ddr-policy-v1",
    policyDelaySec: 86_400,
    lockTrigger: "forecast_readiness",
    methodologyVersion: "v4.0",
    methodologyVersionLabel: "v4.0",
    resolutionRubricVersion: "resolution-rubric-v2",
    durationModelVersion: "duration-landmark-v2",
    incidentGroupingVersion: "incident-group-v2",
    supportRulesVersion: "support-rules-v2",
    row,
    sealedPayload,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  stores.closeRecoveredPreLockIncidents.mockResolvedValue(2);
  stores.ensureCanonicalIncidents.mockResolvedValue([STORE_INCIDENT]);
  stores.loadCanonicalIncidents.mockResolvedValue([STORE_INCIDENT]);
  stores.recordLockDeferral.mockResolvedValue(undefined);
  stores.recordLockOpportunity.mockResolvedValue(undefined);
  stores.loadFirstPublicationMembership.mockResolvedValue([]);
  stores.loadLatestPublicationManifest.mockResolvedValue(null);
  stores.loadPredictionErrata.mockResolvedValue([]);
  stores.loadSealedPublicPredictions.mockResolvedValue([STORE_SEALED]);
  stores.writePublicationManifest.mockResolvedValue(STORE_MANIFEST);
});

describe("DDR storage adapters", () => {
  it("indexes sealed and first-publication rows by their public identities", () => {
    const sealed = [
      { incidentKey: "first", id: 1 },
      { incidentKey: "second", id: 2 },
    ] as DdrSealedPublicPrediction[];
    const memberships = [
      { publicPredictionId: 2 },
    ] as DdrFirstPublicationMembership[];

    expect([...sealedByIncident(sealed).keys()]).toEqual(["first", "second"]);
    expect([...firstPublicationByPredictionId(memberships).keys()]).toEqual([2]);
  });

  it.each([
    ["A".repeat(64), "a".repeat(64)],
    [`  ${"B".repeat(64)}  `, "b".repeat(64)],
    ["not-a-fingerprint", null],
    ["", null],
    [null, null],
  ])("normalizes incident fingerprint %s and preserves the durable contract and defaults", async (sourceFingerprint, normalized) => {
    const event = {
      eventId: 42,
      stablecoinId: "usdc-circle",
      pegCurrency: "USD",
      direction: "below",
      startedAt: 1_700_000_000,
      endedAt: null,
      peakDeviationBps: -150,
      source: "live",
      sourceFingerprint,
      publicTrackedAtFirstSeen: true,
      psiOffCatalogAtFirstSeen: false,
      registrySnapshot: { tracked: true },
    } as const;
    const options = {
      runId: "run-1",
      runAt: 1_700_000_100,
      predictionPolicyVersion: "ddr-policy-v1",
      policyDelaySec: 86_400,
      policyEffectiveAt: 1_600_000_000,
    };

    const incidents = [STORE_INCIDENT];
    stores.ensureCanonicalIncidents.mockResolvedValueOnce(incidents);
    stores.loadCanonicalIncidents.mockResolvedValueOnce(incidents);
    await expect(DEFAULT_DDR_V2_STORE_CONTRACTS.ensureCanonicalIncidents(db, [event], options)).resolves.toBe(incidents);
    expect(stores.ensureCanonicalIncidents).toHaveBeenCalledWith(db, [{
      ...event,
      sourceFingerprint: normalized,
    }], { ...options, createdBy: "ddr-worker" });
    expect(event.sourceFingerprint).toBe(sourceFingerprint);
    await expect(DEFAULT_DDR_V2_STORE_CONTRACTS.loadCanonicalIncidents(db, {})).resolves.toBe(incidents);
    expect(stores.loadCanonicalIncidents.mock.calls[0]?.[1].policyDelaySec).toBe(72 * 3600);
    await DEFAULT_DDR_V2_STORE_CONTRACTS.loadCanonicalIncidents(db, { policyDelaySec: 86_400 });
    expect(stores.loadCanonicalIncidents.mock.calls[1]?.[1].policyDelaySec).toBe(86_400);
    await expect(DEFAULT_DDR_V2_STORE_CONTRACTS.closeRecoveredPreLockIncidents?.(db, { nowSec: 10 })).resolves.toBe(2);
  });

  it("routes deferred and terminal lock records to their owning stores", async () => {
    const base = {
      incidentKey: "ddr:usdc:below",
      eventId: 42,
      runId: "run-1",
      runAt: 100,
      eligibleAt: 90,
      predictionPolicyVersion: "ddr-policy-v1",
      healthStatus: "healthy",
      reason: "waiting",
    } as const;

    await DEFAULT_DDR_V2_STORE_CONTRACTS.recordLockDeferral(db, { ...base, action: "deferred" });
    await DEFAULT_DDR_V2_STORE_CONTRACTS.recordLockDeferral(db, {
      ...base, action: "published", confirmationAt: 95, outcomeAt: 100,
    });

    expect(stores.recordLockDeferral).toHaveBeenCalledOnce();
    expect(stores.recordLockOpportunity).toHaveBeenCalledOnce();
    expect(stores.recordLockDeferral.mock.calls[0]?.[1]).toMatchObject({
      action: "deferred", createdAt: 100, lockTrigger: null, forecastReadinessScore: null,
      forecastReadinessVersion: null, readinessThreshold: null, backstopAt: null, backstopDelaySec: null,
    });
    expect(stores.recordLockOpportunity.mock.calls[0]?.[1]).toMatchObject({
      action: "published", createdAt: 100, confirmationAt: 95, outcomeAt: 100,
    });
  });

  it("seals predictions and no-calls with mapped inputs and canonical row hashes", async () => {
    const predictionInput = sealInput("recovery_likely");
    const predictionHash = computeDdrPublicRowHash(predictionInput.sealedPayload);
    const predictionPayload = {
      ...predictionInput.sealedPayload,
      prediction: {
        ...(predictionInput.sealedPayload.prediction as Record<string, unknown>),
        rowHash: predictionHash,
      },
    };
    const predictionResult = {
      ...STORE_SEALED,
      rowHash: predictionHash,
      sealedPayload: predictionPayload,
      sealedPayloadJson: JSON.stringify(predictionPayload),
    };
    stores.sealPublicPrediction.mockResolvedValueOnce(predictionResult);

    await expect(
      DEFAULT_DDR_V2_STORE_CONTRACTS.sealPublicPrediction(db, predictionInput),
    ).resolves.toBe(predictionResult);
    expect(stores.sealPublicPrediction).toHaveBeenCalledWith(db, expect.objectContaining({
      incidentKey: predictionInput.incidentKey,
      eventId: predictionInput.eventId,
      stablecoinId: predictionInput.identity.stablecoinId,
      pegCurrency: predictionInput.identity.pegCurrency,
      direction: predictionInput.identity.direction,
      startedAt: predictionInput.identity.startedAt,
      symbol: predictionInput.row.symbol,
      name: predictionInput.row.name,
      governance: predictionInput.row.governance,
      resolutionTier: predictionInput.row.resolution.tier,
      durationSuppressed: predictionInput.row.duration.suppressed,
      horizons: predictionInput.row.duration.horizons,
      factors: predictionInput.row.resolution.factors,
      sealedPayload: predictionPayload,
      rowHash: predictionHash,
      runId: predictionInput.runId,
      createdAt: predictionInput.lockedAt,
      forecastReadinessScore: null,
      forecastReadinessVersion: null,
      readinessThreshold: null,
      backstopAt: null,
      backstopDelaySec: null,
    }));

    const noCallInput = sealInput("insufficient_signal");
    const noCallHash = computeDdrPublicRowHash(noCallInput.sealedPayload);
    const noCallPayload = {
      ...noCallInput.sealedPayload,
      prediction: {
        ...(noCallInput.sealedPayload.prediction as Record<string, unknown>),
        rowHash: noCallHash,
      },
    };
    const noCallResult = {
      ...STORE_SEALED,
      outcomeKind: "no_call",
      rowHash: noCallHash,
      sealedPayload: noCallPayload,
      sealedPayloadJson: JSON.stringify(noCallPayload),
    };
    stores.sealPublicNoCall.mockResolvedValueOnce(noCallResult);

    await expect(
      DEFAULT_DDR_V2_STORE_CONTRACTS.sealPublicNoCall(db, noCallInput),
    ).resolves.toBe(noCallResult);
    expect(stores.sealPublicNoCall).toHaveBeenCalledWith(db, expect.objectContaining({
      resolutionTier: "insufficient_signal",
      sealedPayload: noCallPayload,
      rowHash: computeDdrPublicRowHash(noCallInput.sealedPayload),
    }));
  });

  it("forwards publication, membership, manifest, and errata contracts without copying", async () => {
    stores.loadFirstPublicationMembership.mockResolvedValue([{
      publicPredictionId: 77,
      incidentKey: "ddr:usdc:below",
      snapshotToken: "snapshot-1",
      snapshotGeneration: 4,
      publishedAt: 1_800_000_000,
    }]);
    stores.loadPredictionErrata.mockResolvedValue([{
      id: 9,
      state: "invalidated",
      publicPredictionId: 77,
      incidentKey: "ddr:usdc:below",
      eventId: 42,
      assessmentId: 101,
      reason: "input_corruption",
      operatorNote: "bad input",
      replacementAssessmentId: null,
      replacementRowHash: null,
      rowHashBefore: "a".repeat(64),
      createdAt: 1_800_000_000,
      createdBy: "operator",
    }]);

    const sealed = [STORE_SEALED];
    const memberships = await stores.loadFirstPublicationMembership();
    const errata = await stores.loadPredictionErrata();
    stores.loadSealedPublicPredictions.mockResolvedValueOnce(sealed);
    await expect(DEFAULT_DDR_V2_STORE_CONTRACTS.loadSealedPublicPredictions(db, {})).resolves.toBe(sealed);
    await expect(DEFAULT_DDR_V2_STORE_CONTRACTS.loadFirstPublicationMembership(db, {})).resolves.toBe(memberships);
    await expect(DEFAULT_DDR_V2_STORE_CONTRACTS.writePublicationManifest(db, {
      publishedAt: 1_800_000_000,
      snapshotGeneration: 4,
      basePayload: { rows: [] },
      publicPredictionIds: [77],
      publicPredictionRowHashes: { 77: "a".repeat(64) },
    })).resolves.toBe(STORE_MANIFEST);
    expect(stores.writePublicationManifest).toHaveBeenCalledWith(db, {
      publishedAt: 1_800_000_000,
      createdAt: 1_800_000_000,
      validatorVersion: "ddr-worker-v2",
      snapshotGeneration: 4,
      basePayload: { rows: [] },
      publicPredictionIds: [77],
      publicPredictionRowHashes: { 77: "a".repeat(64) },
    });
    stores.loadLatestPublicationManifest.mockResolvedValueOnce(STORE_MANIFEST);
    await expect(DEFAULT_DDR_V2_STORE_CONTRACTS.loadLatestPublicationManifest?.(db)).resolves.toBe(STORE_MANIFEST);
    await expect(DEFAULT_DDR_V2_STORE_CONTRACTS.loadLatestPublicationManifest?.(db)).resolves.toBeNull();
    await expect(DEFAULT_DDR_V2_STORE_CONTRACTS.loadPredictionErrata?.(db, {})).resolves.toBe(errata);
  });

});

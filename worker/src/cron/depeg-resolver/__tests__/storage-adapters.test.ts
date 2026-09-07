import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DdrFirstPublicationMembership, DdrSealedPublicPrediction } from "../../depeg-resolver-v2-contracts";

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
  publicPredictionIdOf,
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

const STORE_SEALED = {
  id: 77,
  publicPredictionId: 77,
  incidentKey: "ddr:usdc:below",
  eventId: 42,
  assessmentId: 101,
  outcomeKind: "prediction",
  predictionPolicyVersion: "ddr-policy-v1",
  predictionMethodologyVersion: "v4.0",
  policyDelaySec: 86_400,
  eligibleAt: 1_700_086_400,
  lockedAt: 1_700_086_500,
  eventAgeAtLockSec: 86_500,
  lockTiming: "on_time",
  lockTrigger: "readiness",
  forecastReadinessScore: 0.9,
  forecastReadinessVersion: "v1",
  readinessThreshold: 0.8,
  backstopAt: null,
  backstopDelaySec: null,
  rowHash: "a".repeat(64),
  sealedPayload: { kind: "prediction" },
  sealedPayloadJson: JSON.stringify({ kind: "prediction" }),
};

const STORE_MANIFEST = {
  snapshotToken: "snapshot-1",
  snapshotGeneration: 4,
  snapshotSequence: 8,
  publishedAt: 1_800_000_000,
  basePayloadHash: "b".repeat(64),
  publicPredictionIds: [77],
};

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
    const legacy = { id: 5 } as DdrSealedPublicPrediction;
    const current = { id: 6, publicPredictionId: 60 } as DdrSealedPublicPrediction;
    const sealed = [
      { incidentKey: "first", id: 1 },
      { incidentKey: "second", id: 2 },
    ] as DdrSealedPublicPrediction[];
    const memberships = [
      { publicPredictionId: 1, firstPublished: false },
      { publicPredictionId: 2, firstPublished: true },
    ] as DdrFirstPublicationMembership[];

    expect(publicPredictionIdOf(legacy)).toBe(5);
    expect(publicPredictionIdOf(current)).toBe(60);
    expect([...sealedByIncident(sealed).keys()]).toEqual(["first", "second"]);
    expect([...firstPublicationByPredictionId(memberships).keys()]).toEqual([2]);
  });

  it("normalizes incident input and maps the durable incident contract", async () => {
    const event = {
      eventId: 42,
      stablecoinId: "usdc-circle",
      symbol: "USDC",
      pegCurrency: "USD",
      direction: "below",
      startedAt: 1_700_000_000,
      endedAt: null,
      recoveryPrice: null,
      peakDeviationBps: -150,
      source: "live",
      sourceFingerprint: "A".repeat(64),
      rolloutActiveAtEnablement: false,
      publicTrackedAtFirstSeen: true,
      psiShadowAtFirstSeen: false,
      predictionPolicyVersion: "ddr-policy-v1",
      policyDelaySec: 86_400,
      policyEffectiveAt: 1_600_000_000,
      registrySnapshot: { tracked: true },
    } as const;
    const options = {
      runId: "run-1",
      runAt: 1_700_000_100,
      predictionPolicyVersion: "ddr-policy-v1",
      policyDelaySec: 86_400,
      policyEffectiveAt: 1_600_000_000,
    };

    await expect(DEFAULT_DDR_V2_STORE_CONTRACTS.ensureCanonicalIncidents(db, [event], options)).resolves.toEqual([
      expect.objectContaining({ incidentKey: "ddr:usdc:below", currentEventId: 42 }),
    ]);
    expect(stores.ensureCanonicalIncidents.mock.calls[0]?.[1][0]?.sourceFingerprint).toBe("a".repeat(64));
    expect(stores.ensureCanonicalIncidents.mock.calls[0]?.[2]).toMatchObject({ createdBy: "ddr-worker" });

    await expect(DEFAULT_DDR_V2_STORE_CONTRACTS.loadCanonicalIncidents(db, {})).resolves.toEqual([
      expect.objectContaining({ stablecoinId: "usdc-circle", lockState: null }),
    ]);
    expect(stores.loadCanonicalIncidents.mock.calls[0]?.[1].policyDelaySec).toBe(72 * 3600);
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
      syncCapabilities: {},
    } as const;

    await DEFAULT_DDR_V2_STORE_CONTRACTS.recordLockDeferral(db, { ...base, action: "deferred" });
    await DEFAULT_DDR_V2_STORE_CONTRACTS.recordLockDeferral(db, { ...base, action: "published" });

    expect(stores.recordLockDeferral).toHaveBeenCalledOnce();
    expect(stores.recordLockOpportunity).toHaveBeenCalledOnce();
    expect(stores.recordLockOpportunity.mock.calls[0]?.[1]).toMatchObject({ action: "published", createdAt: 100 });
  });

  it("maps publication, membership, manifest, and errata reads", async () => {
    stores.loadFirstPublicationMembership.mockResolvedValue([{
      publicPredictionId: 77,
      incidentKey: "ddr:usdc:below",
      snapshotToken: "snapshot-1",
      snapshotGeneration: 4,
      publishedAt: 1_800_000_000,
      firstPublished: true,
    }]);
    stores.loadPredictionErrata.mockResolvedValue([{
      id: 9,
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

    await expect(DEFAULT_DDR_V2_STORE_CONTRACTS.loadSealedPublicPredictions(db, {})).resolves.toEqual([
      expect.objectContaining({ id: 77, publicPredictionId: 77, sealedPayload: { kind: "prediction" } }),
    ]);
    await expect(DEFAULT_DDR_V2_STORE_CONTRACTS.loadFirstPublicationMembership(db, {})).resolves.toEqual([
      expect.objectContaining({ publicPredictionId: 77, firstPublished: true }),
    ]);
    await expect(DEFAULT_DDR_V2_STORE_CONTRACTS.writePublicationManifest(db, {
      runId: "run-1",
      publishedAt: 1_800_000_000,
      snapshotKind: "ddr_public",
      snapshotGeneration: 4,
      basePayload: { rows: [] },
      activeIncidentKeys: [],
      publicPredictionIds: [77],
      publicPredictionRowHashes: { 77: "a".repeat(64) },
    })).resolves.toEqual(expect.objectContaining({ snapshotToken: "snapshot-1", firstPublishedPublicPredictionIds: [77] }));
    stores.loadLatestPublicationManifest.mockResolvedValueOnce(STORE_MANIFEST);
    await expect(DEFAULT_DDR_V2_STORE_CONTRACTS.loadLatestPublicationManifest?.(db)).resolves.toEqual(
      expect.objectContaining({ snapshotSequence: 8 }),
    );
    await expect(DEFAULT_DDR_V2_STORE_CONTRACTS.loadLatestPublicationManifest?.(db)).resolves.toBeNull();
    await expect(DEFAULT_DDR_V2_STORE_CONTRACTS.loadPredictionErrata?.(db, {})).resolves.toEqual([
      expect.objectContaining({ id: 9, reason: "input_corruption" }),
    ]);
  });

  it.each([
    [null, null, "missing"],
    [null, "{", "malformed_json"],
    [null, "[]", "non_object"],
  ] as const)("fails closed for %s sealed payloads", async (sealedPayload, sealedPayloadJson, kind) => {
    stores.loadSealedPublicPredictions.mockResolvedValueOnce([{
      ...STORE_SEALED,
      sealedPayload,
      sealedPayloadJson,
    }]);

    await expect(DEFAULT_DDR_V2_STORE_CONTRACTS.loadSealedPublicPredictions(db, {})).rejects.toMatchObject({
      name: "DdrStorageJsonDecodeError",
      failure: { kind },
    });
  });

  it("decodes the persisted sealed JSON when no materialized payload is present", async () => {
    stores.loadSealedPublicPredictions.mockResolvedValueOnce([{
      ...STORE_SEALED,
      sealedPayload: null,
      sealedPayloadJson: JSON.stringify({ kind: "prediction", restored: true }),
    }]);

    await expect(DEFAULT_DDR_V2_STORE_CONTRACTS.loadSealedPublicPredictions(db, {})).resolves.toEqual([
      expect.objectContaining({ sealedPayload: { kind: "prediction", restored: true } }),
    ]);
  });
});

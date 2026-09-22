import {
  DDR_PREDICTION_POLICY_VERSION,
  DDR_SNAPSHOT_CACHE_GENERATION,
  DDR_VERSION_STAMP,
} from "@shared/lib/methodology-versions/depeg-resolver";
import {
  buildForecastReadinessBackstop,
  evaluateForecastReadinessLock,
  forecastReadinessScore,
} from "@shared/lib/depeg-resolver/forecast-readiness";
import type {
  DdrPredictionErratum,
  DdrRow,
} from "@shared/types/depeg-resolver";
import {
  type DdrCanonicalIncident,
  type DdrFirstPublicationMembership,
  type DdrPublicationManifest,
  type DdrSealedPublicPrediction,
  type DdrSealInput,
  type DdrV2StoreContracts,
} from "../depeg-resolver-v2-contracts";
import type { DdrDiagnosticResponse, DdrEventDbRow } from "./types";
import { computeLockTiming } from "./incident-state";
import { buildSealPayload, buildV2PublicationBasePayload, normalizeErratumRecord } from "./public-projection";
import {
  firstPublicationByPredictionId,
  publicPredictionIdOf,
  sealedByIncident,
} from "./storage-adapters";
import { formatDdrrFailure, publicationSnapshotToken } from "./utils";

export async function loadSealedAndPublicationState(input: {
  stores: DdrV2StoreContracts;
  db: D1Database;
  incidentKeys: string[];
}): Promise<{
  sealed: DdrSealedPublicPrediction[];
  firstPublication: DdrFirstPublicationMembership[];
}> {
  if (input.incidentKeys.length === 0) {
    return { sealed: [], firstPublication: [] };
  }
  const sealed = await input.stores.loadSealedPublicPredictions(input.db, {
    incidentKeys: input.incidentKeys,
  });
  const firstPublication = await input.stores.loadFirstPublicationMembership(input.db, {
    incidentKeys: input.incidentKeys,
  });
  return { sealed, firstPublication };
}

export async function sealEligibleLocks(input: {
  stores: DdrV2StoreContracts;
  db: D1Database;
  rows: DdrRow[];
  activeEventById: Map<number, DdrEventDbRow>;
  incidentsByEventId: Map<number, DdrCanonicalIncident>;
  existingSealed: DdrSealedPublicPrediction[];
  nowSec: number;
  ddrRunId: string;
  runAt: number;
  syncCapabilities: Record<string, unknown>;
}): Promise<{ sealed: DdrSealedPublicPrediction[]; lockedCount: number; noCallCount: number; pendingCount: number }> {
  const sealed = [...input.existingSealed];
  const sealedByKey = sealedByIncident(sealed);
  let lockedCount = 0;
  let noCallCount = 0;
  let pendingCount = 0;

  for (const row of input.rows) {
    const sourceEvent = input.activeEventById.get(row.eventId);
    if (!sourceEvent) continue;
    const incident = input.incidentsByEventId.get(row.eventId);
    if (!incident?.policyUniverseIncluded) continue;

    if (sealedByKey.has(incident.incidentKey)) continue;

    const readiness = forecastReadinessScore(row);
    const backstop = buildForecastReadinessBackstop({ startedAt: row.startedAt, nowSec: input.nowSec });
    const lockDecision = evaluateForecastReadinessLock({
      startedAt: row.startedAt,
      nowSec: input.nowSec,
      readiness,
      backstop,
    });
    if (!lockDecision.eligible) {
      await input.stores.recordLockDeferral(input.db, {
        incidentKey: incident.incidentKey,
        eventId: row.eventId,
        runId: input.ddrRunId,
        runAt: input.runAt,
        eligibleAt: lockDecision.eligibleAt,
        predictionPolicyVersion: DDR_PREDICTION_POLICY_VERSION,
        healthStatus: "healthy",
        action: "pending",
        reason: null,
        syncCapabilities: input.syncCapabilities,
        lockTrigger: null,
        forecastReadinessScore: readiness.score,
        forecastReadinessVersion: readiness.version,
        readinessThreshold: readiness.threshold,
        backstopAt: backstop.backstopAt ?? null,
        backstopDelaySec: backstop.delaySec,
      });
      pendingCount += 1;
      continue;
    }

    const lock = { ...lockDecision, readiness, backstop };

    const lockTiming = computeLockTiming(incident, input.nowSec, lock.eligibleAt);
    const sealedPayload = buildSealPayload(row, incident, input.nowSec, lockTiming, lock);
    const eventAgeAtLockSec = input.nowSec - incident.startedAt;
    const sealInput: DdrSealInput = {
      incidentKey: incident.incidentKey,
      eventId: row.eventId,
      identity: {
        stablecoinId: incident.stablecoinId,
        pegCurrency: incident.pegCurrency,
        direction: incident.direction,
        startedAt: incident.startedAt,
      },
      runId: input.ddrRunId,
      lockedAt: input.nowSec,
      eligibleAt: lock.eligibleAt,
      eventAgeAtLockSec,
      lockTiming,
      policyDelaySec: lock.policyDelaySec,
      lockTrigger: lock.lockTrigger,
      forecastReadinessScore: lock.readiness.score,
      forecastReadinessVersion: lock.readiness.version,
      readinessThreshold: lock.readiness.threshold,
      backstopAt: lock.backstop.backstopAt ?? null,
      backstopDelaySec: lock.backstop.delaySec,
      ...DDR_VERSION_STAMP,
      row,
      sealedPayload,
    };
    const created = row.resolution.tier === "insufficient_signal"
      ? await input.stores.sealPublicNoCall(input.db, sealInput)
      : await input.stores.sealPublicPrediction(input.db, sealInput);
    sealed.push(created);
    sealedByKey.set(created.incidentKey, created);
    if (created.outcomeKind === "no_call") noCallCount += 1;
    else lockedCount += 1;
  }

  return { sealed, lockedCount, noCallCount, pendingCount };
}

export async function loadErrataForSealedPredictions(input: {
  stores: DdrV2StoreContracts;
  db: D1Database;
  sealed: DdrSealedPublicPrediction[];
}): Promise<{ errata: DdrPredictionErratum[]; error: string | null }> {
  if (!input.stores.loadPredictionErrata || input.sealed.length === 0) return { errata: [], error: null };
  try {
    const rows = await input.stores.loadPredictionErrata(input.db, {
      publicPredictionIds: input.sealed.map(publicPredictionIdOf),
      incidentKeys: input.sealed.map((sealed) => sealed.incidentKey),
    });
    return {
      errata: rows.map(normalizeErratumRecord).filter((row): row is DdrPredictionErratum => row != null),
      error: null,
    };
  } catch (error) {
    return { errata: [], error: formatDdrrFailure(error) };
  }
}

export async function writePublicationBeforeCache(input: {
  stores: DdrV2StoreContracts;
  db: D1Database;
  snapshot: DdrDiagnosticResponse;
  incidentsByEventId: Map<number, DdrCanonicalIncident>;
  sealed: DdrSealedPublicPrediction[];
  firstPublication: DdrFirstPublicationMembership[];
  errata: DdrPredictionErratum[];
  ddrRunId: string;
  nowSec: number;
}): Promise<{
  attempted: boolean;
  ok: boolean;
  manifest: DdrPublicationManifest | null;
  firstPublication: DdrFirstPublicationMembership[];
  error: string | null;
}> {
  const snapshotToken = publicationSnapshotToken(input.ddrRunId, input.nowSec);
  const existingFirstPublication = firstPublicationByPredictionId(input.firstPublication);
  const retryPendingSealed = input.sealed.filter((sealed) => !existingFirstPublication.has(publicPredictionIdOf(sealed)));
  const firstPublication = [
    ...input.firstPublication,
    ...retryPendingSealed.map((sealed): DdrFirstPublicationMembership => ({
      publicPredictionId: publicPredictionIdOf(sealed),
      incidentKey: sealed.incidentKey,
      snapshotToken,
      snapshotGeneration: DDR_SNAPSHOT_CACHE_GENERATION,
      publishedAt: input.nowSec,
    })),
  ];
  const basePayload = buildV2PublicationBasePayload({
    snapshot: input.snapshot,
    incidentsByEventId: input.incidentsByEventId,
    sealed: input.sealed,
    firstPublication,
    errata: input.errata,
    snapshotToken,
    nowSec: input.nowSec,
  });
  const publicPredictionIds = input.sealed.map(publicPredictionIdOf).sort((a, b) => a - b);
  const publicPredictionRowHashes = Object.fromEntries(
    input.sealed.map((sealed) => [String(publicPredictionIdOf(sealed)), sealed.rowHash]).sort(([a], [b]) => a.localeCompare(b)),
  );
  try {
    const manifest = await input.stores.writePublicationManifest(input.db, {
      snapshotToken,
      publishedAt: input.nowSec,
      snapshotGeneration: DDR_SNAPSHOT_CACHE_GENERATION,
      basePayload,
      publicPredictionIds,
      publicPredictionRowHashes,
    });
    return { attempted: true, ok: true, manifest, firstPublication, error: null };
  } catch (error) {
    for (const sealed of retryPendingSealed) {
      await input.stores.recordLockDeferral(input.db, {
        incidentKey: sealed.incidentKey,
        eventId: sealed.eventId,
        runId: input.ddrRunId,
        runAt: input.nowSec,
        eligibleAt: sealed.eligibleAt,
        predictionPolicyVersion: DDR_PREDICTION_POLICY_VERSION,
        healthStatus: "healthy",
        action: "publication_retry_pending",
        reason: formatDdrrFailure(error),
        syncCapabilities: {},
        lockTrigger: sealed.lockTrigger ?? null,
        forecastReadinessScore: sealed.forecastReadinessScore ?? null,
        forecastReadinessVersion: sealed.forecastReadinessVersion ?? null,
        readinessThreshold: sealed.readinessThreshold ?? null,
        backstopAt: sealed.backstopAt ?? null,
        backstopDelaySec: sealed.backstopDelaySec ?? null,
      });
    }
    return { attempted: true, ok: false, manifest: null, firstPublication: input.firstPublication, error: formatDdrrFailure(error) };
  }
}

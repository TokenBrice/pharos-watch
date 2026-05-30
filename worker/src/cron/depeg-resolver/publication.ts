import {
  DDR_PREDICTION_POLICY_VERSION,
  DDR_PUBLIC_PREDICTION_DELAY_SEC,
  DDR_SNAPSHOT_CACHE_GENERATION,
} from "@shared/lib/depeg-resolver-version";
import type { DdrPredictionErratum, DdrRow } from "@shared/types/depeg-resolver";
import {
  DDR_PUBLICATION_SNAPSHOT_KIND,
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
import { fallbackIncidentForEvent, formatDdrrFailure, publicationSnapshotToken } from "./utils";
import {
  DDR_DURATION_MODEL_VERSION,
  DDR_INCIDENT_GROUPING_VERSION,
  DDR_METHODOLOGY_VERSION,
  DDR_METHODOLOGY_VERSION_LABEL,
  DDR_RESOLUTION_RUBRIC_VERSION,
  DDR_SUPPORT_RULES_VERSION,
} from "@shared/lib/depeg-resolver-version";

export async function loadSealedAndPublicationState(input: {
  stores: DdrV2StoreContracts | null | undefined;
  db: D1Database;
  incidentKeys: string[];
}): Promise<{
  sealed: DdrSealedPublicPrediction[];
  firstPublication: DdrFirstPublicationMembership[];
}> {
  if (!input.stores || input.incidentKeys.length === 0) {
    return { sealed: [], firstPublication: [] };
  }
  const sealed = await input.stores.loadSealedPublicPredictions(input.db, {
    incidentKeys: input.incidentKeys,
    predictionPolicyVersion: DDR_PREDICTION_POLICY_VERSION,
    includeUnpublished: true,
  });
  const firstPublication = await input.stores.loadFirstPublicationMembership(input.db, {
    incidentKeys: input.incidentKeys,
    predictionPolicyVersion: DDR_PREDICTION_POLICY_VERSION,
  });
  return { sealed, firstPublication };
}

export async function sealEligibleLocks(input: {
  stores: DdrV2StoreContracts | null | undefined;
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
  if (!input.stores) return { sealed: input.existingSealed, lockedCount: 0, noCallCount: 0, pendingCount: 0 };

  const sealed = [...input.existingSealed];
  const sealedByKey = sealedByIncident(sealed);
  let lockedCount = 0;
  let noCallCount = 0;
  let pendingCount = 0;

  for (const row of input.rows) {
    const sourceEvent = input.activeEventById.get(row.eventId);
    if (!sourceEvent) continue;
    const incident = input.incidentsByEventId.get(row.eventId) ?? fallbackIncidentForEvent(sourceEvent);
    if (!incident.policyUniverseIncluded) continue;

    if (input.nowSec < incident.eligibleAt) {
      await input.stores.recordLockDeferral(input.db, {
        incidentKey: incident.incidentKey,
        eventId: row.eventId,
        runId: input.ddrRunId,
        runAt: input.runAt,
        eligibleAt: incident.eligibleAt,
        predictionPolicyVersion: DDR_PREDICTION_POLICY_VERSION,
        healthStatus: "healthy",
        action: "pending",
        reason: null,
        syncCapabilities: input.syncCapabilities,
      });
      pendingCount += 1;
      continue;
    }

    if (sealedByKey.has(incident.incidentKey)) continue;

    const lockTiming = computeLockTiming(incident, input.nowSec);
    const sealedPayload = buildSealPayload(row, incident, input.nowSec, lockTiming);
    const sealInput: DdrSealInput = {
      incidentKey: incident.incidentKey,
      eventId: row.eventId,
      runId: input.ddrRunId,
      lockedAt: input.nowSec,
      eligibleAt: incident.eligibleAt,
      eventAgeAtLockSec: input.nowSec - row.startedAt,
      lockTiming,
      predictionPolicyVersion: DDR_PREDICTION_POLICY_VERSION,
      policyDelaySec: DDR_PUBLIC_PREDICTION_DELAY_SEC,
      methodologyVersion: DDR_METHODOLOGY_VERSION,
      methodologyVersionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      resolutionRubricVersion: DDR_RESOLUTION_RUBRIC_VERSION,
      durationModelVersion: DDR_DURATION_MODEL_VERSION,
      incidentGroupingVersion: DDR_INCIDENT_GROUPING_VERSION,
      supportRulesVersion: DDR_SUPPORT_RULES_VERSION,
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
  stores: DdrV2StoreContracts | null | undefined;
  db: D1Database;
  sealed: DdrSealedPublicPrediction[];
}): Promise<{ errata: DdrPredictionErratum[]; error: string | null }> {
  if (!input.stores?.loadPredictionErrata || input.sealed.length === 0) return { errata: [], error: null };
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
  stores: DdrV2StoreContracts | null | undefined;
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
  if (!input.stores) {
    return { attempted: false, ok: true, manifest: null, firstPublication: input.firstPublication, error: null };
  }
  const activeIncidentKeys = [...new Set([...input.incidentsByEventId.values()].map((incident) => incident.incidentKey))];
  const snapshotToken = publicationSnapshotToken(input.ddrRunId, input.nowSec);
  const existingFirstPublication = firstPublicationByPredictionId(input.firstPublication);
  const firstPublication = [
    ...input.firstPublication,
    ...input.sealed
      .filter((sealed) => !existingFirstPublication.has(publicPredictionIdOf(sealed)))
      .map((sealed): DdrFirstPublicationMembership => ({
        publicPredictionId: publicPredictionIdOf(sealed),
        incidentKey: sealed.incidentKey,
        snapshotToken,
        snapshotGeneration: DDR_SNAPSHOT_CACHE_GENERATION,
        publishedAt: input.nowSec,
        firstPublished: true,
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
      runId: input.ddrRunId,
      snapshotToken,
      publishedAt: input.nowSec,
      snapshotKind: DDR_PUBLICATION_SNAPSHOT_KIND,
      snapshotGeneration: DDR_SNAPSHOT_CACHE_GENERATION,
      basePayload,
      activeIncidentKeys,
      publicPredictionIds,
      publicPredictionRowHashes,
    });
    return { attempted: true, ok: true, manifest, firstPublication, error: null };
  } catch (error) {
    for (const sealed of input.sealed) {
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
      });
    }
    return { attempted: true, ok: false, manifest: null, firstPublication: input.firstPublication, error: formatDdrrFailure(error) };
  }
}

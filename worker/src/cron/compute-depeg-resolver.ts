import type { DdrResponse, DdrRow } from "@shared/types/depeg-resolver";
import type { CronResult } from "../lib/cron-logger";
import { loadDepegResolverSnapshot } from "../lib/depeg-resolver-snapshot-cache";
import {
  emptyDdrLineage,
  loadActiveConfirmedEvents,
  loadDdrContext,
  loadPolicyUniverseEvents,
} from "./depeg-resolver/context";
import {
  applyConfirmationTimes,
  ensureCanonicalIncidentsForEvents,
  loadPendingPromotionConfirmationTimes,
  recordConfirmedSeenOpportunities,
  recordSystemHealthDeferrals,
} from "./depeg-resolver/incident-state";
import { resolveDdrIncidents } from "./depeg-resolver/incident-resolution";
import { normalizeComputeOptions } from "./depeg-resolver/options";
import {
  persistDepegResolverReviewArtifacts,
  persistDepegResolverSnapshot,
} from "./depeg-resolver/persistence";
import {
  loadErrataForSealedPredictions,
  loadSealedAndPublicationState,
  sealEligibleLocks,
  writePublicationBeforeCache,
} from "./depeg-resolver/publication";
import {
  buildDdrResponse,
  buildDiagnosticSnapshot,
} from "./depeg-resolver/public-projection";
import { DDR_SNAPSHOT_TTL_SEC } from "./depeg-resolver/constants";
import type { ComputeDepegResolverV2Options, DdrLineage } from "./depeg-resolver/types";
import { abortIf } from "./depeg-resolver/utils";

export type { DdrV2StoreContracts } from "./depeg-resolver-v2-contracts";
export type { ComputeDepegResolverV2Options } from "./depeg-resolver/types";

function emptyDegradedPublicSnapshot(input: {
  nowSec: number;
  reason: string;
  lineage: DdrLineage;
  storageAvailable: boolean;
}): DdrResponse {
  const snapshot = buildDdrResponse({
    candidateRows: [],
    incidentsByEventId: new Map(),
    sealed: [],
    firstPublication: [],
    manifest: null,
    errata: [],
    lineage: input.lineage,
    nowSec: input.nowSec,
    storageAvailable: input.storageAvailable,
  });
  snapshot._meta.degraded = true;
  snapshot._meta.degradedReason = input.reason;
  return snapshot;
}

async function degradedPublicSnapshotFromCache(input: {
  db: D1Database;
  nowSec: number;
  reason: string;
  lineage: DdrLineage;
  storageAvailable: boolean;
}): Promise<DdrResponse> {
  let cached: Awaited<ReturnType<typeof loadDepegResolverSnapshot>>;
  try {
    cached = await loadDepegResolverSnapshot(input.db);
  } catch {
    return emptyDegradedPublicSnapshot(input);
  }
  if (cached.kind !== "ok") {
    return emptyDegradedPublicSnapshot(input);
  }

  return {
    ...cached.payload,
    _meta: {
      ...cached.payload._meta,
      computedAt: input.nowSec,
      expiresAt: input.nowSec + DDR_SNAPSHOT_TTL_SEC,
      degraded: true,
      degradedReason: input.reason,
    },
    rows: cached.payload.rows.map((row) => ({
      ...row,
      live: {
        ...row.live,
        stale: true,
        degradedReason: row.live.degradedReason ?? input.reason,
      },
    })),
  };
}

async function persistDegradedArtifacts(input: {
  db: D1Database;
  nowSec: number;
  reason: string;
  lineage: DdrLineage;
  signal?: AbortSignal;
  storeContracts: ComputeDepegResolverV2Options["storeContracts"];
}): Promise<{ reviewRows: number; reviewError: string | null }> {
  const publicSnapshot = await degradedPublicSnapshotFromCache({
    db: input.db,
    nowSec: input.nowSec,
    reason: input.reason,
    lineage: input.lineage,
    storageAvailable: input.storeContracts != null,
  });
  await persistDepegResolverSnapshot(input.db, publicSnapshot);

  const diagnosticSnapshot = buildDiagnosticSnapshot({ rows: [], lineage: input.lineage, nowSec: input.nowSec });
  const reviewArtifacts = await persistDepegResolverReviewArtifacts(
    input.db,
    diagnosticSnapshot,
    input.signal,
    input.storeContracts,
  );
  return {
    reviewRows: reviewArtifacts.reviewRows,
    reviewError: reviewArtifacts.reviewError,
  };
}

export async function computeDepegResolver(
  input: D1Database | ComputeDepegResolverV2Options,
  signal?: AbortSignal,
): Promise<CronResult> {
  const options = normalizeComputeOptions(input, signal);
  const { db, storeContracts } = options;
  abortIf(options.signal, "compute-depeg-resolver");
  const nowSec = options.runAt;

  const policyUniverseRows = await loadPolicyUniverseEvents(db);
  const loadedActiveRows = await loadActiveConfirmedEvents(db);
  const incidentRows = policyUniverseRows.length > 0 ? policyUniverseRows : loadedActiveRows;
  const { byEventId: incidentsByEventId, quarantined: quarantinedEvents } =
    await ensureCanonicalIncidentsForEvents(storeContracts, db, incidentRows, {
      ddrRunId: options.ddrRunId,
      runAt: options.runAt,
    });
  // Repair-required events are excluded from the run entirely so the rest of
  // the universe keeps resolving and publishing; each still needs its explicit
  // repair migration and is surfaced via degraded status + metadata below.
  const quarantinedEventIds = new Set(quarantinedEvents.map((entry) => entry.eventId));
  const activeRows = loadedActiveRows.filter((row) => !quarantinedEventIds.has(row.id));

  let rows: DdrRow[] = [];
  let lineage: DdrLineage = emptyDdrLineage(nowSec);
  let activeEventById = new Map(activeRows.map((row) => [row.id, row]));
  let assessmentWriteCount = 0;
  let reviewRows = 0;
  let reviewError: string | null = null;
  let v2LockDeferrals = 0;
  let v2PendingLocks = 0;
  let v2LockedPredictions = 0;
  let v2LockedNoCalls = 0;
  let v2ConfirmedSeen = 0;
  let v2ConfirmationTimingError: string | null = null;
  let v2ErrataLoadError: string | null = null;
  let v2PublicationAttempted = false;
  let v2PublicationSucceeded = false;
  let v2PublicationError: string | null = null;

  const degradedResult = async (degradedReason: string): Promise<CronResult> => {
    v2LockDeferrals = await recordSystemHealthDeferrals({
      stores: storeContracts,
      db,
      incidentsByEventId,
      activeRows,
      nowSec,
      ddrRunId: options.ddrRunId,
      runAt: options.runAt,
      syncCapabilities: options.syncCapabilities,
      reason: degradedReason,
    });
    const degradedArtifacts = await persistDegradedArtifacts({
      db,
      nowSec,
      reason: degradedReason,
      lineage,
      signal: options.signal,
      storeContracts,
    });
    return {
      itemCount: 0,
      metadata: JSON.stringify({
        ddrRunId: options.ddrRunId,
        activeEvents: activeRows.length,
        degraded: true,
        degradedReason,
        v2LockDeferrals,
        v2FreezeSkipped: true,
        v2PublicationAttempted: false,
        ddrrDegraded: degradedArtifacts.reviewError != null,
        ddrrDegradedReason: degradedArtifacts.reviewError,
        reviewRows: degradedArtifacts.reviewRows,
      }),
    };
  };

  const schedulerHealthFailures = [
    options.stablecoinsCacheSafe ? null : "stablecoins-cache-unsafe",
    options.depegPipelineHealthy ? null : "depeg-pipeline-unhealthy",
  ].filter((reason): reason is string => reason != null);
  if (schedulerHealthFailures.length > 0) {
    return degradedResult(schedulerHealthFailures.join(","));
  }

  const confirmationTiming = await loadPendingPromotionConfirmationTimes(db, activeRows);
  v2ConfirmationTimingError = confirmationTiming.error;
  applyConfirmationTimes(incidentsByEventId, confirmationTiming.byEventId);

  if (activeRows.length > 0) {
    abortIf(options.signal, "compute-depeg-resolver");
    const contextResult = await loadDdrContext(db, activeRows, nowSec);
    if (contextResult.kind === "degraded") {
      return degradedResult(contextResult.reason);
    }

    abortIf(options.signal, "compute-depeg-resolver");
    activeEventById = contextResult.context.activeEventById;
    lineage = contextResult.context.lineage;
    v2ConfirmedSeen = await recordConfirmedSeenOpportunities({
      stores: storeContracts,
      db,
      activeRows,
      incidentsByEventId,
      confirmedAtByEventId: confirmationTiming.byEventId,
      ddrRunId: options.ddrRunId,
      runAt: options.runAt,
      syncCapabilities: options.syncCapabilities,
    });
    rows = resolveDdrIncidents(contextResult.context, nowSec);
  }

  const diagnosticSnapshot = buildDiagnosticSnapshot({ rows, lineage, nowSec });

  const activeIncidentKeys = [...new Set(activeRows.map((row) => incidentsByEventId.get(row.id)?.incidentKey).filter((key): key is string => key != null))];
  const publicationState = await loadSealedAndPublicationState({
    stores: storeContracts,
    db,
    incidentKeys: activeIncidentKeys,
  });
  const lockResult = await sealEligibleLocks({
    stores: storeContracts,
    db,
    rows,
    activeEventById,
    incidentsByEventId,
    existingSealed: publicationState.sealed,
    nowSec,
    ddrRunId: options.ddrRunId,
    runAt: options.runAt,
    syncCapabilities: options.syncCapabilities,
  });
  v2LockedPredictions = lockResult.lockedCount;
  v2LockedNoCalls = lockResult.noCallCount;
  v2PendingLocks = lockResult.pendingCount;

  const refreshedPublicationState = storeContracts
    ? await loadSealedAndPublicationState({ stores: storeContracts, db, incidentKeys: activeIncidentKeys })
    : { sealed: lockResult.sealed, firstPublication: publicationState.firstPublication };
  const errataState = await loadErrataForSealedPredictions({
    stores: storeContracts,
    db,
    sealed: refreshedPublicationState.sealed,
  });
  v2ErrataLoadError = errataState.error;

  const publication = await writePublicationBeforeCache({
    stores: storeContracts,
    db,
    snapshot: diagnosticSnapshot,
    incidentsByEventId,
    sealed: refreshedPublicationState.sealed,
    firstPublication: refreshedPublicationState.firstPublication,
    errata: errataState.errata,
    ddrRunId: options.ddrRunId,
    nowSec,
  });
  v2PublicationAttempted = publication.attempted;
  v2PublicationSucceeded = publication.ok;
  v2PublicationError = publication.error;

  const publicSnapshot = buildDdrResponse({
    candidateRows: rows,
    incidentsByEventId,
    sealed: refreshedPublicationState.sealed,
    firstPublication: publication.firstPublication,
    manifest: publication.manifest,
    errata: errataState.errata,
    lineage,
    nowSec,
    storageAvailable: storeContracts != null,
  });
  if (publication.attempted && !publication.ok) {
    publicSnapshot._meta.degraded = true;
    publicSnapshot._meta.degradedReason = `publication-retry-pending:${publication.error ?? "manifest-write-failed"}`;
  }
  await persistDepegResolverSnapshot(db, publicSnapshot);
  const reviewArtifacts = await persistDepegResolverReviewArtifacts(db, diagnosticSnapshot, options.signal, storeContracts);
  assessmentWriteCount = reviewArtifacts.assessmentWriteCount;
  reviewRows = reviewArtifacts.reviewRows;
  reviewError = reviewArtifacts.reviewError;

  return {
    itemCount: rows.length,
    ...(quarantinedEvents.length > 0 ? { status: "degraded" as const } : {}),
    metadata: JSON.stringify({
      ddrRunId: options.ddrRunId,
      activeEvents: rows.length,
      repairRequiredEvents: quarantinedEvents,
      assessmentWriteCount,
      reviewRows,
      ddrrDegraded: reviewError != null,
      ddrrDegradedReason: reviewError,
      incidentCount: lineage?.incidentCount ?? 0,
      quarantinedCoins: lineage?.quarantinedCoins ?? 0,
      v2PolicyUniverseEvents: policyUniverseRows.length,
      v2CanonicalIncidents: new Set([...incidentsByEventId.values()].map((incident) => incident.incidentKey)).size,
      v2PendingLocks,
      v2LockedPredictions,
      v2LockedNoCalls,
      v2ConfirmedSeen,
      v2ConfirmationTimingError,
      v2PublicationAttempted,
      v2PublicationSucceeded,
      v2PublicationError,
      v2ErrataLoadError,
    }),
  };
}

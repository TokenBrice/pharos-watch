import type { DdrRow } from "@shared/types/depeg-resolver";
import type { CronResult } from "../lib/cron-logger";
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
import type { ComputeDepegResolverV2Options, DdrLineage } from "./depeg-resolver/types";
import { abortIf } from "./depeg-resolver/utils";

export type { DdrV2StoreContracts } from "./depeg-resolver-v2-contracts";
export type { ComputeDepegResolverV2Options } from "./depeg-resolver/types";

export async function computeDepegResolver(
  input: D1Database | ComputeDepegResolverV2Options,
  signal?: AbortSignal,
): Promise<CronResult> {
  const options = normalizeComputeOptions(input, signal);
  const { db, storeContracts } = options;
  abortIf(options.signal, "compute-depeg-resolver");
  const nowSec = options.runAt;

  const policyUniverseRows = await loadPolicyUniverseEvents(db);
  const activeRows = await loadActiveConfirmedEvents(db);
  const incidentRows = policyUniverseRows.length > 0 ? policyUniverseRows : activeRows;
  const incidentsByEventId = await ensureCanonicalIncidentsForEvents(storeContracts, db, incidentRows, {
    ddrRunId: options.ddrRunId,
    runAt: options.runAt,
  });

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

  const schedulerHealthFailures = [
    options.stablecoinsCacheSafe ? null : "stablecoins-cache-unsafe",
    options.depegPipelineHealthy ? null : "depeg-pipeline-unhealthy",
  ].filter((reason): reason is string => reason != null);
  if (schedulerHealthFailures.length > 0) {
    v2LockDeferrals = await recordSystemHealthDeferrals({
      stores: storeContracts,
      db,
      incidentsByEventId,
      activeRows,
      nowSec,
      ddrRunId: options.ddrRunId,
      runAt: options.runAt,
      syncCapabilities: options.syncCapabilities,
      reason: schedulerHealthFailures.join(","),
    });
    return {
      itemCount: 0,
      metadata: JSON.stringify({
        ddrRunId: options.ddrRunId,
        activeEvents: activeRows.length,
        degraded: true,
        degradedReason: schedulerHealthFailures.join(","),
        v2LockDeferrals,
        v2FreezeSkipped: true,
        v2PublicationAttempted: false,
      }),
    };
  }

  const confirmationTiming = await loadPendingPromotionConfirmationTimes(db, activeRows);
  v2ConfirmationTimingError = confirmationTiming.error;
  applyConfirmationTimes(incidentsByEventId, confirmationTiming.byEventId);

  if (activeRows.length > 0) {
    abortIf(options.signal, "compute-depeg-resolver");
    const contextResult = await loadDdrContext(db, activeRows, nowSec);
    if (contextResult.kind === "degraded") {
      v2LockDeferrals = await recordSystemHealthDeferrals({
        stores: storeContracts,
        db,
        incidentsByEventId,
        activeRows,
        nowSec,
        ddrRunId: options.ddrRunId,
        runAt: options.runAt,
        syncCapabilities: options.syncCapabilities,
        reason: contextResult.reason,
      });
      return {
        itemCount: 0,
        metadata: JSON.stringify({
          ddrRunId: options.ddrRunId,
          activeEvents: activeRows.length,
          degraded: true,
          degradedReason: contextResult.reason,
          v2LockDeferrals,
          v2FreezeSkipped: true,
          v2PublicationAttempted: false,
        }),
      };
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
    metadata: JSON.stringify({
      ddrRunId: options.ddrRunId,
      activeEvents: rows.length,
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

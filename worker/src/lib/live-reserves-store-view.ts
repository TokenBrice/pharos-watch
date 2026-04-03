import { getReserves, type ReserveResult } from "@shared/lib/reserve-templates";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { ReserveSyncStateView } from "@shared/types/live-reserves";
import { buildReserveProvenanceView, hasConsistentSnapshotState, hasScoringEligibleLiveReserveFreshness, hasUncertainWriteState, parseReserveCompositionRow } from "./live-reserves-store-parsing";
import {
  getReserveCompositionRow,
  getReserveSyncState,
  loadReserveCompositionRowMap,
  loadReserveSyncStateMap,
} from "./live-reserves-store-read";
import {
  getConfiguredLiveReserveCoins,
  LIVE_RESERVE_FRESHNESS_SEC,
  SCORING_LIVE_RESERVE_EVIDENCE_CLASSES,
  type AuthoritativeReserveSnapshot,
  type ReserveCompositionOverview,
  type ReserveCompositionRecord,
  type ReserveSnapshotMetadataRecord,
  type ReserveSyncStateRecord,
  type ReserveSyncStatus,
  type SnapshotIntegrityIssue,
} from "./live-reserves-store-shared";

export async function computeReserveCompositionOverview(
  db: D1Database,
  now: number,
  freshnessSec = LIVE_RESERVE_FRESHNESS_SEC,
): Promise<ReserveCompositionOverview> {
  const configuredCoins = getConfiguredLiveReserveCoins();
  if (configuredCoins.length === 0) {
    return {
      configuredCoins: 0,
      freshCoins: 0,
      staleCoins: 0,
      missingCoins: 0,
      degradedCoins: 0,
      errorCoins: 0,
      corruptCoins: 0,
      independentFreshEligible: 0,
      independentFreshUnverified: 0,
      staticValidatedFresh: 0,
      weakProbeFresh: 0,
      writeTimeoutUncertain: 0,
      lastSuccessAt: null,
      oldestFreshAgeSec: null,
    };
  }

  const coinIds = configuredCoins.map((coin) => coin.id);
  const [syncById, compositionById] = await Promise.all([
    loadReserveSyncStateMap(db, coinIds),
    loadReserveCompositionRowMap(db, coinIds),
  ]);

  let freshCoins = 0;
  let staleCoins = 0;
  let missingCoins = 0;
  let degradedCoins = 0;
  let errorCoins = 0;
  let corruptCoins = 0;
  let independentFreshEligible = 0;
  let independentFreshUnverified = 0;
  let staticValidatedFresh = 0;
  let weakProbeFresh = 0;
  let writeTimeoutUncertain = 0;
  let lastSuccessAt: number | null = null;
  let oldestFreshAgeSec: number | null = null;

  for (const coin of configuredCoins) {
    const syncState = syncById.get(coin.id) ?? null;
    const compositionRow = compositionById.get(coin.id);
    if (hasUncertainWriteState(syncState)) {
      writeTimeoutUncertain++;
    }
    const hasSnapshot = hasConsistentSnapshotState(syncState, compositionRow
      ? { fetchedAt: compositionRow.fetched_at, attemptId: compositionRow.attempt_id ?? null }
      : null);

    if (!hasSnapshot || !compositionRow) {
      if (syncState?.lastStatus === "error") {
        errorCoins++;
      } else {
        missingCoins++;
      }
      continue;
    }

    const parsed = parseReserveCompositionRow(compositionRow, syncState);
    if (!parsed.record) {
      corruptCoins++;
      continue;
    }

    const ageSec = Math.max(0, now - parsed.record.fetchedAt);
    lastSuccessAt = lastSuccessAt == null ? parsed.record.fetchedAt : Math.max(lastSuccessAt, parsed.record.fetchedAt);

    if (syncState?.lastStatus === "error") {
      errorCoins++;
      continue;
    }

    if (syncState && syncState.lastStatus !== "ok") {
      degradedCoins++;
      continue;
    }

    if (ageSec > freshnessSec) {
      staleCoins++;
      continue;
    }

    freshCoins++;
    if (parsed.record.adapterEvidenceClass === "independent") {
      if (hasScoringEligibleLiveReserveFreshness(parsed.record.metadata)) {
        independentFreshEligible++;
      } else {
        independentFreshUnverified++;
      }
    } else if (parsed.record.adapterEvidenceClass === "static-validated") {
      staticValidatedFresh++;
    } else if (parsed.record.adapterEvidenceClass === "weak-live-probe") {
      weakProbeFresh++;
    }

    oldestFreshAgeSec = oldestFreshAgeSec == null ? ageSec : Math.max(oldestFreshAgeSec, ageSec);
  }

  return {
    configuredCoins: configuredCoins.length,
    freshCoins,
    staleCoins,
    missingCoins,
    degradedCoins,
    errorCoins,
    corruptCoins,
    independentFreshEligible,
    independentFreshUnverified,
    staticValidatedFresh,
    weakProbeFresh,
    writeTimeoutUncertain,
    lastSuccessAt,
    oldestFreshAgeSec,
  };
}

async function loadFreshAuthoritativeReserveSnapshots(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
  freshnessSec = LIVE_RESERVE_FRESHNESS_SEC,
  options?: {
    minSlices?: number;
    sourceModels?: readonly ReserveCompositionRecord["adapterSourceModel"][];
    evidenceClasses?: readonly ReserveCompositionRecord["adapterEvidenceClass"][];
    requireOkStatus?: boolean;
  },
): Promise<Map<string, AuthoritativeReserveSnapshot>> {
  const configuredCoins = getConfiguredLiveReserveCoins();
  const coinIds = configuredCoins.map((coin) => coin.id);
  const [syncById, compositionById] = await Promise.all([
    loadReserveSyncStateMap(db, coinIds),
    loadReserveCompositionRowMap(db, coinIds),
  ]);
  const allowedSourceModels = options?.sourceModels ? new Set(options.sourceModels) : null;
  const allowedEvidenceClasses = options?.evidenceClasses ? new Set(options.evidenceClasses) : null;
  const minSlices = options?.minSlices ?? 1;
  const snapshots = new Map<string, AuthoritativeReserveSnapshot>();

  for (const coin of configuredCoins) {
    const syncState = syncById.get(coin.id) ?? null;
    const compositionRow = compositionById.get(coin.id);
    if (!compositionRow || !hasConsistentSnapshotState(syncState, {
      fetchedAt: compositionRow.fetched_at,
      attemptId: compositionRow.attempt_id ?? null,
    })) {
      continue;
    }

    const parsed = parseReserveCompositionRow(compositionRow, syncState);
    if (!parsed.record) continue;
    if (options?.requireOkStatus && syncState?.lastStatus !== "ok") continue;
    if (now - parsed.record.fetchedAt > freshnessSec) continue;
    if (parsed.record.slices.length < minSlices) continue;

    if (allowedSourceModels && !allowedSourceModels.has(parsed.record.adapterSourceModel)) {
      continue;
    }
    if (allowedEvidenceClasses && !allowedEvidenceClasses.has(parsed.record.adapterEvidenceClass)) {
      continue;
    }

    snapshots.set(coin.id, {
      stablecoinId: coin.id,
      slices: parsed.record.slices,
      fetchedAt: parsed.record.fetchedAt,
      source: parsed.record.source,
      metadata: parsed.record.metadata,
      warningCount: parsed.record.warningCount,
      warnings: parsed.record.warnings,
      sourceModel: parsed.record.adapterSourceModel,
      evidenceClass: parsed.record.adapterEvidenceClass,
    });
  }

  return snapshots;
}

export async function loadFreshIndependentLiveReserveMap(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
  freshnessSec = LIVE_RESERVE_FRESHNESS_SEC,
  minSlices = 1,
): Promise<Map<string, ReserveCompositionRecord["slices"]>> {
  const snapshots = await loadFreshAuthoritativeReserveSnapshots(db, now, freshnessSec, {
    minSlices,
    evidenceClasses: SCORING_LIVE_RESERVE_EVIDENCE_CLASSES,
    requireOkStatus: true,
  });
  return new Map(
    Array.from(snapshots.entries())
      .filter(([, snapshot]) => hasScoringEligibleLiveReserveFreshness(snapshot.metadata))
      .map(([coinId, snapshot]) => [coinId, snapshot.slices]),
  );
}

function buildReserveSnapshotMetadataRecord(
  stablecoinId: string,
  record: ReserveCompositionRecord,
  syncState: ReserveSyncStateRecord | null,
): ReserveSnapshotMetadataRecord {
  return {
    stablecoinId,
    fetchedAt: record.fetchedAt,
    source: record.source,
    metadata: record.metadata,
    warningCount: record.warningCount,
    warnings: record.warnings,
    sourceModel: record.adapterSourceModel,
    evidenceClass: record.adapterEvidenceClass,
    syncStatus: syncState?.lastStatus ?? "error",
  };
}

export async function loadReserveSnapshotMetadataMap(
  db: D1Database,
  stablecoinIds: readonly string[],
): Promise<Map<string, ReserveSnapshotMetadataRecord>> {
  if (stablecoinIds.length === 0) {
    return new Map();
  }

  const [syncById, compositionById] = await Promise.all([
    loadReserveSyncStateMap(db, stablecoinIds),
    loadReserveCompositionRowMap(db, stablecoinIds),
  ]);

  const records = new Map<string, ReserveSnapshotMetadataRecord>();
  for (const stablecoinId of stablecoinIds) {
    const syncState = syncById.get(stablecoinId) ?? null;
    const compositionRow = compositionById.get(stablecoinId);
    if (!compositionRow || !hasConsistentSnapshotState(syncState, {
      fetchedAt: compositionRow.fetched_at,
      attemptId: compositionRow.attempt_id ?? null,
    })) {
      continue;
    }

    const parsed = parseReserveCompositionRow(compositionRow, syncState);
    if (!parsed.record) continue;
    records.set(stablecoinId, buildReserveSnapshotMetadataRecord(stablecoinId, parsed.record, syncState));
  }

  return records;
}

export async function getLatestSuccessfulReserveSnapshotMetadata(
  db: D1Database,
  stablecoinId: string,
): Promise<ReserveSnapshotMetadataRecord | null> {
  const records = await loadReserveSnapshotMetadataMap(db, [stablecoinId]);
  return records.get(stablecoinId) ?? null;
}

function buildSyncView(
  syncState: ReserveSyncStateRecord | null,
  stale: boolean,
  overrides: {
    enabled: boolean;
    defaultStatus: ReserveSyncStatus;
    bootstrap: boolean;
    statusOverride?: ReserveSyncStatus;
    extraWarnings?: string[];
    lastErrorOverride?: string | null;
  },
): ReserveSyncStateView {
  const warningMessages = [
    ...(syncState?.warnings.map((warning) => warning.message) ?? []),
    ...(overrides.extraWarnings ?? []),
  ];
  const lastError = overrides.lastErrorOverride ?? syncState?.lastError ?? null;
  return {
    enabled: overrides.enabled,
    status: overrides.statusOverride ?? syncState?.lastStatus ?? overrides.defaultStatus,
    stale,
    bootstrap: overrides.bootstrap,
    ...(syncState?.lastAttemptedAt != null ? { lastAttemptedAt: syncState.lastAttemptedAt } : {}),
    ...(syncState?.lastSuccessAt != null ? { lastSuccessAt: syncState.lastSuccessAt } : {}),
    ...(warningMessages.length > 0 ? { warnings: warningMessages } : {}),
    ...(lastError ? { lastError: lastError.slice(0, 200) } : {}),
  };
}

function describeSnapshotIssue(issue: SnapshotIntegrityIssue): string {
  switch (issue.code) {
    case "invalid-json":
    case "invalid-payload":
      return "Stored live reserve snapshot is unreadable";
    case "empty-slices":
      return "Stored live reserve snapshot is empty";
    case "invalid-slice":
      return "Stored live reserve snapshot contains invalid slices";
    case "invalid-sum":
      return issue.message;
    default:
      return "Stored live reserve snapshot is invalid";
  }
}

export async function resolveReserveResult(
  db: D1Database,
  stablecoinId: string,
  now = Math.floor(Date.now() / 1000),
  freshnessSec = LIVE_RESERVE_FRESHNESS_SEC,
): Promise<ReserveResult | null> {
  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  if (!meta) return null;

  const [compositionRow, syncState] = await Promise.all([
    getReserveCompositionRow(db, stablecoinId),
    getReserveSyncState(db, stablecoinId),
  ]);

  const displayUrl = meta.liveReservesConfig?.display?.url;
  const staticFallback = getReserves(meta);
  const consistentSnapshot = compositionRow && hasConsistentSnapshotState(syncState, {
    fetchedAt: compositionRow.fetched_at,
    attemptId: compositionRow.attempt_id ?? null,
  })
    ? parseReserveCompositionRow(compositionRow, syncState)
    : { record: null, issue: null };
  const liveSnapshot = consistentSnapshot.record;
  const liveAtCandidate = liveSnapshot?.fetchedAt
    ?? (
      compositionRow && hasConsistentSnapshotState(syncState, {
        fetchedAt: compositionRow.fetched_at,
        attemptId: compositionRow.attempt_id ?? null,
      })
        ? compositionRow.fetched_at
        : syncState?.lastSuccessAt ?? null
    );
  const stale = !!(liveAtCandidate && now - liveAtCandidate > freshnessSec);

  if (liveSnapshot) {
    const provenance = buildReserveProvenanceView(liveSnapshot, syncState, stale);
    return {
      reserves: liveSnapshot.slices,
      estimated: false,
      mode: stale ? "live-stale" : "live",
      liveAt: liveSnapshot.fetchedAt,
      source: liveSnapshot.source,
      displayUrl,
      metadata: liveSnapshot.metadata,
      provenance,
      sync: buildSyncView(syncState, stale, {
        enabled: !!meta.liveReservesConfig,
        defaultStatus: "ok",
        bootstrap: false,
      }),
    };
  }

  const snapshotIntegrityWarning = consistentSnapshot.issue ? describeSnapshotIssue(consistentSnapshot.issue) : null;
  const statusOverride = snapshotIntegrityWarning
    ? (syncState?.lastStatus === "error" ? "error" : "degraded")
    : undefined;
  const lastErrorOverride = snapshotIntegrityWarning
    ? `Stored live reserve snapshot rejected: ${snapshotIntegrityWarning}`
    : null;

  if (staticFallback) {
    return {
      ...staticFallback,
      displayUrl,
      sync: meta.liveReservesConfig
        ? buildSyncView(syncState, stale, {
            enabled: true,
            defaultStatus: "skipped",
            bootstrap: !syncState?.lastSuccessAt,
            statusOverride,
            extraWarnings: snapshotIntegrityWarning ? [snapshotIntegrityWarning] : undefined,
            lastErrorOverride,
          })
        : undefined,
    };
  }

  return meta.liveReservesConfig
    ? {
        reserves: [],
        estimated: false,
        mode: "unavailable",
        displayUrl,
        sync: buildSyncView(syncState, stale, {
          enabled: true,
          defaultStatus: "skipped",
          bootstrap: !syncState?.lastSuccessAt,
          statusOverride,
          extraWarnings: snapshotIntegrityWarning ? [snapshotIntegrityWarning] : undefined,
          lastErrorOverride,
        }),
      }
    : null;
}

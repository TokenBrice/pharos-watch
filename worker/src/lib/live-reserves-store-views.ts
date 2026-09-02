import {
  buildReserveDisplayBadge,
  getReserveDisplayBadgeKindForAdapter,
  hasReserveDisplayBadgeForAdapter,
} from "@shared/lib/live-reserve-display";
import { inferReserveDisplayBadgeKindFromEvidenceClass } from "@shared/lib/live-reserve-adapter-descriptors";
import { getReserves, type ReserveResult } from "@shared/lib/reserve-templates";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type {
  LiveReserveSnapshotMetadata,
  ReserveDisplayBadgeView,
  ReserveProvenanceView,
  ReserveSyncStateView,
} from "@shared/types/live-reserves";
import { getReserveCompositionRow, getReserveSyncState } from "./live-reserves-store-read";
import { parseReserveCompositionRow } from "./live-reserves-store-row-decoding";
import {
  LIVE_RESERVE_FRESHNESS_SEC,
  type ReserveCompositionRecord,
  type ReserveSyncStateRecord,
  type ReserveSyncStatus,
  type SnapshotIntegrityIssue,
} from "./live-reserves-store-shared";
import {
  hasConsistentSnapshotState,
  hasScoringEligibleLiveReserveFreshness,
} from "./live-reserves-store-snapshot-state";

function effectiveObservedAt(record: Pick<ReserveCompositionRecord, "fetchedAt" | "metadata">): number {
  const sourceTimestamp = record.metadata.freshnessMode === "verified" ? record.metadata.sourceTimestamp : undefined;
  return typeof sourceTimestamp === "number" && Number.isFinite(sourceTimestamp) ? sourceTimestamp : record.fetchedAt;
}

function buildReserveProvenanceView(
  record: Pick<ReserveCompositionRecord, "adapterEvidenceClass" | "adapterSourceModel" | "metadata">,
  syncState: ReserveSyncStateRecord | null,
  stale: boolean,
): ReserveProvenanceView {
  const freshnessMode = record.metadata.freshnessMode;
  return {
    evidenceClass: record.adapterEvidenceClass,
    sourceModel: record.adapterSourceModel,
    ...(freshnessMode ? { freshnessMode } : {}),
    scoringEligible: record.adapterEvidenceClass === "independent"
      && !stale
      && syncState?.lastStatus === "ok"
      && hasScoringEligibleLiveReserveFreshness(record.metadata),
  };
}

function buildReserveDisplayBadgeView(
  record: Pick<ReserveCompositionRecord, "source" | "adapterEvidenceClass">,
): ReserveDisplayBadgeView {
  const kind = hasReserveDisplayBadgeForAdapter(record.source)
    ? getReserveDisplayBadgeKindForAdapter(record.source)
    : inferReserveDisplayBadgeKindFromEvidenceClass(record.adapterEvidenceClass);
  return buildReserveDisplayBadge(kind);
}

function extractReserveEvidenceUrls(
  metadata: LiveReserveSnapshotMetadata | undefined,
  displayUrl: string | undefined,
): string[] | undefined {
  const sourceUrls = metadata?.redemption?.sourceUrls;
  if (!Array.isArray(sourceUrls) || sourceUrls.length === 0) return undefined;

  const seen = new Set<string>();
  const evidenceUrls: string[] = [];

  for (const url of sourceUrls) {
    if (typeof url !== "string") continue;
    const trimmed = url.trim();
    if (trimmed.length === 0 || trimmed === displayUrl || seen.has(trimmed)) continue;
    seen.add(trimmed);
    evidenceUrls.push(trimmed);
  }

  return evidenceUrls.length > 0 ? evidenceUrls : undefined;
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
  const failureCategory = typeof syncState?.metadata.failureCategory === "string"
    ? syncState.metadata.failureCategory
    : undefined;
  const uncertainWrite = syncState?.metadata.uncertainWrite === true;
  return {
    enabled: overrides.enabled,
    status: overrides.statusOverride ?? syncState?.lastStatus ?? overrides.defaultStatus,
    stale,
    bootstrap: overrides.bootstrap,
    ...(syncState?.lastAttemptedAt != null ? { lastAttemptedAt: syncState.lastAttemptedAt } : {}),
    ...(syncState?.lastSuccessAt != null ? { lastSuccessAt: syncState.lastSuccessAt } : {}),
    ...(warningMessages.length > 0 ? { warnings: warningMessages } : {}),
    ...(lastError ? { lastError: lastError.slice(0, 200) } : {}),
    ...(failureCategory ? { failureCategory } : {}),
    ...(uncertainWrite ? { uncertainWrite: true } : {}),
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
    case "unknown-adapter-source":
      return "Stored live reserve snapshot references an unknown adapter";
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
  const stale = (liveAtCandidate != null && now - liveAtCandidate > freshnessSec)
    || (liveSnapshot != null && now - effectiveObservedAt(liveSnapshot) > freshnessSec);

  // Prior live detail deliberately stays visible when the *current* sync attempt
  // failed: the earlier snapshot was validly observed, and scoring already
  // excludes it separately by requiring `lastStatus === "ok"`. Only genuine
  // staleness (Worker fetch age or effective upstream observation age, computed
  // above) may demote it, and that surfaces as `live-stale` rather than hiding it.
  if (liveSnapshot) {
    const provenance = buildReserveProvenanceView(liveSnapshot, syncState, stale);
    const displayBadge = buildReserveDisplayBadgeView(liveSnapshot);
    const evidenceUrls = extractReserveEvidenceUrls(liveSnapshot.metadata, displayUrl);
    return {
      reserves: liveSnapshot.slices,
      estimated: false,
      mode: stale ? "live-stale" : "live",
      liveAt: liveSnapshot.fetchedAt,
      source: liveSnapshot.source,
      displayUrl,
      evidenceUrls,
      displayBadge,
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

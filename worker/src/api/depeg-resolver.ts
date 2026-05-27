import { withErrorHandler, jsonFreshResponse, buildMethodologyEnvelope } from "../lib/api-utils";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { CACHE_PROFILES } from "../lib/constants";
import { buildInClause, chunkArray } from "../lib/db";
import { loadDepegResolverSnapshot } from "../lib/depeg-resolver-snapshot-cache";
import {
  DDR_EMPTY_READ_OVERLAY,
  DDR_PUBLIC_WARNING,
  DdrResponseSchema,
  DdrV2RowSchema,
  type DdrResponse,
  type DdrV2LiveOverlay,
  type DdrV2ResponseRow,
  type DdrV2Row,
} from "@shared/types/depeg-resolver";
import { validateDdrPublicCacheContract } from "@shared/lib/depeg-resolver/public-contract";
import {
  DDR_DURATION_MODEL_VERSION,
  DDR_INCIDENT_GROUPING_VERSION,
  DDR_METHODOLOGY_CHANGELOG_PATH,
  DDR_METHODOLOGY_VERSION,
  DDR_METHODOLOGY_VERSION_LABEL,
  DDR_RESOLUTION_RUBRIC_VERSION,
  DDR_SUPPORT_RULES_VERSION,
} from "@shared/lib/depeg-resolver-version";
import { loadLatestPublicationManifest } from "../lib/depeg-resolver-publication-store";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { isTerminalStablecoinStatus } from "@shared/lib/stablecoin-lifecycle";
import type { DdrPublicationManifest } from "../lib/depeg-resolver-publication-store";

function degradedResponse(reason: string): DdrResponse {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    _meta: {
      schemaVersion: 2,
      dataAsOf: nowSec,
      modelAsOf: nowSec,
      computedAt: nowSec,
      expiresAt: nowSec + 1800,
      snapshotToken: null,
      snapshotGeneration: null,
      publicPredictionIds: [],
      publicPredictionRowHashes: {},
      basePayloadHash: null,
      readOverlay: DDR_EMPTY_READ_OVERLAY,
      degraded: true,
      degradedReason: reason,
      publicWarning: DDR_PUBLIC_WARNING,
      resolutionRubricVersion: DDR_RESOLUTION_RUBRIC_VERSION,
      durationModelVersion: DDR_DURATION_MODEL_VERSION,
      incidentGroupingVersion: DDR_INCIDENT_GROUPING_VERSION,
      supportRulesVersion: DDR_SUPPORT_RULES_VERSION,
      lineage: null,
    },
    rows: [],
    methodology: buildMethodologyEnvelope({
      version: DDR_METHODOLOGY_VERSION,
      versionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      currentVersion: DDR_METHODOLOGY_VERSION,
      currentVersionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      changelogPath: DDR_METHODOLOGY_CHANGELOG_PATH,
      asOf: nowSec,
    }),
  };
}

interface DdrApiEventStateRow {
  id: number;
  ended_at: number | null;
}

function sameNumberArray(left: readonly number[], right: readonly number[]): boolean {
  return JSON.stringify([...left].sort((a, b) => a - b)) === JSON.stringify([...right].sort((a, b) => a - b));
}

function sameStringMap(left: Record<string, string>, right: Record<string, string>): boolean {
  const normalize = (input: Record<string, string>) =>
    Object.fromEntries(Object.entries(input).sort(([leftKey], [rightKey]) => Number(leftKey) - Number(rightKey)));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function cacheMatchesLatestManifest(snapshot: DdrResponse, manifest: DdrPublicationManifest | null): { ok: true } | { ok: false; reason: string } {
  if (!manifest) return { ok: true };
  if (snapshot._meta.snapshotToken !== manifest.snapshotToken) return { ok: false, reason: "cache-manifest-token-behind" };
  if (snapshot._meta.snapshotGeneration !== manifest.snapshotGeneration) {
    return { ok: false, reason: "cache-manifest-generation-mismatch" };
  }
  if (snapshot._meta.basePayloadHash !== manifest.basePayloadHash) return { ok: false, reason: "cache-manifest-base-hash-mismatch" };
  if (!sameNumberArray(snapshot._meta.publicPredictionIds, manifest.publicPredictionIds)) {
    return { ok: false, reason: "cache-manifest-id-set-mismatch" };
  }
  if (!sameStringMap(snapshot._meta.publicPredictionRowHashes, manifest.publicPredictionRowHashes)) {
    return { ok: false, reason: "cache-manifest-row-hash-mismatch" };
  }
  return { ok: true };
}

async function loadApiEventState(db: D1Database, eventIds: number[]): Promise<Map<number, DdrApiEventStateRow>> {
  const out = new Map<number, DdrApiEventStateRow>();
  for (const chunk of chunkArray([...new Set(eventIds)])) {
    if (chunk.length === 0) continue;
    const clause = buildInClause(chunk);
    const result = await db
      .prepare(`SELECT id, ended_at FROM depeg_events WHERE id IN (${clause.sql})`)
      .bind(...clause.binds)
      .all<DdrApiEventStateRow>();
    for (const row of result.results ?? []) out.set(row.id, row);
  }
  return out;
}

async function staleSnapshotResponse(db: D1Database, snapshot: DdrResponse): Promise<DdrResponse> {
  const eventState = await loadApiEventState(
    db,
    snapshot.rows.map((row) => row.live.currentEventId ?? row.eventId),
  );
  const closedPendingReviewIncidentKeys = new Set(snapshot._meta.readOverlay?.closedPendingReviewIncidentKeys ?? []);
  const rows = snapshot.rows.map((row) => {
    const eventId = row.live.currentEventId ?? row.eventId;
    const state = eventState.get(eventId);
    const terminal = isTerminalStablecoinStatus(TRACKED_META_BY_ID.get(row.stablecoinId)?.status ?? null);
    const missing = !state;
    const closedPendingReview = state?.ended_at != null || terminal;
    if (closedPendingReview) closedPendingReviewIncidentKeys.add(row.incidentKey);
    return {
      ...row,
      live: {
        ...row.live,
        currentEventId: missing ? null : row.live.currentEventId,
        eventState: missing ? "source_event_missing" as const : closedPendingReview ? "closed_pending_review" as const : row.live.eventState,
        stale: true,
        degradedReason: row.live.degradedReason ?? (closedPendingReview ? "closed-pending-review" : "stale-cache"),
      },
    };
  });
  return {
    ...snapshot,
    _meta: {
      ...snapshot._meta,
      degraded: true,
      degradedReason: "stale-cache",
      readOverlay: {
        ...(snapshot._meta.readOverlay ?? DDR_EMPTY_READ_OVERLAY),
        closedPendingReviewIncidentKeys: [...closedPendingReviewIncidentKeys].sort(),
      },
    },
    rows,
  };
}

function fallbackLiveOverlay(row: DdrV2Row, updatedAt: number, reason: string): DdrV2LiveOverlay {
  const sourceRow = row.kind === "prediction" ? row.frozen.sourceRow : null;
  return {
    currentEventId: null,
    ageSec: 0,
    peakDeviationBps: sourceRow?.peakDeviationBps ?? 0,
    currentDeviationBps: null,
    eventState: "source_event_missing",
    updatedAt,
    stale: true,
    degradedReason: reason,
  };
}

async function manifestFallbackResponse(db: D1Database, reason: string): Promise<DdrResponse | null> {
  try {
    const manifest = await loadLatestPublicationManifest(db);
    if (!manifest) return null;

    const parsed = JSON.parse(manifest.basePayloadJson) as {
      _meta?: Partial<DdrResponse["_meta"]>;
      rows?: unknown[];
      methodology?: DdrResponse["methodology"];
    };
    if (!Array.isArray(parsed.rows) || !parsed.methodology) return null;

    const nowSec = Math.floor(Date.now() / 1000);
    const rows: DdrV2ResponseRow[] = [];
    for (const row of parsed.rows) {
      const baseRow = DdrV2RowSchema.parse(row);
      rows.push({
        ...baseRow,
        live: fallbackLiveOverlay(baseRow, manifest.publishedAt, `manifest-fallback:${reason}`),
      } as DdrV2ResponseRow);
    }

    const response = DdrResponseSchema.safeParse({
      _meta: {
        schemaVersion: 2,
        dataAsOf: parsed._meta?.dataAsOf ?? manifest.publishedAt,
        modelAsOf: parsed._meta?.modelAsOf ?? manifest.publishedAt,
        computedAt: parsed._meta?.computedAt ?? manifest.publishedAt,
        expiresAt: parsed._meta?.expiresAt ?? nowSec + 1800,
        snapshotToken: manifest.snapshotToken,
        snapshotGeneration: manifest.snapshotGeneration,
        publicPredictionIds: manifest.publicPredictionIds,
        publicPredictionRowHashes: manifest.publicPredictionRowHashes,
        basePayloadHash: manifest.basePayloadHash,
        readOverlay: DDR_EMPTY_READ_OVERLAY,
        degraded: true,
        degradedReason: `manifest-fallback:${reason}`,
        publicWarning: parsed._meta?.publicWarning ?? DDR_PUBLIC_WARNING,
        resolutionRubricVersion: parsed._meta?.resolutionRubricVersion ?? DDR_RESOLUTION_RUBRIC_VERSION,
        durationModelVersion: parsed._meta?.durationModelVersion ?? DDR_DURATION_MODEL_VERSION,
        incidentGroupingVersion: parsed._meta?.incidentGroupingVersion ?? DDR_INCIDENT_GROUPING_VERSION,
        supportRulesVersion: parsed._meta?.supportRulesVersion ?? DDR_SUPPORT_RULES_VERSION,
        lineage: parsed._meta?.lineage ?? null,
      },
      rows,
      methodology: parsed.methodology,
    });

    if (!response.success) return null;
    const contract = validateDdrPublicCacheContract(response.data);
    return contract.ok ? response.data : null;
  } catch {
    return null;
  }
}

export const handleDepegResolver = withErrorHandler("depeg-resolver", async (db: D1Database): Promise<Response> => {
  const cached = await loadDepegResolverSnapshot(db);
  if (cached.kind === "ok") {
    const contract = validateDdrPublicCacheContract(cached.payload);
    if (!contract.ok) {
      const manifestFallback = await manifestFallbackResponse(db, contract.reason);
      if (manifestFallback) {
        return jsonFreshResponse(manifestFallback, {
          cacheControl: CACHE_PROFILES.standard,
          updatedAt: manifestFallback._meta.computedAt,
          maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.depegResolver,
        });
      }
      console.warn(`[depeg-resolver] cache contract invalid; serving degraded reason=${contract.reason}`);
      const nowSec = Math.floor(Date.now() / 1000);
      return jsonFreshResponse(degradedResponse(contract.reason), {
        cacheControl: CACHE_PROFILES.standard,
        updatedAt: nowSec,
        maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.depegResolver,
      });
    }
    const latestManifest = await loadLatestPublicationManifest(db);
    const manifestContract = cacheMatchesLatestManifest(cached.payload, latestManifest);
    if (!manifestContract.ok) {
      const manifestFallback = await manifestFallbackResponse(db, manifestContract.reason);
      if (manifestFallback) {
        return jsonFreshResponse(manifestFallback, {
          cacheControl: CACHE_PROFILES.standard,
          updatedAt: manifestFallback._meta.computedAt,
          maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.depegResolver,
        });
      }
      console.warn(`[depeg-resolver] cache manifest mismatch; serving degraded reason=${manifestContract.reason}`);
      const nowSec = Math.floor(Date.now() / 1000);
      return jsonFreshResponse(degradedResponse(manifestContract.reason), {
        cacheControl: CACHE_PROFILES.standard,
        updatedAt: nowSec,
        maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.depegResolver,
      });
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = nowSec > cached.payload._meta.expiresAt ? await staleSnapshotResponse(db, cached.payload) : cached.payload;
    return jsonFreshResponse(payload, {
      cacheControl: CACHE_PROFILES.standard,
      updatedAt: cached.payload._meta.computedAt,
      maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.depegResolver,
    });
  }

  // No usable snapshot yet (e.g. before first cron run, or after a methodology bump):
  // serve a degraded 200 with no rows rather than failing — the module renders an
  // "unavailable" state and recovers on the next precompute.
  console.warn(`[depeg-resolver] snapshot unavailable; serving degraded reason=${cached.reason}`);
  const nowSec = Math.floor(Date.now() / 1000);
  return jsonFreshResponse(degradedResponse(cached.reason), {
    cacheControl: CACHE_PROFILES.standard,
    updatedAt: nowSec,
    maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.depegResolver,
  });
});

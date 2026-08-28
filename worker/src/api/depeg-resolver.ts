import { logWorkerEventArgs } from "../lib/structured-log";
import { toErrorMessage } from "../lib/error-utils";
import { cacheControlForDegradedPayload, jsonFreshResponse } from "../lib/api-response";
import { buildDdrMethodologyEnvelope } from "../lib/depeg-resolver-methodology";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { buildInClause, chunkArray } from "../lib/db";
import { loadDepegResolverSnapshot } from "../lib/depeg-resolver-snapshot-cache";
import {
  DDR_DURATION_BAND_META,
  DDR_EMPTY_READ_OVERLAY,
  DDR_PUBLIC_WARNING,
  DdrResponseSchema,
  DdrV2RowSchema,
  type DdrResponse,
  type DdrForecastReadinessBackstop,
  type DdrV2LiveOverlay,
  type DdrV2ResponseRow,
  type DdrV2Row,
} from "@shared/types/depeg-resolver";
import { validateDdrPublicCacheContract } from "@shared/lib/depeg-resolver/public-contract";
import {
  DDR_DURATION_MODEL_VERSION,
  DDR_FORECAST_READINESS_VERSION,
  DDR_INCIDENT_GROUPING_VERSION,
  DDR_PREDICTION_POLICY_VERSION,
  DDR_RESOLUTION_RUBRIC_VERSION,
  DDR_SUPPORT_RULES_VERSION,
} from "@shared/lib/methodology-versions/depeg-resolver";
import { loadLatestPublicationManifest } from "../lib/depeg-resolver-publication-store";
import { loadPredictionErrata } from "../lib/depeg-resolver-errata-store";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { isTerminalStablecoinStatus } from "@shared/lib/stablecoin-lifecycle";
import type { DdrPublicationManifest } from "../lib/depeg-resolver-publication-store";
import type { DdrPredictionErratum as StoreDdrPredictionErratum } from "../lib/depeg-resolver-errata-store";
import type { DdrPredictionErratum } from "@shared/types/depeg-resolver";

function degradedResponse(reason: string): DdrResponse {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    _meta: {
      schemaVersion: 2,
      dataAsOf: nowSec,
      modelAsOf: nowSec,
      computedAt: nowSec,
      expiresAt: nowSec + API_FRESHNESS_MAX_AGE_SEC.depegResolver,
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
      durationBand: DDR_DURATION_BAND_META,
      incidentGroupingVersion: DDR_INCIDENT_GROUPING_VERSION,
      supportRulesVersion: DDR_SUPPORT_RULES_VERSION,
      lineage: null,
    },
    rows: [],
    methodology: buildDdrMethodologyEnvelope(nowSec),
  };
}

interface DdrApiEventStateRow {
  id: number;
  ended_at: number | null;
}

interface DdrApiLockDeferralRow {
  incident_key: string;
  stablecoin_id: string;
  peg_currency: string;
  direction: "above" | "below";
  current_started_at: number;
  current_event_id: number;
  prediction_policy_version: string;
  eligible_at: number;
  deferral_count: number;
  last_deferral_reason: string | null;
  last_attempted_at: number | null;
  updated_at: number;
  lock_trigger: "scheduled_24h" | "forecast_readiness" | "readiness_backstop" | null;
  forecast_readiness_score: number | null;
  forecast_readiness_version: string | null;
  readiness_threshold: number | null;
  backstop_at: number | null;
  backstop_delay_sec: number | null;
  symbol: string;
  peg_type: string;
  peak_deviation_bps: number;
  started_at: number;
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

function withOverlayBaseHashCleared(response: DdrResponse): DdrResponse {
  return {
    ...response,
    _meta: {
      ...response._meta,
      basePayloadHash: null,
    },
  };
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

function toPublicErratum(row: StoreDdrPredictionErratum): DdrPredictionErratum {
  return {
    state: "invalidated",
    id: row.id,
    publicPredictionId: row.publicPredictionId,
    incidentKey: row.incidentKey,
    eventId: row.eventId,
    assessmentId: row.assessmentId,
    reason: row.reason,
    createdAt: row.createdAt,
    operatorNote: row.operatorNote,
    rowHashBefore: row.rowHashBefore,
    replacementAssessmentId: row.replacementAssessmentId,
    replacementRowHash: row.replacementRowHash,
    createdBy: row.createdBy,
  };
}

function errataByPredictionId(rows: readonly StoreDdrPredictionErratum[]): Map<number, DdrPredictionErratum[]> {
  const out = new Map<number, DdrPredictionErratum[]>();
  for (const row of rows) {
    const publicRow = toPublicErratum(row);
    const existing = out.get(row.publicPredictionId);
    if (existing) existing.push(publicRow);
    else out.set(row.publicPredictionId, [publicRow]);
  }
  for (const history of out.values()) history.sort((left, right) => right.createdAt - left.createdAt || right.id - left.id);
  return out;
}

async function applyErrataOverlay(db: D1Database, response: DdrResponse): Promise<DdrResponse> {
  const publicPredictionIds = response.rows
    .map((row) => row.prediction.publicPredictionId)
    .filter((id): id is number => id != null);
  if (publicPredictionIds.length === 0) return response;

  let errata: Map<number, DdrPredictionErratum[]>;
  try {
    errata = errataByPredictionId(await loadPredictionErrata(db, { publicPredictionIds }));
  } catch (error) {
    logWorkerEventArgs("api", "warn", `[depeg-resolver] errata overlay unavailable: ${toErrorMessage(error)}`);
    return response;
  }
  if (errata.size === 0) return response;

  let changed = false;
  const rows = response.rows.map((row): DdrV2ResponseRow => {
    const publicPredictionId = row.prediction.publicPredictionId;
    const history = publicPredictionId == null ? null : errata.get(publicPredictionId) ?? null;
    if (!history || history.length === 0) return row;

    if (row.kind !== "prediction" && row.kind !== "no_call" && row.kind !== "invalidated_prediction") {
      return row;
    }

    const latestErratum = history[0];
    changed = true;
    if (row.kind === "invalidated_prediction") {
      return {
        ...row,
        prediction: {
          ...row.prediction,
          state: "invalidated",
          source: "erratum",
          latestErratum,
          errataCount: history.length,
          errataHistory: history,
        },
      };
    }

    return {
      ...row,
      kind: "invalidated_prediction",
      originalKind: row.kind,
      originalOutcome: row.kind === "prediction" ? row.frozen : row.noCall,
      frozen: row.kind === "prediction" ? row.frozen : null,
      noCall: row.kind === "no_call" ? row.noCall : null,
      prediction: {
        ...row.prediction,
        state: "invalidated",
        source: "erratum",
        latestErratum,
        errataCount: history.length,
        errataHistory: history,
      },
    };
  });

  return changed ? withOverlayBaseHashCleared({ ...response, rows }) : response;
}

async function loadApiLockDeferrals(db: D1Database): Promise<DdrApiLockDeferralRow[]> {
  try {
    const result = await db
      .prepare(
        `SELECT i.incident_key,
                i.stablecoin_id,
                i.peg_currency,
                i.direction,
                i.current_started_at,
                i.current_event_id,
                ls.prediction_policy_version,
                ls.eligible_at,
                ls.deferral_count,
                ls.last_deferral_reason,
                ls.last_attempted_at,
                ls.updated_at,
                ls.lock_trigger,
                ls.forecast_readiness_score,
                ls.forecast_readiness_version,
                ls.readiness_threshold,
                ls.backstop_at,
                ls.backstop_delay_sec,
                e.symbol,
                e.peg_type,
                e.peak_deviation_bps,
                e.started_at,
                e.ended_at
         FROM depeg_resolver_prediction_lock_state ls
         JOIN depeg_resolver_incidents i
           ON i.incident_key = ls.incident_key
         JOIN depeg_resolver_incident_policy_membership m
           ON m.incident_key = i.incident_key
         JOIN depeg_events e
           ON e.id = i.current_event_id
         WHERE ls.last_state = 'lock_deferred'
           AND i.incident_state = 'active'
           AND m.policy_universe_included = 1
           AND m.prediction_policy_version = ?
           AND e.ended_at IS NULL
         ORDER BY ls.updated_at DESC, i.incident_key
         LIMIT 100`,
      )
      .bind(DDR_PREDICTION_POLICY_VERSION)
      .all<DdrApiLockDeferralRow>();
    return result.results ?? [];
  } catch (error) {
    logWorkerEventArgs("api", "warn", `[depeg-resolver] lock deferral overlay unavailable: ${toErrorMessage(error)}`);
    return [];
  }
}

function buildApiBackstop(
  row: Pick<DdrApiLockDeferralRow, "backstop_at" | "backstop_delay_sec" | "current_started_at">,
  nowSec: number,
): DdrForecastReadinessBackstop | null {
  if (row.backstop_at == null) return null;
  return {
    version: DDR_FORECAST_READINESS_VERSION,
    delaySec: row.backstop_delay_sec ?? Math.max(0, row.backstop_at - row.current_started_at),
    backstopAt: row.backstop_at,
    reached: nowSec >= row.backstop_at,
  };
}

function buildLockDeferralRow(row: DdrApiLockDeferralRow, nowSec: number): DdrV2ResponseRow | null {
  const meta = TRACKED_META_BY_ID.get(row.stablecoin_id);
  if (isTerminalStablecoinStatus(meta?.status ?? null)) return null;

  return {
    stablecoinId: row.stablecoin_id,
    symbol: row.symbol,
    name: meta?.name ?? row.symbol,
    pegCurrency: row.peg_currency,
    governance: meta?.flags.governance ?? "centralized",
    status: meta?.status ?? null,
    eventId: row.current_event_id,
    incidentKey: row.incident_key,
    startedAt: row.current_started_at,
    direction: row.direction,
    kind: "pending",
    prediction: {
      state: "lock_deferred",
      publicPredictionId: null,
      incidentKey: row.incident_key,
      predictionPolicyVersion: row.prediction_policy_version || DDR_PREDICTION_POLICY_VERSION,
      predictionMethodologyVersion: null,
      predictionMethodologyVersionLabel: null,
      resolutionRubricVersion: null,
      durationModelVersion: null,
      incidentGroupingVersion: null,
      supportRulesVersion: null,
      eligibleAt: row.eligible_at,
      policyDelaySec: Math.max(0, row.eligible_at - row.current_started_at),
      lockedAt: null,
      publishedAt: null,
      publicationSnapshotToken: null,
      snapshotGeneration: null,
      eventAgeAtLockSec: null,
      lockTiming: null,
      lockTrigger: row.lock_trigger ?? "scheduled_24h",
      readiness: null,
      backstop: buildApiBackstop(row, nowSec),
      source: "pending",
      deferralReason: row.last_deferral_reason,
      deferralCount: row.deferral_count,
      rowHash: null,
      lineage: null,
      modelAsOf: row.last_attempted_at ?? row.updated_at ?? nowSec,
      latestErratum: null,
      errataCount: 0,
      errataHistory: [],
    },
    frozen: null,
    live: {
      currentEventId: row.current_event_id,
      ageSec: Math.max(0, nowSec - row.current_started_at),
      peakDeviationBps: row.peak_deviation_bps,
      currentDeviationBps: null,
      eventState: "active",
      updatedAt: row.last_attempted_at ?? row.updated_at ?? nowSec,
      stale: true,
      degradedReason: row.last_deferral_reason ?? "lock-deferred",
    },
  };
}

async function applyLockDeferralOverlay(db: D1Database, response: DdrResponse): Promise<DdrResponse> {
  const deferrals = await loadApiLockDeferrals(db);
  if (deferrals.length === 0) return response;

  const nowSec = Math.floor(Date.now() / 1000);
  const deferralByIncidentKey = new Map(deferrals.map((row) => [row.incident_key, row]));
  const deferralKeys = new Set(response._meta.readOverlay?.degradedLockDeferralIncidentKeys ?? []);
  const seenKeys = new Set<string>();
  let overlayApplied = false;

  const rows = response.rows.map((row): DdrV2ResponseRow => {
    const deferral = deferralByIncidentKey.get(row.incidentKey);
    if (!deferral || row.prediction.publicPredictionId != null) return row;
    seenKeys.add(row.incidentKey);
    deferralKeys.add(row.incidentKey);
    if (row.kind !== "pending") return row;
    overlayApplied = true;
    return {
      ...row,
      prediction: {
        ...row.prediction,
        state: "lock_deferred",
        eligibleAt: deferral.eligible_at,
        policyDelaySec: Math.max(0, deferral.eligible_at - row.startedAt),
        lockTrigger: deferral.lock_trigger ?? row.prediction.lockTrigger,
        backstop: buildApiBackstop(deferral, nowSec) ?? row.prediction.backstop,
        deferralReason: deferral.last_deferral_reason,
        deferralCount: deferral.deferral_count,
        modelAsOf: deferral.last_attempted_at ?? deferral.updated_at ?? row.prediction.modelAsOf,
      },
      live: {
        ...row.live,
        stale: true,
        degradedReason: row.live.degradedReason ?? deferral.last_deferral_reason ?? "lock-deferred",
      },
    };
  });

  for (const deferral of deferrals) {
    if (seenKeys.has(deferral.incident_key) || rows.some((row) => row.incidentKey === deferral.incident_key)) continue;
    const appended = buildLockDeferralRow(deferral, nowSec);
    if (!appended) continue;
    rows.push(appended);
    deferralKeys.add(deferral.incident_key);
    overlayApplied = true;
  }

  if (!overlayApplied || deferralKeys.size === 0) return response;

  return withOverlayBaseHashCleared({
    ...response,
    _meta: {
      ...response._meta,
      degraded: true,
      degradedReason: response._meta.degradedReason ?? "lock-deferral-overlay",
      readOverlay: {
        ...(response._meta.readOverlay ?? DDR_EMPTY_READ_OVERLAY),
        degradedLockDeferralIncidentKeys: [...deferralKeys].sort(),
      },
    },
    rows,
  });
}

async function decorateDdrResponse(db: D1Database, response: DdrResponse): Promise<DdrResponse> {
  return applyLockDeferralOverlay(db, await applyErrataOverlay(db, response));
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
  const sourceRow = row.kind === "prediction"
    ? row.frozen.sourceRow
    : row.kind === "invalidated_prediction"
      ? row.frozen?.sourceRow ?? null
      : null;
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
        expiresAt: parsed._meta?.expiresAt ?? nowSec + API_FRESHNESS_MAX_AGE_SEC.depegResolver,
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
        durationBand: parsed._meta?.durationBand,
        incidentGroupingVersion: parsed._meta?.incidentGroupingVersion ?? DDR_INCIDENT_GROUPING_VERSION,
        supportRulesVersion: parsed._meta?.supportRulesVersion ?? DDR_SUPPORT_RULES_VERSION,
        lineage: parsed._meta?.lineage ?? null,
      },
      rows,
      methodology: parsed.methodology,
    });

    if (!response.success) return null;
    const contract = validateDdrPublicCacheContract(response.data);
    return contract.ok ? await decorateDdrResponse(db, response.data) : null;
  } catch {
    return null;
  }
}

export const handleDepegResolver = async (db: D1Database): Promise<Response> => {
  const cached = await loadDepegResolverSnapshot(db);
  if (cached.kind === "ok") {
    const contract = validateDdrPublicCacheContract(cached.payload);
    if (!contract.ok) {
      const manifestFallback = await manifestFallbackResponse(db, contract.reason);
      if (manifestFallback) {
        return jsonFreshResponse(manifestFallback, {
          cacheControl: cacheControlForDegradedPayload(manifestFallback),
          updatedAt: manifestFallback._meta.computedAt,
          maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.depegResolver,
        });
      }
      logWorkerEventArgs("api", "warn", `[depeg-resolver] cache contract invalid; serving degraded reason=${contract.reason}`);
      const nowSec = Math.floor(Date.now() / 1000);
      const payload = await decorateDdrResponse(db, degradedResponse(contract.reason));
      return jsonFreshResponse(payload, {
        cacheControl: cacheControlForDegradedPayload(payload),
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
          cacheControl: cacheControlForDegradedPayload(manifestFallback),
          updatedAt: manifestFallback._meta.computedAt,
          maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.depegResolver,
        });
      }
      logWorkerEventArgs("api", "warn", `[depeg-resolver] cache manifest mismatch; serving degraded reason=${manifestContract.reason}`);
      const nowSec = Math.floor(Date.now() / 1000);
      const payload = await decorateDdrResponse(db, degradedResponse(manifestContract.reason));
      return jsonFreshResponse(payload, {
        cacheControl: cacheControlForDegradedPayload(payload),
        updatedAt: nowSec,
        maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.depegResolver,
      });
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const basePayload = nowSec > cached.payload._meta.expiresAt ? await staleSnapshotResponse(db, cached.payload) : cached.payload;
    const payload = await decorateDdrResponse(db, basePayload);
    return jsonFreshResponse(payload, {
      cacheControl: cacheControlForDegradedPayload(payload),
      updatedAt: cached.payload._meta.computedAt,
      maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.depegResolver,
    });
  }

  // No usable snapshot yet (e.g. before first cron run, or after a methodology bump):
  // serve a degraded 200 with no rows rather than failing — the module renders an
  // "unavailable" state and recovers on the next precompute.
  logWorkerEventArgs("api", "warn", `[depeg-resolver] snapshot unavailable; serving degraded reason=${cached.reason}`);
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = await decorateDdrResponse(db, degradedResponse(cached.reason));
  return jsonFreshResponse(payload, {
    cacheControl: cacheControlForDegradedPayload(payload),
    updatedAt: nowSec,
    maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.depegResolver,
  });
};

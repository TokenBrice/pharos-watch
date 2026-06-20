import { DDR_PUBLIC_PREDICTION_DELAY_SEC, DDR_V2_EFFECTIVE_AT } from "@shared/lib/depeg-resolver-version";
import { stableJsonStringifyV1 } from "@shared/lib/depeg-resolver/hash";
import { runChunkedInRead } from "./db";
import { authorizeEventRepair, consumeEventRepairAuthorization } from "./depeg-resolver-repair-store";
import {
  DDR_LOCK_AUDIT_INSERT_COLUMNS_SQL,
  DDR_LOCK_STATE_INSERT_COLUMNS_SQL,
  type DdrLockTrigger,
  assertHash,
  assertLockMetadata,
  assertNonEmpty,
  assertPositiveInteger,
  bindLockMetadata,
  lockAuditInsertValuesSql,
  lockStateOnConflictUpdateSql,
  lockStateInsertValuesSql,
} from "./depeg-resolver-store-validators";
import { sha256Hex } from "./hash";

export type DdrIncidentDirection = "above" | "below";
export type DdrIncidentRelation = "observed" | "superseded" | "merged" | "split_from" | "repair_replacement";
export type DdrIncidentState = "active" | "merged" | "superseded" | "split_source";
export type DdrPolicyUniverseReason =
  | "post_effective_public_tracked"
  | "rollout_active_public_tracked"
  | "psi_shadow_excluded"
  | "not_public_tracked";
export type DdrLockState =
  | "pending_lock"
  | "lock_deferred"
  | "frozen"
  | "no_call"
  | "publication_retry_pending"
  | "publication_failed"
  | "published";
export type DdrLockHealthStatus = "healthy" | "degraded" | "skipped";
export type { DdrLockTrigger };
export type DdrLockAuditAction =
  | "pending"
  | "deferred"
  | "confirmed_seen"
  | "locked_prediction"
  | "locked_no_call"
  | "publication_retry_pending"
  | "publication_failed"
  | "published";

// Unix ts for 2100-01-01T00:00:00Z; far-future sentinel = effectively non-expiring.
const REPAIR_AUTHORIZATION_LONG_EXPIRY_AT = 4_102_444_800;
const DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC = 6 * 3600;
const AUTOMATED_SEALED_TAIL_REPAIR_CREATED_BY = "ddr-worker:auto-sealed-tail";
const AUTOMATED_SEALED_TAIL_LINK_NOTE = "sealed incident live tail linked through automated repair authorization";
const AUTOMATED_SEALED_TAIL_CURRENT_REASON = "sealed incident live tail adopted as current source event";
const DDR_INCIDENT_MEMBERSHIP_LOCK_PROJECTION = `
                m.incident_key AS membership_incident_key,
                m.stablecoin_id AS membership_stablecoin_id,
                m.prediction_policy_version,
                m.public_tracked_at_first_seen,
                m.psi_shadow_at_first_seen,
                m.rollout_active_at_enablement,
                m.policy_universe_included,
                m.policy_universe_reason,
                m.registry_snapshot_json,
                m.created_at AS membership_created_at,
                ls.eligible_at AS lock_eligible_at,
                ls.deferral_count,
                ls.last_deferral_reason,
                ls.last_state,
                ls.lock_trigger,
                ls.forecast_readiness_score,
                ls.forecast_readiness_version,
                ls.readiness_threshold,
                ls.backstop_at,
                ls.backstop_delay_sec`;

export interface DdrCanonicalIncidentEventInput {
  eventId: number;
  stablecoinId: string;
  pegCurrency: string;
  direction: DdrIncidentDirection;
  startedAt: number;
  peakDeviationBps: number;
  endedAt?: number | null;
  source?: string | null;
  sourceFingerprint?: string | null;
  publicTrackedAtFirstSeen?: boolean;
  psiShadowAtFirstSeen?: boolean;
  registrySnapshot?: unknown;
}

export interface EnsureCanonicalIncidentsOptions {
  nowSec?: number;
  runAt?: number;
  runId?: string;
  predictionPolicyVersion: string;
  ddrV2EffectiveAt?: number;
  policyEffectiveAt?: number;
  policyDelaySec?: number;
  createdBy?: string;
  /**
   * Called when an event needs an explicit repair migration (ambiguous
   * overlap with a canonical incident, or an unlinked event whose key maps to
   * an existing incident). When provided, the event is quarantined — skipped
   * for this run — instead of failing the whole run; the repair requirement
   * itself is unchanged. Without the callback the historical throw remains.
   */
  onRepairRequired?: (eventId: number, reason: string) => void;
}

/** Raised when an event cannot be linked without an explicit repair migration. */
class DdrIncidentRepairRequiredError extends Error {
  readonly eventId: number;

  constructor(eventId: number, message: string) {
    super(message);
    this.name = "DdrIncidentRepairRequiredError";
    this.eventId = eventId;
  }
}

export interface DdrCanonicalIncident {
  incidentKey: string;
  stablecoinId: string;
  pegCurrency: string;
  direction: DdrIncidentDirection;
  firstEventId: number;
  currentEventId: number;
  firstStartedAt: number;
  currentStartedAt: number;
  firstObservedPeakBucketBps: number;
  incidentState: DdrIncidentState;
  supersededByIncidentKey: string | null;
  sourceFingerprint: string;
  createdAt: number;
  updatedAt: number;
  eventId: number;
  relation?: DdrIncidentRelation;
  policyMembership?: DdrIncidentPolicyMembership;
  startedAt: number;
  eligibleAt: number;
  policyUniverseIncluded: boolean;
  rolloutActiveAtEnablement: boolean;
  confirmedAt: number | null;
  lockState: {
    eligibleAt: number;
    deferralCount: number;
    lastDeferralReason: string | null;
    lastState: DdrLockState;
    lockTrigger: DdrLockTrigger | null;
    forecastReadinessScore: number | null;
    forecastReadinessVersion: string | null;
    readinessThreshold: number | null;
    backstopAt: number | null;
    backstopDelaySec: number | null;
  } | null;
}

export interface DdrIncidentPolicyMembership {
  incidentKey: string;
  stablecoinId: string;
  predictionPolicyVersion: string;
  publicTrackedAtFirstSeen: boolean;
  psiShadowAtFirstSeen: boolean;
  rolloutActiveAtEnablement: boolean;
  policyUniverseIncluded: boolean;
  policyUniverseReason: DdrPolicyUniverseReason;
  registrySnapshotJson: string;
  createdAt: number;
}

export interface LoadCanonicalIncidentsFilters {
  incidentKeys?: string[];
  eventIds?: number[];
  stablecoinIds?: string[];
  predictionPolicyVersion?: string;
  policyUniverseIncluded?: boolean;
  includeSuperseded?: boolean;
  policyDelaySec?: number;
}

export interface RecordLockDeferralInput {
  incidentKey: string;
  eventId: number;
  predictionPolicyVersion: string;
  eligibleAt: number;
  runAt: number;
  createdAt?: number;
  runId?: string | null;
  reason?: string | null;
  healthStatus?: DdrLockHealthStatus;
  action?: DdrLockAuditAction;
  confirmationAt?: number | null;
  outcomeAt?: number | null;
  lockTrigger?: DdrLockTrigger | null;
  forecastReadinessScore?: number | null;
  forecastReadinessVersion?: string | null;
  readinessThreshold?: number | null;
  backstopAt?: number | null;
  backstopDelaySec?: number | null;
}

interface IncidentRow {
  incident_key: string;
  stablecoin_id: string;
  peg_currency: string;
  direction: DdrIncidentDirection;
  first_event_id: number;
  current_event_id: number;
  first_started_at: number;
  current_started_at: number;
  first_observed_peak_bucket_bps: number;
  incident_state: DdrIncidentState;
  superseded_by_incident_key: string | null;
  source_fingerprint: string;
  created_at: number;
  updated_at: number;
  event_id?: number;
  relation?: DdrIncidentRelation;
  membership_incident_key?: string | null;
  membership_stablecoin_id?: string | null;
  prediction_policy_version?: string | null;
  public_tracked_at_first_seen?: number | null;
  psi_shadow_at_first_seen?: number | null;
  rollout_active_at_enablement?: number | null;
  policy_universe_included?: number | null;
  policy_universe_reason?: DdrPolicyUniverseReason | null;
  registry_snapshot_json?: string | null;
  membership_created_at?: number | null;
  lock_eligible_at?: number | null;
  deferral_count?: number | null;
  last_deferral_reason?: string | null;
  last_state?: DdrLockState | null;
  lock_trigger?: DdrLockTrigger | null;
  forecast_readiness_score?: number | null;
  forecast_readiness_version?: string | null;
  readiness_threshold?: number | null;
  backstop_at?: number | null;
  backstop_delay_sec?: number | null;
}

function optionNowSec(options: EnsureCanonicalIncidentsOptions): number {
  const nowSec = options.nowSec ?? options.runAt;
  if (nowSec == null) throw new Error("nowSec or runAt is required");
  return nowSec;
}

function optionEffectiveAt(options: EnsureCanonicalIncidentsOptions): number {
  return options.ddrV2EffectiveAt ?? options.policyEffectiveAt ?? DDR_V2_EFFECTIVE_AT;
}

function optionPolicyDelaySec(options?: { policyDelaySec?: number }): number {
  return options?.policyDelaySec ?? DDR_PUBLIC_PREDICTION_DELAY_SEC;
}

async function sourceFingerprintForEvent(event: DdrCanonicalIncidentEventInput): Promise<string> {
  if (event.sourceFingerprint != null) {
    const fingerprint = event.sourceFingerprint.trim().toLowerCase();
    assertHash(fingerprint, `sourceFingerprint for event ${event.eventId}`);
    return fingerprint;
  }

  return sha256Hex(
    stableJsonStringifyV1({
      direction: event.direction,
      firstObservedPeakBucketBps: peakBucketBps(event.peakDeviationBps),
      firstStartedAt: event.startedAt,
      pegCurrency: event.pegCurrency,
      source: event.source ?? "unknown",
      stablecoinId: event.stablecoinId,
    }),
  );
}

function peakBucketBps(peakDeviationBps: number): number {
  if (!Number.isFinite(peakDeviationBps)) throw new Error("peakDeviationBps must be finite");
  return Math.floor(Math.abs(Math.round(peakDeviationBps)) / 25) * 25;
}

async function incidentKeyForEvent(event: DdrCanonicalIncidentEventInput, sourceFingerprint: string): Promise<string> {
  const canonicalIdentityJson = stableJsonStringifyV1({
    direction: event.direction,
    firstObservedPeakBucketBps: peakBucketBps(event.peakDeviationBps),
    firstStartedAt: event.startedAt,
    pegCurrency: event.pegCurrency,
    sourceFingerprint,
    stablecoinId: event.stablecoinId,
  });
  const hash = await sha256Hex(canonicalIdentityJson);
  return `ddr2:${hash.slice(0, 32)}`;
}

function policyMembershipForEvent(
  event: DdrCanonicalIncidentEventInput,
  incidentKey: string,
  options: EnsureCanonicalIncidentsOptions,
): DdrIncidentPolicyMembership {
  const effectiveAt = optionEffectiveAt(options);
  const nowSec = optionNowSec(options);
  const publicTracked = event.publicTrackedAtFirstSeen ?? true;
  const psiShadow = event.psiShadowAtFirstSeen ?? false;
  const rolloutActive = event.startedAt < effectiveAt && (event.endedAt == null || event.endedAt >= effectiveAt);
  const postEffective = event.startedAt >= effectiveAt;

  let policyUniverseReason: DdrPolicyUniverseReason = "not_public_tracked";
  let policyUniverseIncluded = false;
  if (psiShadow) {
    policyUniverseReason = "psi_shadow_excluded";
  } else if (publicTracked && postEffective) {
    policyUniverseReason = "post_effective_public_tracked";
    policyUniverseIncluded = true;
  } else if (publicTracked && rolloutActive) {
    policyUniverseReason = "rollout_active_public_tracked";
    policyUniverseIncluded = true;
  }

  return {
    incidentKey,
    stablecoinId: event.stablecoinId,
    predictionPolicyVersion: options.predictionPolicyVersion,
    publicTrackedAtFirstSeen: publicTracked,
    psiShadowAtFirstSeen: psiShadow,
    rolloutActiveAtEnablement: rolloutActive,
    policyUniverseIncluded,
    policyUniverseReason,
    registrySnapshotJson: JSON.stringify(event.registrySnapshot ?? {}),
    createdAt: nowSec,
  };
}

function buildFreshIncident(args: {
  incidentKey: string;
  event: DdrCanonicalIncidentEventInput;
  sourceFingerprint: string;
  policyMembership: DdrIncidentPolicyMembership;
  nowSec: number;
  policyDelaySec: number;
}): DdrCanonicalIncident {
  const { incidentKey, event, sourceFingerprint, policyMembership, nowSec, policyDelaySec } = args;
  return {
    incidentKey,
    stablecoinId: event.stablecoinId,
    pegCurrency: event.pegCurrency,
    direction: event.direction,
    firstEventId: event.eventId,
    currentEventId: event.eventId,
    firstStartedAt: event.startedAt,
    currentStartedAt: event.startedAt,
    firstObservedPeakBucketBps: peakBucketBps(event.peakDeviationBps),
    incidentState: "active",
    supersededByIncidentKey: null,
    sourceFingerprint,
    createdAt: nowSec,
    updatedAt: nowSec,
    eventId: event.eventId,
    relation: "observed",
    policyMembership,
    startedAt: event.startedAt,
    eligibleAt: event.startedAt + policyDelaySec,
    policyUniverseIncluded: policyMembership.policyUniverseIncluded,
    rolloutActiveAtEnablement: policyMembership.rolloutActiveAtEnablement,
    confirmedAt: null,
    lockState: null,
  };
}

function mapIncidentRow(
  row: IncidentRow,
  policyDelaySec = DDR_PUBLIC_PREDICTION_DELAY_SEC,
): DdrCanonicalIncident {
  const policyMembership =
    row.membership_incident_key == null
      ? undefined
      : {
          incidentKey: row.membership_incident_key,
          stablecoinId: row.membership_stablecoin_id ?? row.stablecoin_id,
          predictionPolicyVersion: row.prediction_policy_version ?? "",
          publicTrackedAtFirstSeen: row.public_tracked_at_first_seen === 1,
          psiShadowAtFirstSeen: row.psi_shadow_at_first_seen === 1,
          rolloutActiveAtEnablement: row.rollout_active_at_enablement === 1,
          policyUniverseIncluded: row.policy_universe_included === 1,
          policyUniverseReason: row.policy_universe_reason ?? "not_public_tracked",
          registrySnapshotJson: row.registry_snapshot_json ?? "{}",
          createdAt: row.membership_created_at ?? row.created_at,
        };

  return {
    incidentKey: row.incident_key,
    stablecoinId: row.stablecoin_id,
    pegCurrency: row.peg_currency,
    direction: row.direction,
    firstEventId: row.first_event_id,
    currentEventId: row.current_event_id,
    firstStartedAt: row.first_started_at,
    currentStartedAt: row.current_started_at,
    firstObservedPeakBucketBps: row.first_observed_peak_bucket_bps,
    incidentState: row.incident_state,
    supersededByIncidentKey: row.superseded_by_incident_key,
    sourceFingerprint: row.source_fingerprint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    eventId: row.event_id ?? row.current_event_id,
    relation: row.relation,
    policyMembership,
    startedAt: row.current_started_at,
    eligibleAt: row.current_started_at + policyDelaySec,
    policyUniverseIncluded: policyMembership?.policyUniverseIncluded ?? (row.policy_universe_included === 1),
    rolloutActiveAtEnablement: policyMembership?.rolloutActiveAtEnablement ?? (row.rollout_active_at_enablement === 1),
    confirmedAt: null,
    lockState:
      row.lock_eligible_at == null || row.last_state == null
        ? null
        : {
            eligibleAt: row.lock_eligible_at,
            deferralCount: row.deferral_count ?? 0,
            lastDeferralReason: row.last_deferral_reason ?? null,
            lastState: row.last_state,
            lockTrigger: row.lock_trigger ?? null,
            forecastReadinessScore: row.forecast_readiness_score ?? null,
            forecastReadinessVersion: row.forecast_readiness_version ?? null,
            readinessThreshold: row.readiness_threshold ?? null,
            backstopAt: row.backstop_at ?? null,
            backstopDelaySec: row.backstop_delay_sec ?? null,
          },
  };
}

async function loadIncidentsByEventIds(
  db: D1Database,
  eventIds: number[],
  policyDelaySec = DDR_PUBLIC_PREDICTION_DELAY_SEC,
): Promise<Map<number, DdrCanonicalIncident>> {
  const linked = new Map<number, DdrCanonicalIncident>();
  const rows = await runChunkedInRead(
    [...new Set(eventIds)],
    (inClauseSql) => `WHERE l.event_id IN (${inClauseSql})`,
    async (whereSql, binds) => {
      const result = await db
        .prepare(
          `SELECT i.*,
                l.event_id,
                l.relation,
${DDR_INCIDENT_MEMBERSHIP_LOCK_PROJECTION}
         FROM depeg_resolver_incident_event_links l
         JOIN depeg_resolver_incidents i ON i.incident_key = l.incident_key
         LEFT JOIN depeg_resolver_incident_policy_membership m ON m.incident_key = i.incident_key
         LEFT JOIN depeg_resolver_prediction_lock_state ls ON ls.incident_key = i.incident_key
         ${whereSql}`,
        )
        .bind(...binds)
        .all<IncidentRow>();

      return result.results ?? [];
    },
  );

  const supersededRows = rows.filter((row) =>
    row.event_id != null &&
    row.incident_state === "superseded" &&
    row.superseded_by_incident_key != null,
  );
  const supersedingByKey = supersededRows.length > 0
    ? new Map(
        (await loadCanonicalIncidents(db, {
          incidentKeys: supersededRows.map((row) => row.superseded_by_incident_key!),
          policyDelaySec,
        })).map((incident) => [incident.incidentKey, incident]),
      )
    : new Map<string, DdrCanonicalIncident>();

  for (const row of rows) {
    if (row.event_id == null) continue;
    const incident = mapIncidentRow(row, policyDelaySec);
    const superseding = row.superseded_by_incident_key
      ? supersedingByKey.get(row.superseded_by_incident_key)
      : undefined;
    if (row.incident_state === "superseded" && superseding) {
      linked.set(row.event_id, {
        ...superseding,
        eventId: row.event_id,
        relation: row.relation,
        currentEventId: incident.currentEventId,
        currentStartedAt: incident.currentStartedAt,
        startedAt: superseding.firstStartedAt,
        eligibleAt: supersedingEligibleAt(superseding, policyDelaySec),
      });
      continue;
    }
    linked.set(row.event_id, incident);
  }
  return linked;
}

function supersedingEligibleAt(incident: DdrCanonicalIncident, policyDelaySec: number): number {
  return incident.firstStartedAt + policyDelaySec;
}

async function insertNewIncident(
  db: D1Database,
  event: DdrCanonicalIncidentEventInput,
  incidentKey: string,
  sourceFingerprint: string,
  policyMembership: DdrIncidentPolicyMembership,
  options: EnsureCanonicalIncidentsOptions,
): Promise<void> {
  const nowSec = optionNowSec(options);
  const bucket = peakBucketBps(event.peakDeviationBps);
  const createdBy = options.createdBy ?? "ddr-v2";
  await db.batch([
    db
      .prepare(
        `INSERT INTO depeg_resolver_incident_event_links
         (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
         VALUES (?, ?, 'observed', NULL, ?, ?)`,
      )
      .bind(incidentKey, event.eventId, nowSec, "initial canonical incident link"),
    db
      .prepare(
        `INSERT INTO depeg_resolver_incidents
         (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id,
          first_started_at, current_started_at, first_observed_peak_bucket_bps, incident_state,
          superseded_by_incident_key, source_fingerprint, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?)`,
      )
      .bind(
        incidentKey,
        event.stablecoinId,
        event.pegCurrency,
        event.direction,
        event.eventId,
        event.eventId,
        event.startedAt,
        event.startedAt,
        bucket,
        sourceFingerprint,
        nowSec,
        nowSec,
      ),
    db
      .prepare(
        `INSERT INTO depeg_resolver_incident_revisions
         (incident_key, previous_event_id, current_event_id, reason, repair_authorization_id, erratum_id, created_at, created_by)
         VALUES (?, NULL, ?, ?, NULL, NULL, ?, ?)`,
      )
      .bind(incidentKey, event.eventId, "initial canonical incident", nowSec, createdBy),
    db
      .prepare(
        `INSERT INTO depeg_resolver_incident_policy_membership
         (incident_key, stablecoin_id, prediction_policy_version, public_tracked_at_first_seen,
          psi_shadow_at_first_seen, rollout_active_at_enablement, policy_universe_included,
          policy_universe_reason, registry_snapshot_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        policyMembership.incidentKey,
        policyMembership.stablecoinId,
        policyMembership.predictionPolicyVersion,
        policyMembership.publicTrackedAtFirstSeen ? 1 : 0,
        policyMembership.psiShadowAtFirstSeen ? 1 : 0,
        policyMembership.rolloutActiveAtEnablement ? 1 : 0,
        policyMembership.policyUniverseIncluded ? 1 : 0,
        policyMembership.policyUniverseReason,
        policyMembership.registrySnapshotJson,
        policyMembership.createdAt,
      ),
  ]);
}

async function linkUnsealedNearbyIncident(
  db: D1Database,
  event: DdrCanonicalIncidentEventInput,
  options: EnsureCanonicalIncidentsOptions,
  policyDelaySec: number,
): Promise<DdrCanonicalIncident | null> {
  const nowSec = optionNowSec(options);
  const createdBy = options.createdBy ?? "ddr-v2";
  const row = await db
    .prepare(
      `SELECT i.*,
${DDR_INCIDENT_MEMBERSHIP_LOCK_PROJECTION}
       FROM depeg_resolver_incidents i
       LEFT JOIN depeg_resolver_incident_policy_membership m ON m.incident_key = i.incident_key
       LEFT JOIN depeg_resolver_prediction_lock_state ls ON ls.incident_key = i.incident_key
       WHERE i.stablecoin_id = ?
         AND i.peg_currency = ?
         AND i.direction = ?
         AND i.incident_state = 'active'
         AND (
           ABS(i.current_started_at - ?) <= ?
           OR EXISTS (
             SELECT 1
             FROM depeg_events current_event
             WHERE current_event.id = i.current_event_id
               AND current_event.ended_at IS NOT NULL
               AND ? >= current_event.ended_at
               AND ? - current_event.ended_at <= ?
           )
         )
         AND NOT EXISTS (
           SELECT 1
           FROM depeg_resolver_incident_event_links l
           WHERE l.incident_key = i.incident_key
             AND l.event_id = ?
         )
       ORDER BY
         CASE
           WHEN EXISTS (
             SELECT 1
             FROM depeg_events current_event
             WHERE current_event.id = i.current_event_id
               AND current_event.ended_at IS NOT NULL
               AND ? >= current_event.ended_at
               AND ? - current_event.ended_at <= ?
           )
             THEN 0
           ELSE 1
         END ASC,
         ABS(i.current_started_at - ?) ASC,
         i.created_at ASC
       LIMIT 1`,
    )
    .bind(
      event.stablecoinId,
      event.pegCurrency,
      event.direction,
      event.startedAt,
      policyDelaySec,
      event.startedAt,
      event.startedAt,
      DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC,
      event.eventId,
      event.startedAt,
      event.startedAt,
      DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC,
      event.startedAt,
    )
    .first<IncidentRow>();
  if (!row) return null;

  const sealed = await db
    .prepare(
      `SELECT 1 AS sealed
       FROM depeg_resolver_public_predictions
       WHERE incident_key = ?
       LIMIT 1`,
    )
    .bind(row.incident_key)
    .first<{ sealed: number }>();
  if (sealed) {
    return linkSealedNearbyIncidentTail(db, event, row, options, policyDelaySec);
  }

  if (!canAutoRepairUnsealedTail(event, row, nowSec, policyDelaySec)) {
    throw new DdrIncidentRepairRequiredError(
      event.eventId,
      `Unlinked depeg event ${event.eventId} overlaps nearby canonical incident ${row.incident_key}; explicit repair required`,
    );
  }

  await db.batch([
    db
      .prepare(
        `INSERT INTO depeg_resolver_incident_event_links
         (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
         VALUES (?, ?, 'repair_replacement', NULL, ?, ?)`,
      )
      .bind(row.incident_key, event.eventId, nowSec, "pre-lock nearby event adopted as current incident source"),
    db
      .prepare(
        `INSERT INTO depeg_resolver_incident_revisions
         (incident_key, previous_event_id, current_event_id, reason, repair_authorization_id, erratum_id, created_at, created_by)
         VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .bind(
        row.incident_key,
        row.current_event_id,
        event.eventId,
        "pre-lock nearby event adopted as current incident source",
        nowSec,
        createdBy,
      ),
    db
      .prepare(
        `UPDATE depeg_resolver_incidents
         SET current_event_id = ?,
             current_started_at = ?,
             updated_at = ?
         WHERE incident_key = ?`,
      )
      .bind(event.eventId, event.startedAt, nowSec, row.incident_key),
  ]);

  return mapIncidentRow(
    {
      ...row,
      current_event_id: event.eventId,
      current_started_at: event.startedAt,
      updated_at: nowSec,
      event_id: event.eventId,
      relation: "repair_replacement",
    },
    policyDelaySec,
  );
}

function canAutoRepairUnsealedTail(
  event: DdrCanonicalIncidentEventInput,
  row: IncidentRow,
  nowSec: number,
  policyDelaySec: number,
): boolean {
  const originalEligibleAt = row.first_started_at + policyDelaySec;
  return (
    row.incident_state === "active" &&
    event.source === "live" &&
    event.endedAt == null &&
    event.stablecoinId === row.stablecoin_id &&
    event.pegCurrency === row.peg_currency &&
    event.direction === row.direction &&
    event.startedAt > row.current_started_at &&
    event.startedAt <= originalEligibleAt &&
    nowSec < originalEligibleAt
  );
}

function canAutoRepairSealedTail(event: DdrCanonicalIncidentEventInput, row: IncidentRow): boolean {
  return (
    row.incident_state === "active" &&
    event.source === "live" &&
    event.stablecoinId === row.stablecoin_id &&
    event.pegCurrency === row.peg_currency &&
    event.direction === row.direction &&
    event.startedAt > row.current_started_at
  );
}

async function linkSealedNearbyIncidentTail(
  db: D1Database,
  event: DdrCanonicalIncidentEventInput,
  row: IncidentRow,
  options: EnsureCanonicalIncidentsOptions,
  policyDelaySec: number,
): Promise<DdrCanonicalIncident> {
  if (!canAutoRepairSealedTail(event, row)) {
    throw new DdrIncidentRepairRequiredError(
      event.eventId,
      `Unlinked depeg event ${event.eventId} overlaps nearby canonical incident ${row.incident_key}; explicit repair required`,
    );
  }

  const nowSec = optionNowSec(options);

  const linkAuthorization = await authorizeEventRepair(db, {
    eventId: event.eventId,
    incidentKey: row.incident_key,
    operation: "incident_link",
    columns: ["event_id", "incident_key"],
    reason: "Live source event reopened inside DDR sealed incident merge window",
    createdAt: nowSec,
    expiresAt: REPAIR_AUTHORIZATION_LONG_EXPIRY_AT,
    createdBy: AUTOMATED_SEALED_TAIL_REPAIR_CREATED_BY,
  });
  await consumeEventRepairAuthorization(db, {
    authorizationId: linkAuthorization.id,
    eventId: event.eventId,
    incidentKey: row.incident_key,
    operation: "incident_link",
    consumedAt: nowSec,
    consumer: AUTOMATED_SEALED_TAIL_REPAIR_CREATED_BY,
  });

  const currentAuthorization = await authorizeEventRepair(db, {
    eventId: event.eventId,
    incidentKey: row.incident_key,
    operation: "incident_current_update",
    columns: ["current_event_id", "current_started_at"],
    reason: "Live source event is the current source event for the sealed canonical incident",
    createdAt: nowSec,
    expiresAt: REPAIR_AUTHORIZATION_LONG_EXPIRY_AT,
    createdBy: AUTOMATED_SEALED_TAIL_REPAIR_CREATED_BY,
  });
  await consumeEventRepairAuthorization(db, {
    authorizationId: currentAuthorization.id,
    eventId: event.eventId,
    incidentKey: row.incident_key,
    operation: "incident_current_update",
    consumedAt: nowSec,
    consumer: AUTOMATED_SEALED_TAIL_REPAIR_CREATED_BY,
  });

  // The two authorize/consume pairs above must run sequentially because the
  // INSERTs/UPDATE below depend on their generated authorization ids. Those
  // three mechanical writes are atomic via db.batch(); the residual partial-
  // state window is between authorization consumption and this batch.
  await db.batch([
    db
      .prepare(
        `INSERT INTO depeg_resolver_incident_event_links
         (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
         VALUES (?, ?, 'repair_replacement', ?, ?, ?)`,
      )
      .bind(row.incident_key, event.eventId, linkAuthorization.id, nowSec, AUTOMATED_SEALED_TAIL_LINK_NOTE),
    db
      .prepare(
        `INSERT INTO depeg_resolver_incident_revisions
         (incident_key, previous_event_id, current_event_id, reason, repair_authorization_id, erratum_id, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .bind(
        row.incident_key,
        row.current_event_id,
        event.eventId,
        AUTOMATED_SEALED_TAIL_CURRENT_REASON,
        currentAuthorization.id,
        nowSec,
        AUTOMATED_SEALED_TAIL_REPAIR_CREATED_BY,
      ),
    db
      .prepare(
        `UPDATE depeg_resolver_incidents
         SET current_event_id = ?,
             current_started_at = ?,
             updated_at = ?
         WHERE incident_key = ?`,
      )
      .bind(event.eventId, event.startedAt, nowSec, row.incident_key),
  ]);

  return mapIncidentRow(
    {
      ...row,
      current_event_id: event.eventId,
      current_started_at: event.startedAt,
      updated_at: nowSec,
      event_id: event.eventId,
      relation: "repair_replacement",
    },
    policyDelaySec,
  );
}

export async function ensureCanonicalIncidents(
  db: D1Database,
  events: DdrCanonicalIncidentEventInput[],
  options: EnsureCanonicalIncidentsOptions,
): Promise<DdrCanonicalIncident[]> {
  if (events.length === 0) return [];
  const nowSec = optionNowSec(options);
  const policyDelaySec = optionPolicyDelaySec(options);
  assertPositiveInteger(nowSec, "nowSec");
  assertNonEmpty(options.predictionPolicyVersion, "predictionPolicyVersion");

  const eventIds = events.map((event) => {
    assertPositiveInteger(event.eventId, "eventId");
    assertPositiveInteger(event.startedAt, "startedAt");
    assertNonEmpty(event.stablecoinId, "stablecoinId");
    assertNonEmpty(event.pegCurrency, "pegCurrency");
    return event.eventId;
  });
  const linkedByEventId = await loadIncidentsByEventIds(db, eventIds, policyDelaySec);
  const ensured = new Map<number, DdrCanonicalIncident>();

  // Compute canonical keys for every unlinked event up front (pure crypto, no
  // I/O) so the key-collision check can be a single batched IN (...) query
  // instead of one sequential D1 round-trip per event. [audit S-142]
  const unlinkedEvents = events.filter((event) => !linkedByEventId.has(event.eventId));
  const identityByEventId = new Map<number, { sourceFingerprint: string; incidentKey: string }>();
  await Promise.all(
    unlinkedEvents.map(async (event) => {
      const sourceFingerprint = await sourceFingerprintForEvent(event);
      const incidentKey = await incidentKeyForEvent(event, sourceFingerprint);
      identityByEventId.set(event.eventId, { sourceFingerprint, incidentKey });
    }),
  );
  const collidingKeys = new Set(
    (await loadCanonicalIncidents(db, {
      incidentKeys: [...identityByEventId.values()].map((identity) => identity.incidentKey),
    })).map((incident) => incident.incidentKey),
  );

  for (const event of events) {
    const existing = linkedByEventId.get(event.eventId);
    if (existing) {
      ensured.set(event.eventId, existing);
      continue;
    }

    const { sourceFingerprint, incidentKey } = identityByEventId.get(event.eventId)!;
    if (collidingKeys.has(incidentKey)) {
      const keyConflict = new DdrIncidentRepairRequiredError(
        event.eventId,
        `Unlinked depeg event ${event.eventId} maps to existing incident ${incidentKey}`,
      );
      if (options.onRepairRequired) {
        options.onRepairRequired(event.eventId, keyConflict.message);
        continue;
      }
      throw keyConflict;
    }
    try {
      const nearby = await linkUnsealedNearbyIncident(db, event, options, policyDelaySec);
      if (nearby) {
        ensured.set(event.eventId, nearby);
        continue;
      }
    } catch (error) {
      if (error instanceof DdrIncidentRepairRequiredError && options.onRepairRequired) {
        options.onRepairRequired(event.eventId, error.message);
        continue;
      }
      throw error;
    }

    const policyMembership = policyMembershipForEvent(event, incidentKey, options);
    await insertNewIncident(db, event, incidentKey, sourceFingerprint, policyMembership, options);
    // Record the freshly inserted key so a within-batch duplicate is still
    // reported as a repair conflict (matching the prior per-event check that
    // re-queried after each insert). [audit S-142]
    collidingKeys.add(incidentKey);
    ensured.set(
      event.eventId,
      buildFreshIncident({ incidentKey, event, sourceFingerprint, policyMembership, nowSec, policyDelaySec }),
    );
  }

  return events
    .map((event) => ensured.get(event.eventId))
    .filter((incident): incident is DdrCanonicalIncident => !!incident);
}

export async function loadCanonicalIncidents(
  db: D1Database,
  filters: LoadCanonicalIncidentsFilters = {},
): Promise<DdrCanonicalIncident[]> {
  const policyDelaySec = optionPolicyDelaySec(filters);
  if (filters.eventIds && filters.eventIds.length > 0) {
    return [...(await loadIncidentsByEventIds(db, filters.eventIds, policyDelaySec)).values()];
  }

  const readRows = async (whereSql: string, binds: unknown[]) => {
    const result = await db
      .prepare(
        `SELECT i.*,
${DDR_INCIDENT_MEMBERSHIP_LOCK_PROJECTION}
         FROM depeg_resolver_incidents i
         LEFT JOIN depeg_resolver_incident_policy_membership m ON m.incident_key = i.incident_key
         LEFT JOIN depeg_resolver_prediction_lock_state ls ON ls.incident_key = i.incident_key
         ${whereSql}
         ORDER BY i.first_started_at DESC, i.incident_key`,
      )
      .bind(...binds)
      .all<IncidentRow>();
    return (result.results ?? []).map((row) => mapIncidentRow(row, policyDelaySec));
  };
  const scopedConditions = (filterCondition?: string) => {
    const conditions = filterCondition ? [filterCondition] : [];
    if (filters.policyUniverseIncluded != null) conditions.push("m.policy_universe_included = ?");
    if (filters.predictionPolicyVersion) conditions.push("m.prediction_policy_version = ?");
    if (!filters.includeSuperseded) conditions.push("i.incident_state = 'active'");
    return conditions;
  };
  const scopedBinds = () => [
    ...(filters.policyUniverseIncluded == null ? [] : [filters.policyUniverseIncluded ? 1 : 0]),
    ...(filters.predictionPolicyVersion ? [filters.predictionPolicyVersion] : []),
  ];

  if (filters.incidentKeys) {
    if (filters.incidentKeys.length === 0) return [];
    const extraBinds = scopedBinds();
    return runChunkedInRead(
      [...new Set(filters.incidentKeys)],
      (inClauseSql) => `WHERE ${scopedConditions(`i.incident_key IN (${inClauseSql})`).join(" AND ")}`,
      (whereSql, binds) => readRows(whereSql, [...binds, ...extraBinds]),
    );
  }

  if (filters.stablecoinIds) {
    if (filters.stablecoinIds.length === 0) return [];
    const extraBinds = scopedBinds();
    return runChunkedInRead(
      [...new Set(filters.stablecoinIds)],
      (inClauseSql) => `WHERE ${scopedConditions(`i.stablecoin_id IN (${inClauseSql})`).join(" AND ")}`,
      (whereSql, binds) => readRows(whereSql, [...binds, ...extraBinds]),
    );
  }

  const conditions = scopedConditions();
  return readRows(conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "", scopedBinds());
}

function assertLockInput(input: RecordLockDeferralInput): void {
  assertPositiveInteger(input.eventId, "eventId");
  assertPositiveInteger(input.eligibleAt, "eligibleAt");
  assertPositiveInteger(input.runAt, "runAt");
  assertNonEmpty(input.incidentKey, "incidentKey");
  assertNonEmpty(input.predictionPolicyVersion, "predictionPolicyVersion");
  assertLockMetadata(input);
}

export async function recordLockDeferral(db: D1Database, input: RecordLockDeferralInput): Promise<void> {
  assertLockInput(input);

  const createdAt = input.createdAt ?? input.runAt;
  const reason = input.reason ?? null;
  await db.batch([
    db
      .prepare(
        `INSERT INTO depeg_resolver_prediction_lock_state
         (${DDR_LOCK_STATE_INSERT_COLUMNS_SQL})
         VALUES (${lockStateInsertValuesSql("1", "?", "'lock_deferred'")})
         ${lockStateOnConflictUpdateSql({
           incrementDeferralCount: true,
           preserveDeferralReason: false,
           preserveMetadata: false,
           lastStateSql: "'lock_deferred'",
         })}`,
      )
      .bind(
        input.incidentKey,
        input.eventId,
        input.predictionPolicyVersion,
        input.eligibleAt,
        input.runAt,
        input.runAt,
        reason,
        createdAt,
        createdAt,
        ...bindLockMetadata(input),
      ),
    db
      .prepare(
        `INSERT INTO depeg_resolver_lock_opportunity_audit
         (${DDR_LOCK_AUDIT_INSERT_COLUMNS_SQL})
         VALUES (${lockAuditInsertValuesSql("NULL", "NULL", "?")})`,
      )
      .bind(
        input.incidentKey,
        input.eventId,
        input.runId ?? null,
        input.runAt,
        input.eligibleAt,
        input.healthStatus ?? "degraded",
        input.action ?? "deferred",
        reason,
        createdAt,
        ...bindLockMetadata(input),
      ),
  ]);
}

export async function recordLockOpportunity(
  db: D1Database,
  input: RecordLockDeferralInput & { action: DdrLockAuditAction },
): Promise<void> {
  if (input.action === "deferred") {
    await recordLockDeferral(db, input);
    return;
  }

  assertLockInput(input);

  const createdAt = input.createdAt ?? input.runAt;
  const stateAction =
    input.action === "publication_retry_pending" ||
    input.action === "publication_failed" ||
    input.action === "published"
      ? input.action
      : null;
  const statements: D1PreparedStatement[] = [];
  if (stateAction) {
    statements.push(
      db
        .prepare(
          `INSERT INTO depeg_resolver_prediction_lock_state
           (${DDR_LOCK_STATE_INSERT_COLUMNS_SQL})
           VALUES (${lockStateInsertValuesSql("0", "?", "?")})
           ${lockStateOnConflictUpdateSql({
             incrementDeferralCount: false,
             preserveDeferralReason: true,
             preserveMetadata: true,
             lastStateSql: "excluded.last_state",
           })}`,
        )
        .bind(
          input.incidentKey,
          input.eventId,
          input.predictionPolicyVersion,
          input.eligibleAt,
          input.runAt,
          input.runAt,
          input.reason ?? null,
          stateAction,
          createdAt,
          createdAt,
          ...bindLockMetadata(input),
        ),
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO depeg_resolver_lock_opportunity_audit
         (${DDR_LOCK_AUDIT_INSERT_COLUMNS_SQL})
         VALUES (${lockAuditInsertValuesSql("?", "?", "?")})`,
      )
      .bind(
        input.incidentKey,
        input.eventId,
        input.runId ?? null,
        input.runAt,
        input.eligibleAt,
        input.healthStatus ?? "healthy",
        input.action,
        input.confirmationAt ?? null,
        input.outcomeAt ?? null,
        input.reason ?? null,
        createdAt,
        ...bindLockMetadata(input),
      ),
  );
  await db.batch(statements);
}

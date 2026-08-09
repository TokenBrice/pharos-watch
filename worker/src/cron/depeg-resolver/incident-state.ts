import {
  DDR_LOCK_ON_TIME_GRACE_SEC,
  DDR_PUBLIC_PREDICTION_BACKSTOP_DELAY_SEC,
  DDR_PREDICTION_POLICY_VERSION,
  DDR_V2_EFFECTIVE_AT,
} from "@shared/lib/methodology-versions/depeg-resolver";
import type {
  DdrCanonicalIncident,
  DdrLockTiming,
  DdrV2StoreContracts,
} from "../depeg-resolver-v2-contracts";
import type { ComputeDepegResolverV2Options, DdrEventDbRow, DdrPendingPromotionOutcomeRow } from "./types";
import {
  fallbackIncidentForEvent,
  placeholders,
  toCanonicalIncidentInput,
} from "./utils";
import { queryRows } from "./context";

export function computeLockTiming(
  incident: DdrCanonicalIncident,
  lockedAt: number,
  eligibleAt = incident.eligibleAt,
): DdrLockTiming {
  const lockState = incident.lockState;
  if (lockState && lockState.deferralCount > 0) return "deferred";
  if (incident.confirmedAt != null && incident.confirmedAt > eligibleAt) return "late_confirmation";
  if (incident.rolloutActiveAtEnablement === true || incident.startedAt < DDR_V2_EFFECTIVE_AT) return "late_freeze";
  if (lockedAt <= eligibleAt + DDR_LOCK_ON_TIME_GRACE_SEC) return "on_time";
  return "late_freeze";
}

function pendingPromotionKey(input: {
  stablecoin_id: string;
  peg_type: string;
  direction: string;
  started_at: number;
}): string {
  return `${input.stablecoin_id}\u0000${input.peg_type}\u0000${input.direction}\u0000${input.started_at}`;
}

function maybePendingPromotedEvent(row: DdrEventDbRow): boolean {
  return row.pending_reason != null || row.confirmation_sources != null;
}

export async function loadPendingPromotionConfirmationTimes(
  db: D1Database,
  events: DdrEventDbRow[],
): Promise<{ byEventId: Map<number, number>; error: string | null }> {
  const candidates = events.filter(maybePendingPromotedEvent);
  if (candidates.length === 0) return { byEventId: new Map(), error: null };

  const stablecoinIds = [...new Set(candidates.map((row) => row.stablecoin_id))];
  const firstSeenAtValues = [...new Set(candidates.map((row) => row.started_at))];
  const result = await queryRows("depeg_pending_outcomes", () => db
    .prepare(
      `SELECT stablecoin_id, peg_type, direction, first_seen_at, outcome_at
       FROM depeg_pending_outcomes
       WHERE outcome = 'promoted'
         AND stablecoin_id IN (${placeholders(stablecoinIds.length)})
         AND first_seen_at IN (${placeholders(firstSeenAtValues.length)})`,
    )
    .bind(...stablecoinIds, ...firstSeenAtValues)
    .all<DdrPendingPromotionOutcomeRow>());
  if (result.error) return { byEventId: new Map(), error: result.error };

  const outcomeByKey = new Map<string, number>();
  for (const row of result.rows) {
    const key = pendingPromotionKey({
      stablecoin_id: row.stablecoin_id,
      peg_type: row.peg_type,
      direction: row.direction,
      started_at: row.first_seen_at,
    });
    const current = outcomeByKey.get(key);
    if (current == null || row.outcome_at > current) outcomeByKey.set(key, row.outcome_at);
  }

  const byEventId = new Map<number, number>();
  for (const event of candidates) {
    const confirmationAt = outcomeByKey.get(pendingPromotionKey({
      stablecoin_id: event.stablecoin_id,
      peg_type: event.peg_type,
      direction: event.direction,
      started_at: event.started_at,
    }));
    if (confirmationAt != null) byEventId.set(event.id, confirmationAt);
  }
  return { byEventId, error: null };
}

export function applyConfirmationTimes(
  incidentsByEventId: Map<number, DdrCanonicalIncident>,
  confirmedAtByEventId: Map<number, number>,
): void {
  for (const [eventId, confirmedAt] of confirmedAtByEventId) {
    const incident = incidentsByEventId.get(eventId);
    if (!incident) continue;
    // The incident is aliased under both eventId and currentEventId (see
    // ensureCanonicalIncidentsForEvents). Reseat both keys to a single shared
    // updated reference so the resolved confirmedAt is order-independent.
    const updated = { ...incident, confirmedAt };
    incidentsByEventId.set(eventId, updated);
    incidentsByEventId.set(incident.currentEventId, updated);
  }
}

export interface QuarantinedIncidentEvent {
  eventId: number;
  reason: string;
}

export interface EnsureCanonicalIncidentsResult {
  byEventId: Map<number, DdrCanonicalIncident>;
  /**
   * Events needing an explicit repair migration. They are excluded from this
   * run (no canonical incident, no fallback pseudo-incident) so one
   * conflicted event no longer freezes DDR publication for every other
   * incident; the repair requirement itself is unchanged.
   */
  quarantined: QuarantinedIncidentEvent[];
}

export async function ensureCanonicalIncidentsForEvents(
  stores: DdrV2StoreContracts | null | undefined,
  db: D1Database,
  events: DdrEventDbRow[],
  options: Required<Pick<ComputeDepegResolverV2Options, "ddrRunId" | "runAt">>,
): Promise<EnsureCanonicalIncidentsResult> {
  if (!stores || events.length === 0) {
    return {
      byEventId: new Map(events.map((event) => [event.id, fallbackIncidentForEvent(event)])),
      quarantined: [],
    };
  }

  const quarantined: QuarantinedIncidentEvent[] = [];
  const incidents = await stores.ensureCanonicalIncidents(
    db,
    events.map(toCanonicalIncidentInput),
    {
      runId: options.ddrRunId,
      runAt: options.runAt,
      predictionPolicyVersion: DDR_PREDICTION_POLICY_VERSION,
      policyDelaySec: DDR_PUBLIC_PREDICTION_BACKSTOP_DELAY_SEC,
      policyEffectiveAt: DDR_V2_EFFECTIVE_AT,
      onRepairRequired: (eventId, reason) => {
        quarantined.push({ eventId, reason });
      },
    },
  );
  const byEventId = new Map<number, DdrCanonicalIncident>();
  for (const incident of incidents) {
    byEventId.set(incident.eventId, incident);
    byEventId.set(incident.currentEventId, incident);
  }
  const quarantinedIds = new Set(quarantined.map((entry) => entry.eventId));
  for (const event of events) {
    if (quarantinedIds.has(event.id)) continue;
    if (!byEventId.has(event.id)) byEventId.set(event.id, fallbackIncidentForEvent(event));
  }
  return { byEventId, quarantined };
}

export async function recordSystemHealthDeferrals(input: {
  stores: DdrV2StoreContracts | null | undefined;
  db: D1Database;
  incidentsByEventId: Map<number, DdrCanonicalIncident>;
  activeRows: DdrEventDbRow[];
  nowSec: number;
  ddrRunId: string;
  runAt: number;
  syncCapabilities: Record<string, unknown>;
  reason: string;
}): Promise<number> {
  if (!input.stores) return 0;
  let count = 0;
  for (const row of input.activeRows) {
    const incident = input.incidentsByEventId.get(row.id) ?? fallbackIncidentForEvent(row);
    if (!incident.policyUniverseIncluded || input.nowSec < incident.eligibleAt) continue;
    // Sealed incidents (frozen/no_call/publication_*) must not receive deferral
    // writes: the D1 sealed lock-state trigger forbids any policy-metadata change.
    if (incident.lockState?.lastState && incident.lockState.lastState !== "pending_lock" && incident.lockState.lastState !== "lock_deferred") {
      continue;
    }
    const backstopDelaySec = Math.max(0, incident.eligibleAt - incident.startedAt);
    await input.stores.recordLockDeferral(input.db, {
      incidentKey: incident.incidentKey,
      eventId: row.id,
      runId: input.ddrRunId,
      runAt: input.runAt,
      eligibleAt: incident.eligibleAt,
      predictionPolicyVersion: DDR_PREDICTION_POLICY_VERSION,
      healthStatus: "degraded",
      action: "deferred",
      reason: input.reason,
      syncCapabilities: input.syncCapabilities,
      lockTrigger: "readiness_backstop",
      backstopAt: incident.eligibleAt,
      backstopDelaySec,
    });
    count += 1;
  }
  return count;
}

export async function recordConfirmedSeenOpportunities(input: {
  stores: DdrV2StoreContracts | null | undefined;
  db: D1Database;
  activeRows: DdrEventDbRow[];
  incidentsByEventId: Map<number, DdrCanonicalIncident>;
  confirmedAtByEventId: Map<number, number>;
  ddrRunId: string;
  runAt: number;
  syncCapabilities: Record<string, unknown>;
}): Promise<number> {
  if (!input.stores || input.confirmedAtByEventId.size === 0) return 0;

  let count = 0;
  for (const row of input.activeRows) {
    const confirmedAt = input.confirmedAtByEventId.get(row.id);
    if (confirmedAt == null) continue;
    const incident = input.incidentsByEventId.get(row.id) ?? fallbackIncidentForEvent(row);
    if (!incident.policyUniverseIncluded) continue;
    if (confirmedAt <= incident.eligibleAt) continue;
    if (incident.lockState?.lastState && incident.lockState.lastState !== "pending_lock" && incident.lockState.lastState !== "lock_deferred") {
      continue;
    }
    const backstopDelaySec = Math.max(0, incident.eligibleAt - incident.startedAt);
    await input.stores.recordLockDeferral(input.db, {
      incidentKey: incident.incidentKey,
      eventId: row.id,
      runId: input.ddrRunId,
      runAt: input.runAt,
      eligibleAt: incident.eligibleAt,
      predictionPolicyVersion: DDR_PREDICTION_POLICY_VERSION,
      healthStatus: "healthy",
      action: "confirmed_seen",
      reason: "pending-outcome-promoted",
      confirmationAt: confirmedAt,
      outcomeAt: confirmedAt,
      syncCapabilities: input.syncCapabilities,
      lockTrigger: "readiness_backstop",
      backstopAt: incident.eligibleAt,
      backstopDelaySec,
    });
    count += 1;
  }
  return count;
}

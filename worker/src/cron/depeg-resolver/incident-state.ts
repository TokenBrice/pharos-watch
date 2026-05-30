import {
  DDR_LOCK_ON_TIME_GRACE_SEC,
  DDR_PREDICTION_POLICY_VERSION,
  DDR_PUBLIC_PREDICTION_DELAY_SEC,
  DDR_V2_EFFECTIVE_AT,
} from "@shared/lib/depeg-resolver-version";
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

export function computeLockTiming(incident: DdrCanonicalIncident, lockedAt: number): DdrLockTiming {
  const lockState = incident.lockState;
  if (lockState && lockState.deferralCount > 0) return "deferred";
  if (incident.confirmedAt != null && incident.confirmedAt > incident.eligibleAt) return "late_confirmation";
  if (incident.rolloutActiveAtEnablement === true || incident.startedAt < DDR_V2_EFFECTIVE_AT) return "late_freeze";
  if (lockedAt <= incident.eligibleAt + DDR_LOCK_ON_TIME_GRACE_SEC) return "on_time";
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
    incidentsByEventId.set(eventId, { ...incident, confirmedAt });
    incidentsByEventId.set(incident.currentEventId, { ...incident, confirmedAt });
  }
}

export async function ensureCanonicalIncidentsForEvents(
  stores: DdrV2StoreContracts | null | undefined,
  db: D1Database,
  events: DdrEventDbRow[],
  options: Required<Pick<ComputeDepegResolverV2Options, "ddrRunId" | "runAt">>,
): Promise<Map<number, DdrCanonicalIncident>> {
  if (!stores || events.length === 0) {
    return new Map(events.map((event) => [event.id, fallbackIncidentForEvent(event)]));
  }

  const incidents = await stores.ensureCanonicalIncidents(
    db,
    events.map(toCanonicalIncidentInput),
    {
      runId: options.ddrRunId,
      runAt: options.runAt,
      predictionPolicyVersion: DDR_PREDICTION_POLICY_VERSION,
      policyDelaySec: DDR_PUBLIC_PREDICTION_DELAY_SEC,
      policyEffectiveAt: DDR_V2_EFFECTIVE_AT,
    },
  );
  const byEventId = new Map<number, DdrCanonicalIncident>();
  for (const incident of incidents) {
    byEventId.set(incident.eventId, incident);
    byEventId.set(incident.currentEventId, incident);
  }
  for (const event of events) {
    if (!byEventId.has(event.id)) byEventId.set(event.id, fallbackIncidentForEvent(event));
  }
  return byEventId;
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
    });
    count += 1;
  }
  return count;
}

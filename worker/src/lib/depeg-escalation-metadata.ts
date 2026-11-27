import { reviewedDepegDisputeEvidenceSql } from "@shared/data/depegs/reviewed-depeg-disposition-sql";
import {
  DDR_SEALED_TAIL_REGIME_ESCALATION_MIN_PEAK_BPS_V1,
  DDR_SEALED_TAIL_REGIME_ESCALATION_MULTIPLIER_V1,
} from "@shared/lib/depeg-config";
import { parseJsonObject } from "./json-parse";

const MEMBER_DISPUTED_EVIDENCE = reviewedDepegDisputeEvidenceSql("member", "member_prov");
const PREV_DISPUTED_EVIDENCE = reviewedDepegDisputeEvidenceSql("prev", "prev_prov");
const PREV2_DISPUTED_EVIDENCE = reviewedDepegDisputeEvidenceSql("prev2", "prev2_prov");

function incidentFamilyStatsJsonFragment(canonicalAlias: string, coinExpr: string, directionExpr: string): string {
  return `(
    SELECT json_object(
      'maxAnchorBps', MAX(CASE WHEN typeof(member.peak_escalation_anchor_bps) = 'integer' AND member.peak_escalation_anchor_bps > 0 THEN member.peak_escalation_anchor_bps END),
      'maxEscalatedAt', MAX(CASE WHEN typeof(member.peak_escalated_at) = 'integer' AND member.peak_escalated_at >= 0 THEN member.peak_escalated_at END),
      'hasInvalidEscalationTs', COALESCE(MAX(CASE WHEN member.peak_escalated_at IS NOT NULL AND (typeof(member.peak_escalated_at) != 'integer' OR member.peak_escalated_at < 0) THEN 1 ELSE 0 END), 0)
    )
      FROM depeg_resolver_incident_event_links member_link
      CROSS JOIN depeg_events member ON member.id = member_link.event_id
      LEFT JOIN depeg_event_provenance member_prov ON member_prov.event_id = member.id
     WHERE member_link.incident_key IN (
             SELECT ${canonicalAlias}.incident_key
             UNION ALL
             SELECT alias.incident_key
               FROM depeg_resolver_incidents alias
              WHERE alias.superseded_by_incident_key = ${canonicalAlias}.incident_key
                AND alias.incident_state = 'superseded'
           )
       AND member.stablecoin_id = ${coinExpr}
       AND member.direction = ${directionExpr}
       AND COALESCE(${MEMBER_DISPUTED_EVIDENCE}, 0) = 0
  )`;
}

/**
 * Indexed owner lookup: UNION of `idx_ddr_incident_current_event_all` and
 * `idx_ddr_incident_event_single_incident` avoids full-table `SCAN` on
 * `depeg_resolver_incidents` for every open event.
 */
function activeIncidentOwnerMatchFragment(ownerAlias: string, eventIdExpr: string): string {
  return `${ownerAlias}.incident_key IN (
    SELECT owner_direct.incident_key
      FROM depeg_resolver_incidents owner_direct
     WHERE owner_direct.current_event_id = ${eventIdExpr}
    UNION
    SELECT owner_link.incident_key
      FROM depeg_resolver_incident_event_links owner_link
     WHERE owner_link.event_id = ${eventIdExpr}
  )`;
}

export function linkedOpenIncidentJsonFragment(eventAlias: string): string {
  return `(
    SELECT json_object(
      'firstStartedAt', CASE WHEN typeof(canonical.first_started_at) = 'integer' THEN canonical.first_started_at END,
      'familyStats', json(${incidentFamilyStatsJsonFragment("canonical", `${eventAlias}.stablecoin_id`, `${eventAlias}.direction`)})
    )
      FROM depeg_resolver_incidents open_owner
      JOIN depeg_resolver_incidents canonical
        ON canonical.incident_key = CASE
             WHEN open_owner.incident_state = 'active' THEN open_owner.incident_key
             ELSE COALESCE(open_owner.superseded_by_incident_key, open_owner.incident_key)
           END
     WHERE canonical.incident_state = 'active'
       AND ${activeIncidentOwnerMatchFragment("open_owner", `${eventAlias}.id`)}
     ORDER BY CASE WHEN open_owner.current_event_id = ${eventAlias}.id THEN 0 ELSE 1 END ASC,
              canonical.first_started_at ASC
     LIMIT 1
  )`;
}

export const PREV_INCIDENT_JSON_FRAGMENT = `(
  SELECT json_object(
    'firstStartedAt', CASE WHEN typeof(prev_canonical.first_started_at) = 'integer' THEN prev_canonical.first_started_at END,
    'sealedOutcomeKind', CASE WHEN typeof(sealed.outcome_kind) = 'text' THEN sealed.outcome_kind END,
    'sealedLockTimePeakBps', CASE
      WHEN typeof(sealed.sealed_payload_json) = 'text'
       AND json_valid(sealed.sealed_payload_json)
       AND json_type(sealed.sealed_payload_json, '$.frozen.sourceRow.peakDeviationBps') IN ('integer', 'real')
      THEN json_extract(sealed.sealed_payload_json, '$.frozen.sourceRow.peakDeviationBps')
    END,
    'familyStats', json(${incidentFamilyStatsJsonFragment("prev_canonical", "prev.stablecoin_id", "prev.direction")})
  )
    FROM depeg_resolver_incidents prev_owner
    JOIN depeg_resolver_incidents prev_canonical
      ON prev_canonical.incident_key = CASE
           WHEN prev_owner.incident_state = 'active' THEN prev_owner.incident_key
           ELSE COALESCE(prev_owner.superseded_by_incident_key, prev_owner.incident_key)
         END
    LEFT JOIN depeg_resolver_public_predictions sealed
      ON sealed.incident_key = prev_canonical.incident_key
   WHERE prev_canonical.incident_state = 'active'
     AND ${activeIncidentOwnerMatchFragment("prev_owner", "prev.id")}
   ORDER BY CASE WHEN prev_owner.current_event_id = prev.id THEN 0 ELSE 1 END ASC,
            prev_canonical.first_started_at ASC
   LIMIT 1
)`;

/**
 * Resolves the latest eligible non-disputed closed <=6h reopen predecessor for `eventAlias`
 * and checks whether that predecessor itself has an earlier clean <=6h predecessor so unarmed
 * multi-hop unlinked chains fail closed as indeterminate instead of misclassifying >30d incidents.
 * Bind order (2 binds): [DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC, DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC].
 */
export function reopenPredecessorJsonFragment(eventAlias: string): string {
  return `(
    SELECT json_object(
      'prevStartedAt', CASE WHEN typeof(prev.started_at) = 'integer' THEN prev.started_at END,
      'prevAnchorBps', CASE WHEN typeof(prev.peak_escalation_anchor_bps) = 'integer' AND prev.peak_escalation_anchor_bps > 0 THEN prev.peak_escalation_anchor_bps END,
      'prevEscalatedAt', CASE WHEN typeof(prev.peak_escalated_at) = 'integer' AND prev.peak_escalated_at >= 0 THEN prev.peak_escalated_at END,
      'prevEscalationInvalid', CASE WHEN prev.peak_escalated_at IS NOT NULL AND (typeof(prev.peak_escalated_at) != 'integer' OR prev.peak_escalated_at < 0) THEN 1 ELSE 0 END,
      'hasEarlierPredecessor', CASE
        WHEN typeof(prev.started_at) = 'integer' AND EXISTS (
          SELECT 1
            FROM depeg_events prev2
            LEFT JOIN depeg_event_provenance prev2_prov ON prev2_prov.event_id = prev2.id
           WHERE prev2.stablecoin_id = prev.stablecoin_id
             AND prev2.direction = prev.direction
             AND prev2.id != prev.id
             AND prev2.id != ${eventAlias}.id
             AND prev2.ended_at IS NOT NULL
             AND typeof(prev2.ended_at) = 'integer'
             AND prev.started_at >= prev2.ended_at
             AND prev.started_at - prev2.ended_at <= ?
             AND COALESCE(${PREV2_DISPUTED_EVIDENCE}, 0) = 0
        ) THEN 1 ELSE 0
      END,
      'incident', json(${PREV_INCIDENT_JSON_FRAGMENT})
    )
      FROM depeg_events prev
      LEFT JOIN depeg_event_provenance prev_prov ON prev_prov.event_id = prev.id
     WHERE prev.stablecoin_id = ${eventAlias}.stablecoin_id
       AND prev.direction = ${eventAlias}.direction
       AND prev.id != ${eventAlias}.id
       AND prev.ended_at IS NOT NULL
       AND typeof(prev.ended_at) = 'integer'
       AND ${eventAlias}.started_at >= prev.ended_at
       AND ${eventAlias}.started_at - prev.ended_at <= ?
       AND COALESCE(${PREV_DISPUTED_EVIDENCE}, 0) = 0
     ORDER BY prev.ended_at DESC, prev.id DESC
     LIMIT 1
  )`;
}

/**
 * Bounded, snapshot-consistent read of open-event escalation metadata (canonical onset,
 * linked clean family max `peak_escalated_at`, and eligible <=6h reopen carry-forward).
 * Bind order: [DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC, DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC, MAX_OPEN_DEPEG_EVENTS + 1].
 */
export const OPEN_EVENT_ESCALATION_METADATA_SELECT = `SELECT /* pharos:peg-analytics:open-incident-escalation */
  open_event.id,
  open_event.started_at,
  open_event.peak_deviation_bps,
  open_event.peak_escalated_at,
  ${linkedOpenIncidentJsonFragment("open_event")} AS linked_incident_json,
  ${reopenPredecessorJsonFragment("open_event")} AS reopen_predecessor_json
  FROM depeg_events open_event
 WHERE open_event.ended_at IS NULL
 LIMIT ?`;

export function maxNullableInt(...values: Array<number | null | undefined>): number | null {
  let best: number | null = null;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) continue;
    best = best == null ? value : Math.max(best, value);
  }
  return best;
}

export function isValidOptionalEscalationTimestamp(value: unknown): boolean {
  return value == null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function positiveSafeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function readFamilyStats(value: unknown): {
  maxAnchorBps: number | null;
  maxEscalatedAt: number | null;
  hasInvalidEscalationTs: boolean;
} {
  const obj = typeof value === "string"
    ? parseJsonObject(value)
    : value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const rawAnchor = obj?.maxAnchorBps;
  const rawEscalatedAt = obj?.maxEscalatedAt;
  return {
    maxAnchorBps: positiveSafeInt(rawAnchor),
    maxEscalatedAt:
      typeof rawEscalatedAt === "number" && Number.isSafeInteger(rawEscalatedAt) && rawEscalatedAt >= 0
        ? rawEscalatedAt
        : null,
    hasInvalidEscalationTs:
      obj?.hasInvalidEscalationTs === 1 || !isValidOptionalEscalationTimestamp(rawEscalatedAt),
  };
}

export type SealedRegimeSplitVerdict = "not_split" | "split" | "indeterminate";

/**
 * Mirrors DDR `sealedTailEscalatesRegime` (`depeg-resolver-incident-store.ts`):
 * - No sealed prediction or `no_call` -> `"not_split"` (inheritance allowed).
 * - Sealed prediction with missing/non-numeric frozen lock-time peak or non-finite
 *   reopen peak -> `"indeterminate"` (DDR requires explicit repair; withhold inheritance).
 * - Reopened tail at >=1000 bps and >=4x the sealed lock-time peak -> `"split"`.
 */
export function classifySealedRegimeSplit(
  eventPeakDeviationBps: number,
  sealedOutcomeKind: string | null | undefined,
  sealedLockTimePeakBps: unknown,
): SealedRegimeSplitVerdict {
  if (sealedOutcomeKind == null || sealedOutcomeKind === "no_call") return "not_split";
  if (typeof sealedLockTimePeakBps !== "number" || !Number.isFinite(sealedLockTimePeakBps)) return "indeterminate";
  if (!Number.isFinite(eventPeakDeviationBps)) return "indeterminate";
  const newPeakBps = Math.abs(eventPeakDeviationBps);
  const lockPeakBps = Math.abs(sealedLockTimePeakBps);
  return newPeakBps >= DDR_SEALED_TAIL_REGIME_ESCALATION_MIN_PEAK_BPS_V1 &&
    newPeakBps >= DDR_SEALED_TAIL_REGIME_ESCALATION_MULTIPLIER_V1 * lockPeakBps
    ? "split"
    : "not_split";
}

export interface OpenEventEscalationMetadataRow {
  id: number;
  started_at: number;
  peak_deviation_bps: number;
  peak_escalated_at?: unknown;
  linked_incident_json?: string | null;
  reopen_predecessor_json?: string | null;
}

export type IncidentOnsetResolutionKind =
  | "linked"
  | "reopen_continuation"
  | "reopen_split"
  | "reopen_indeterminate"
  | "standalone";

export interface ResolvedOpenIncidentEscalationMetadata {
  incidentStartedAt: number;
  /**
   * True when canonical onset cannot be certified (unreadable linked `first_started_at`,
   * indeterminate sealed-regime split, or an unlinked predecessor whose own onset is
   * unreadable, already carries >30d escalation evidence, or chains to an earlier <=6h fragment).
   */
  onsetIndeterminate: boolean;
  /** True when `row.peak_escalated_at` is present but not a non-negative safe integer (e.g. REAL/negative/BLOB). */
  escalationInvalid: boolean;
  resolutionKind: IncidentOnsetResolutionKind;
  carryForwardAnchorBps: number | null;
  carryForwardEscalatedAt: number | null;
  effectiveEscalatedAt: number | null;
}

/**
 * Resolves canonical onset (clamped `<= row.started_at`) and clean family escalation metadata
 * for an open event row from its linked active DDR incident or eligible non-split <=6h reopen predecessor.
 */
export function resolveOpenIncidentEscalationMetadata(
  row: Pick<
    OpenEventEscalationMetadataRow,
    "started_at" | "peak_deviation_bps" | "peak_escalated_at" | "linked_incident_json" | "reopen_predecessor_json"
  >,
): ResolvedOpenIncidentEscalationMetadata {
  const rowEscalationInvalid = !isValidOptionalEscalationTimestamp(row.peak_escalated_at);
  const rowEscalatedAt = rowEscalationInvalid
    ? null
    : maxNullableInt(row.peak_escalated_at as number | null | undefined);
  const linked = parseJsonObject(row.linked_incident_json);
  if (linked != null) {
    const firstStartedAt = positiveSafeInt(linked.firstStartedAt);
    const stats = readFamilyStats(linked.familyStats);
    return {
      incidentStartedAt: firstStartedAt != null ? Math.min(row.started_at, firstStartedAt) : row.started_at,
      onsetIndeterminate: firstStartedAt == null,
      escalationInvalid: rowEscalationInvalid || stats.hasInvalidEscalationTs,
      resolutionKind: "linked",
      carryForwardAnchorBps: stats.maxAnchorBps,
      carryForwardEscalatedAt: stats.maxEscalatedAt,
      effectiveEscalatedAt: maxNullableInt(rowEscalatedAt, stats.maxEscalatedAt),
    };
  }

  const predecessor = parseJsonObject(row.reopen_predecessor_json);
  if (predecessor != null) {
    const incident = predecessor.incident && typeof predecessor.incident === "object" && !Array.isArray(predecessor.incident)
      ? (predecessor.incident as Record<string, unknown>)
      : null;
    const sealedOutcomeKind = typeof incident?.sealedOutcomeKind === "string" ? incident.sealedOutcomeKind : null;
    const splitVerdict = classifySealedRegimeSplit(
      row.peak_deviation_bps,
      sealedOutcomeKind,
      incident?.sealedLockTimePeakBps,
    );
    if (splitVerdict === "indeterminate") {
      return {
        incidentStartedAt: row.started_at,
        onsetIndeterminate: true,
        escalationInvalid: rowEscalationInvalid,
        resolutionKind: "reopen_indeterminate",
        carryForwardAnchorBps: null,
        carryForwardEscalatedAt: null,
        effectiveEscalatedAt: rowEscalatedAt,
      };
    }
    if (splitVerdict === "not_split") {
      const incidentFirstStartedAt = positiveSafeInt(incident?.firstStartedAt);
      const prevStartedAt = positiveSafeInt(predecessor.prevStartedAt);
      const stats = readFamilyStats(incident?.familyStats);
      const prevAnchorBps = positiveSafeInt(predecessor.prevAnchorBps);
      const prevEscalationInvalid =
        predecessor.prevEscalationInvalid === 1 || !isValidOptionalEscalationTimestamp(predecessor.prevEscalatedAt);
      const prevEscalatedAt = prevEscalationInvalid
        ? null
        : maxNullableInt(predecessor.prevEscalatedAt as number | null | undefined);
      const anchorBps = maxNullableInt(prevAnchorBps, stats.maxAnchorBps);
      const carriedEscalatedAt = maxNullableInt(prevEscalatedAt, stats.maxEscalatedAt);
      const hasEarlierPredecessor = predecessor.hasEarlierPredecessor === 1;
      const onsetIndeterminate =
        incidentFirstStartedAt == null &&
        (incident != null ||
          prevStartedAt == null ||
          anchorBps != null ||
          carriedEscalatedAt != null ||
          hasEarlierPredecessor);
      const resolvedStart = incidentFirstStartedAt ?? prevStartedAt;
      const incidentStartedAt =
        resolvedStart != null ? Math.min(row.started_at, resolvedStart) : row.started_at;
      return {
        incidentStartedAt,
        onsetIndeterminate,
        escalationInvalid: rowEscalationInvalid || prevEscalationInvalid || stats.hasInvalidEscalationTs,
        resolutionKind: "reopen_continuation",
        carryForwardAnchorBps: anchorBps,
        carryForwardEscalatedAt: carriedEscalatedAt,
        effectiveEscalatedAt: maxNullableInt(rowEscalatedAt, carriedEscalatedAt),
      };
    }
    return {
      incidentStartedAt: row.started_at,
      onsetIndeterminate: false,
      escalationInvalid: rowEscalationInvalid,
      resolutionKind: "reopen_split",
      carryForwardAnchorBps: null,
      carryForwardEscalatedAt: null,
      effectiveEscalatedAt: rowEscalatedAt,
    };
  }

  return {
    incidentStartedAt: row.started_at,
    onsetIndeterminate: false,
    escalationInvalid: rowEscalationInvalid,
    resolutionKind: "standalone",
    carryForwardAnchorBps: null,
    carryForwardEscalatedAt: null,
    effectiveEscalatedAt: rowEscalatedAt,
  };
}

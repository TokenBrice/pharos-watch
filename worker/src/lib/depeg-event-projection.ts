import { DepegEventQuoteDomainSchema, type DepegEvent } from "@shared/types/peg";
import { DEPEG_AUDIT_VERDICT_VALUES } from "@shared/types/depeg-audit";
import { z } from "zod";
import { isNativePegEvent } from "@shared/lib/depeg-quote-domain";
import { getPegTaxonomyByType } from "@shared/lib/peg-taxonomy";
import { isRetiredFromCatalog } from "@shared/lib/stablecoin-lifecycle";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { BRZ_UNVERIFIED_PEAK_EVENT_IDS } from "@shared/data/depegs/backfill-replay-suppressions";
import { reviewedDepegDisputeSql } from "@shared/data/depegs/reviewed-depeg-disposition-sql";
import { mergeDepegIntervals } from "@shared/lib/peg-utils";
import { admittedDepegRecoveryAt } from "./tape-projectors/depeg";
import { readPendingObservationReceipt, type DepegObservationReceipt } from "./depeg-pending";
import { isNativeOriginPending, isPairedDepegPeak, readDepegAdmittedCoverage, readDepegPeakQuote, readDepegProvenanceJson, type DepegRow, rowToDepegEvent } from "./depeg-helpers";

/**
 * Later of a canonical incident's own current fragment and its superseded
 * aliases' current fragments, by `current_started_at` then `current_event_id`
 * (the `buildEffectiveIncidentByKey` recency rule). One public row per logical
 * incident is this effective fragment; every other linked event is absorbed.
 */
function effectiveAliasIncidentKeySql(canonical: string): string {
  return `(SELECT alias.incident_key
             FROM depeg_resolver_incidents alias
            WHERE alias.superseded_by_incident_key = ${canonical}.incident_key
              AND alias.incident_state = 'superseded'
              AND (alias.current_started_at > ${canonical}.current_started_at
                OR (alias.current_started_at = ${canonical}.current_started_at
                    AND alias.current_event_id > ${canonical}.current_event_id))
            ORDER BY alias.current_started_at DESC, alias.current_event_id DESC
            LIMIT 1)`;
}

function effectiveAliasJoinSql(canonical: string): string {
  return `LEFT JOIN depeg_resolver_incidents effective_alias
      ON effective_alias.incident_key = ${effectiveAliasIncidentKeySql(canonical)}`;
}

function effectiveCurrentEventSql(canonical: string): string {
  return `COALESCE(effective_alias.current_event_id, ${canonical}.current_event_id)`;
}

/** Incident links stay append-only; the projection only decides visibility. */
export const EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL = `
  id NOT IN (
    SELECT links.event_id
      FROM depeg_resolver_incident_event_links links
      JOIN depeg_resolver_incidents owner
        ON owner.incident_key = links.incident_key
      JOIN depeg_resolver_incidents canonical
        ON canonical.incident_key = COALESCE(owner.superseded_by_incident_key, owner.incident_key)
      ${effectiveAliasJoinSql("canonical")}
     WHERE canonical.incident_state = 'active'
       AND links.event_id != ${effectiveCurrentEventSql("canonical")}
  )
`;

function timestampJsonSql(column: string): string {
  return `CASE WHEN typeof(${column}) = 'blob' THEN '' ELSE ${column} END`;
}

function hasValidEventWindow({ started_at, ended_at }: Pick<DepegRow, "started_at" | "ended_at">): boolean {
  return Number.isSafeInteger(started_at) && started_at > 0 &&
    (ended_at === null || (Number.isSafeInteger(ended_at) && ended_at >= started_at));
}

const KNOWN_AUDIT_VERDICTS_SQL = DEPEG_AUDIT_VERDICT_VALUES.map((verdict) => `'${verdict}'`).join(", ");

function hasKnownAuditVerdictSql(provenance: "provenance" | "first_provenance"): string {
  return `(${provenance}.audit_verdict IS NULL OR ${provenance}.audit_verdict IN (${KNOWN_AUDIT_VERDICTS_SQL}))
    AND CASE WHEN json_valid(${provenance}.public_json) THEN (
      SELECT COUNT(*) <= 1 AND COALESCE(MIN(value IN (${KNOWN_AUDIT_VERDICTS_SQL})), 1)
      FROM json_each(${provenance}.public_json) WHERE key = 'auditVerdict'
    ) ELSE 1 END`;
}

/** Correlated to e. Keep tied current peaks and distinguish malformed quote evidence from absent legacy fields. */
export const PROJECTED_DEPEG_PEAK_SQL = `(
  SELECT json_object(
    'id', member.id, 'stablecoin_id', member.stablecoin_id,
    'peg_type', CASE WHEN typeof(member.peg_type) = 'text' THEN member.peg_type END,
    'source', member.source,
    'quote_mode', CASE WHEN typeof(provenance.quote_mode) IN ('text', 'null') THEN provenance.quote_mode ELSE '' END,
    'confidence_tier', CASE WHEN typeof(provenance.confidence_tier) = 'text' THEN provenance.confidence_tier END,
    'provenance_json', CASE WHEN typeof(provenance.public_json) = 'text' THEN provenance.public_json END,
    'peg_reference', CASE WHEN typeof(member.peg_reference) IN ('integer', 'real') THEN member.peg_reference END,
    'peak_deviation_bps', CASE WHEN e.direction = 'below' THEN -ABS(member.peak_deviation_bps)
                               ELSE ABS(member.peak_deviation_bps) END,
    'peak_price', CASE WHEN typeof(member.peak_price) IN ('integer', 'real') THEN member.peak_price END,
    'peak_peg_reference', CASE WHEN typeof(member.peak_peg_reference) IN ('integer', 'real', 'null')
                               THEN member.peak_peg_reference ELSE '' END,
    'peak_quote_domain', CASE WHEN typeof(member.peak_quote_domain) IN ('text', 'null')
                              THEN member.peak_quote_domain ELSE '' END,
    'started_at', ${timestampJsonSql("member.started_at")}, 'ended_at', ${timestampJsonSql("member.ended_at")},
    'pending_reason', CASE WHEN typeof(member.pending_reason) = 'text' THEN member.pending_reason END,
    'peer_basis_json', CASE WHEN typeof(member.peer_basis_json) = 'text' THEN member.peer_basis_json END
  )
  FROM depeg_resolver_incident_event_links source_link
  JOIN depeg_resolver_incidents owner ON owner.incident_key = source_link.incident_key
  JOIN depeg_resolver_incidents root ON root.incident_key = COALESCE(owner.superseded_by_incident_key, owner.incident_key)
  JOIN depeg_resolver_incident_event_links member_link ON member_link.incident_key IN (
    SELECT root.incident_key
    UNION ALL
    SELECT alias.incident_key FROM depeg_resolver_incidents alias
     WHERE alias.superseded_by_incident_key = root.incident_key AND alias.incident_state = 'superseded'
  )
  JOIN depeg_events member ON member.id = member_link.event_id
  LEFT JOIN depeg_event_provenance provenance ON provenance.event_id = member.id
  WHERE source_link.event_id = e.id AND root.incident_state = 'active' AND owner.current_event_id = e.id
    AND owner.incident_key = COALESCE(${effectiveAliasIncidentKeySql("root")}, root.incident_key)
    AND member.stablecoin_id = e.stablecoin_id AND member.direction = e.direction
    AND ${hasKnownAuditVerdictSql("provenance")}
    AND CASE WHEN typeof(member.peak_deviation_bps) IN ('integer', 'real')
      AND member.peak_deviation_bps BETWEEN -${Number.MAX_SAFE_INTEGER} AND ${Number.MAX_SAFE_INTEGER}
      AND typeof(e.peak_deviation_bps) IN ('integer', 'real')
      AND e.peak_deviation_bps BETWEEN -${Number.MAX_SAFE_INTEGER} AND ${Number.MAX_SAFE_INTEGER}
      THEN ABS(member.peak_deviation_bps) > ABS(e.peak_deviation_bps) END
  ORDER BY ABS(member.peak_deviation_bps) DESC, member.id
  LIMIT 1
)`;

interface ActiveIncidentProjectionRow {
  current_event_id: number | null;
  first_started_at: number | null;
  first_peak_deviation_bps?: unknown;
  first_start_price: number | null;
  first_peg_reference: number | null;
  first_source?: string | null;
  first_peg_type?: string | null;
  first_quote_mode?: string | null;
  first_provenance_json?: string | null;
  first_pending_reason?: string | null;
  first_peer_basis_json?: string | null;
  current_quote_mode?: string | null;
  constituent_event_count: number | null;
  references_valid: number;
  covered_members_json?: string;
  reviewed_dispute?: number;
  incident_peak_json: string | null;
}

interface ActiveIncidentProjection {
  startedAt: number;
  onsetFragmentPeakBps?: number | null;
  startPrice: number | null;
  pegReference: number | null;
  /** First constituent's quote domain; null when its reference cannot classify one. */
  nativePeg: boolean | null;
  currentQuoteMode?: string | null;
  constituentEventCount: number;
  admittedCoverage?: DepegEvent["admittedCoverage"];
  reviewedDispute: boolean;
  peerOpening: boolean;
  peak: ReturnType<typeof readProjectedDepegPeak>;
}

export type IncidentProjectionUnavailableReason =
  | "incident-projection-read-failed"
  | "incident-projection-invalid"
  | "incident-projection-dangling-reference";

export type ActiveIncidentProjectionLoad =
  | { available: true; projections: Map<number, ActiveIncidentProjection> }
  | { available: false; reason: IncidentProjectionUnavailableReason };

export class IncidentProjectionUnavailableError extends Error {
  constructor(readonly reason: IncidentProjectionUnavailableReason = "incident-projection-read-failed") {
    super(reason);
    this.name = "IncidentProjectionUnavailableError";
  }
}

function isPeerOpening(
  onset: DepegObservationReceipt | null | undefined, pendingReason: string | null | undefined,
  price: number | null, reference: number | null,
): boolean {
  if (onset && onset.price === price && onset.pegReference === reference) return onset.basis === "peer-relative";
  return !isNativeOriginPending(pendingReason) && pendingReason?.split("+").includes("peer-relative") === true;
}

function readOpeningQuoteMode(column: unknown, provenanceJson: DepegRow["provenance_json"]) {
  return DepegEventQuoteDomainSchema.safeParse(column).data
    ?? DepegEventQuoteDomainSchema.safeParse(readDepegProvenanceJson(provenanceJson)?.quoteMode).data;
}

function normalizeActiveIncidentProjection(row: ActiveIncidentProjectionRow): [number, ActiveIncidentProjection] | null {
  if (
    !row || typeof row !== "object" ||
    row.references_valid !== 1 ||
    typeof row.current_event_id !== "number" ||
    !Number.isSafeInteger(row.current_event_id) ||
    row.current_event_id <= 0 ||
    typeof row.first_started_at !== "number" ||
    !Number.isSafeInteger(row.first_started_at) ||
    row.first_started_at <= 0 ||
    !(row.first_start_price === null ||
      (typeof row.first_start_price === "number" && Number.isFinite(row.first_start_price) && row.first_start_price >= 0)) ||
    !(row.first_peg_reference === null ||
      (typeof row.first_peg_reference === "number" && Number.isFinite(row.first_peg_reference) && row.first_peg_reference > 0)) ||
    !(row.first_source == null || typeof row.first_source === "string") ||
    !(row.first_peg_type == null || typeof row.first_peg_type === "string") ||
    !(row.first_quote_mode == null || typeof row.first_quote_mode === "string") ||
    !(row.first_pending_reason == null || typeof row.first_pending_reason === "string") ||
    !(row.first_peer_basis_json == null || typeof row.first_peer_basis_json === "string") ||
    !(row.reviewed_dispute === undefined || row.reviewed_dispute === 0 || row.reviewed_dispute === 1) ||
    typeof row.constituent_event_count !== "number" ||
    !Number.isSafeInteger(row.constituent_event_count) ||
    row.constituent_event_count <= 0
  ) {
    return null;
  }

  let admittedCoverage: DepegEvent["admittedCoverage"];
  let peak: ActiveIncidentProjection["peak"];
  try {
    if (row.incident_peak_json !== null && typeof row.incident_peak_json !== "string") return null;
    peak = readProjectedDepegPeak(row.incident_peak_json);
  } catch {
    return null;
  }
  let reviewedDispute = row.reviewed_dispute === 1;
  if (row.covered_members_json !== undefined) {
    let members: Pick<DepegRow, "id" | "started_at" | "ended_at" | "admitted_coverage_json" | "disposition">[];
    try {
      members = JSON.parse(row.covered_members_json) as typeof members;
      if (!Array.isArray(members) || members.some((member) => member == null || typeof member !== "object")) return null;
    } catch {
      return null;
    }
    if (members.length > 0) {
      const intervals = members.flatMap((member) => {
        if (!hasValidEventWindow(member)) return [];
        const admitted = readDepegAdmittedCoverage(member) ?? [];
        if (member.disposition === "repaired" && admitted.length === 0) reviewedDispute = true;
        return admitted.map(({ fromSec, toSec }): [number, number] => [fromSec, toSec]);
      });
      admittedCoverage = mergeDepegIntervals(intervals).map(([fromSec, toSec]) => ({ fromSec, toSec }));
    }
  }
  const peerOpening = isPeerOpening(readPendingObservationReceipt(row.first_peer_basis_json)?.onset,
    row.first_pending_reason, row.first_start_price, row.first_peg_reference);
  const quoteMode = readOpeningQuoteMode(row.first_quote_mode, row.first_provenance_json);
  const openingQuoteUnknown = !peerOpening && quoteMode == null && row.first_source === "live"
    && row.first_peg_reference === 1 && !getPegTaxonomyByType(row.first_peg_type ?? undefined);
  const onsetPeak = row.first_peak_deviation_bps;
  return [
    row.current_event_id,
    {
      startedAt: row.first_started_at,
      onsetFragmentPeakBps: onsetPeak === undefined || (typeof onsetPeak === "number" && Math.abs(onsetPeak) <= Number.MAX_SAFE_INTEGER)
        ? onsetPeak : null,
      startPrice: openingQuoteUnknown ? null : row.first_start_price,
      pegReference: openingQuoteUnknown ? null : row.first_peg_reference,
      nativePeg: openingQuoteUnknown || row.first_peg_reference == null
        ? null
        : !peerOpening && isNativePegEvent({
          source: row.first_source ?? undefined,
          peg_type: row.first_peg_type ?? undefined,
          peg_reference: row.first_peg_reference,
          quote_mode: quoteMode,
        }),
      currentQuoteMode: row.current_quote_mode,
      constituentEventCount: row.constituent_event_count,
      ...(admittedCoverage !== undefined ? { admittedCoverage } : {}),
      reviewedDispute,
      peerOpening,
      peak,
    },
  ];
}

function activeIncidentProjectionSql(stablecoinId: string | null): string {
    const stablecoinFilter = stablecoinId ? " AND incidents.stablecoin_id = ?" : "";
    const effectiveCurrentEvent = effectiveCurrentEventSql("incidents");
    return `SELECT
          ${effectiveCurrentEvent} AS current_event_id,
          incidents.first_started_at,
          CASE WHEN ${hasKnownAuditVerdictSql("first_provenance")}
            THEN first_event.peak_deviation_bps END AS first_peak_deviation_bps,
          first_event.start_price AS first_start_price,
          first_event.peg_reference AS first_peg_reference,
          first_event.source AS first_source,
          CASE WHEN typeof(first_event.peg_type) = 'text' THEN first_event.peg_type END AS first_peg_type,
          CASE WHEN typeof(first_provenance.quote_mode) = 'text' THEN first_provenance.quote_mode END AS first_quote_mode,
          CASE WHEN typeof(first_provenance.public_json) = 'text' THEN first_provenance.public_json END AS first_provenance_json,
          CASE WHEN typeof(first_event.pending_reason) = 'text' THEN first_event.pending_reason END AS first_pending_reason,
          CASE WHEN typeof(first_event.peer_basis_json) = 'text' THEN first_event.peer_basis_json END AS first_peer_basis_json,
          CASE WHEN typeof(current_provenance.quote_mode) = 'text' THEN current_provenance.quote_mode END AS current_quote_mode,
          COUNT(DISTINCT linked_event.id) AS constituent_event_count,
          ${PROJECTED_DEPEG_PEAK_SQL} AS incident_peak_json,
          ${reviewedDepegDisputeSql("e")} AS reviewed_dispute,
          json_group_array(json_object('id', linked_event.id, 'started_at', ${timestampJsonSql("linked_event.started_at")},
            'ended_at', ${timestampJsonSql("linked_event.ended_at")}, 'admitted_coverage_json', linked_event.admitted_coverage_json,
            'disposition', linked_event.disposition))
            FILTER (WHERE linked_event.admitted_coverage_json IS NOT NULL)
            AS covered_members_json,
          CASE WHEN first_event.id IS NOT NULL AND e.id IS NOT NULL
            AND canonical_current_event.id IS NOT NULL
            AND MAX(CASE WHEN links.event_id = incidents.first_event_id THEN 1 ELSE 0 END) = 1
            AND MAX(CASE WHEN links.event_id = incidents.current_event_id THEN 1 ELSE 0 END) = 1
            AND MAX(CASE WHEN links.event_id = ${effectiveCurrentEvent} THEN 1 ELSE 0 END) = 1
            AND COUNT(CASE WHEN links.incident_key = incidents.incident_key THEN linked_event.id END)
              = COUNT(CASE WHEN links.incident_key = incidents.incident_key THEN links.event_id END)
            THEN 1 ELSE 0 END AS references_valid
         FROM depeg_resolver_incidents incidents
         LEFT JOIN depeg_events first_event
           ON first_event.id = incidents.first_event_id
         LEFT JOIN depeg_event_provenance first_provenance
           ON first_provenance.event_id = first_event.id
         ${effectiveAliasJoinSql("incidents")}
         LEFT JOIN depeg_events e
           ON e.id = ${effectiveCurrentEvent}
         LEFT JOIN depeg_event_provenance current_provenance
           ON current_provenance.event_id = e.id
         LEFT JOIN depeg_events canonical_current_event
           ON canonical_current_event.id = incidents.current_event_id
         LEFT JOIN depeg_resolver_incident_event_links links
           ON links.incident_key = incidents.incident_key
           OR links.incident_key IN (
                SELECT alias.incident_key
                  FROM depeg_resolver_incidents alias
                 WHERE alias.superseded_by_incident_key = incidents.incident_key
                   AND alias.incident_state = 'superseded'
              )
         LEFT JOIN depeg_events linked_event
           ON linked_event.id = links.event_id
        WHERE incidents.incident_state = 'active'${stablecoinFilter}
        GROUP BY incidents.incident_key, incidents.first_started_at,
                 first_event.start_price, first_event.peg_reference,
                 first_event.source, first_event.peg_type, first_provenance.quote_mode,
                 ${effectiveCurrentEvent}`;
}

/**
 * The effective onset of one depeg-event row: an active incident's projected
 * first onset replaces the fragment's own `started_at`. One SQL authority for
 * every caller that names that clock (the public page and the summary's
 * read-time day counters).
 */
export function effectiveStartedAtSql(eventsAlias: string): string {
  return `COALESCE((
        SELECT canonical.first_started_at
          FROM depeg_resolver_incidents owner
          JOIN depeg_resolver_incidents canonical
            ON canonical.incident_key = CASE
                 WHEN owner.incident_state = 'active' THEN owner.incident_key
                 ELSE COALESCE(owner.superseded_by_incident_key, owner.incident_key)
               END
         WHERE owner.current_event_id = ${eventsAlias}.id
           AND canonical.incident_state = 'active'
           AND COALESCE(${effectiveAliasIncidentKeySql("canonical")}, canonical.incident_key) = owner.incident_key
      ), ${eventsAlias}.started_at)`;
}

/**
 * Raw fragment clocks remain intact; public pagination uses the projected onset.
 * A projection row is keyed by its effective fragment's `current_event_id`, and
 * an incident's current event is one linked event (links are unique per event),
 * so the fragment is recoverable from the page row's own id. Resolving it as one
 * correlated lookup keeps the page's reads proportional to the scanned events
 * instead of cross-joining them with the whole materialized projection.
 */
export const PUBLIC_DEPEG_EVENTS_SQL = `(
  SELECT events.*, ${effectiveStartedAtSql("events")} AS effective_started_at, ${reviewedDepegDisputeSql("events")} AS reviewed_dispute
    FROM depeg_events_with_provenance events
)`;

/** Disjoint top-K branches; limit includes the caller's lookahead row. */
export function buildPublicDepegEventsPageQuery(
  where: string,
  bindings: (string | number)[],
  limit: number,
  offset: number,
): { sql: string; bindings: (string | number)[] } {
  const ordinaryWhere = where.replace(/\beffective_started_at\b/g, "started_at");
  const sql = `SELECT events.*, ${reviewedDepegDisputeSql("events")} AS reviewed_dispute FROM (SELECT * FROM (
  WITH effective_ids AS MATERIALIZED (
    SELECT DISTINCT ${effectiveCurrentEventSql("canonical")} AS effective_event_id
      FROM depeg_resolver_incidents canonical
      ${effectiveAliasJoinSql("canonical")}
     WHERE canonical.incident_state = 'active'
  ), ordinary AS (
    SELECT events.*, events.started_at AS effective_started_at
      FROM depeg_events_with_provenance events
      ${ordinaryWhere}${ordinaryWhere ? " AND" : "WHERE"} id NOT IN (SELECT effective_event_id FROM effective_ids)
     ORDER BY started_at DESC, id DESC LIMIT ?
  ), overlay AS (
    SELECT * FROM (
      SELECT events.*, ${effectiveStartedAtSql("events")} AS effective_started_at
        FROM effective_ids
        CROSS JOIN depeg_events_with_provenance events ON events.id = effective_ids.effective_event_id
    )${where}
     ORDER BY effective_started_at DESC, id DESC LIMIT ?
  )
  SELECT * FROM ordinary UNION ALL SELECT * FROM overlay
  )
   ORDER BY effective_started_at DESC, id DESC LIMIT ? OFFSET ?) events ORDER BY effective_started_at DESC, id DESC`;
  // Each branch must contain the whole offset prefix before the final merge.
  const candidates = offset + limit;
  // Static projection/exclusion fragments contain no '?'; repeat only caller bindings.
  return { sql, bindings: [...bindings, candidates, ...bindings, candidates, limit, offset] };
}

export type PublicDepegRow = DepegRow & { effective_started_at: number; reviewed_dispute?: number };

export function prepareActiveIncidentProjections(db: D1Database, stablecoinId: string | null): D1PreparedStatement {
  const stmt = db.prepare(`SELECT /* pharos:depeg-event-projection:active-incidents */ *
    FROM (${activeIncidentProjectionSql(stablecoinId)})`);
  return stablecoinId ? stmt.bind(stablecoinId) : stmt;
}

export function decodeActiveIncidentProjections(
  result: { success?: boolean; results?: unknown[] },
): ActiveIncidentProjectionLoad {
    if (result.success === false) {
      return { available: false, reason: "incident-projection-read-failed" };
    }
    if (!Array.isArray(result.results)) {
      return { available: false, reason: "incident-projection-invalid" };
    }
    const projections = new Map<number, ActiveIncidentProjection>();
    for (const value of result.results) {
      const row = value as ActiveIncidentProjectionRow;
      const normalized = normalizeActiveIncidentProjection(row);
      if (!normalized) return {
        available: false,
        reason: row?.references_valid === 0
          ? "incident-projection-dangling-reference"
          : "incident-projection-invalid",
      };
      projections.set(normalized[0], normalized[1]);
    }
    return { projections, available: true };
}

export type DepegPeakBasisRow = Parameters<typeof readDepegPeakQuote>[0] &
  Pick<DepegRow, "started_at" | "ended_at" | "peer_basis_json" | "pending_reason">;

export function readPublicDepegPeakBasis(
  row: DepegPeakBasisRow,
  storedPeak = readPendingObservationReceipt(row.peer_basis_json)?.peak,
  { peakPegReference, peakQuoteDomain } = readDepegPeakQuote(row),
): Pick<DepegEvent, "peakBasis" | "peakPeerMedianUsd"> {
  if (peakQuoteDomain === "native-peg") return {};
  const peakReceipt = storedPeak && storedPeak.observedAt >= row.started_at
    && (row.ended_at == null || storedPeak.observedAt <= row.ended_at)
    && storedPeak.price === row.peak_price && storedPeak.pegReference === peakPegReference
    && isPairedDepegPeak(storedPeak.price, storedPeak.pegReference, storedPeak.bps) ? storedPeak : null;
  if (peakReceipt?.basis === "peer-relative") return { peakBasis: "peer-relative", peakPeerMedianUsd: peakReceipt.pegReference };
  if (!peakReceipt && row.pending_reason?.split("+").includes("peer-relative")) return { peakBasis: "peer-relative" };
  return {};
}

const projectedPeakRowSchema = z.object({
  id: z.number().int().positive(),
  stablecoin_id: z.string(),
  peg_type: z.string().nullable(),
  source: z.string(),
  quote_mode: z.string().nullable(),
  confidence_tier: z.string().nullable().default(null),
  provenance_json: z.string().nullish(),
  // The opening reference only helps infer the quote unit for legacy peaks.
  peg_reference: z.number().positive().catch(NaN),
  peak_deviation_bps: z.number(),
  peak_price: z.number().positive().nullable().catch(null),
  peak_peg_reference: z.number().positive().nullish().catch(undefined),
  peak_quote_domain: DepegEventQuoteDomainSchema.nullish().catch(undefined),
  started_at: z.number().catch(NaN),
  ended_at: z.number().nullable().catch(NaN),
  pending_reason: z.string().nullable(),
  peer_basis_json: z.string().nullable(),
});

export function readProjectedDepegPeak(encoded: string | null | undefined): Pick<DepegEvent,
  "peakDeviationBps" | "peakPrice" | "peakPegReference" | "peakQuoteDomain" | "peakBasis" | "peakPeerMedianUsd" | "peakReview" | "peakConfidenceTier"
> | null {
  if (encoded == null) return null;
  const row = projectedPeakRowSchema.parse(JSON.parse(encoded));
  const provenance = readDepegProvenanceJson(row.provenance_json);
  const confidenceTier = provenance == null ? row.confidence_tier : provenance.confidenceTier;
  const quote = readDepegPeakQuote(row);
  // An unreadable close must not be treated as an open receipt window.
  const basis = hasValidEventWindow(row) ? readPublicDepegPeakBasis(row, undefined, quote) : {};
  let peakQuoteDomain = quote.peakQuoteDomain;
  // Only legacy rows without a stored peak pair can use the event's quote provenance.
  if (peakQuoteDomain == null && row.peak_peg_reference === null && row.peak_quote_domain === null) {
    const quoteMode = row.quote_mode ?? provenance?.quoteMode;
    if (basis.peakBasis === "peer-relative") peakQuoteDomain = "usd";
    else if (quoteMode != null) peakQuoteDomain = DepegEventQuoteDomainSchema.safeParse(quoteMode).data;
    else if (row.peg_type != null && getPegTaxonomyByType(row.peg_type) && Number.isFinite(row.peg_reference)) {
      peakQuoteDomain = isNativePegEvent({ ...row, peg_type: row.peg_type }) ? "native-peg" : "usd";
    }
  }
  return {
    peakDeviationBps: row.peak_deviation_bps,
    peakConfidenceTier: typeof confidenceTier === "string" ? confidenceTier : null,
    peakPrice: peakQuoteDomain == null ? null : row.peak_price,
    ...(peakQuoteDomain != null ? { peakQuoteDomain } : {}),
    ...(basis.peakBasis !== "peer-relative" && quote.peakPegReference != null
      ? { peakPegReference: quote.peakPegReference } : {}),
    ...basis,
    ...readPeakReview(row),
  };
}

function readPeakReview(row: Pick<DepegRow, "id" | "stablecoin_id">): Pick<DepegEvent, "peakReview"> {
  return row.stablecoin_id === "brz-transfero" && (BRZ_UNVERIFIED_PEAK_EVENT_IDS as readonly number[]).includes(row.id)
    ? { peakReview: "unverified" } : {};
}

export function rowToPublicDepegEvent(
  row: DepegRow & { reviewed_dispute?: number },
  projections: Map<number, ActiveIncidentProjection>,
): DepegEvent {
  const retiredMarker = isRetiredFromCatalog(row.stablecoin_id, WORKER_TRACKED_META_BY_ID)
    ? { retired: true as const }
    : {};
  const projection = projections.get(row.id);

  // Borrow the incident onset only within the effective fragment's opening quote domain.
  const receipt = readPendingObservationReceipt(row.peer_basis_json);
  const peerOpening = isPeerOpening(receipt?.onset, row.pending_reason, row.start_price, row.peg_reference);
  const quoteMode = projection ? readOpeningQuoteMode(projection.currentQuoteMode, row.provenance_json) : undefined;
  const openingQuote = {
    source: row.source,
    peg_type: row.peg_type,
    peg_reference: row.peg_reference,
    quote_mode: quoteMode,
  };
  const currentNativePeg = !peerOpening && isNativePegEvent(openingQuote);
  const sameQuoteDomain = projection?.nativePeg === currentNativePeg;
  const onsetQuoteFromLaterFragment = projection && projection.startedAt < row.started_at
    && (!sameQuoteDomain || projection.startPrice == null || projection.pegReference == null);
  const event = rowToDepegEvent(projection ? {
    ...row,
    started_at: projection.startedAt,
    ...(sameQuoteDomain ? {
      start_price: projection.startPrice ?? row.start_price,
      peg_reference: projection.pegReference ?? row.peg_reference,
    } : {}),
  } : row);
  const publishedPeerOpening = projection && sameQuoteDomain ? projection.peerOpening : peerOpening;
  const reviewedDispute = projection?.reviewedDispute || row.reviewed_dispute === 1
    || (event.disposition === "repaired" && event.admittedCoverage?.length === 0);
  const peak = !reviewedDispute && projection?.peak && Math.abs(projection.peak.peakDeviationBps) > Math.abs(row.peak_deviation_bps)
    ? projection.peak : null;
  const peakBasis = peak ?? readPublicDepegPeakBasis(row, receipt?.peak ?? null, event);
  if (peak || peakBasis.peakBasis === "peer-relative") delete event.peakPegReference;
  if (peak) delete event.peakQuoteDomain;
  return {
    ...event,
    ...(projection ? { onsetQuoteDomain: currentNativePeg ? "native-peg" : "usd" } : {}),
    ...(onsetQuoteFromLaterFragment ? { onsetQuoteFromLaterFragment: true as const } : {}),
    ...(publishedPeerOpening ? { onsetBasis: "peer-relative" } : {}),
    ...(row.ended_at != null && (row.price_coverage_json != null || row.admitted_coverage_json != null
      || row.disposition != null || projection?.admittedCoverage !== undefined || reviewedDispute)
      ? { analyticRecoveryAt: reviewedDispute ? null : admittedDepegRecoveryAt(row) } : {}),
    ...(projection?.admittedCoverage !== undefined ? { admittedCoverage: projection.admittedCoverage } : {}),
    ...(reviewedDispute ? { provenance: { ...event.provenance, pegScoreEligible: false }, admittedCoverage: [] } : {}),
    ...peakBasis,
    ...(peak ? { currentFragmentPeakBps: row.peak_deviation_bps } : {}),
    ...(projection?.onsetFragmentPeakBps !== undefined && projection.onsetFragmentPeakBps !== row.peak_deviation_bps
      ? { onsetFragmentPeakBps: projection.onsetFragmentPeakBps } : {}),
    ...(peak ? {} : readPeakReview(row)),
    constituentEventCount: projection?.constituentEventCount ?? 1,
    ...retiredMarker,
  };
}

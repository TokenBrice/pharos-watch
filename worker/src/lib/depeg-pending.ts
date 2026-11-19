import { z } from "zod";
import { ReferenceAdmissionSchema, type ReferenceAdmission } from "@shared/types/reference-admission";
import { DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC } from "@shared/lib/depeg-closure";
import { DEPEG_PENDING_EXPIRY_SEC, DEPEG_PENDING_EXTENDED_EXPIRY_SEC, DEPEG_PENDING_SEVERE_EXPIRY_SEC, DEPEG_PRIMARY_PRICE_MAX_AGE_SEC } from "@shared/lib/depeg-config";
import { coerceDepegDirection, deriveDepegSignal, pickMoreSevereBps, signalCrossesThreshold, type DepegDirection } from "@shared/lib/depeg-signals";
import { MIN_PEER_MEDIAN_CONTRIBUTORS } from "@shared/lib/peg-reference-trust";
import { getPegTaxonomyByType } from "@shared/lib/peg-taxonomy";
import { getReferenceMarket, getReferenceSessionState } from "@shared/lib/reference-market-hours";
import { isPairedDepegPeak, isNativeOriginPending, NATIVE_ORIGIN_PENDING_REASON_FLAG, type PendingDepegReason } from "./depeg-helpers";
import { getDepegThresholdBps } from "./depeg-threshold-policy";
import { isFreshDexPoolObservation } from "./depeg-trust-policy";

export interface PendingDepegRow {
  id: number;
  stablecoin_id: string;
  symbol: string;
  peg_type: string;
  direction: string;
  first_seen_bps: number;
  first_seen_at: number;
  first_price: number;
  last_seen_bps: number | null;
  last_seen_at: number | null;
  last_price: number | null;
  peak_seen_bps: number | null;
  peak_price: number | null;
  peak_peg_reference?: number | null;
  peer_basis_json?: string | null;
  last_live_event_end_at?: number | null;
  reference_market_held_at?: number | null;
  peg_reference: number;
  reason?: PendingDepegReason;
  updated_at?: number | null;
}

export interface PendingDepegState {
  direction: DepegDirection;
  firstSeenBps: number;
  firstSeenAt: number;
  firstPrice: number;
  lastSeenBps: number;
  lastSeenAt: number;
  lastPrice: number;
  peakSeenBps: number;
  peakPrice: number;
  peakPegReference?: number | null;
  pegReference: number;
  reason: PendingDepegReason;
}

export interface PendingDepegUpsertParams {
  stablecoinId: string;
  symbol: string;
  pegType: string;
  direction: DepegDirection;
  bps: number;
  rawBps?: number;
  seenAt: number;
  quoteObservedAt?: number;
  price: number;
  pegReference: number;
  reason: PendingDepegReason;
  peerBasis?: string;
  nativeVenue?: string;
  sourceKeys?: string[];
  referenceAdmission?: ReferenceAdmission;
}

const observationReceiptSchema = z.object({
  basis: z.enum(["native-peg", "peer-relative", "benchmark"]),
  observedAt: z.number().int().positive(),
  seenAt: z.number().int().positive().optional(),
  price: z.number().finite().positive(),
  pegReference: z.number().finite().positive(),
  bps: z.number().finite(),
  venue: z.string().optional(),
  sourceKeys: z.array(z.string().min(1)).optional(),
  referenceAdmission: ReferenceAdmissionSchema.optional(),
  corroboration: z.unknown().optional(),
});
export type DepegObservationReceipt = z.output<typeof observationReceiptSchema>;

const pendingReceiptSchema = z.object({
  onset: observationReceiptSchema.nullish(),
  latest: observationReceiptSchema.nullish(),
  peak: observationReceiptSchema.nullish(),
  sourceKeys: z.array(z.string().min(1)).nullish(),
  sourceFamilies: z.array(z.string().min(1)).nullish(),
});

export function readPendingObservationReceipt(value: string | null | undefined) {
  if (!value) return null;
  try {
    const parsed = pendingReceiptSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const peerOnsetCorroborationSchema = z.object({
  basis: z.literal("peer-relative"),
  confidence: z.literal("low"),
  quoteObservedAt: z.number().int().positive(),
  contributors: z.array(z.object({
    id: z.string().trim().min(1),
    provenanceKey: z.string().trim().min(1),
    observedAtSec: z.number().int().positive(),
  })).min(MIN_PEER_MEDIAN_CONTRIBUTORS),
  corroborator: z.object({
    source: z.string().min(1).max(256),
    observedAtSec: z.number().int().positive(),
  }),
});

interface PeerObservationRow {
  stablecoin_id: string;
  peg_type: string;
  started_at: number;
  start_price?: number | null;
  peg_reference?: number;
  direction?: string;
  peer_basis_json?: string | null;
}

export function readAdmittedPeerPeak(row: PeerObservationRow & {
  peak_price?: number | null; peak_peg_reference?: number | null; peak_deviation_bps: number;
  peak_quote_domain?: string | null; ended_at?: number | null;
}) {
  if (row.peak_quote_domain === "native-peg") return null;
  const stored = readPendingObservationReceipt(row.peer_basis_json)?.peak;
  if (stored) {
    if (stored.observedAt < row.started_at || (row.ended_at != null && stored.observedAt > row.ended_at) ||
        stored.price !== row.peak_price || stored.pegReference !== row.peak_peg_reference ||
        !isPairedDepegPeak(stored.price, stored.pegReference, row.peak_deviation_bps)) return null;
    return readAdmittedPeerObservation({ ...row, started_at: stored.observedAt,
      start_price: stored.price, peg_reference: stored.pegReference }, stored);
  }
  // Promotion can retain only the onset receipt when the first print is still the peak.
  if ((row.peak_price != null && row.peak_price !== row.start_price) ||
      (row.peak_peg_reference != null && row.peak_peg_reference !== row.peg_reference) ||
      !isPairedDepegPeak(row.start_price, row.peg_reference, row.peak_deviation_bps)) return null;
  return readAdmittedPeerOnset(row);
}

export function readAdmittedPeerOnset(row: PeerObservationRow) {
  if (!row.peer_basis_json) return null;
  let json: unknown;
  try {
    json = JSON.parse(row.peer_basis_json);
  } catch {
    return null;
  }
  const envelope = z.object({ onset: z.unknown().optional(), pending: pendingReceiptSchema.optional() }).safeParse(json);
  if (!envelope.success) return null;
  const onset = observationReceiptSchema.safeParse(envelope.data.onset ?? envelope.data.pending?.onset);
  return onset.success ? readAdmittedPeerObservation(row, onset.data) : null;
}

export function readAdmittedPeerObservation(row: PeerObservationRow, observation: DepegObservationReceipt) {
  if (observation.basis !== "peer-relative" || observation.observedAt !== row.started_at ||
      (row.start_price !== undefined && observation.price !== row.start_price) ||
      (row.peg_reference !== undefined && observation.pegReference !== row.peg_reference)) return null;
  const receipt = peerOnsetCorroborationSchema.safeParse(observation.corroboration);
  const signal = deriveDepegSignal(observation.price, observation.pegReference);
  const decisionAt = observation.seenAt ?? row.started_at;
  if (!receipt.success || decisionAt < row.started_at || receipt.data.quoteObservedAt > row.started_at ||
      (observation.seenAt != null && receipt.data.quoteObservedAt !== observation.observedAt) ||
      decisionAt - receipt.data.quoteObservedAt > DEPEG_PRIMARY_PRICE_MAX_AGE_SEC || !signal ||
      Math.abs(signal.rawBps - observation.bps) > 0.5 ||
      (row.direction != null && row.direction !== signal.direction) ||
      !signalCrossesThreshold(signal, getDepegThresholdBps(row.peg_type))) return null;
  const market = getReferenceMarket(getPegTaxonomyByType(row.peg_type)?.currency);
  if (!market) return null;
  const session = getReferenceSessionState(market, decisionAt);
  const boundary = session.open ? session.sessionOpenedAtSec : session.closureStartSec;
  if (receipt.data.quoteObservedAt < boundary) return null;
  const { contributors, corroborator } = receipt.data;
  const [kind, ...corroboratorKeys] = corroborator.source.toLowerCase().split(":");
  const requiredKeys = kind === "pool" ? 2 : kind === "native" ? 1 : null;
  if (corroboratorKeys.length !== requiredKeys || corroboratorKeys.some((key) => !key || key === "unknown" || /\s/.test(key)) ||
      corroborator.observedAtSec < boundary ||
      !(kind === "pool"
        ? isFreshDexPoolObservation(corroborator.observedAtSec, decisionAt)
        : corroborator.observedAtSec <= decisionAt && decisionAt - corroborator.observedAtSec <= DEPEG_PRIMARY_PRICE_MAX_AGE_SEC)) return null;
  const ids = new Set<string>();
  const provenances = new Set<string>();
  for (const peer of contributors) {
    const key = peer.provenanceKey.toLowerCase();
    if (peer.id === row.stablecoin_id || ids.has(peer.id) || key === "unknown" || provenances.has(key) ||
        corroboratorKeys.includes(key) || peer.observedAtSec < boundary || peer.observedAtSec > decisionAt ||
        decisionAt - peer.observedAtSec > DEPEG_PRIMARY_PRICE_MAX_AGE_SEC) return null;
    ids.add(peer.id);
    provenances.add(key);
  }
  return { ...receipt.data, availableAt: decisionAt, rawBps: signal.rawBps };
}

export function getPendingExpiryLimitSec(params: {
  primarySameDirectionDepegged: boolean;
  isExtremeMove: boolean;
  unavailableSources: string[];
  circuitOpenSources: string[];
}): number {
  let expirySec = DEPEG_PENDING_EXPIRY_SEC;
  if (params.primarySameDirectionDepegged || params.unavailableSources.length > 0 || params.circuitOpenSources.length > 0) {
    expirySec = Math.max(expirySec, DEPEG_PENDING_EXTENDED_EXPIRY_SEC);
  }
  if (params.isExtremeMove) expirySec = Math.max(expirySec, DEPEG_PENDING_SEVERE_EXPIRY_SEC);
  return expirySec;
}

// Both the pending API and confirmer also read legacy schemas during migration skew.
export const SELECT_PENDING_DEPEGS_SQL = "SELECT * FROM depeg_pending";

export function normalizePendingDepegRow(row: PendingDepegRow): PendingDepegState {
  const fallbackDirectionBps = row.last_seen_bps ?? row.first_seen_bps;
  const direction = coerceDepegDirection(row.direction, fallbackDirectionBps);
  const firstSeenBps = row.first_seen_bps;
  const firstSeenAt = row.first_seen_at;
  const firstPrice = row.first_price;
  const lastSeenBps = row.last_seen_bps ?? firstSeenBps;
  const lastSeenAt = row.last_seen_at ?? firstSeenAt;
  const lastPrice = row.last_price ?? firstPrice;
  const peakSeenBps = pickMoreSevereBps(row.peak_seen_bps, firstSeenBps) ?? firstSeenBps;
  const storedPeak = peakSeenBps === row.peak_seen_bps && row.peak_price != null;
  const peakPrice = storedPeak ? row.peak_price! : firstPrice;
  const peakReference = storedPeak ? row.peak_peg_reference : row.peg_reference;

  return {
    direction,
    firstSeenBps: Math.round(firstSeenBps),
    firstSeenAt,
    firstPrice,
    lastSeenBps: Math.round(lastSeenBps),
    lastSeenAt,
    lastPrice,
    peakSeenBps: Math.round(peakSeenBps),
    peakPrice,
    peakPegReference: isPairedDepegPeak(peakPrice, peakReference, peakSeenBps) ? peakReference : null,
    pegReference: row.peg_reference,
    // Reason is stored as a "+"-joined composite of flags (see PendingDepegReason).
    // Legacy rows without a reason column fall back to the historical "large-cap" default.
    reason: row.reason ?? "large-cap",
  };
}

export function buildUpsertPendingDepegStmt(
  db: D1Database,
  params: PendingDepegUpsertParams,
): D1PreparedStatement {
  // A legacy writer can update the row while leaving a newer writer's receipt behind.
  const lastQuoteClock = `CASE WHEN json_valid(depeg_pending.peer_basis_json) THEN
    CASE WHEN json_extract(depeg_pending.peer_basis_json, '$.latest.seenAt') = depeg_pending.last_seen_at
      THEN json_extract(depeg_pending.peer_basis_json, '$.latest.observedAt') ELSE depeg_pending.last_seen_at END
    ELSE depeg_pending.last_seen_at END`;
  const nextQuoteClock = "json_extract(excluded.peer_basis_json, '$.latest.observedAt')";
  const preservesEpisode =
    `depeg_pending.direction = excluded.direction AND ` +
    `depeg_pending.peg_type = excluded.peg_type AND ` +
    `excluded.last_seen_at - depeg_pending.last_seen_at <= ${DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC} AND ` +
    `${nextQuoteClock} - (${lastQuoteClock}) <= ${DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC} AND ` +
    `(instr('+' || COALESCE(depeg_pending.reason, '') || '+', '+${NATIVE_ORIGIN_PENDING_REASON_FLAG}+') > 0) = ` +
    `(instr('+' || excluded.reason || '+', '+${NATIVE_ORIGIN_PENDING_REASON_FLAG}+') > 0)`;
  // Equal displayed bps can still have different peaks. Compare their original price/reference pairs.
  // Trial writers stored fractional bps. Match Math.round even at negative half-ties when refreshing those rows.
  const roundedBpsSql = (value: string) => `(ROUND(${value}) + (${value} - CAST(${value} AS INTEGER) = -0.5))`;
  const storedPeakBps = roundedBpsSql("COALESCE(depeg_pending.peak_seen_bps, depeg_pending.first_seen_bps)");
  const previousPeakBps = `ABS(${storedPeakBps})`;
  const strongerPeak = `(ABS(excluded.peak_seen_bps) > ${previousPeakBps} OR
    (ABS(excluded.peak_seen_bps) = ${previousPeakBps} AND COALESCE(depeg_pending.peak_peg_reference, 0) > 0 AND depeg_pending.peak_price IS NOT NULL AND
     ABS(excluded.peak_price / excluded.peak_peg_reference - 1) >
     ABS(depeg_pending.peak_price / depeg_pending.peak_peg_reference - 1)))`;
  const bps = Math.round(params.rawBps ?? params.bps);
  const observation = {
    basis: isNativeOriginPending(params.reason) ? "native-peg" : params.peerBasis ? "peer-relative" : "benchmark",
    observedAt: params.quoteObservedAt ?? params.seenAt,
    ...(params.quoteObservedAt != null || params.sourceKeys?.length ? { seenAt: params.seenAt } : {}),
    ...(params.sourceKeys?.length ? { sourceKeys: params.sourceKeys } : {}),
    pegReference: params.pegReference,
    price: params.price,
    bps,
    ...(params.referenceAdmission ? { referenceAdmission: params.referenceAdmission } : {}),
    ...(params.nativeVenue ? { venue: params.nativeVenue } : {}),
    ...(params.peerBasis ? { corroboration: JSON.parse(params.peerBasis) as unknown } : {}),
  };
  return db.prepare(
    `INSERT INTO depeg_pending (
       stablecoin_id,
       symbol,
       peg_type,
       direction,
       first_seen_bps,
       first_seen_at,
       first_price,
       last_seen_bps,
       last_seen_at,
       last_price,
       peak_seen_bps,
       peak_price,
       peg_reference,
       reason,
       updated_at,
       peak_peg_reference,
       peer_basis_json
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(stablecoin_id) DO UPDATE SET
       symbol = excluded.symbol,
       peg_type = excluded.peg_type,
       reason = excluded.reason,
       updated_at = excluded.updated_at,
       reference_market_held_at = NULL,
       peer_basis_json = CASE WHEN ${preservesEpisode} THEN json_object(
         'onset', CASE WHEN json_valid(depeg_pending.peer_basis_json) THEN
           CASE WHEN json_type(depeg_pending.peer_basis_json, '$.sourceFamilies') = 'array'
             AND json_type(depeg_pending.peer_basis_json, '$.onset') = 'object'
             AND json_extract(depeg_pending.peer_basis_json, '$.onset') = json_extract(depeg_pending.peer_basis_json, '$.latest')
             THEN json_set(json_extract(depeg_pending.peer_basis_json, '$.onset'), '$.sourceKeys',
               json_extract(depeg_pending.peer_basis_json, '$.sourceFamilies'))
             ELSE json_extract(depeg_pending.peer_basis_json, '$.onset') END END,
         'latest', json_extract(excluded.peer_basis_json, '$.latest'),
         'sourceKeys', (
           SELECT json_group_array(value) FROM (
             SELECT value FROM json_each(excluded.peer_basis_json, '$.sourceKeys')
             UNION SELECT value FROM json_each(CASE WHEN json_valid(depeg_pending.peer_basis_json) THEN
               CASE WHEN json_extract(depeg_pending.peer_basis_json, '$.latest.seenAt') = depeg_pending.last_seen_at
                 AND json_extract(depeg_pending.peer_basis_json, '$.latest.price') = depeg_pending.last_price
                 AND json_extract(depeg_pending.peer_basis_json, '$.latest.bps') = depeg_pending.last_seen_bps
                 THEN CASE
                   WHEN json_type(depeg_pending.peer_basis_json, '$.sourceKeys') = 'array'
                     THEN json_extract(depeg_pending.peer_basis_json, '$.sourceKeys')
                   WHEN json_type(depeg_pending.peer_basis_json, '$.sourceFamilies') = 'array'
                     THEN json_extract(depeg_pending.peer_basis_json, '$.sourceFamilies')
                 END END
             END) WHERE type = 'text' AND value <> ''
           )
         ),
         'peak', CASE WHEN ${strongerPeak}
           THEN json_extract(excluded.peer_basis_json, '$.peak')
           WHEN json_valid(depeg_pending.peer_basis_json) THEN json_extract(depeg_pending.peer_basis_json, '$.peak') END
       ) ELSE excluded.peer_basis_json END,
       peak_peg_reference = CASE
         WHEN ${preservesEpisode} AND NOT ${strongerPeak}
           THEN depeg_pending.peak_peg_reference
         ELSE excluded.peak_peg_reference
       END,
       direction = CASE
         WHEN ${preservesEpisode} THEN depeg_pending.direction
         ELSE excluded.direction
       END,
       first_seen_bps = CASE
         WHEN ${preservesEpisode} THEN ${roundedBpsSql("depeg_pending.first_seen_bps")}
         ELSE excluded.first_seen_bps
       END,
       first_seen_at = CASE
         WHEN ${preservesEpisode} THEN depeg_pending.first_seen_at
         ELSE excluded.first_seen_at
       END,
       first_price = CASE
         WHEN ${preservesEpisode} THEN depeg_pending.first_price
         ELSE excluded.first_price
       END,
       last_seen_bps = CASE
         WHEN ${preservesEpisode} AND excluded.last_seen_at < depeg_pending.last_seen_at THEN depeg_pending.last_seen_bps
         ELSE excluded.last_seen_bps
       END,
       last_seen_at = CASE
         WHEN ${preservesEpisode} AND excluded.last_seen_at < depeg_pending.last_seen_at THEN depeg_pending.last_seen_at
         ELSE excluded.last_seen_at
       END,
       last_price = CASE
         WHEN ${preservesEpisode} AND excluded.last_seen_at < depeg_pending.last_seen_at THEN depeg_pending.last_price
         ELSE excluded.last_price
       END,
       peak_seen_bps = CASE
         WHEN ${preservesEpisode} THEN
           CASE
             WHEN ${strongerPeak}
               THEN excluded.peak_seen_bps
             ELSE ${storedPeakBps}
           END
         ELSE excluded.peak_seen_bps
       END,
       peak_price = CASE
         WHEN ${preservesEpisode} THEN
           CASE
             WHEN ${strongerPeak}
               THEN excluded.peak_price
             ELSE COALESCE(depeg_pending.peak_price, depeg_pending.first_price)
           END
         ELSE excluded.peak_price
       END,
       peg_reference = CASE
         WHEN ${preservesEpisode} THEN depeg_pending.peg_reference
         ELSE excluded.peg_reference
       END
     WHERE depeg_pending.last_seen_at IS NULL OR (excluded.last_seen_at > depeg_pending.last_seen_at
       AND ${nextQuoteClock} > (${lastQuoteClock}))`
  ).bind(
    params.stablecoinId,
    params.symbol,
    params.pegType,
    params.direction,
    bps,
    params.seenAt,
    params.price,
    bps,
    params.seenAt,
    params.price,
    bps,
    params.price,
    params.pegReference,
    params.reason,
    params.seenAt,
    params.pegReference,
    JSON.stringify({ onset: observation, latest: observation, peak: observation, sourceKeys: params.sourceKeys }),
  );
}

/** Legacy writers can change a pending row while retaining its additive hold timestamp. */
export function pendingClosureRevision(row: PendingDepegRow, heldAt = row.reference_market_held_at ?? null): string {
  return JSON.stringify([row.id, row.stablecoin_id, row.peg_type, row.direction, row.first_seen_at, row.first_seen_bps,
    row.first_price, row.last_seen_at, row.last_seen_bps, row.last_price, row.peak_seen_bps, row.peak_price,
    row.peak_peg_reference ?? null, row.peg_reference, row.reason ?? null, row.updated_at ?? null, heldAt]);
}

function storedPendingClosureRevision(row: PendingDepegRow): unknown {
  if (!row.peer_basis_json) return null;
  try {
    return (JSON.parse(row.peer_basis_json) as { closureRevision?: unknown } | null)?.closureRevision;
  } catch {
    return null;
  }
}

export function hasCurrentPendingClosureVerdict(row: PendingDepegRow): boolean {
  return row.reference_market_held_at != null && storedPendingClosureRevision(row) === pendingClosureRevision(row);
}

export function buildPendingClosureHoldStatements(
  db: D1Database,
  row: PendingDepegRow,
  heldAt: number | null,
): D1PreparedStatement[] {
  const previous = row.reference_market_held_at ?? null;
  const revision = heldAt == null ? null : pendingClosureRevision(row, heldAt);
  if (previous === heldAt && (storedPendingClosureRevision(row) ?? null) === revision) return [];
  return [db.prepare(`UPDATE depeg_pending SET reference_market_held_at = ?,
      peer_basis_json = CASE WHEN ? IS NULL THEN
        CASE WHEN json_valid(peer_basis_json) THEN json_remove(peer_basis_json, '$.closureRevision') ELSE peer_basis_json END
      ELSE json_set(
        CASE WHEN (CASE WHEN json_valid(peer_basis_json) THEN json_type(peer_basis_json) END) = 'object'
          THEN peer_basis_json ELSE '{}' END, '$.closureRevision', ?) END
    WHERE id = ? AND direction = ? AND first_seen_at = ? AND last_seen_at IS ? AND updated_at IS ?
      AND reference_market_held_at IS ?`)
    .bind(heldAt, heldAt, revision, row.id, row.direction, row.first_seen_at, row.last_seen_at, row.updated_at ?? null, previous)];
}

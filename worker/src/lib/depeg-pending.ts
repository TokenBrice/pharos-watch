import type { DepegDirection } from "./depeg-signals";
import { DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC } from "@shared/lib/depeg-closure";
import { coerceDepegDirection, pickMoreSevereBps } from "./depeg-signals";
import type { PendingDepegReason } from "./depeg-helpers";

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
  pegReference: number;
  reason: PendingDepegReason;
}

export interface PendingDepegUpsertParams {
  stablecoinId: string;
  symbol: string;
  pegType: string;
  direction: DepegDirection;
  bps: number;
  seenAt: number;
  price: number;
  pegReference: number;
  reason: PendingDepegReason;
}

export const SELECT_PENDING_DEPEGS_SQL = `
  SELECT
    id,
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
    updated_at
  FROM depeg_pending
`;

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
  const peakPrice = peakSeenBps === row.peak_seen_bps && row.peak_price != null
    ? row.peak_price
    : firstPrice;

  return {
    direction,
    firstSeenBps,
    firstSeenAt,
    firstPrice,
    lastSeenBps,
    lastSeenAt,
    lastPrice,
    peakSeenBps,
    peakPrice,
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
  const preservesEpisode =
    `depeg_pending.direction = excluded.direction AND ` +
    `excluded.last_seen_at - depeg_pending.last_seen_at <= ${DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC}`;
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
       updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(stablecoin_id) DO UPDATE SET
       symbol = excluded.symbol,
       peg_type = excluded.peg_type,
       reason = excluded.reason,
       updated_at = excluded.updated_at,
       direction = CASE
         WHEN ${preservesEpisode} THEN depeg_pending.direction
         ELSE excluded.direction
       END,
       first_seen_bps = CASE
         WHEN ${preservesEpisode} THEN depeg_pending.first_seen_bps
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
       last_seen_bps = excluded.last_seen_bps,
       last_seen_at = excluded.last_seen_at,
       last_price = excluded.last_price,
       peak_seen_bps = CASE
         WHEN ${preservesEpisode} THEN
           CASE
             WHEN ABS(excluded.peak_seen_bps) > ABS(COALESCE(depeg_pending.peak_seen_bps, depeg_pending.first_seen_bps))
               THEN excluded.peak_seen_bps
             ELSE COALESCE(depeg_pending.peak_seen_bps, depeg_pending.first_seen_bps)
           END
         ELSE excluded.peak_seen_bps
       END,
       peak_price = CASE
         WHEN ${preservesEpisode} THEN
           CASE
             WHEN ABS(excluded.peak_seen_bps) > ABS(COALESCE(depeg_pending.peak_seen_bps, depeg_pending.first_seen_bps))
               THEN excluded.peak_price
             ELSE COALESCE(depeg_pending.peak_price, depeg_pending.first_price)
           END
         ELSE excluded.peak_price
       END,
       peg_reference = CASE
         WHEN ${preservesEpisode} THEN depeg_pending.peg_reference
         ELSE excluded.peg_reference
       END`
  ).bind(
    params.stablecoinId,
    params.symbol,
    params.pegType,
    params.direction,
    params.bps,
    params.seenAt,
    params.price,
    params.bps,
    params.seenAt,
    params.price,
    params.bps,
    params.price,
    params.pegReference,
    params.reason,
    params.seenAt,
  );
}

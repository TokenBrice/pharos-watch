import { DepegAdmittedCoverageSchema, DepegPriceCoverageSchema } from "@shared/types/peg";
import { deriveDepegSignal } from "@shared/lib/depeg-signals";
import { getDepegRecoveryThresholdBps, getDepegThresholdBps, isWithinRecoveryBand } from "../depeg-threshold-policy";
import { hasPeerDeviationReceipt, readBenchmarkOnset } from "../depeg-observation-marks";
import { readAdmittedPeerOnset, readAdmittedPeerPeak } from "../depeg-pending";
/**
 * depeg.* projectors. Source: `depeg_events` (explicit transition table).
 *
 *   - depeg.opened       : one row per newly opened depeg
 *   - depeg.resolved     : one row per row whose ended_at was filled in by recovery evidence
 *   - depeg.peak_worsened: emitted when an OPEN row's |peak_deviation_bps| grows
 *
 * peak_worsened uses a JSON map in `cache` keyed `tape-projector:peak-worsened-seen`
 * holding `{ [depegEventId]: lastSeenAbsBps }`. On each run we scan currently
 * open rows; for each row whose magnitude exceeds the previously recorded
 * peak we emit one event and update the map.
 */
import {
  buildTapeEventId,
  deriveIssuerId,
  severityForDepegOpened,
} from "../tape-event-helpers";
import { getCache, prepareCacheUpsert } from "../db-cache";
import { batchExecute, executeAtomicBatch } from "../db";
import { D1_BATCH_SIZE } from "../constants";
import { setProjectorWatermark } from "../tape-event-store";
import type { TapeEventInsert } from "../tape-event-types";
import {
  DEFAULT_BATCH_LIMIT,
  fetchRowsWithTieExpansion,
  resolveProjectorOptions,
  sourceReconciliationSince,
  type ProjectorOptions,
  type ProjectorResult,
} from "./types";
import { formatDuration, formatPrice } from "@shared/lib/format";
import { getMethodologyVersionAt } from "@shared/lib/methodology-versions/registry";
import { classifyDepegClosure, DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC, DEPEG_RECOVERY_CLOSE_REASONS } from "@shared/lib/depeg-closure";
import { getPegTaxonomyByCurrency, getPegTaxonomyByType } from "@shared/lib/peg-taxonomy";
import { reviewedDepegDisputeSql } from "@shared/data/depegs/reviewed-depeg-disposition-sql";
import { getReferenceMarket, isReferenceMarketClosed } from "@shared/lib/reference-market-hours";

const PEAK_WORSENED_CACHE_KEY = "tape-projector:peak-worsened-seen";
const AUDIT_ELIGIBLE_DEPEG_SQL = `NOT ${reviewedDepegDisputeSql("depeg_events")}`;
const OPENING_NOT_SUPPRESSED_SQL = `NOT EXISTS (
    SELECT 1 FROM tape_events WHERE source_table = 'depeg_events'
      AND source_row_id = CAST(depeg_events.id AS TEXT) AND transition = 'opened' AND suppressed_at IS NOT NULL)`;
// The rollback Worker wrote benchmark payloads without a basis discriminator.
const LEGACY_OPENING_PAYLOAD = "CASE WHEN json_valid(tape_events.payload_json) THEN json_type(tape_events.payload_json, '$.basis') END IS NULL";
const PEER_OBSERVATION_RECEIPT = `CASE WHEN json_valid(depeg_events.peer_basis_json) THEN 'peer-relative' IN (
  json_extract(depeg_events.peer_basis_json, '$.onset.basis'), json_extract(depeg_events.peer_basis_json, '$.pending.onset.basis'),
  json_extract(depeg_events.peer_basis_json, '$.latest.basis'), json_extract(depeg_events.peer_basis_json, '$.peak.basis')) END IS TRUE`;
const SOURCE_COLUMNS = `id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
  started_at, ended_at, start_price, recovery_price, peg_reference, source, close_reason, disposition,
  confirmation_sources, pending_reason, admitted_coverage_json, price_coverage_json,
  last_trusted_price_at, price_coverage_gap_started_at, recovery_peg_reference`;

export interface DepegTransitionEvidence {
  id: number;
  stablecoin_id: string;
  peg_type: string;
  started_at: number;
  start_price?: number | null;
  peg_reference?: number;
  direction?: string;
  ended_at: number | null;
  disposition?: string | null;
  pending_reason?: string | null;
  confirmation_sources?: string | null;
  admitted_coverage_json?: string | null;
  price_coverage_json?: string | null;
  last_trusted_price_at?: number | null;
  price_coverage_gap_started_at?: number | null;
  peer_basis_json?: string | null;
}

interface DepegSourceRow extends DepegTransitionEvidence {
  symbol: string;
  direction: string;
  peak_deviation_bps: number;
  start_price: number | null;
  peak_price?: number | null;
  peak_peg_reference?: number | null;
  peak_quote_domain?: string | null;
  recovery_price?: number | null;
  recovery_peg_reference?: number | null;
  peg_reference: number;
  source: string;
  close_reason?: string | null;
  source_preimage: string;
  has_peer_receipt?: number;
  has_stored_onset?: number;
}

function observedPriceCoverage(row: DepegTransitionEvidence) {
  if (row.price_coverage_json == null) return null;
  try {
    return DepegPriceCoverageSchema.safeParse({
      ...JSON.parse(row.price_coverage_json),
      lastTrustedObservationAt: row.last_trusted_price_at ?? null,
      gapStartedAt: row.price_coverage_gap_started_at ?? null,
    }).data ?? null;
  } catch {
    return null;
  }
}

export function admittedDepegOnset(row: DepegTransitionEvidence): number | null {
  if (row.disposition === "restored-evidenced") return row.started_at;
  if (row.admitted_coverage_json != null) {
    try {
      const coverage = DepegAdmittedCoverageSchema.safeParse(JSON.parse(row.admitted_coverage_json));
      if (!coverage.success || coverage.data.some(({ fromSec, toSec }) =>
        fromSec < row.started_at || (row.ended_at != null && toSec > row.ended_at))) return null;
      const onset = observedPriceCoverage(row)?.intervals[0];
      if (onset?.[0] === row.started_at && onset[0] === onset[1]) return onset[0];
      return coverage.data[0]?.fromSec ?? null;
    } catch {
      return null;
    }
  }
  if (hasPeerDeviationReceipt(row)) {
    if (readAdmittedPeerOnset(row)) return row.started_at;
    const benchmark = readBenchmarkOnset(row);
    if (!benchmark) return null;
    if (benchmark.admission) return benchmark.admission.quoteObservedAtSec === row.started_at ? row.started_at : null;
  }
  if (!isReferenceMarketClosed(getReferenceMarket(pegCurrencyForType(row.peg_type)), row.started_at)) return row.started_at;
  // This reviewed BRZ onset predates the stored OR-2 confirmation marker.
  if (row.id === 91044 && row.stablecoin_id === "brz-transfero" && row.started_at === 1794678383) return row.started_at;

  return null;
}

type ProjectedClaim = { event: TapeEventInsert; row: DepegSourceRow };

function prepareDepegClaim(db: D1Database, { event, row }: ProjectedClaim, nowSec: number): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO tape_events (event_id, type, severity, ts, ends_at, coin_id, issuer_id, peg_currency,
      chain, title, summary, payload_json, source_table, source_row_id, transition, source_url,
      methodology_version, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM depeg_events WHERE id = ?
      AND source = 'live' AND json_array(${SOURCE_COLUMNS}) = ?
      ${row.peer_basis_json === undefined ? "" : "AND peer_basis_json IS ? AND peak_price IS ? AND peak_peg_reference IS ? AND peak_quote_domain IS ?"} AND ${AUDIT_ELIGIBLE_DEPEG_SQL}
      ${event.transition === "updated" ? `AND ${OPENING_NOT_SUPPRESSED_SQL}` : ""})
    ON CONFLICT(source_table, source_row_id, transition) DO UPDATE SET
      ts = excluded.ts, ends_at = excluded.ends_at, summary = excluded.summary, payload_json = excluded.payload_json,
      methodology_version = excluded.methodology_version
      ${event.transition === "opened" ? `, title = excluded.title, severity = excluded.severity
        WHERE tape_events.transition = 'opened' AND tape_events.suppressed_at IS NULL
          AND json_extract(excluded.payload_json, '$.basis') IN ('benchmark', 'peer-relative') AND ${LEGACY_OPENING_PAYLOAD}`
        : `WHERE tape_events.transition = 'resolved' AND tape_events.suppressed_at IS NULL
          AND tape_events.ts IS NOT excluded.ts`}`).bind(event.eventId, event.type, event.severity, event.ts, event.endsAt, event.coinId,
      event.issuerId, event.pegCurrency, event.chain, event.title, event.summary, JSON.stringify(event.payload),
      event.sourceTable, event.sourceRowId, event.transition, event.sourceUrl, event.methodologyVersion, nowSec,
      row.id, row.source_preimage, ...(row.peer_basis_json === undefined ? [] : [row.peer_basis_json, row.peak_price ?? null, row.peak_peg_reference ?? null, row.peak_quote_domain ?? null]));
}

function coinSourceUrl(coinId: string): string {
  return `/stablecoin/${encodeURIComponent(coinId)}/#peg-history`;
}

/**
 * `depeg_events.peg_type` stores the canonical peg type (`peggedUSD`);
 * `tape_events.peg_currency` and the public peg filter use the peg currency
 * (`USD`). Resolve through the shared registry so an unknown type stays null
 * instead of leaking an unfilterable value into the column.
 */
function pegCurrencyForType(pegType: string): string | null {
  return getPegTaxonomyByType(pegType)?.currency
    ?? getPegTaxonomyByCurrency(pegType.replace(/^pegged/i, ""))?.currency
    ?? null;
}

function classCursorKey(variant: "opened" | "resolved"): string {
  return variant === "opened" ? "depeg.opened" : "depeg.resolved";
}

async function fetchDepegRows(
  db: D1Database,
  variant: "opened" | "resolved",
  since: number,
  until: number | null,
  limit: number,
): Promise<DepegSourceRow[]> {
  const timeColumn = variant === "opened" ? "started_at" : "ended_at";
  const trailingWhereSql = variant === "opened"
    ? " AND source = 'live'"
    : ` AND source = 'live' AND ended_at IS NOT NULL
        AND (close_reason IN (${DEPEG_RECOVERY_CLOSE_REASONS.map(() => "?").join(",")})
          OR (close_reason IS NULL AND recovery_price IS NOT NULL))`;

  return fetchRowsWithTieExpansion<DepegSourceRow>(db, {
    selectSql: `SELECT depeg_events.*, json_array(${SOURCE_COLUMNS}) AS source_preimage
      ${variant === "opened" ? `, ${PEER_OBSERVATION_RECEIPT} AS has_peer_receipt,
        CASE WHEN json_valid(peer_basis_json) THEN (json_type(peer_basis_json, '$.onset') IS NOT NULL
          OR json_type(peer_basis_json, '$.pending.onset') IS NOT NULL) END AS has_stored_onset` : ""}`,
    fromSql: "depeg_events",
    timeColumn,
    trailingWhereSql: `${trailingWhereSql}
      AND ${AUDIT_ELIGIBLE_DEPEG_SQL}
      AND NOT EXISTS (
        SELECT 1 FROM tape_events INDEXED BY idx_tape_source_key
        WHERE source_table = 'depeg_events'
          AND source_row_id = CAST(depeg_events.id AS TEXT) AND transition = ?
          ${variant === "resolved" ? `AND (suppressed_at IS NOT NULL OR (ts IS ends_at AND (
            depeg_events.price_coverage_json IS NULL OR depeg_events.last_trusted_price_at IS NULL
            OR ts = 1000 * depeg_events.last_trusted_price_at)))` : `AND (suppressed_at IS NOT NULL
            OR NOT (${PEER_OBSERVATION_RECEIPT})
            OR NOT (${LEGACY_OPENING_PAYLOAD}))`}
      )`,
    trailingBinds: [
      ...(variant === "resolved" ? DEPEG_RECOVERY_CLOSE_REASONS : []),
      variant,
    ],
    orderBySql: `${timeColumn} ASC, id ASC`,
    since,
    until,
    limit,
    getTime: (row) => variant === "opened" ? row.started_at : row.ended_at,
  });
}

export function admittedDepegRecoveryAt(row: DepegTransitionEvidence & {
  close_reason?: string | null;
  recovery_price?: number | null;
  recovery_peg_reference?: number | null;
}, options?: { inferLegacyClose: boolean }): number | null {
  const closure = classifyDepegClosure({
    endedAt: row.ended_at,
    closeReason: row.close_reason,
    recoveryPrice: row.recovery_price ?? null,
  });
  const end = row.ended_at;
  if (end == null || (closure !== "recovered" && closure !== "legacy_recovered")) return null;
  const inferLegacy = options?.inferLegacyClose && row.admitted_coverage_json == null && row.disposition == null;
  // Legacy primary price coverage predates reference admission and can be blind at a DEX recovery.
  if (inferLegacy && row.recovery_peg_reference == null) return end;
  const currency = pegCurrencyForType(row.peg_type);
  const recoveryReference = row.recovery_peg_reference ?? (currency === "USD" ? 1 : null);
  const recovery = recoveryReference != null && row.recovery_price != null
    ? deriveDepegSignal(row.recovery_price, recoveryReference) : null;
  if (recovery && !isWithinRecoveryBand(recovery.absRawBps, getDepegRecoveryThresholdBps(row.peg_type))) return null;
  const coverage = observedPriceCoverage(row);
  const observedAt = coverage?.lastTrustedObservationAt ?? end;
  const atPar = observedAt >= row.started_at && observedAt <= end && end - observedAt <= DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC
    && coverage?.atParIntervals?.some(([from, to]) => from <= observedAt && observedAt <= to);
  const market = getReferenceMarket(currency);
  if (isReferenceMarketClosed(market, end) || isReferenceMarketClosed(market, observedAt)) {
    return atPar && row.recovery_peg_reference != null && recovery != null ? observedAt : null;
  }
  if (atPar && recovery) return observedAt;
  // A fixed one-dollar reference alone does not introduce an admitted-coverage requirement.
  if (inferLegacy && currency === "USD" && row.recovery_peg_reference === 1 &&
    (row.recovery_price == null || recovery != null)) return end;
  const legacy = row.recovery_price != null && row.recovery_peg_reference == null && row.price_coverage_json == null &&
    row.admitted_coverage_json == null && row.disposition == null;
  return legacy ? end : null;
}

async function projectDepegByVariant(
  db: D1Database,
  variant: "opened" | "resolved",
  options: ProjectorOptions | undefined,
): Promise<ProjectorResult> {
  const cursorKey = classCursorKey(variant);
  const { since, until, limit } = await resolveProjectorOptions(db, cursorKey, options);

  const claims: ProjectedClaim[] = [];
  let after = sourceReconciliationSince(options);
  let maxCursor = since;
  let scanned = false;
  while (claims.length < limit) {
    const rows = await fetchDepegRows(db, variant, after, until, limit - claims.length);
    if (rows.length === 0) break;
    scanned = true;
    let pageEnd = after;
    for (const row of rows) {
      const tsSec = variant === "opened" ? row.started_at : (row.ended_at ?? row.started_at);
      if (tsSec <= after) continue;
      pageEnd = Math.max(pageEnd, tsSec);
      const analyticEnd = admittedDepegRecoveryAt(row);
      if (variant === "resolved" ? analyticEnd == null : admittedDepegOnset(row) !== row.started_at) continue;

      const occurrenceSec = variant === "resolved" ? analyticEnd! : tsSec;
      const tsMs = occurrenceSec * 1000;
      const peer = variant === "opened" ? readAdmittedPeerOnset(row) : readAdmittedPeerPeak(row);
      const mixedOpening = variant === "opened" && !peer && hasPeerDeviationReceipt(row);
      const benchmark = mixedOpening ? readBenchmarkOnset(row) : null;
      let openingSignal = benchmark && (!benchmark.admission || benchmark.admission.quoteObservedAtSec === row.started_at)
        ? benchmark.signal : undefined;
      if (mixedOpening && !openingSignal && row.has_stored_onset === 0 && readAdmittedPeerPeak(row)) {
        // Older coverage can prove the onset without storing a separate benchmark receipt.
        const signal = row.start_price == null ? null : deriveDepegSignal(row.start_price, row.peg_reference);
        if (!signal || signal.direction !== row.direction || signal.absRawBps < getDepegThresholdBps(row.peg_type)) continue;
        openingSignal = signal;
      }
      if ((mixedOpening || row.has_peer_receipt) && !peer && !openingSignal) continue;
      const signedBps = peer ? Math.round(peer.rawBps) : openingSignal?.bps ?? row.peak_deviation_bps;
      const absBps = Math.abs(signedBps);
      const sign = row.direction === "below" ? "−" : "+";
      const type = variant === "opened" ? "depeg.opened" : "depeg.resolved";
      const severity = variant === "opened" ? severityForDepegOpened(absBps) : "info";
      const transition = variant === "opened" ? "opened" : "resolved";
      const sourceRowId = String(row.id);

      const peerMagnitude = `${sign}${absBps} bps from the peer median (lower confidence)`;
      const title = peer ? `${row.symbol} peer-relative incident ${variant}, ${peerMagnitude}` : variant === "opened"
        ? `${row.symbol} depeg opened (${sign}${absBps} bps)`
        : `${row.symbol} depeg resolved`;
      const directionWord = row.direction === "below" ? "below" : "above";
      const summary = peer ? (variant === "opened"
        ? `${row.symbol} traded ${peerMagnitude}.` : `Resolved after ${formatDuration(row.started_at, analyticEnd!)}. Peak ${peerMagnitude}.`)
        : variant === "opened"
        ? (row.start_price != null
            ? `Trading at ${formatPrice(row.start_price)} (${directionWord} peg).`
            : `${row.symbol} crossed peg threshold (${directionWord} peg).`)
        : (analyticEnd != null
            ? `Resolved after ${formatDuration(row.started_at, analyticEnd)} (peak ${sign}${absBps} bps).`
            : `Resolved (peak ${sign}${absBps} bps).`);

      claims.push({ row, event: {
        eventId: buildTapeEventId({ tsMs, type, sourceTable: "depeg_events", sourceRowId, transition }),
        type,
        severity,
        ts: tsMs,
        endsAt: analyticEnd == null ? null : analyticEnd * 1000,
        coinId: row.stablecoin_id,
        issuerId: deriveIssuerId(row.stablecoin_id),
        pegCurrency: pegCurrencyForType(row.peg_type),
        chain: null,
        title,
        summary,
        payload: {
          symbol: row.symbol,
          direction: row.direction,
          ...(peer ? { basis: "peer-relative", confidence: peer.confidence, peerDeviationBps: signedBps } : {
            ...(openingSignal ? { basis: "benchmark" } : {}),
            absDeviationBps: absBps, signedDeviationBps: signedBps, pegReference: row.peg_reference,
            startedAt: row.started_at, endedAt: analyticEnd,
          }),
        },
        sourceTable: "depeg_events",
        sourceRowId,
        transition,
        sourceUrl: coinSourceUrl(row.stablecoin_id),
        methodologyVersion: getMethodologyVersionAt("depeg-dews", occurrenceSec),
      } });
    }
    if (pageEnd <= after) break;
    after = pageEnd;
    maxCursor = Math.max(maxCursor, pageEnd);
  }
  if (!scanned) return { projected: 0, advanced: null };
  if (options?.dryRun) return { projected: claims.length, advanced: null };
  const nowSec = Math.floor(Date.now() / 1000);
  const projected = await batchExecute(db, claims.map((claim) => prepareDepegClaim(db, claim, nowSec)));
  if (options?.since == null && options?.until == null) await setProjectorWatermark(db, cursorKey, maxCursor);
  return { projected, advanced: maxCursor };
}

export function projectDepegOpened(db: D1Database, options?: ProjectorOptions): Promise<ProjectorResult> {
  return projectDepegByVariant(db, "opened", options);
}

export function projectDepegResolved(db: D1Database, options?: ProjectorOptions): Promise<ProjectorResult> {
  return projectDepegByVariant(db, "resolved", options);
}

interface PeakWorsenedSeenMap {
  [depegEventId: string]: number;   // last seen |peak_deviation_bps|
}

async function loadPeakSeenMap(db: D1Database): Promise<PeakWorsenedSeenMap> {
  const row = await getCache(db, PEAK_WORSENED_CACHE_KEY);
  if (!row) return {};
  try {
    const parsed: unknown = JSON.parse(row.value);
    // A corrupt cached peak must not suppress a future peak-worsened event.
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      && Object.values(parsed).every((value: unknown) => typeof value === "number" && Number.isFinite(value))
      ? (parsed as PeakWorsenedSeenMap)
      : {};
  } catch {
    return {};
  }
}

async function fetchOpenDepegRows(
  db: D1Database,
  since: number | null,
  until: number | null,
  afterId: number | null,
  limit: number,
): Promise<DepegSourceRow[]> {
  const conditions = ["source = 'live'", "ended_at IS NULL", AUDIT_ELIGIBLE_DEPEG_SQL, OPENING_NOT_SUPPRESSED_SQL];
  const binds: unknown[] = [];
  if (since != null) {
    conditions.push("started_at > ?");
    binds.push(since);
  }
  if (until != null) {
    conditions.push("started_at <= ?");
    binds.push(until);
  }
  if (afterId != null) {
    conditions.push("id > ?");
    binds.push(afterId);
  }

  const sql = `SELECT depeg_events.*, json_array(${SOURCE_COLUMNS}) AS source_preimage
                 FROM depeg_events
                 WHERE ${conditions.join(" AND ")}
                 ORDER BY id ASC
                 LIMIT ?`;
  const result = await db.prepare(sql).bind(...binds, limit).all<DepegSourceRow>();
  return result.results ?? [];
}

/**
 * For each OPEN depeg row whose magnitude exceeds the previously recorded
 * peak, emit one `depeg.peak_worsened` event. Idempotent because the source
 * row id encodes the new magnitude: re-running with the same DB state is a
 * no-op (the unique index on `(source_table, source_row_id, transition)`
 * absorbs duplicates).
 */
export async function projectDepegPeakWorsened(
  db: D1Database,
  options?: ProjectorOptions,
): Promise<ProjectorResult> {
  const dryRun = options?.dryRun === true;
  const since = options?.since ?? null;
  const until = options?.until ?? null;
  // Fill the cap with eligible rows, paging past unsupported open events.
  const maxRows = options?.maxRows ?? null;
  const seenMap = await loadPeakSeenMap(db);
  // Keep observations outside any bounded backfill intact. Only an unbounded
  // census can rebuild the map from currently open rows and prune closures.
  const nextMap: PeakWorsenedSeenMap = since != null || until != null || maxRows != null
    ? { ...seenMap }
    : {};
  const claims: ProjectedClaim[] = [];
  const nowMs = Date.now();
  let afterId: number | null = null;
  let assessed = 0;

  while (true) {
    const pageLimit = maxRows == null ? DEFAULT_BATCH_LIMIT : Math.min(DEFAULT_BATCH_LIMIT, maxRows - assessed);
    const rows = await fetchOpenDepegRows(db, since, until, afterId, pageLimit);
    for (const row of rows) {
      if (maxRows != null && assessed >= maxRows) break;
      if (admittedDepegOnset(row) !== row.started_at) continue;
      assessed++;
      const key = String(row.id);
      const absBps = Math.abs(row.peak_deviation_bps);
      const prevAbsBps = nextMap[key] ?? seenMap[key] ?? 0;
      nextMap[key] = Math.max(absBps, prevAbsBps);

      if (absBps <= prevAbsBps) continue;
      if (prevAbsBps === 0) {
        // First time we have seen this open row in the seen-map. Treat it as a
        // baseline observation and do not emit — the row's `depeg.opened` event
        // already carries its initial magnitude. Future runs will only fire on
        // a genuine worsening past this baseline.
        continue;
      }

      const sign = row.direction === "below" ? "−" : "+";
      const peer = readAdmittedPeerPeak(row);
      const peakLabel = `${sign}${absBps} bps${peer ? " from the peer median (lower confidence)" : ""}`;
      const sourceRowId = `${row.id}:${absBps}`;
      const transition = "updated";
      const type = "depeg.peak_worsened";

      claims.push({ row, event: {
        eventId: buildTapeEventId({ tsMs: nowMs, type, sourceTable: "depeg_events", sourceRowId, transition }),
        type,
        severity: severityForDepegOpened(absBps),
        ts: nowMs,
        endsAt: null,
        coinId: row.stablecoin_id,
        issuerId: deriveIssuerId(row.stablecoin_id),
        pegCurrency: pegCurrencyForType(row.peg_type),
        chain: null,
        title: peer ? `${row.symbol} peer-relative peak widened to ${peakLabel}` : `${row.symbol} depeg peak worsened (${peakLabel})`,
        summary: peer ? `Peer-relative deviation reached ${peakLabel}.` : `Deviation widened to ${sign}${absBps} bps from ${sign}${prevAbsBps} bps.`,
        payload: {
          symbol: row.symbol,
          direction: row.direction,
          ...(peer ? { basis: "peer-relative", confidence: peer.confidence, peerDeviationBps: row.peak_deviation_bps } : {
            absDeviationBps: absBps, prevAbsDeviationBps: prevAbsBps, signedDeviationBps: row.peak_deviation_bps,
            pegReference: row.peg_reference, startedAt: row.started_at,
          }),
          depegEventId: row.id,
        },
        sourceTable: "depeg_events",
        sourceRowId,
        transition,
        sourceUrl: coinSourceUrl(row.stablecoin_id),
        methodologyVersion: getMethodologyVersionAt("depeg-dews", row.started_at),
      } });
    }

    if (rows.length < pageLimit) break;
    if (maxRows != null && assessed >= maxRows) break;
    const lastId = rows[rows.length - 1]?.id;
    if (lastId == null || (afterId != null && lastId <= afterId)) break;
    afterId = lastId;
  }

  if (dryRun) return { projected: claims.length, advanced: null };
  const nowSec = Math.floor(nowMs / 1000);
  if (claims.length === 0) {
    await prepareCacheUpsert(db, { key: PEAK_WORSENED_CACHE_KEY, value: JSON.stringify(nextMap), updatedAt: nowSec }).run();
    return { projected: 0, advanced: null };
  }
  const claimKeys = Object.fromEntries(claims.map(({ row, event }) => [row.id, event.sourceRowId]));
  // Commit each bounded claim batch with its matching checkpoint. A claim rejected by
  // the source pre-image guard leaves that event's prior peak available for retry.
  const checkpoint = db.prepare(`WITH peaks AS (
    SELECT n.key, CASE WHEN claim.value IS NULL OR EXISTS (
      SELECT 1 FROM tape_events WHERE source_table = 'depeg_events'
        AND source_row_id = claim.value AND transition = 'updated'
    ) THEN n.value ELSE prior.value END AS bps
    FROM json_each(?1) n LEFT JOIN json_each(?2) claim ON claim.key = n.key
    LEFT JOIN json_each(?3) prior ON prior.key = n.key)
    INSERT INTO cache (key, value, updated_at)
    SELECT ?4, json_group_object(key, bps), ?5 FROM peaks WHERE bps IS NOT NULL
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(JSON.stringify(nextMap), JSON.stringify(claimKeys), JSON.stringify(seenMap), PEAK_WORSENED_CACHE_KEY, nowSec);
  let projected = 0;
  const claimLimit = D1_BATCH_SIZE - 1;
  for (let start = 0; start < claims.length; start += claimLimit) {
    const batch = claims.slice(start, start + claimLimit).map((claim) => prepareDepegClaim(db, claim, nowSec));
    projected += await executeAtomicBatch(db, [...batch, checkpoint]) - 1;
  }
  return { projected, advanced: null };
}

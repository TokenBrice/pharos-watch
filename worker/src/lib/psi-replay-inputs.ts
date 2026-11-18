import { PEG_SCORE_EXCLUDED_AUDIT_VERDICTS, type DepegAuditVerdict } from "@shared/types/depeg-audit";
import { isPegScoreExcludedAuditVerdict } from "@shared/lib/depeg-audit";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { getPegTaxonomyByType } from "@shared/lib/peg-taxonomy";
import { DEPEG_SEVERITY_BPS } from "@shared/lib/depeg-config";
import { deriveDepegSignal } from "@shared/lib/depeg-signals";
import { getReferenceMarket, isReferenceMarketClosed, replayReferenceMarketEventStart } from "@shared/lib/reference-market-hours";
import { reviewedDepegDisputeSql } from "@shared/data/depegs/reviewed-depeg-disposition-sql";
import { readAdmittedPeerOnset } from "./depeg-pending";
import { hasPeerDeviationReceipt, readBenchmarkOnset } from "./depeg-observation-marks";
import { readDepegCoverageLedger } from "./depeg-helpers";
import { auditVerdictNotInSql } from "./depeg-audit";
import { buildInClause } from "./db";
import { getHistoricalPsiSupplyWindow } from "./psi-history-universe";
import { buildHistoricalReferenceLookup, fetchHistoricalCommodityPeers, HISTORICAL_INTRADAY_PAIRING_SEC, type CommodityPeg } from "./backfill-fx";
import { buildSupplySnapshotMap, type PsiDepegEventRow, type PsiSupplyRow } from "./psi-recompute";
import { buildHistoricalDewsMap, type PsiHistoricalDewsRow } from "./psi-replay";

export interface PsiEligibleDepegEventRow extends PsiDepegEventRow {
  id: number;
  audit_verdict: DepegAuditVerdict | null;
  disposition?: string | null;
  direction?: string;
  pending_reason?: string | null;
  peer_basis_json?: string | null;
}

export async function loadSupplyHistoryRowsForWindow(
  db: D1Database,
  startSec: number,
  endSec: number,
  includeQuantity = false,
): Promise<PsiSupplyRow[]> {
  const load = (withQuantity: boolean) => db.prepare(
    `SELECT stablecoin_id, snapshot_date, circulating_usd, price, price_observed_at
      ${withQuantity ? ", circulating_native, supply_provenance" : ""} FROM supply_history
     WHERE snapshot_date BETWEEN ? AND ? ORDER BY snapshot_date`,
  ).bind(Math.max(0, startSec), endSec).all<PsiSupplyRow>();
  const rows = await load(includeQuantity).catch((error: unknown) => {
    if (includeQuantity && error instanceof Error && /no such column: (circulating_native|supply_provenance)\b/i.test(error.message)) {
      return load(false);
    }
    throw error;
  });
  return rows.results ?? [];
}

export async function loadHistoricalPsiArchives(db: D1Database, startDay: number, endDay: number) {
  const window = getHistoricalPsiSupplyWindow(startDay, endDay);
  const supplyRows = await loadSupplyHistoryRowsForWindow(db, window.startSec, window.endSec, true);
  const dewsRows = await db.prepare(
    `SELECT stablecoin_id, snapshot_date, band FROM stress_signal_history
     WHERE snapshot_date BETWEEN ? AND ? ORDER BY snapshot_date`,
  ).bind(startDay, endDay).all<PsiHistoricalDewsRow>();
  return {
    supplyByCoin: buildSupplySnapshotMap(supplyRows),
    dewsByDay: buildHistoricalDewsMap(dewsRows.results ?? []),
  };
}

export async function loadHistoricalPsiSampleSlots(db: D1Database, startDay: number, endDay: number) {
  const slots = await db.prepare(
    "SELECT stored_at FROM stability_index_samples WHERE stored_at >= ? AND stored_at < ? ORDER BY stored_at",
  ).bind(startDay, endDay + DAY_SECONDS).all<{ stored_at: number }>();
  const sampleSlotsByDay = new Map<number, number[]>();
  for (const { stored_at } of slots.results ?? []) {
    const day = bucketUnixSecondsToUtcDay(stored_at);
    const entries = sampleSlotsByDay.get(day) ?? [];
    entries.push(stored_at);
    sampleSlotsByDay.set(day, entries);
  }
  return sampleSlotsByDay;
}

export async function loadHistoricalPsiReferences(
  db: D1Database,
  events: readonly PsiDepegEventRow[],
  startDay: number,
  endDay: number,
  coingeckoApiKey: string | null,
) {
  const pegs = new Set<CommodityPeg>();
  for (const event of events) {
    const peg = getPegTaxonomyByType(event.peg_type)?.currency;
    if (peg === "GOLD" || peg === "SILVER") pegs.add(peg);
  }
  if (pegs.size === 0) return undefined;
  const { startSec } = getHistoricalPsiSupplyWindow(startDay, endDay);
  const commodityPeers = await fetchHistoricalCommodityPeers({
    startSec: Math.max(0, startSec - HISTORICAL_INTRADAY_PAIRING_SEC),
    endSec: Math.min(endDay + DAY_SECONDS, Math.floor(Date.now() / 1000)),
  }, coingeckoApiKey, [...pegs], db);
  return buildHistoricalReferenceLookup({ commodityPeers });
}

/** Project pending verdicts before scoring, without committing provenance early. */
export async function loadPsiEligibleDepegEvents(
  db: D1Database,
  options: {
    startDay?: number;
    endDay?: number;
    excludedIds?: readonly number[];
    auditVerdicts?: ReadonlyMap<number, DepegAuditVerdict>;
    onEligibilityChange?: (event: PsiDepegEventRow) => void;
    /** False returns stored starts, for the reference-market artifact repair's before-replay. */
    replayClosureRule?: boolean;
  } = {},
): Promise<PsiEligibleDepegEventRow[]> {
  const predicates: string[] = [];
  const binds: unknown[] = [];
  if (options.startDay != null && options.endDay != null) {
    predicates.push("e.started_at < ? AND (e.ended_at IS NULL OR e.ended_at > ?)");
    binds.push(options.endDay + DAY_SECONDS, options.startDay);
  }
  if (options.excludedIds?.length) {
    const clause = buildInClause(options.excludedIds);
    predicates.push(`e.id NOT IN (${clause.sql})`);
    binds.push(...clause.binds);
  }
  if (!options.auditVerdicts?.size) {
    const eligible = auditVerdictNotInSql("p.audit_verdict", PEG_SCORE_EXCLUDED_AUDIT_VERDICTS);
    predicates.push(eligible.sql);
    binds.push(...eligible.binds);
  }
  const selectEvents = async (hasCoverage: boolean, hasReceipt = hasCoverage) => db.prepare(
    `SELECT e.id, e.stablecoin_id, e.peak_deviation_bps, e.peg_reference, e.started_at, e.ended_at,
            e.source, e.peg_type, e.start_price, e.recovery_price, e.direction, e.pending_reason,
            CASE WHEN p.quote_mode IS NOT NULL THEN p.quote_mode
                 WHEN p.peg_reference_source = 'native-peg-history' AND e.peg_reference = 1 THEN 'native-peg'
                 WHEN p.peg_reference_source IN ('fixed-usd', 'historical-fx-or-current-fallback') THEN 'usd'
            END AS quote_mode, p.audit_verdict${hasCoverage
              ? `, e.admitted_coverage_json, e.disposition, ${reviewedDepegDisputeSql("e", false)} AS reviewed_exclusion` : ""}
            ${hasReceipt ? ", e.peer_basis_json, e.peak_price, e.peak_peg_reference, e.peak_quote_domain" : ""}
     FROM depeg_events e LEFT JOIN depeg_event_provenance p ON p.event_id = e.id
     ${predicates.length ? `WHERE ${predicates.join(" AND ")}` : ""}
     ORDER BY e.started_at`,
  ).bind(...binds).all<PsiEligibleDepegEventRow & { admitted_coverage_json?: string | null; reviewed_exclusion?: number }>();
  const rows = await selectEvents(true).catch((error: unknown) => {
    // An older one-shot D1 clone can predate migration 0307.
    if (error instanceof Error && /no such column: e\.peer_basis_json\b/i.test(error.message)) return selectEvents(true, false);
    if (error instanceof Error && /no such column: (e|reviewed)\.(admitted_coverage_json|disposition)\b/i.test(error.message)) {
      return selectEvents(false);
    }
    throw error;
  });
  return (rows.results ?? []).flatMap(({ admitted_coverage_json, reviewed_exclusion, ...row }) => {
    if (reviewed_exclusion === 1) return [];
    const verdict = options.auditVerdicts?.get(row.id) ?? row.audit_verdict;
    if (isPegScoreExcludedAuditVerdict(verdict) !== isPegScoreExcludedAuditVerdict(row.audit_verdict)) {
      options.onEligibilityChange?.(row);
    }
    if (isPegScoreExcludedAuditVerdict(verdict)) return [];
    const coverage = readDepegCoverageLedger({ ...row, admitted_coverage_json });
    if (coverage === null) row.coverageUnavailable = true;
    else if (coverage !== undefined) row.admittedCoverage = coverage;
    return [row];
  }).flatMap((row) => options.replayClosureRule === false ? [row] : applyReferenceMarketClosureRule([row]));
}

/**
 * Replays the closure rule detection has applied since depeg-dews v6.47 over stored rows: an
 * artifact is dropped, and a longer event that began during a closure counts from the reopen.
 */
export function applyReferenceMarketClosureRule<T extends PsiDepegEventRow & {
  id?: number; disposition?: string | null; pending_reason?: string | null;
}>(rows: readonly T[]): T[] {
  return rows.flatMap((row) => {
    if (row.admittedCoverage != null) {
      const first = row.admittedCoverage[0];
      return [first ? { ...row, counted_from: first.fromSec } : row];
    }
    if (row.coverageUnavailable || row.disposition === "restored-evidenced") return [row];
    const currency = getPegTaxonomyByType(row.peg_type)?.currency;
    if (!isReferenceMarketClosed(getReferenceMarket(currency), row.started_at)) return [row];
    if (row.id === 91044 && row.stablecoin_id === "brz-transfero" && row.started_at === 1794678383) return [row];
    if (hasPeerDeviationReceipt(row) && row.peg_type != null) {
      const opening = { ...row, peg_type: row.peg_type };
      if (readAdmittedPeerOnset(opening) || readBenchmarkOnset(opening)?.admission) return [row];
    }
    const opening = row.start_price == null ? null : deriveDepegSignal(row.start_price, row.peg_reference);
    // A severe print needs independent evidence to establish its onset during closure.
    const openingBps = opening && opening.absRawBps < DEPEG_SEVERITY_BPS.severe ? opening.absRawBps : NaN;
    const countedFrom = replayReferenceMarketEventStart(
      currency, row.started_at, row.ended_at, openingBps,
    );
    return countedFrom == null ? [] : [countedFrom === row.started_at ? row : { ...row, counted_from: countedFrom }];
  });
}

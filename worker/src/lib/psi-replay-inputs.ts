import { PEG_SCORE_EXCLUDED_AUDIT_VERDICTS, type DepegAuditVerdict } from "@shared/types/depeg-audit";
import { isPegScoreExcludedAuditVerdict } from "@shared/lib/depeg-audit";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { auditVerdictNotInSql } from "./depeg-audit";
import { buildInClause } from "./db";
import { getHistoricalPsiSupplyWindow } from "./psi-history-universe";
import { buildSupplySnapshotMap, type PsiDepegEventRow, type PsiSupplyRow } from "./psi-recompute";
import { buildHistoricalDewsMap, type PsiHistoricalDewsRow } from "./psi-replay";

export interface PsiEligibleDepegEventRow extends PsiDepegEventRow {
  id: number;
  audit_verdict: DepegAuditVerdict | null;
}

export async function loadSupplyHistoryRowsForWindow(
  db: D1Database,
  startSec: number,
  endSec: number,
): Promise<PsiSupplyRow[]> {
  const rows = await db.prepare(
    `SELECT stablecoin_id, snapshot_date, circulating_usd, price FROM supply_history
     WHERE snapshot_date BETWEEN ? AND ? ORDER BY snapshot_date`,
  ).bind(Math.max(0, startSec), endSec).all<PsiSupplyRow>();
  return rows.results ?? [];
}

export async function loadHistoricalPsiArchives(db: D1Database, startDay: number, endDay: number) {
  const window = getHistoricalPsiSupplyWindow(startDay, endDay);
  const supplyRows = await loadSupplyHistoryRowsForWindow(db, window.startSec, window.endSec);
  const dewsRows = await db.prepare(
    `SELECT stablecoin_id, snapshot_date, band FROM stress_signal_history
     WHERE snapshot_date BETWEEN ? AND ? ORDER BY snapshot_date`,
  ).bind(startDay, endDay).all<PsiHistoricalDewsRow>();
  return {
    supplyByCoin: buildSupplySnapshotMap(supplyRows),
    dewsByDay: buildHistoricalDewsMap(dewsRows.results ?? []),
  };
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
  const rows = await db.prepare(
    `SELECT e.id, e.stablecoin_id, e.peak_deviation_bps, e.peg_reference, e.started_at, e.ended_at,
            e.source, e.peg_type, e.start_price, e.recovery_price, p.quote_mode, p.audit_verdict
     FROM depeg_events e LEFT JOIN depeg_event_provenance p ON p.event_id = e.id
     ${predicates.length ? `WHERE ${predicates.join(" AND ")}` : ""}
     ORDER BY e.started_at`,
  ).bind(...binds).all<PsiEligibleDepegEventRow>();
  return (rows.results ?? []).filter((row) => {
    const verdict = options.auditVerdicts?.get(row.id) ?? row.audit_verdict;
    if (isPegScoreExcludedAuditVerdict(verdict) !== isPegScoreExcludedAuditVerdict(row.audit_verdict)) {
      options.onEligibilityChange?.(row);
    }
    return !isPegScoreExcludedAuditVerdict(verdict);
  });
}

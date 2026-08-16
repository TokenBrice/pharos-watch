import { logWorkerEventArgs } from "../lib/structured-log";
import { jsonResponse, errorResponse } from "../lib/api-utils";
import { runTrustedAdminMutation } from "../lib/route-wrappers";
import { getDepegThresholdBps } from "../lib/constants";
import { buildInClause } from "../lib/db";
import { DEPEG_EVENTS_DEPEGROW_COLUMNS, type DepegRow } from "../lib/depeg-helpers";
import type { PsiDepegEventRow } from "../lib/psi-recompute";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { deriveDepegSignal } from "../lib/depeg-signals";
import {
  runCoinGeckoAuditBatch,
  type AuditedEvent,
  type Verdict,
} from "./audit-depeg-history/coingecko-audit";
import { parseAuditRequest, type AuditPaginatedRequest, type RepairMode } from "./audit-depeg-history/request";
import {
  buildRecomputeStabilityStatements,
  loadSupplyHistoryRowsForWindow,
} from "./audit-depeg-history/stability-recompute";
import {
  collectSyntheticSplitGroups,
  planSyntheticSplitRepair,
  projectSyntheticSplitDepegEvents,
  summarizeSyntheticSplitGroup,
  type SyntheticSplitRepairSummary,
} from "./audit-depeg-history/synthetic-splits";

// If at least this fraction of attempted CG fetches fail, treat it as an
// upstream outage rather than genuine per-event errors: mark the result
// upstreamReachable=false and refuse to persist provenance for the batch.
const AUDIT_UPSTREAM_OUTAGE_ERROR_RATIO = 0.5;
const AUDIT_MIN_SUPPLY_LOOKUP_MARGIN_SEC = 30 * DAY_SECONDS;

class AuditMutationCommitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditMutationCommitError";
  }
}

class Ddrv2SealedRepairRequiredError extends Error {
  constructor(
    readonly operation: string,
    readonly conflicts: DdrSealedEventConflict[],
  ) {
    super("DDRv2 sealed repair required");
    this.name = "Ddrv2SealedRepairRequiredError";
  }
}

interface DdrSealedEventConflict {
  eventId: number;
  incidentKey: string;
  publicPredictionId: number;
}

interface AuditResult {
  totalMatching: number;
  offset: number;
  limit: number;
  dryRun: boolean;
  auditedEvents: AuditedEvent[];
  falsePositivesFound: number;
  deletedEvents: { id: number; symbol: string; startedAt: number; peakBps: number }[];
  daysRecomputed: number;
  rejectedByValidationCount: number;
  /** Number of attempted CG fetches that failed (non-ok response or fetch/parse error). */
  upstreamErrorCount: number;
  /**
   * false when the upstream (CoinGecko) error rate crossed the outage threshold,
   * signalling that the per-event 'error' verdicts reflect an outage rather than
   * genuine data errors. Provenance is not persisted in that case.
   */
  upstreamReachable: boolean;
}

interface SyntheticSplitRepairResult {
  repair: RepairMode;
  totalMatching: number;
  offset: number;
  limit: number;
  dryRun: boolean;
  candidateGroups: SyntheticSplitRepairSummary[];
  repairedGroups: SyntheticSplitRepairSummary[];
  repairedEventCount: number;
  daysRecomputed: number;
}

interface ContradictoryRecoveryRepairSummary {
  id: number;
  stablecoinId: string;
  symbol: string;
  direction: string;
  startedAt: number;
  endedAt: number;
  recoveryPrice: number;
  recoveryBps: number;
  thresholdBps: number;
}

interface ContradictoryRecoveryRepairResult {
  repair: RepairMode;
  totalMatching: number;
  offset: number;
  limit: number;
  dryRun: boolean;
  candidateEvents: ContradictoryRecoveryRepairSummary[];
  repairedEvents: ContradictoryRecoveryRepairSummary[];
  repairedEventCount: number;
}

interface AuditMutationPlan {
  statements: D1PreparedStatement[];
  affectedDays: Set<number>;
}

function getDeviationSignal(price: number | null | undefined, pegReference: number) {
  return price == null ? null : deriveDepegSignal(price, pegReference);
}

function confidenceTierForVerdict(verdict: Verdict): "high" | "medium" | "low" {
  if (verdict === "confirmed" || verdict === "repaired") return "high";
  if (verdict === "no_data") return "low";
  return "medium";
}

function buildAuditVerdictProvenanceStmt(
  db: D1Database,
  event: DepegRow,
  verdict: Verdict,
  nowSec: number,
): D1PreparedStatement {
  const confidenceTier = confidenceTierForVerdict(verdict);
  const publicJson = JSON.stringify({
    auditVerdict: verdict,
    confidenceTier,
    pegScoreEligible: verdict !== "false_positive" && verdict !== "disputed",
    updatedAt: nowSec,
  });
  return db
    .prepare(
      `INSERT INTO depeg_event_provenance (
         event_id, source_kind, audit_verdict, confidence_tier, public_json, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET
         audit_verdict = excluded.audit_verdict,
         confidence_tier = excluded.confidence_tier,
         public_json = json_patch(COALESCE(depeg_event_provenance.public_json, '{}'), excluded.public_json),
         updated_at = excluded.updated_at`,
    )
    .bind(
      event.id,
      event.source,
      verdict,
      confidenceTier,
      publicJson,
      nowSec,
      nowSec,
    );
}

async function loadClosedDepegEvents(db: D1Database): Promise<DepegRow[]> {
  const allClosedEvents = await db
    .prepare(
      `SELECT ${DEPEG_EVENTS_DEPEGROW_COLUMNS} FROM depeg_events WHERE ended_at IS NOT NULL ORDER BY started_at`,
    )
    .all<DepegRow>();
  return allClosedEvents.results ?? [];
}

async function loadAllDepegEvents(db: D1Database): Promise<DepegRow[]> {
  const allEvents = await db
    .prepare(
      `SELECT ${DEPEG_EVENTS_DEPEGROW_COLUMNS} FROM depeg_events ORDER BY stablecoin_id, started_at`,
    )
    .all<DepegRow>();
  return allEvents.results ?? [];
}

async function loadSealedDdrEventConflicts(
  db: D1Database,
  eventIds: readonly number[],
): Promise<DdrSealedEventConflict[]> {
  const uniqueIds = [...new Set(eventIds)].filter((id) => Number.isSafeInteger(id) && id > 0);
  if (uniqueIds.length === 0) return [];

  const idClause = buildInClause(uniqueIds);
  const rows = await db
    .prepare(
      `SELECT l.event_id AS event_id,
              l.incident_key AS incident_key,
              p.id AS public_prediction_id
       FROM depeg_resolver_incident_event_links l
       JOIN depeg_resolver_public_predictions p ON p.incident_key = l.incident_key
       WHERE l.event_id IN (${idClause.sql})
       ORDER BY l.event_id`,
    )
    .bind(...idClause.binds)
    .all<{ event_id: number; incident_key: string; public_prediction_id: number }>();

  return (rows.results ?? []).map((row) => ({
    eventId: row.event_id,
    incidentKey: row.incident_key,
    publicPredictionId: row.public_prediction_id,
  }));
}

function ddrv2SealedRepairResponse(operation: string, conflicts: DdrSealedEventConflict[]): Response {
  return jsonResponse(
    {
      error: "DDRv2 sealed repair required",
      message:
        "This endpoint will not directly mutate sealed depeg_events. Create/consume an append-only DDRv2 repair authorization with the required lineage and errata, then run a dedicated repair path for the sealed incident.",
      operation,
      conflicts,
    },
    { status: 409, noStore: true },
  );
}

async function rejectSealedDdrEventMutation(
  db: D1Database,
  eventIds: readonly number[],
  operation: string,
): Promise<Response | null> {
  const conflicts = await loadSealedDdrEventConflicts(db, eventIds);
  if (conflicts.length === 0) return null;
  return ddrv2SealedRepairResponse(operation, conflicts);
}

async function assertNoSealedDdrEventMutation(
  db: D1Database,
  eventIds: readonly number[],
  operation: string,
): Promise<void> {
  const conflicts = await loadSealedDdrEventConflicts(db, eventIds);
  if (conflicts.length > 0) {
    throw new Ddrv2SealedRepairRequiredError(operation, conflicts);
  }
}

function toDeletedEventSummary(event: DepegRow): { id: number; symbol: string; startedAt: number; peakBps: number } {
  return {
    id: event.id,
    symbol: event.symbol,
    startedAt: event.started_at,
    peakBps: event.peak_deviation_bps,
  };
}

function addAffectedDays(affectedDays: Set<number>, startedAt: number, endedAt: number): void {
  const startDay = bucketUnixSecondsToUtcDay(startedAt);
  const endDay = bucketUnixSecondsToUtcDay(endedAt);
  for (let day = startDay; day <= endDay; day += DAY_SECONDS) {
    affectedDays.add(day);
  }
}

function getAuditMinSupplyHistoryWindow(events: readonly DepegRow[]): { startSec: number; endSec: number } | null {
  let minStartedAt = Infinity;
  let maxStartedAt = -Infinity;
  for (const event of events) {
    if (!Number.isFinite(event.started_at)) continue;
    minStartedAt = Math.min(minStartedAt, event.started_at);
    maxStartedAt = Math.max(maxStartedAt, event.started_at);
  }
  if (!Number.isFinite(minStartedAt) || !Number.isFinite(maxStartedAt)) return null;
  return {
    startSec: Math.max(0, minStartedAt - AUDIT_MIN_SUPPLY_LOOKUP_MARGIN_SEC),
    endSec: maxStartedAt + AUDIT_MIN_SUPPLY_LOOKUP_MARGIN_SEC,
  };
}

function summarizeContradictoryRecoveryEvent(event: DepegRow): ContradictoryRecoveryRepairSummary | null {
  if (event.ended_at == null || event.recovery_price == null) {
    return null;
  }
  const thresholdBps = getDepegThresholdBps(event.peg_type);
  const recoveryBps = getDeviationSignal(event.recovery_price, event.peg_reference)?.absBps ?? null;
  if (recoveryBps == null || recoveryBps < thresholdBps) {
    return null;
  }
  return {
    id: event.id,
    stablecoinId: event.stablecoin_id,
    symbol: event.symbol,
    direction: event.direction,
    startedAt: event.started_at,
    endedAt: event.ended_at,
    recoveryPrice: event.recovery_price,
    recoveryBps,
    thresholdBps,
  };
}

async function loadRemainingDepegEvents(
  db: D1Database,
  excludedIds: readonly number[] = [],
): Promise<PsiDepegEventRow[]> {
  const baseSql =
    "SELECT stablecoin_id, peak_deviation_bps, peg_reference, started_at, ended_at FROM depeg_events_with_provenance";
  const auditEligibleWhere =
    "(provenance_audit_verdict IS NULL OR provenance_audit_verdict NOT IN ('false_positive', 'disputed'))";
  const orderBy = " ORDER BY started_at";
  if (excludedIds.length === 0) {
    const rows = await db.prepare(`${baseSql} WHERE ${auditEligibleWhere}${orderBy}`).all<PsiDepegEventRow>();
    return rows.results ?? [];
  }

  const idClause = buildInClause(excludedIds);
  const rows = await db
    .prepare(`${baseSql} WHERE ${auditEligibleWhere} AND id NOT IN (${idClause.sql})${orderBy}`)
    .bind(...idClause.binds)
    .all<PsiDepegEventRow>();
  return rows.results ?? [];
}

async function commitAuditMutation(
  db: D1Database,
  mutationStatements: D1PreparedStatement[],
  failureMessage: string,
  recomputePlan?: { affectedDays: Set<number>; remainingDepegEvents: PsiDepegEventRow[] },
): Promise<number> {
  const recompute = recomputePlan
    ? await buildRecomputeStabilityStatements(db, recomputePlan.affectedDays, recomputePlan.remainingDepegEvents)
    : { statements: [], daysRecomputed: 0 };
  const statements = [...mutationStatements, ...recompute.statements];
  if (statements.length === 0) {
    return recompute.daysRecomputed;
  }

  try {
    // D1 batches execute as a single SQL transaction; keep the mutation and
    // any downstream PSI repairs in the same commit boundary for admin runs.
    await db.batch(statements);
  } catch (error) {
    logWorkerEventArgs("api", "error", `[audit] ${failureMessage}:`, error);
    throw new AuditMutationCommitError(`${failureMessage}; no changes were committed.`);
  }

  return recompute.daysRecomputed;
}

function planDirectDelete(db: D1Database, events: DepegRow[]): AuditMutationPlan {
  const affectedDays = new Set<number>();
  const statements = events.map((event) => {
    addAffectedDays(affectedDays, event.started_at, event.ended_at ?? event.started_at);
    logWorkerEventArgs("api", "info", `[audit] Direct delete: ${event.symbol} id=${event.id} peak=${event.peak_deviation_bps}bps`);
    return db.prepare("DELETE FROM depeg_events WHERE id = ?").bind(event.id);
  });
  return { statements, affectedDays };
}

async function executeDirectDelete(
  db: D1Database,
  events: DepegRow[],
  deleteIds: readonly number[],
  dryRun: boolean,
): Promise<Response> {
  const toDelete = events.filter((event) => deleteIds.includes(event.id));
  if (toDelete.length === 0) {
    return errorResponse(404, "No matching events found");
  }

  if (dryRun) {
    return jsonResponse({
      dryRun: true,
      deletedEvents: toDelete.map(toDeletedEventSummary),
      daysRecomputed: 0,
    });
  }

  const sealedMutationResponse = await rejectSealedDdrEventMutation(
    db,
    toDelete.map((event) => event.id),
    "audit-depeg-history:direct-delete",
  );
  if (sealedMutationResponse) return sealedMutationResponse;

  const mutationPlan = planDirectDelete(db, toDelete);
  const remainingDepegEvents = await loadRemainingDepegEvents(db, toDelete.map((event) => event.id));
  const daysRecomputed = await commitAuditMutation(
    db,
    mutationPlan.statements,
    "Direct delete failed before the stability-index repair could finish",
    { affectedDays: mutationPlan.affectedDays, remainingDepegEvents },
  );

  return jsonResponse({
    dryRun: false,
    deletedEvents: toDelete.map(toDeletedEventSummary),
    daysRecomputed,
  });
}

async function executeSyntheticSplitRepair(
  db: D1Database,
  request: AuditPaginatedRequest,
): Promise<Response> {
  const allRows = await loadAllDepegEvents(db);
  const groupedCandidates = collectSyntheticSplitGroups(
    allRows.filter((event) => (request.symbolFilter ? event.symbol.toUpperCase() === request.symbolFilter : true)),
  );
  const paginatedGroups = groupedCandidates.slice(request.offset, request.offset + request.limit);
  const result: SyntheticSplitRepairResult = {
    repair: "synthetic-splits",
    totalMatching: groupedCandidates.length,
    offset: request.offset,
    limit: request.limit,
    dryRun: request.dryRun,
    candidateGroups: paginatedGroups.map((group) => summarizeSyntheticSplitGroup(group)),
    repairedGroups: [],
    repairedEventCount: 0,
    daysRecomputed: 0,
  };

  if (request.dryRun || paginatedGroups.length === 0) {
    return jsonResponse(result);
  }

  const sealedMutationResponse = await rejectSealedDdrEventMutation(
    db,
    paginatedGroups.flatMap((group) => group.map((event) => event.id)),
    "audit-depeg-history:synthetic-splits",
  );
  if (sealedMutationResponse) return sealedMutationResponse;

  const mutationPlan = planSyntheticSplitRepair(db, paginatedGroups, Math.floor(Date.now() / 1000));
  result.repairedGroups = mutationPlan.summaries;
  result.repairedEventCount = mutationPlan.repairedEventCount;
  result.daysRecomputed = await commitAuditMutation(
    db,
    mutationPlan.statements,
    "Synthetic split repair failed before the stability-index repair could finish",
    {
      affectedDays: mutationPlan.affectedDays,
      remainingDepegEvents: projectSyntheticSplitDepegEvents(allRows, paginatedGroups),
    },
  );
  return jsonResponse(result);
}

function findContradictoryRecoveryCandidates(
  events: DepegRow[],
  symbolFilter: string | null,
): ContradictoryRecoveryRepairSummary[] {
  return events
    .filter((event) => (symbolFilter ? event.symbol.toUpperCase() === symbolFilter : true))
    .map((event) => summarizeContradictoryRecoveryEvent(event))
    .filter((event): event is ContradictoryRecoveryRepairSummary => event !== null);
}

async function executeContradictoryRecoveryRepair(
  db: D1Database,
  events: DepegRow[],
  request: AuditPaginatedRequest,
): Promise<Response> {
  const filteredCandidates = findContradictoryRecoveryCandidates(events, request.symbolFilter);
  const paginatedCandidates = filteredCandidates.slice(request.offset, request.offset + request.limit);
  const result: ContradictoryRecoveryRepairResult = {
    repair: "contradictory-recovery-price",
    totalMatching: filteredCandidates.length,
    offset: request.offset,
    limit: request.limit,
    dryRun: request.dryRun,
    candidateEvents: paginatedCandidates,
    repairedEvents: [],
    repairedEventCount: 0,
  };

  if (request.dryRun || paginatedCandidates.length === 0) {
    return jsonResponse(result);
  }

  const sealedMutationResponse = await rejectSealedDdrEventMutation(
    db,
    paginatedCandidates.map((candidate) => candidate.id),
    "audit-depeg-history:contradictory-recovery-price",
  );
  if (sealedMutationResponse) return sealedMutationResponse;

  const statements = paginatedCandidates.map((candidate) =>
    db.prepare("UPDATE depeg_events SET recovery_price = NULL WHERE id = ?").bind(candidate.id)
  );
  await commitAuditMutation(db, statements, "Contradictory recovery-price repair failed");
  result.repairedEvents = paginatedCandidates;
  result.repairedEventCount = paginatedCandidates.length;
  return jsonResponse(result);
}

export interface AuditDepegHistoryRouteContext {
  db: D1Database;
  url: URL;
  request?: Request;
}

export async function handleAuditDepegHistoryTrusted({
  db,
  url,
  request,
}: AuditDepegHistoryRouteContext): Promise<Response> {
  return runTrustedAdminMutation(async () => {
    try {
      const auditRequest = parseAuditRequest(url, request);
      if (auditRequest instanceof Response) return auditRequest;

      if (auditRequest.repairMode === "synthetic-splits") {
        return await executeSyntheticSplitRepair(db, auditRequest);
      }

      const events = await loadClosedDepegEvents(db);

      if (auditRequest.deleteIds) {
        return await executeDirectDelete(db, events, auditRequest.deleteIds, auditRequest.dryRun);
      }

      if (auditRequest.repairMode === "contradictory-recovery-price") {
        return await executeContradictoryRecoveryRepair(db, events, auditRequest);
      }

      const result = await auditEvents(db, {
        events,
        minSupply: auditRequest.minSupply,
        symbolFilter: auditRequest.symbolFilter,
        offset: auditRequest.offset,
        limit: auditRequest.limit,
        dryRun: auditRequest.dryRun,
      });

      return jsonResponse(result);
    } catch (error) {
      if (error instanceof Ddrv2SealedRepairRequiredError) {
        return ddrv2SealedRepairResponse(error.operation, error.conflicts);
      }
      if (error instanceof AuditMutationCommitError) {
        return errorResponse(500, error.message);
      }
      throw error;
    }
  });
}

export interface AuditEventsOptions {
  events: DepegRow[];
  minSupply: number;
  symbolFilter: string | null;
  offset: number;
  limit: number;
  dryRun: boolean;
}

/**
 * @internal exported for tests. Runs the standard CG-backed audit loop against
 * a pre-loaded set of closed depeg events.
 */
export async function auditEvents(
  db: D1Database,
  options: AuditEventsOptions,
): Promise<AuditResult> {
  const { events, minSupply, symbolFilter, offset, limit, dryRun } = options;
  const symbolFilteredEvents = symbolFilter
    ? events.filter((event) => event.symbol.toUpperCase() === symbolFilter)
    : events;

  // Build supply lookup only when min-supply > 0
  let getSupplyAtTime: ((coinId: string, ts: number) => number) | null = null;
  if (minSupply > 0 && symbolFilteredEvents.length > 0) {
    const supplyWindow = getAuditMinSupplyHistoryWindow(symbolFilteredEvents);
    const supplyRows = supplyWindow
      ? await loadSupplyHistoryRowsForWindow(db, supplyWindow.startSec, supplyWindow.endSec)
      : [];
    const supplyByCoin = new Map<string, { date: number; supply: number }[]>();
    for (const r of supplyRows) {
      const list = supplyByCoin.get(r.stablecoin_id) ?? [];
      list.push({ date: r.snapshot_date, supply: r.circulating_usd });
      supplyByCoin.set(r.stablecoin_id, list);
    }

    getSupplyAtTime = (coinId: string, ts: number): number => {
      const snaps = supplyByCoin.get(coinId);
      if (!snaps || snaps.length === 0) return 0;
      let best = snaps[0];
      for (const s of snaps) {
        if (Math.abs(s.date - ts) < Math.abs(best.date - ts)) best = s;
        if (s.date > ts) break;
      }
      return Math.abs(best.date - ts) <= 30 * DAY_SECONDS ? best.supply : 0;
    };
  }

  // Apply filters: symbol, min-supply, geckoId presence
  const filtered = symbolFilteredEvents.filter((e) => {
    if (minSupply > 0 && getSupplyAtTime) {
      if (getSupplyAtTime(e.stablecoin_id, e.started_at) < minSupply) return false;
    }
    return true;
  });

  const paginatedEvents = filtered.slice(offset, offset + limit);

  const result: AuditResult = {
    totalMatching: filtered.length,
    offset,
    limit,
    dryRun,
    auditedEvents: [],
    falsePositivesFound: 0,
    deletedEvents: [],
    daysRecomputed: 0,
    rejectedByValidationCount: 0,
    upstreamErrorCount: 0,
    upstreamReachable: true,
  };

  const affectedDays = new Set<number>();
  const provenanceStatements: D1PreparedStatement[] = [];
  const invalidatingProvenanceEventIds: number[] = [];
  const nowSec = Math.floor(Date.now() / 1000);
  const { outcomes, attemptedCgFetches } = await runCoinGeckoAuditBatch(db, paginatedEvents);

  for (const outcome of outcomes) {
    result.auditedEvents.push(outcome.auditedEvent);
    if (outcome.upstreamError) result.upstreamErrorCount++;
    result.rejectedByValidationCount += outcome.rejectedByValidationCount;
    if (outcome.falsePositiveFound) result.falsePositivesFound++;

    if (!dryRun && outcome.provenanceVerdict != null) {
      provenanceStatements.push(buildAuditVerdictProvenanceStmt(db, outcome.event, outcome.provenanceVerdict, nowSec));
      if (outcome.invalidatesProvenance) {
        invalidatingProvenanceEventIds.push(outcome.event.id);
        addAffectedDays(affectedDays, outcome.event.started_at, outcome.event.ended_at ?? outcome.event.started_at);
      }
    }
  }

  // A high upstream error rate means CG was effectively down for the batch, so
  // the per-event 'error' verdicts are outage noise, not genuine findings.
  // Degrade cleanly: flag the result and skip provenance persistence.
  result.upstreamReachable = !(
    attemptedCgFetches > 0 &&
    result.upstreamErrorCount / attemptedCgFetches >= AUDIT_UPSTREAM_OUTAGE_ERROR_RATIO
  );

  if (!dryRun && result.upstreamReachable && provenanceStatements.length > 0) {
    await assertNoSealedDdrEventMutation(
      db,
      invalidatingProvenanceEventIds,
      "audit-depeg-history:provenance-invalidation",
    );
    const remainingDepegEvents = await loadRemainingDepegEvents(db);
    result.daysRecomputed = await commitAuditMutation(
      db,
      provenanceStatements,
      "False-positive audit persistence failed before the stability-index repair could finish",
      { affectedDays, remainingDepegEvents },
    );
  }

  return result;
}

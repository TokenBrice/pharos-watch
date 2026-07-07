import { parseQueryParams, jsonResponse, errorResponse } from "../lib/api-utils";
import { runAdminRoute, runTrustedAdminMutation } from "../lib/route-wrappers";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { getDepegThresholdBps, DEPEG_SECONDARY_THRESHOLD_RATIO, USER_AGENT } from "../lib/constants";
import { cgUrl, cgHeaders } from "../lib/coingecko";
import { computeStabilityIndex } from "../lib/stability-index";
import { buildInClause } from "../lib/db";
import { fetchWithRetry } from "../lib/fetch-retry";
import { mapWithConcurrency } from "../lib/concurrency";
import { DEPEG_EVENTS_DEPEGROW_COLUMNS, type DepegRow } from "../lib/depeg-helpers";
import {
  buildPriceValidationContext,
  loadPriceValidationReferences,
  validatePriceCandidate,
} from "../lib/price-validation";
import { getPsiMethodologyVersionAt } from "@shared/lib/stability-index-version";
import {
  buildStabilityInputForDay,
  buildSupplySnapshotMap,
  type PsiDepegEventRow,
  type PsiSupplyRow,
} from "../lib/psi-recompute";
import type { PsiUniverseCache } from "../lib/psi-history-universe";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { deriveDepegSignal } from "../lib/depeg-signals";

type Verdict = "false_positive" | "confirmed" | "disputed" | "no_data" | "repaired" | "skipped" | "error";
type RepairMode = "synthetic-splits" | "contradictory-recovery-price";

const SYNTHETIC_SPLIT_MAX_GAP_SEC = 30 * 60;
const SYNTHETIC_SPLIT_RECOVERY_BAR_BPS = 50;
const SYNTHETIC_SPLIT_RESUME_MIN_BPS = 500;
// Audit history is capped at 25 events per request (default and max are the same).
const AUDIT_DEPEG_HISTORY_LIMIT = 25;
const DELETE_ID_PATTERN = /^\d+$/;
const AUDIT_CG_FETCH_START_INTERVAL_MS = 200;
const AUDIT_CG_FETCH_CONCURRENCY = 4;
// If at least this fraction of attempted CG fetches fail, treat it as an
// upstream outage rather than genuine per-event errors: mark the result
// upstreamReachable=false and refuse to persist provenance for the batch.
const AUDIT_UPSTREAM_OUTAGE_ERROR_RATIO = 0.5;
const PSI_SUPPLY_NEAREST_SNAPSHOT_MARGIN_SEC = 14 * DAY_SECONDS;
const PSI_RECOMPUTE_SUPPLY_LOOKBACK_SEC = 7 * DAY_SECONDS + PSI_SUPPLY_NEAREST_SNAPSHOT_MARGIN_SEC;
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

interface AuditedEvent {
  id: number;
  symbol: string;
  startedAt: number;
  peakBps: number;
  cgMaxBps: number | null;
  cgMaxSameDirectionBps?: number | null;
  cgMaxOppositeDirectionBps?: number | null;
  verdict: Verdict;
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

interface SyntheticSplitRepairSummary {
  stablecoinId: string;
  symbol: string;
  direction: string;
  keeperId: number;
  mergedIds: number[];
  eventIds: number[];
  startedAt: number;
  endedAt: number | null;
  peakBps: number;
  recoveryPrice: number | null;
  gapSeconds: number[];
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

interface AuditPaginatedRequest {
  limit: number;
  offset: number;
  dryRun: boolean;
  symbolFilter: string | null;
}

interface ParsedAuditRequest extends AuditPaginatedRequest {
  minSupply: number;
  deleteIds: number[] | null;
  repairMode: RepairMode | null;
}

interface AuditMutationPlan {
  statements: D1PreparedStatement[];
  affectedDays: Set<number>;
}

interface AuditEventOutcome {
  event: DepegRow;
  auditedEvent: AuditedEvent;
  attemptedCgFetch: boolean;
  upstreamError: boolean;
  rejectedByValidationCount: number;
  falsePositiveFound: boolean;
  provenanceVerdict: Verdict | null;
  invalidatesProvenance: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFetchStartLimiter(intervalMs: number): () => Promise<void> {
  let nextStartAt = 0;
  let tail = Promise.resolve();

  return async () => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const now = Date.now();
    const waitMs = Math.max(0, nextStartAt - now);
    nextStartAt = Math.max(now, nextStartAt) + intervalMs;
    release();
    if (waitMs > 0) {
      await sleep(waitMs);
    }
  };
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

function parseDeleteIds(value: string): number[] | Response {
  const tokens = value.split(",").map((token) => token.trim());
  if (tokens.length === 0 || tokens.some((token) => token.length === 0 || !DELETE_ID_PATTERN.test(token))) {
    return errorResponse(400, "Invalid delete parameter: expected comma-separated numeric event IDs");
  }

  const ids = tokens.map((token) => Number.parseInt(token, 10));
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    return errorResponse(400, "Invalid delete parameter: expected positive event IDs");
  }
  return ids;
}

function parseRepairMode(value: string | null): RepairMode | null | Response {
  if (value == null || value.length === 0) return null;
  if (value === "synthetic-splits" || value === "contradictory-recovery-price") return value;
  return errorResponse(400, `Unsupported repair mode: ${value}`);
}

function parseAuditRequest(url: URL, request?: Request): ParsedAuditRequest | Response {
  const parsed = parseQueryParams(url.searchParams, {
    limit: {
      type: "int",
      default: AUDIT_DEPEG_HISTORY_LIMIT,
      min: 1,
      max: AUDIT_DEPEG_HISTORY_LIMIT,
      rangePolicy: "reject",
    },
    offset: { type: "int", default: 0, min: 0, max: 100_000 },
    "min-supply": { type: "int", default: 0, min: 0, max: Number.MAX_SAFE_INTEGER, name: "min-supply" },
  });
  if (parsed instanceof Response) return parsed;

  const deleteParam = url.searchParams.get("delete");
  const hasDeleteParam = deleteParam != null;
  const repairMode = parseRepairMode(url.searchParams.get("repair"));
  if (repairMode instanceof Response) return repairMode;
  if (hasDeleteParam && repairMode) {
    return errorResponse(400, "Use either delete=... or repair=..., not both");
  }

  const dryRun = url.searchParams.get("dry-run") === "true";
  const method = request?.method ?? "GET";
  if (method === "GET" && !dryRun) {
    return new Response(
      JSON.stringify({ error: "Method not allowed. GET supports dry-run=true only; use POST for mutations." }),
      { status: 405, headers: { "Content-Type": "application/json", Allow: "POST" } },
    );
  }

  const deleteIds = deleteParam == null ? null : parseDeleteIds(deleteParam);
  if (deleteIds instanceof Response) return deleteIds;

  return {
    limit: parsed.limit,
    offset: parsed.offset,
    minSupply: parsed["min-supply"],
    deleteIds,
    repairMode,
    dryRun,
    symbolFilter: url.searchParams.get("symbol")?.toUpperCase() ?? null,
  };
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

function toAuditedEvent(
  event: DepegRow,
  verdict: Verdict,
  cgDeviation: {
    cgMaxBps: number | null;
    cgMaxSameDirectionBps?: number | null;
    cgMaxOppositeDirectionBps?: number | null;
  },
): AuditedEvent {
  const auditedEvent: Omit<AuditedEvent, "verdict"> = {
    id: event.id,
    symbol: event.symbol,
    startedAt: event.started_at,
    peakBps: event.peak_deviation_bps,
    cgMaxBps: cgDeviation.cgMaxBps,
  };
  if ("cgMaxSameDirectionBps" in cgDeviation) {
    auditedEvent.cgMaxSameDirectionBps = cgDeviation.cgMaxSameDirectionBps;
  }
  if ("cgMaxOppositeDirectionBps" in cgDeviation) {
    auditedEvent.cgMaxOppositeDirectionBps = cgDeviation.cgMaxOppositeDirectionBps;
  }
  return { ...auditedEvent, verdict };
}

function addAffectedDays(affectedDays: Set<number>, startedAt: number, endedAt: number): void {
  const startDay = Math.floor(startedAt / DAY_SECONDS) * DAY_SECONDS;
  const endDay = Math.floor(endedAt / DAY_SECONDS) * DAY_SECONDS;
  for (let day = startDay; day <= endDay; day += DAY_SECONDS) {
    affectedDays.add(day);
  }
}

async function loadSupplyHistoryRowsForWindow(
  db: D1Database,
  startSec: number,
  endSec: number,
): Promise<PsiSupplyRow[]> {
  const rows = await db
    .prepare(
      `SELECT stablecoin_id, snapshot_date, circulating_usd
       FROM supply_history
       WHERE snapshot_date BETWEEN ? AND ?
       ORDER BY snapshot_date`,
    )
    .bind(Math.max(0, startSec), endSec)
    .all<PsiSupplyRow>();
  return rows.results ?? [];
}

function getRecomputeSupplyHistoryWindow(sortedDays: readonly number[]): { startSec: number; endSec: number } | null {
  const firstDay = sortedDays[0];
  const lastDay = sortedDays[sortedDays.length - 1];
  if (firstDay == null || lastDay == null) return null;
  return {
    startSec: Math.max(0, firstDay - PSI_RECOMPUTE_SUPPLY_LOOKBACK_SEC),
    endSec: lastDay + PSI_SUPPLY_NEAREST_SNAPSHOT_MARGIN_SEC,
  };
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

function isSyntheticSplitPair(previous: DepegRow, next: DepegRow): boolean {
  if (previous.stablecoin_id !== next.stablecoin_id) return false;
  if (previous.direction !== next.direction) return false;
  if (previous.ended_at == null) return false;

  const gapSec = next.started_at - previous.ended_at;
  if (gapSec < 0 || gapSec > SYNTHETIC_SPLIT_MAX_GAP_SEC) return false;

  const threshold = Math.max(getDepegThresholdBps(next.peg_type), SYNTHETIC_SPLIT_RESUME_MIN_BPS);
  const recoveryBps = getDeviationSignal(previous.recovery_price, previous.peg_reference)?.absBps ?? null;
  const resumeBps = getDeviationSignal(next.start_price, next.peg_reference)?.absBps ?? null;
  const previousPeakAbsBps = Math.abs(previous.peak_deviation_bps);

  const resumedSevereDepeg =
    resumeBps != null &&
    resumeBps >= threshold &&
    previousPeakAbsBps >= threshold;
  if (!resumedSevereDepeg) {
    return false;
  }

  const sameSourceSyntheticSplit =
    previous.source === "live" &&
    next.source === "live" &&
    recoveryBps != null &&
    recoveryBps <= SYNTHETIC_SPLIT_RECOVERY_BAR_BPS;
  if (sameSourceSyntheticSplit) {
    return true;
  }

  return previous.source === "backfill" && next.source === "live" && previous.recovery_price == null;
}

function shouldKeepLiveTailForSyntheticSplit(rows: DepegRow[]): boolean {
  if (rows.length < 2) return false;
  const tail = rows[rows.length - 1];
  if (!tail || tail.source !== "live") return false;
  return rows.slice(0, -1).every((row) => row.source === "backfill");
}

function pickSyntheticSplitKeeper(rows: DepegRow[]): DepegRow {
  if (shouldKeepLiveTailForSyntheticSplit(rows)) {
    return rows[rows.length - 1];
  }
  return rows[0];
}

function pickWorstPeakRow(rows: DepegRow[], seed: DepegRow): DepegRow {
  let worst = seed;
  for (const row of rows) {
    if (Math.abs(row.peak_deviation_bps) > Math.abs(worst.peak_deviation_bps)) {
      worst = row;
    }
  }
  return worst;
}

function resolveSyntheticSplitAnchors(rows: DepegRow[]): {
  keeper: DepegRow;
  first: DepegRow;
  tail: DepegRow;
  worst: DepegRow;
} {
  const keeper = pickSyntheticSplitKeeper(rows);
  return {
    keeper,
    first: rows[0],
    tail: rows[rows.length - 1],
    worst: pickWorstPeakRow(rows, keeper),
  };
}

function summarizeSyntheticSplitGroup(rows: DepegRow[]): SyntheticSplitRepairSummary {
  const { keeper, first, tail, worst } = resolveSyntheticSplitAnchors(rows);
  const gapSeconds: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    gapSeconds.push(Math.max(0, rows[i].started_at - (rows[i - 1].ended_at ?? rows[i].started_at)));
  }
  return {
    stablecoinId: first.stablecoin_id,
    symbol: first.symbol,
    direction: first.direction,
    keeperId: keeper.id,
    mergedIds: rows.filter((row) => row.id !== keeper.id).map((row) => row.id),
    eventIds: rows.map((row) => row.id),
    startedAt: first.started_at,
    endedAt: tail.ended_at,
    peakBps: worst.peak_deviation_bps,
    recoveryPrice: tail.ended_at == null ? null : tail.recovery_price,
    gapSeconds,
  };
}

function collectSyntheticSplitGroups(events: DepegRow[]): DepegRow[][] {
  const byCoin = new Map<string, DepegRow[]>();
  for (const event of events) {
    const list = byCoin.get(event.stablecoin_id) ?? [];
    list.push(event);
    byCoin.set(event.stablecoin_id, list);
  }

  const groups: DepegRow[][] = [];
  for (const rows of byCoin.values()) {
    rows.sort((a, b) => a.started_at - b.started_at);
    let currentGroup: DepegRow[] = [];
    for (const row of rows) {
      if (currentGroup.length === 0) {
        currentGroup = [row];
        continue;
      }
      const previous = currentGroup[currentGroup.length - 1];
      if (isSyntheticSplitPair(previous, row)) {
        currentGroup.push(row);
        continue;
      }
      if (currentGroup.length > 1) {
        groups.push(currentGroup);
      }
      currentGroup = [row];
    }
    if (currentGroup.length > 1) {
      groups.push(currentGroup);
    }
  }

  groups.sort((a, b) => a[0].started_at - b[0].started_at);
  return groups;
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

function projectSyntheticSplitDepegEvents(
  events: DepegRow[],
  repairedGroups: DepegRow[][],
): PsiDepegEventRow[] {
  const removedIds = new Set<number>();
  const updatedRows = new Map<number, PsiDepegEventRow>();

  for (const group of repairedGroups) {
    const { keeper, first, tail, worst } = resolveSyntheticSplitAnchors(group);
    for (const row of group) {
      if (row.id !== keeper.id) {
        removedIds.add(row.id);
      }
    }

    updatedRows.set(keeper.id, {
      stablecoin_id: keeper.stablecoin_id,
      peak_deviation_bps: worst.peak_deviation_bps,
      peg_reference: first.peg_reference,
      started_at: first.started_at,
      ended_at: tail.ended_at,
    });
  }

  const projected: PsiDepegEventRow[] = [];
  for (const row of events) {
    if (removedIds.has(row.id)) {
      continue;
    }
    projected.push(
      updatedRows.get(row.id) ?? {
        stablecoin_id: row.stablecoin_id,
        peak_deviation_bps: row.peak_deviation_bps,
        peg_reference: row.peg_reference,
        started_at: row.started_at,
        ended_at: row.ended_at,
      },
    );
  }

  projected.sort((a, b) => a.started_at - b.started_at);
  return projected;
}

async function buildRecomputeStabilityStatements(
  db: D1Database,
  affectedDays: Set<number>,
  depegEvents: PsiDepegEventRow[],
): Promise<{ statements: D1PreparedStatement[]; daysRecomputed: number }> {
  if (affectedDays.size === 0) {
    return { statements: [], daysRecomputed: 0 };
  }

  const sortedDays = [...affectedDays].sort((a, b) => a - b);
  const now = Math.floor(Date.now() / 1000);
  const supplyWindow = getRecomputeSupplyHistoryWindow(sortedDays);
  const supplyRows = supplyWindow
    ? await loadSupplyHistoryRowsForWindow(db, supplyWindow.startSec, supplyWindow.endSec)
    : [];
  const supplyByCoin = buildSupplySnapshotMap(supplyRows);

  const statements: D1PreparedStatement[] = [];
  let daysRecomputed = 0;
  const universeCache: PsiUniverseCache = new Map();

  for (const day of sortedDays) {
    const input = buildStabilityInputForDay(day, now, depegEvents, supplyByCoin, universeCache);
    const indexResult = computeStabilityIndex({
      depegs: input.depegs,
      totalMcapUsd: input.totalMcapUsd,
      mcap7dChangePct: input.mcap7dChangePct,
    });
    if (!indexResult) {
      continue;
    }

    const methodologyVersion = getPsiMethodologyVersionAt(day);
    statements.push(
      db
        .prepare(
          `INSERT INTO stability_index (computed_at, score, band, components, input_snapshot, methodology_version)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(computed_at) DO UPDATE SET
           score = excluded.score,
           band = excluded.band,
           components = excluded.components,
           input_snapshot = excluded.input_snapshot,
           methodology_version = excluded.methodology_version`,
        )
        .bind(
          day,
          indexResult.score,
          indexResult.band,
          JSON.stringify(indexResult.components),
          JSON.stringify({
            depegCount: input.depegCount,
            totalMcapUsd: input.totalMcapUsd,
            mcap7dChangePct: input.mcap7dChangePct,
            methodologyVersion,
          }),
          methodologyVersion,
        ),
    );
    daysRecomputed++;
  }

  return { statements, daysRecomputed };
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
    console.error(`[audit] ${failureMessage}:`, error);
    throw new AuditMutationCommitError(`${failureMessage}; no changes were committed.`);
  }

  return recompute.daysRecomputed;
}

function planDirectDelete(db: D1Database, events: DepegRow[]): AuditMutationPlan {
  const affectedDays = new Set<number>();
  const statements = events.map((event) => {
    addAffectedDays(affectedDays, event.started_at, event.ended_at ?? event.started_at);
    console.log(`[audit] Direct delete: ${event.symbol} id=${event.id} peak=${event.peak_deviation_bps}bps`);
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

function planSyntheticSplitRepair(
  db: D1Database,
  groups: DepegRow[][],
  now: number,
): AuditMutationPlan & { summaries: SyntheticSplitRepairSummary[]; repairedEventCount: number } {
  const affectedDays = new Set<number>();
  const statements: D1PreparedStatement[] = [];
  const summaries: SyntheticSplitRepairSummary[] = [];
  let repairedEventCount = 0;

  for (const group of groups) {
    const summary = summarizeSyntheticSplitGroup(group);
    const { keeper, first, tail, worst } = resolveSyntheticSplitAnchors(group);

    statements.push(
      db
        .prepare(
          "UPDATE depeg_events SET started_at = ?, start_price = ?, peg_reference = ?, peak_deviation_bps = ?, peak_price = ?, ended_at = ?, recovery_price = ? WHERE id = ?",
        )
        .bind(
          first.started_at,
          first.start_price,
          first.peg_reference,
          worst.peak_deviation_bps,
          worst.peak_price ?? worst.start_price,
          tail.ended_at,
          tail.ended_at == null ? null : tail.recovery_price,
          keeper.id,
        ),
    );
    for (const row of group) {
      if (row.id === keeper.id) continue;
      statements.push(db.prepare("DELETE FROM depeg_events WHERE id = ?").bind(row.id));
    }

    addAffectedDays(affectedDays, summary.startedAt, summary.endedAt ?? now);
    summaries.push(summary);
    repairedEventCount += summary.mergedIds.length;
  }

  return { statements, affectedDays, summaries, repairedEventCount };
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

export async function handleAuditDepegHistory(
  db: D1Database,
  url: URL,
  trustedAdmin?: boolean,
  request?: Request,
): Promise<Response> {
  return runAdminRoute(
    {
      endpoint: "audit-depeg-history",
      request,
      trustedAdmin,
    },
    () => handleAuditDepegHistoryTrusted(db, url, request),
  );
}

export async function handleAuditDepegHistoryTrusted(
  db: D1Database,
  url: URL,
  request?: Request,
): Promise<Response> {
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

type PriceValidationReferences = Awaited<ReturnType<typeof loadPriceValidationReferences>>;

async function auditSingleEventWithCoinGecko(
  event: DepegRow,
  validationReferences: PriceValidationReferences | undefined,
  waitForCgFetchStart: () => Promise<void>,
): Promise<AuditEventOutcome> {
  const meta = TRACKED_META_BY_ID.get(event.stablecoin_id);
  const geckoId = meta?.geckoId;

  if (!geckoId) {
    return {
      event,
      auditedEvent: toAuditedEvent(event, "skipped", { cgMaxBps: null }),
      attemptedCgFetch: false,
      upstreamError: false,
      rejectedByValidationCount: 0,
      falsePositiveFound: false,
      provenanceVerdict: null,
      invalidatesProvenance: false,
    };
  }

  const threshold = getDepegThresholdBps(event.peg_type);
  const falsePositiveBar = Math.round(threshold * DEPEG_SECONDARY_THRESHOLD_RATIO);
  const validationContext = buildPriceValidationContext({
    stablecoinId: event.stablecoin_id,
    pegType: event.peg_type,
  });

  const from = event.started_at - 3600;
  const to = (event.ended_at ?? event.started_at) + 3600;
  let rejectedByValidationCount = 0;

  try {
    await waitForCgFetchStart();

    const cgEndpoint = cgUrl(
      `/coins/${geckoId}/market_chart/range?vs_currency=usd&from=${from}&to=${to}&precision=full`,
    );
    const cgFetchHeaders = cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT });
    const cgRes = await fetchWithRetry(cgEndpoint, { headers: cgFetchHeaders }, 1);

    if (!cgRes?.ok) {
      console.warn(`[audit] CG fetch failed for ${event.symbol} (${geckoId}): ${cgRes?.status ?? "no response"}`);
      return {
        event,
        auditedEvent: toAuditedEvent(event, "error", { cgMaxBps: null }),
        attemptedCgFetch: true,
        upstreamError: true,
        rejectedByValidationCount,
        falsePositiveFound: false,
        provenanceVerdict: null,
        invalidatesProvenance: false,
      };
    }

    const cgData = (await cgRes.json()) as { prices?: [number, number][] };
    const rawPrices = cgData.prices ?? [];
    const validatedPrices = rawPrices.filter(([, cgPrice]) => {
      if (typeof cgPrice !== "number" || !Number.isFinite(cgPrice) || cgPrice <= 0) {
        rejectedByValidationCount++;
        return false;
      }
      const verdict = validatePriceCandidate(
        cgPrice,
        validationContext,
        "historical_backfill",
        validationReferences,
      );
      if (!verdict.accepted) {
        rejectedByValidationCount++;
        return false;
      }
      return true;
    });

    if (validatedPrices.length === 0) {
      return {
        event,
        auditedEvent: toAuditedEvent(event, "no_data", { cgMaxBps: null }),
        attemptedCgFetch: true,
        upstreamError: false,
        rejectedByValidationCount,
        falsePositiveFound: false,
        provenanceVerdict: "no_data",
        invalidatesProvenance: true,
      };
    }

    let maxCgBps = 0;
    let maxSameDirectionBps = 0;
    let maxOppositeDirectionBps = 0;
    for (const [, cgPrice] of validatedPrices) {
      const cgSignal = getDeviationSignal(cgPrice, event.peg_reference);
      if (cgSignal == null) continue;
      const cgBps = cgSignal.absBps;
      if (cgBps > maxCgBps) maxCgBps = cgBps;
      if (cgSignal.direction === event.direction) {
        if (cgBps > maxSameDirectionBps) maxSameDirectionBps = cgBps;
      } else if (cgBps > maxOppositeDirectionBps) {
        maxOppositeDirectionBps = cgBps;
      }
    }

    if (maxSameDirectionBps >= falsePositiveBar) {
      return {
        event,
        auditedEvent: toAuditedEvent(event, "confirmed", {
          cgMaxBps: maxCgBps,
          cgMaxSameDirectionBps: maxSameDirectionBps,
          cgMaxOppositeDirectionBps: maxOppositeDirectionBps,
        }),
        attemptedCgFetch: true,
        upstreamError: false,
        rejectedByValidationCount,
        falsePositiveFound: false,
        provenanceVerdict: "confirmed",
        invalidatesProvenance: false,
      };
    }

    if (maxOppositeDirectionBps >= falsePositiveBar) {
      return {
        event,
        auditedEvent: toAuditedEvent(event, "disputed", {
          cgMaxBps: maxCgBps,
          cgMaxSameDirectionBps: maxSameDirectionBps,
          cgMaxOppositeDirectionBps: maxOppositeDirectionBps,
        }),
        attemptedCgFetch: true,
        upstreamError: false,
        rejectedByValidationCount,
        falsePositiveFound: false,
        provenanceVerdict: "disputed",
        invalidatesProvenance: true,
      };
    }

    return {
      event,
      auditedEvent: toAuditedEvent(event, "false_positive", {
        cgMaxBps: maxCgBps,
        cgMaxSameDirectionBps: maxSameDirectionBps,
        cgMaxOppositeDirectionBps: maxOppositeDirectionBps,
      }),
      attemptedCgFetch: true,
      upstreamError: false,
      rejectedByValidationCount,
      falsePositiveFound: true,
      provenanceVerdict: "false_positive",
      invalidatesProvenance: true,
    };
  } catch (err) {
    console.warn(`[audit] Error auditing ${event.symbol}:`, err);
    return {
      event,
      auditedEvent: toAuditedEvent(event, "error", { cgMaxBps: null }),
      attemptedCgFetch: true,
      upstreamError: true,
      rejectedByValidationCount,
      falsePositiveFound: false,
      provenanceVerdict: null,
      invalidatesProvenance: false,
    };
  }
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

  // Load FX references once so CG prices can be vetted with the same
  // validation context the live pricing pipeline uses.
  const validationReferences = paginatedEvents.length > 0
    ? await loadPriceValidationReferences(db)
    : undefined;

  const affectedDays = new Set<number>();
  const provenanceStatements: D1PreparedStatement[] = [];
  const invalidatingProvenanceEventIds: number[] = [];
  const nowSec = Math.floor(Date.now() / 1000);
  let attemptedCgFetches = 0;

  // Analyst plan: 500 req/min. A 200ms shared start interval gives ~300
  // req/min with headroom while allowing validation/fetch waits to overlap.
  const waitForCgFetchStart = createFetchStartLimiter(AUDIT_CG_FETCH_START_INTERVAL_MS);
  const outcomes = await mapWithConcurrency(
    paginatedEvents,
    AUDIT_CG_FETCH_CONCURRENCY,
    (event) => auditSingleEventWithCoinGecko(event, validationReferences, waitForCgFetchStart),
  );

  for (const outcome of outcomes) {
    result.auditedEvents.push(outcome.auditedEvent);
    if (outcome.attemptedCgFetch) attemptedCgFetches++;
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

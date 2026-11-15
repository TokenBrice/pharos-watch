import { jsonResponse } from "../../src/lib/api-response";
import { runAdminJob } from "../../src/lib/admin-job";
import { D1_BATCH_SIZE } from "../../src/lib/constants";
import { buildInClause, executeAtomicBatch } from "../../src/lib/db";
import type { PsiUniverseCache } from "../../src/lib/psi-history-universe";
import { replayHistoricalPsiForDay } from "../../src/lib/psi-replay";
import {
  applyReferenceMarketClosureRule,
  loadHistoricalPsiArchives,
  loadPsiEligibleDepegEvents,
  type PsiEligibleDepegEventRow,
} from "../../src/lib/psi-replay-inputs";
import { computeStabilityIndex } from "../../src/lib/stability-index";
import { getMethodologyVersionAt } from "@shared/lib/methodology-versions/registry";
import { getPegTaxonomyByType } from "@shared/lib/peg-taxonomy";
import { getConditionBand } from "@shared/lib/psi-policy";
import {
  getReferenceMarket,
  getReferenceMarketReopen,
  REFERENCE_MARKET_REOPEN_GRACE_SEC,
  replayReferenceMarketEventStart,
} from "@shared/lib/reference-market-hours";
import { canonicalizePsiStablecoinId } from "@shared/lib/stablecoin-id-registry";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { DAY_SECONDS } from "@shared/lib/time-constants";

/**
 * One-shot repair for history recorded before detection held closed FX and metal references
 * (depeg-dews v6.47). It deletes the artifacts the closure rule (`replayReferenceMarketEventStart`)
 * drops and removes only their effect from published daily PSI rows; a longer event that began
 * during a closure keeps its row, and PSI counts it from the reopen. Closures commit in shared
 * atomic batches. Events in a depeg-resolver incident are never touched and are reported instead.
 */
const REPAIR_MARKER_VERSION = "3.69";
const MAX_CLOSURES_PER_RUN = 50;
/** A daily row missing this close to today may still be written by the snapshot catch-up. */
const SNAPSHOT_CATCH_UP_SEC = 3 * DAY_SECONDS;

interface Change { event: PsiEligibleDepegEventRow; countedFrom: number | null }
interface DayRow { computed_at: number; score: number; components: string; input_snapshot: string; repaired: number }
interface Sample { stored_at: number; input_snapshot: string }
interface SampleSnapshot {
  contributors?: Array<{ id: string; bps: number; mcapUsd: number; ageDays: number }>;
  totalMcapUsd?: number;
  mcap7dChangePct?: number;
  dewsStressBreadth?: number;
}
type Components = Record<"severity" | "breadth" | "stressBreadth" | "trend", number | null>;
type Correction =
  | { day: number; method: "samples" | "replay-delta"; previous: number; score: number; components: Components }
  | { day: number; method: "unavailable"; reason: string; previous: number }
  | { day: number; method: "replayed-with-rule"; previous: number };

/** UTC days on which the rule removes some of the event: all of an artifact's, or a longer event's before the reopen. */
function changedDays({ event, countedFrom }: Change, now: number): number[] {
  const until = countedFrom ?? event.ended_at ?? now;
  const days: number[] = [];
  for (let day = bucketUnixSecondsToUtcDay(event.started_at); day < until; day += DAY_SECONDS) days.push(day);
  return days;
}

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;
const isActive = (event: PsiEligibleDepegEventRow, at: number) =>
  (event.counted_from ?? event.started_at) <= at && (event.ended_at == null || event.ended_at > at);

/** The artifacts' effect on one live sample: its PSI recomputed without them minus with them. */
function sampleDelta(sample: Sample, before: PsiEligibleDepegEventRow[], after: PsiEligibleDepegEventRow[]) {
  const removed = new Set(before.filter((event) => isActive(event, sample.stored_at)).map((event) => canonicalizePsiStablecoinId(event.stablecoin_id)));
  for (const event of after) if (isActive(event, sample.stored_at)) removed.delete(canonicalizePsiStablecoinId(event.stablecoin_id));
  const { contributors, totalMcapUsd, mcap7dChangePct, dewsStressBreadth } = JSON.parse(sample.input_snapshot) as SampleSnapshot;
  if (!contributors?.some((contributor) => removed.has(contributor.id))) return { score: 0, severity: 0, breadth: 0 };
  if (totalMcapUsd == null || mcap7dChangePct == null) return null;
  const score = (kept: typeof contributors) => computeStabilityIndex({
    depegs: kept.map((contributor) => ({ bps: contributor.bps, mcapUsd: contributor.mcapUsd, depegAgeDays: contributor.ageDays })),
    totalMcapUsd, mcap7dChangePct, dewsStressBreadth,
  });
  const was = score(contributors);
  const is = score(contributors.filter((contributor) => !removed.has(contributor.id)));
  if (!was || !is) return null;
  return { score: is.score - was.score, severity: is.components.severity - was.components.severity, breadth: is.components.breadth - was.components.breadth };
}

/** Stored components are rounded and older replays differ slightly from today's. */
const COMPONENT_DRIFT_TOLERANCE = 0.5;

function adjusted(row: DayRow, delta: { score: number; severity: number; breadth: number }, method: "samples" | "replay-delta"): Correction {
  const components = JSON.parse(row.components) as Components;
  const lowered = (key: "severity" | "breadth") => components[key] == null ? null : components[key]! + delta[key];
  const severity = lowered("severity");
  const breadth = lowered("breadth");
  // Removing more than a component holds floors it at zero and gives the excess back to the score;
  // beyond the tolerance the row was built from other inputs and stays as published.
  const overshoot = Math.max(0, -(severity ?? 0)) + Math.max(0, -(breadth ?? 0));
  if (overshoot > COMPONENT_DRIFT_TOLERANCE) return { day: row.computed_at, method: "unavailable", reason: "component-drift", previous: row.score };
  const floored = (value: number | null) => value == null ? null : round(Math.max(0, value), 2);
  return {
    day: row.computed_at, method, previous: row.score,
    score: round(Math.min(100, Math.max(0, row.score + delta.score - overshoot)), 1),
    components: { ...components, severity: floored(severity), breadth: floored(breadth) },
  };
}

export async function handleRepairReferenceMarketArtifacts({ db, url, request }: { db: D1Database; url: URL; request?: Request }): Promise<Response> {
  return runAdminJob({ request, url }, async ({ dryRun }) => {
    const limit = Math.min(MAX_CLOSURES_PER_RUN, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "5", 10) || 5));
    // Preview cursor: only closures reopening after this unix second.
    const afterReopen = Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0;
    const now = Math.floor(Date.now() / 1000);
    const lastCompletedDay = bucketUnixSecondsToUtcDay(now) - DAY_SECONDS;
    const before = await loadPsiEligibleDepegEvents(db, { replayClosureRule: false });
    const after = applyReferenceMarketClosureRule(before);
    const closures = new Map<number, Change[]>();
    for (const event of before) {
      const pegCurrency = getPegTaxonomyByType(event.peg_type)?.currency;
      const countedFrom = replayReferenceMarketEventStart(pegCurrency, event.started_at, event.ended_at, event.peak_deviation_bps);
      if (countedFrom === event.started_at) continue;
      const reopen = getReferenceMarketReopen(getReferenceMarket(pegCurrency), event.started_at)!;
      closures.set(reopen, [...(closures.get(reopen) ?? []), { event, countedFrom }]);
    }
    const candidateIds = [...closures.values()].flat().map((change) => change.event.id);
    const linked = new Map<number, { incidentKey: string; sealedTarget: boolean }>();
    for (let offset = 0; offset < candidateIds.length; offset += 90) {
      const clause = buildInClause(candidateIds.slice(offset, offset + 90));
      const rows = await db.prepare(
        `SELECT l.event_id, l.incident_key, MAX(CASE WHEN p.event_id = l.event_id THEN 1 ELSE 0 END) AS sealed_target
         FROM depeg_resolver_incident_event_links l
         LEFT JOIN depeg_resolver_public_predictions p ON p.incident_key = l.incident_key
         WHERE l.event_id IN (${clause.sql}) GROUP BY l.event_id, l.incident_key`,
      ).bind(...clause.binds).all<{ event_id: number; incident_key: string; sealed_target: number }>();
      for (const row of rows.results ?? []) linked.set(row.event_id, { incidentKey: row.incident_key, sealedTarget: row.sealed_target === 1 });
    }

    const universeCache: PsiUniverseCache = new Map();
    const results: Record<string, unknown>[] = [];
    let processed = 0;
    // Closures are independent, so several share one atomic import: D1 may pause during each import.
    let pending: { statements: D1PreparedStatement[]; results: Record<string, unknown>[] } = { statements: [], results: [] };
    const flush = async () => {
      if (!dryRun && pending.statements.length > 0) await executeAtomicBatch(db, pending.statements);
      for (const result of pending.results) result.status = dryRun ? "planned" : "applied";
      pending = { statements: [], results: [] };
    };
    for (const [reopen, changes] of [...closures.entries()].sort(([a], [b]) => a - b)) {
      if (processed >= limit) break;
      if (reopen <= afterReopen) continue;
      const days = [...new Set(changes.flatMap((change) => changedDays(change, now)))].sort((a, b) => a - b);
      const deletable = changes.filter((change) => change.countedFrom == null && !linked.has(change.event.id));
      const dayRows = days.length === 0 ? [] : await db.prepare(
        `SELECT computed_at, score, components, input_snapshot,
           json_extract(input_snapshot, '$.referenceMarketRepair') IS NOT NULL AS repaired
         FROM stability_index WHERE computed_at IN (${buildInClause(days).sql})`,
      ).bind(...days).all<DayRow>().then((rows) => rows.results ?? []);
      const open = dayRows.filter((row) => !row.repaired);
      if (deletable.length === 0 && open.length === 0) continue;
      processed++;
      // Wait until the closure's artifacts have settled and every recent daily row exists: the
      // correction cannot be derived once its events are deleted.
      const missing = days.filter((day) => !dayRows.some((row) => row.computed_at === day));
      if (now < reopen + REFERENCE_MARKET_REOPEN_GRACE_SEC || missing.some((day) => day > lastCompletedDay - SNAPSHOT_CATCH_UP_SEC)) {
        results.push({ reopen, status: "waiting-for-daily-rows" });
        continue;
      }

      const corrections: Correction[] = [];
      // Replay inputs load only for a replay-built row.
      let archives: Awaited<ReturnType<typeof loadHistoricalPsiArchives>> | null = null;
      for (const row of open) {
        const snapshot = JSON.parse(row.input_snapshot) as { source?: string; sampleCount?: number; referenceMarketRule?: boolean };
        // A row a later replay rebuilt already excludes the artifacts: mark it, change nothing.
        if (snapshot.referenceMarketRule === true) {
          corrections.push({ day: row.computed_at, method: "replayed-with-rule", previous: row.score });
          continue;
        }
        if (snapshot.source === "daily-avg") {
          // A live daily average is corrected only from its own complete set of samples.
          const samples = await db.prepare(
            "SELECT stored_at, input_snapshot FROM stability_index_samples WHERE stored_at >= ? AND stored_at < ?",
          ).bind(row.computed_at, row.computed_at + DAY_SECONDS).all<Sample>().then((rows) => rows.results ?? []);
          const deltas = samples.map((sample) => sampleDelta(sample, before, after));
          if (samples.length === 0 || samples.length !== snapshot.sampleCount || deltas.some((delta) => delta == null)) {
            corrections.push({ day: row.computed_at, method: "unavailable", reason: "samples-unavailable", previous: row.score });
            continue;
          }
          const mean = (key: "score" | "severity" | "breadth") => deltas.reduce((sum, delta) => sum + delta![key], 0) / deltas.length;
          corrections.push(adjusted(row, { score: mean("score"), severity: mean("severity"), breadth: mean("breadth") }, "samples"));
          continue;
        }
        const inputs = archives ??= await loadHistoricalPsiArchives(db, days[0]!, days[days.length - 1]!);
        const replay = (events: PsiEligibleDepegEventRow[]) => replayHistoricalPsiForDay({
          day: row.computed_at, now, methodologyVersion: getMethodologyVersionAt("stability-index", row.computed_at),
          depegEvents: events, supplyByCoin: inputs.supplyByCoin, dewsByDay: inputs.dewsByDay, universeCache,
        }).result;
        const was = replay(before);
        const is = replay(after);
        corrections.push(!was || !is
          ? { day: row.computed_at, method: "unavailable", reason: "replay-unavailable", previous: row.score }
          : adjusted(row, {
            score: is.score - was.score, severity: is.components.severity - was.components.severity, breadth: is.components.breadth - was.components.breadth,
          }, "replay-delta"));
      }

      // Every evaluated day is marked, corrected or not, so a rerun converges; the guard makes a
      // day shared by two closures change once.
      const statements = [
        ...deletable.map(({ event }) => db.prepare("DELETE FROM depeg_events WHERE id = ?").bind(event.id)),
        ...corrections.map((correction) => {
          const marker = JSON.stringify({ version: REPAIR_MARKER_VERSION, method: correction.method, previousScore: correction.previous, repairedAt: now,
            ...(correction.method === "unavailable" ? { reason: correction.reason } : {}) });
          return correction.method === "unavailable" || correction.method === "replayed-with-rule"
            ? db.prepare(`UPDATE stability_index SET input_snapshot = json_set(input_snapshot, '$.referenceMarketRepair', json(?))
                WHERE computed_at = ? AND json_extract(input_snapshot, '$.referenceMarketRepair') IS NULL`).bind(marker, correction.day)
            : db.prepare(`UPDATE stability_index SET score = ?, band = ?, components = ?, input_snapshot = json_set(input_snapshot, '$.referenceMarketRepair', json(?))
                WHERE computed_at = ? AND json_extract(input_snapshot, '$.referenceMarketRepair') IS NULL`)
              .bind(correction.score, getConditionBand(correction.score), JSON.stringify(correction.components), marker, correction.day);
        }),
      ];
      if (statements.length > D1_BATCH_SIZE) {
        results.push({ reopen, status: "exceeds-atomic-batch", statements: statements.length });
        continue;
      }
      if (pending.statements.length + statements.length > D1_BATCH_SIZE) await flush();
      const result: Record<string, unknown> = {
        reopen,
        status: "pending",
        deleted: deletable.map((change) => change.event.id),
        locked: changes.filter((change) => linked.has(change.event.id))
          .map((change) => ({ id: change.event.id, artifact: change.countedFrom == null, ...linked.get(change.event.id)! })),
        days: corrections.map((correction) => correction.method === "unavailable"
          ? { day: correction.day, method: correction.method, reason: correction.reason, previous: correction.previous }
          : correction.method === "replayed-with-rule"
            ? { day: correction.day, method: correction.method, previous: correction.previous }
            : { day: correction.day, method: correction.method, previous: correction.previous, score: correction.score }),
      };
      results.push(result);
      pending.statements.push(...statements);
      pending.results.push(result);
    }
    await flush();
    return jsonResponse({ dryRun, limit, closuresWithChanges: closures.size, processed, results });
  });
}

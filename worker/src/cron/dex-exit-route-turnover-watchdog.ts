import { z } from "zod";

import {
  DexExitEvidenceKindSchema,
  DexExitRouteObservationsSchema,
  MAX_DEX_EXIT_ROUTE_OBSERVATIONS,
  type DexExitEvidenceKind,
} from "@shared/types/market";
import { throwIfAborted } from "../lib/abort";
import { getCache, setCache } from "../lib/db-cache";
import type { CronResult } from "../lib/cron-logger";
import { createCronResult } from "../lib/cron-result";
import { parseJson } from "../lib/json-parse";
import { logWorkerEvent } from "../lib/structured-log";

export const DEX_EXIT_ROUTE_TURNOVER_SNAPSHOT_CACHE_KEY = "dex-exit-route-turnover-watchdog:snapshot:v1";

/**
 * Alert at 0.5 Jaccard distance: for two equally sized route sets this means
 * at least one third of the published slots were replaced. Smaller changes
 * remain visible in metadata without degrading the cron, while wholesale loss
 * of a coin's routes is 1.0.
 */
export const DEX_EXIT_ROUTE_TURNOVER_ALERT_THRESHOLD = 0.5;

const MAX_WORST_OFFENDERS = 10;
const MAX_ROUTE_ID_SAMPLES = 8;

const RouteEvidenceSchema = z.object({
  routeId: z.string().min(1),
  evidenceKind: DexExitEvidenceKindSchema,
}).strict();

const PendingTurnoverAlertSchema = z.object({
  generationId: z.string().min(1),
  threshold: z.number(),
  worstOffenders: z.array(z.object({ stablecoinId: z.string().min(1), jaccardDistance: z.number() }).strict())
    .max(MAX_WORST_OFFENDERS),
}).strict();

const RouteSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  generationId: z.string().min(1),
  coins: z.array(z.object({
    stablecoinId: z.string().min(1),
    routes: z.array(RouteEvidenceSchema).max(MAX_DEX_EXIT_ROUTE_OBSERVATIONS),
  }).strict()).max(1_024),
  /**
   * Evidence for an alerting run. The baseline advances in the same run that
   * alerts, so the alert itself is persisted here and cleared only by a later
   * run that observes no alerting coin.
   */
  pendingAlert: PendingTurnoverAlertSchema.optional(),
}).strict();

type RouteEvidence = z.infer<typeof RouteEvidenceSchema>;
type RouteSnapshot = z.infer<typeof RouteSnapshotSchema>;
type PendingTurnoverAlert = z.infer<typeof PendingTurnoverAlertSchema>;

interface PublishedGenerationRow {
  generation_id: string;
  published_at: number | null;
}

interface PublishedRouteRow {
  stablecoin_id: string;
  score_components_json: string | null;
}

interface EvidenceKindChange {
  routeId: string;
  previousEvidenceKind: DexExitEvidenceKind;
  currentEvidenceKind: DexExitEvidenceKind;
}

interface TurnoverEvaluation {
  stablecoinId: string;
  previousRouteCount: number;
  currentRouteCount: number;
  addedRouteCount: number;
  removedRouteCount: number;
  jaccardDistance: number;
  evidenceKindChangedCount: number;
  addedRouteIds: string[];
  removedRouteIds: string[];
  evidenceKindChanges: EvidenceKindChange[];
}

function parsePublishedRouteEvidence(row: PublishedRouteRow): RouteEvidence[] {
  if (row.score_components_json === null) return [];
  const parsed = parseJson(row.score_components_json);
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    throw new Error(`Invalid DEX score details for turnover watchdog (${row.stablecoin_id})`);
  }
  const rawObservations = (parsed.value as { exitRouteObservations?: unknown }).exitRouteObservations;
  if (rawObservations == null) return [];
  const observations = DexExitRouteObservationsSchema.safeParse(rawObservations);
  if (!observations.success) {
    throw new Error(`Invalid DEX exit-route observations for turnover watchdog (${row.stablecoin_id})`);
  }
  const seen = new Set<string>();
  const routes = observations.data.map((observation) => {
    if (seen.has(observation.routeId)) {
      throw new Error(`Duplicate DEX exit-route id for turnover watchdog (${row.stablecoin_id})`);
    }
    seen.add(observation.routeId);
    const evidenceKind = DexExitEvidenceKindSchema.safeParse(observation.evidenceKind);
    if (!evidenceKind.success) {
      throw new Error(`Invalid DEX exit-route evidence kind for turnover watchdog (${row.stablecoin_id})`);
    }
    return {
      routeId: observation.routeId,
      evidenceKind: evidenceKind.data,
    };
  });
  return routes.sort((left, right) => left.routeId.localeCompare(right.routeId));
}

function buildRouteSnapshot(generationId: string, rows: readonly PublishedRouteRow[]): RouteSnapshot {
  const stablecoinIds = new Set<string>();
  const coins = rows.map((row) => {
    if (stablecoinIds.has(row.stablecoin_id)) {
      throw new Error(`Duplicate DEX stablecoin row for turnover watchdog (${row.stablecoin_id})`);
    }
    stablecoinIds.add(row.stablecoin_id);
    return {
      stablecoinId: row.stablecoin_id,
      routes: parsePublishedRouteEvidence(row),
    };
  });
  coins.sort((left, right) => left.stablecoinId.localeCompare(right.stablecoinId));
  return {
    schemaVersion: 1,
    generationId,
    coins,
  };
}

function parsePreviousRouteSnapshot(value: string): RouteSnapshot | { invalidReason: string } {
  const parsed = parseJson(value);
  if (!parsed.ok) return { invalidReason: "invalid-json" };
  const snapshot = RouteSnapshotSchema.safeParse(parsed.value);
  if (!snapshot.success) return { invalidReason: "invalid-schema" };
  return snapshot.data;
}

function routeMap(routes: readonly RouteEvidence[], stablecoinId: string): Map<string, DexExitEvidenceKind> {
  const map = new Map<string, DexExitEvidenceKind>();
  for (const route of routes) {
    if (map.has(route.routeId)) {
      throw new Error(`Duplicate persisted DEX exit-route id for turnover watchdog (${stablecoinId})`);
    }
    map.set(route.routeId, route.evidenceKind);
  }
  return map;
}

function evaluateCoinTurnover(
  stablecoinId: string,
  previousRoutes: readonly RouteEvidence[],
  currentRoutes: readonly RouteEvidence[],
): TurnoverEvaluation {
  const previous = routeMap(previousRoutes, stablecoinId);
  const current = routeMap(currentRoutes, stablecoinId);
  const addedRouteIds = [...current.keys()].filter((routeId) => !previous.has(routeId)).sort();
  const removedRouteIds = [...previous.keys()].filter((routeId) => !current.has(routeId)).sort();
  const sharedRouteIds = [...previous.keys()].filter((routeId) => current.has(routeId)).sort();
  const unionSize = previous.size + addedRouteIds.length;
  const jaccardDistance = unionSize === 0 ? 0 : 1 - sharedRouteIds.length / unionSize;
  const evidenceKindChanges = sharedRouteIds.flatMap((routeId): EvidenceKindChange[] => {
    const previousEvidenceKind = previous.get(routeId)!;
    const currentEvidenceKind = current.get(routeId)!;
    return previousEvidenceKind === currentEvidenceKind
      ? []
      : [{ routeId, previousEvidenceKind, currentEvidenceKind }];
  });
  return {
    stablecoinId,
    previousRouteCount: previous.size,
    currentRouteCount: current.size,
    addedRouteCount: addedRouteIds.length,
    removedRouteCount: removedRouteIds.length,
    jaccardDistance: Number(jaccardDistance.toFixed(6)),
    evidenceKindChangedCount: evidenceKindChanges.length,
    addedRouteIds: addedRouteIds.slice(0, MAX_ROUTE_ID_SAMPLES),
    removedRouteIds: removedRouteIds.slice(0, MAX_ROUTE_ID_SAMPLES),
    evidenceKindChanges: evidenceKindChanges.slice(0, MAX_ROUTE_ID_SAMPLES),
  };
}

function compareRouteSnapshots(previous: RouteSnapshot, current: RouteSnapshot): TurnoverEvaluation[] {
  const currentById = new Map(current.coins.map((coin) => [coin.stablecoinId, coin.routes]));
  return previous.coins
    .map((coin) => evaluateCoinTurnover(
      coin.stablecoinId,
      coin.routes,
      currentById.get(coin.stablecoinId) ?? [],
    ))
    .sort((left, right) =>
      right.jaccardDistance - left.jaccardDistance
      || right.evidenceKindChangedCount - left.evidenceKindChangedCount
      || left.stablecoinId.localeCompare(right.stablecoinId),
    );
}

export async function runDexExitRouteTurnoverWatchdog(
  db: D1Database,
  signal?: AbortSignal,
): Promise<CronResult> {
  throwIfAborted(signal);
  const generation = await db
    .prepare(
      `SELECT generation_id, published_at
         FROM dex_liquidity_publication_generations
        WHERE state = 'published'
        ORDER BY published_at DESC, started_at DESC, generation_id DESC
        LIMIT 1`,
    )
    .first<PublishedGenerationRow>();
  throwIfAborted(signal);
  if (generation === null) {
    return createCronResult({
      status: "skipped_neutral",
      itemCount: 0,
      metadata: { reason: "no-published-dex-generation" },
    });
  }

  const publishedRows = await db
    .prepare(
      `SELECT stablecoin_id, score_components_json
         FROM dex_liquidity_run_rows
        WHERE generation_id = ?
          AND stablecoin_id != '__global__'
        ORDER BY stablecoin_id`,
    )
    .bind(generation.generation_id)
    .all<PublishedRouteRow>();
  throwIfAborted(signal);
  const current = buildRouteSnapshot(generation.generation_id, publishedRows.results ?? []);
  const previousCache = await getCache(db, DEX_EXIT_ROUTE_TURNOVER_SNAPSHOT_CACHE_KEY, signal);
  throwIfAborted(signal);

  const previous = previousCache === null
    ? null
    : parsePreviousRouteSnapshot(previousCache.value);
  if (previous !== null && "invalidReason" in previous) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "dex_exit_route_turnover_snapshot_recovered",
      job: "dex-exit-route-turnover-watchdog",
      message: "Replaced an unreadable DEX exit-route turnover baseline",
      metadata: { reason: previous.invalidReason, generationId: current.generationId },
    });
  }
  const comparable = previous !== null && !("invalidReason" in previous) ? previous : null;

  let result: CronResult;
  let pendingAlert: PendingTurnoverAlert | undefined;
  if (comparable === null) {
    result = createCronResult({
      itemCount: 0,
      metadata: {
        currentGenerationId: current.generationId,
        previousGenerationId: null,
        baselineCreated: true,
        recoveredFromInvalidBaseline: previous !== null,
        comparedCoinCount: 0,
        evidenceKindChangedRouteCount: 0,
        alertingCoinCount: 0,
        turnoverAlertThreshold: DEX_EXIT_ROUTE_TURNOVER_ALERT_THRESHOLD,
        worstOffenders: [],
      },
    });
  } else {
    const evaluations = compareRouteSnapshots(comparable, current);
    const changedCoinCount = evaluations.filter(
      (evaluation) => evaluation.jaccardDistance > 0 || evaluation.evidenceKindChangedCount > 0,
    ).length;
    const alerting = evaluations.filter(
      (evaluation) => evaluation.jaccardDistance >= DEX_EXIT_ROUTE_TURNOVER_ALERT_THRESHOLD,
    );
    const evidenceKindChangedRouteCount = evaluations.reduce(
      (sum, evaluation) => sum + evaluation.evidenceKindChangedCount,
      0,
    );
    // The baseline advances in this run, so an alert raised here is persisted
    // with the new snapshot and stays visible until a run sees no alerting coin.
    const carriedAlert = comparable.pendingAlert ?? null;
    pendingAlert = alerting.length === 0
      ? undefined
      : {
          generationId: current.generationId,
          threshold: DEX_EXIT_ROUTE_TURNOVER_ALERT_THRESHOLD,
          worstOffenders: alerting.slice(0, MAX_WORST_OFFENDERS).map((evaluation) => ({
            stablecoinId: evaluation.stablecoinId,
            jaccardDistance: evaluation.jaccardDistance,
          })),
        };
    const metadata = JSON.stringify({
      currentGenerationId: current.generationId,
      previousGenerationId: comparable.generationId,
      baselineCreated: false,
      comparedCoinCount: evaluations.length,
      changedCoinCount,
      evidenceKindChangedRouteCount,
      alertingCoinCount: alerting.length,
      turnoverAlertThreshold: DEX_EXIT_ROUTE_TURNOVER_ALERT_THRESHOLD,
      highestObservedTurnover: evaluations[0]?.jaccardDistance ?? 0,
      worstOffenders: alerting.slice(0, MAX_WORST_OFFENDERS),
      carriedPendingAlert: carriedAlert,
      pendingAlertCleared: carriedAlert !== null && alerting.length === 0,
      reason: alerting.length > 0
        ? "dex-route-turnover-threshold"
        : carriedAlert !== null ? "dex-route-turnover-pending-alert" : null,
    });
    result = alerting.length === 0 && carriedAlert === null
      ? { itemCount: evaluations.length, metadata }
      : { status: "degraded", itemCount: evaluations.length, metadata };
  }

  await setCache(
    db,
    DEX_EXIT_ROUTE_TURNOVER_SNAPSHOT_CACHE_KEY,
    JSON.stringify(pendingAlert ? { ...current, pendingAlert } : current),
    signal,
  );
  throwIfAborted(signal);
  return result;
}

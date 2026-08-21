import { z } from "zod";

import {
  DexExitEvidenceKindSchema,
  DexExitRouteObservationSchema,
  MAX_DEX_EXIT_ROUTE_OBSERVATIONS,
  type DexExitEvidenceKind,
} from "@shared/types/market";
import { throwIfAborted } from "../lib/abort";
import { getCache, setCache } from "../lib/db-cache";
import type { CronResult } from "../lib/cron-logger";
import { parseJson } from "../lib/json-parse";

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

const RouteSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  generationId: z.string().min(1),
  coins: z.array(z.object({
    stablecoinId: z.string().min(1),
    routes: z.array(RouteEvidenceSchema).max(MAX_DEX_EXIT_ROUTE_OBSERVATIONS),
  }).strict()).max(1_024),
}).strict();

type RouteEvidence = z.infer<typeof RouteEvidenceSchema>;
type RouteSnapshot = z.infer<typeof RouteSnapshotSchema>;

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
  const observations = DexExitRouteObservationSchema.array()
    .max(MAX_DEX_EXIT_ROUTE_OBSERVATIONS)
    .safeParse(rawObservations);
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

function parsePreviousRouteSnapshot(value: string): RouteSnapshot {
  const parsed = parseJson(value);
  if (!parsed.ok) throw new Error("Invalid persisted DEX exit-route turnover snapshot JSON");
  const snapshot = RouteSnapshotSchema.safeParse(parsed.value);
  if (!snapshot.success) throw new Error("Invalid persisted DEX exit-route turnover snapshot schema");
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
    return {
      status: "skipped_neutral",
      itemCount: 0,
      metadata: JSON.stringify({ reason: "no-published-dex-generation" }),
    };
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
  await setCache(db, DEX_EXIT_ROUTE_TURNOVER_SNAPSHOT_CACHE_KEY, JSON.stringify(current), signal);
  throwIfAborted(signal);

  if (previousCache === null) {
    return {
      itemCount: 0,
      metadata: JSON.stringify({
        currentGenerationId: current.generationId,
        previousGenerationId: null,
        baselineCreated: true,
        comparedCoinCount: 0,
        evidenceKindChangedRouteCount: 0,
        alertingCoinCount: 0,
        turnoverAlertThreshold: DEX_EXIT_ROUTE_TURNOVER_ALERT_THRESHOLD,
        worstOffenders: [],
      }),
    };
  }

  const previous = parsePreviousRouteSnapshot(previousCache.value);
  const evaluations = compareRouteSnapshots(previous, current);
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
  const metadata = JSON.stringify({
    currentGenerationId: current.generationId,
    previousGenerationId: previous.generationId,
    baselineCreated: false,
    comparedCoinCount: evaluations.length,
    changedCoinCount,
    evidenceKindChangedRouteCount,
    alertingCoinCount: alerting.length,
    turnoverAlertThreshold: DEX_EXIT_ROUTE_TURNOVER_ALERT_THRESHOLD,
    highestObservedTurnover: evaluations[0]?.jaccardDistance ?? 0,
    worstOffenders: alerting.slice(0, MAX_WORST_OFFENDERS),
  });

  return alerting.length === 0
    ? { itemCount: evaluations.length, metadata }
    : { status: "degraded", itemCount: evaluations.length, metadata };
}

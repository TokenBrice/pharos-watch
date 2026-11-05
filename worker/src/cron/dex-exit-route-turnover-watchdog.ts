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
import { recordOperatorAlertReceipt } from "../lib/status/operator-alert-health";
import { parseJson } from "../lib/json-parse";
import { escapeHtml, type TelegramCreds } from "../telegram/delivery/telegram";
import { deliverOperatorAlert } from "./cron-sentinel-rules";

export const DEX_EXIT_ROUTE_TURNOVER_SNAPSHOT_CACHE_KEY = "dex-exit-route-turnover-watchdog:snapshot:v1";
/**
 * One alert per alert episode. The episode flag is committed only after
 * transport accepts the durable pending payload.
 */
export const DEX_EXIT_ROUTE_TURNOVER_ALERT_STATE_CACHE_KEY = "dex-exit-route-turnover-watchdog:alert:v1";

/**
 * Alert at 0.5 Jaccard distance: for two equally sized route sets this means
 * at least one third of the published slots were replaced. A coin alerts only
 * when this distance is reached with enough REMOVED routes (see
 * `DEX_EXIT_ROUTE_TURNOVER_MIN_CHANGED_ROUTES`) and is sustained across two
 * consecutive published generations against the last confirmed baseline;
 * smaller changes remain visible in metadata without degrading the cron,
 * while wholesale loss of a coin's routes is 1.0.
 */
export const DEX_EXIT_ROUTE_TURNOVER_ALERT_THRESHOLD = 0.5;

/**
 * Minimum REMOVED routes that can alert alongside the Jaccard threshold.
 * Exit-route turnover is published exit capacity disappearing, so coverage
 * gains never meet the churn gate: a discovery-tier refresh reviving staged
 * CoinGecko evidence, or a new venue listing, can add a coin's whole route
 * set (Jaccard distance 1.0) without removing a single route. Likewise a
 * single route swapping for another on a 1-2 route coin trivially crosses
 * 0.5 Jaccard distance without being turnover. Those additions and swaps
 * stay metadata-only even when sustained across generations.
 */
const DEX_EXIT_ROUTE_TURNOVER_MIN_CHANGED_ROUTES = 2;

const MAX_WORST_OFFENDERS = 10;
const MAX_ROUTE_ID_SAMPLES = 8;

const RouteEvidenceSchema = z.object({
  routeId: z.string().min(1),
  evidenceKind: DexExitEvidenceKindSchema,
}).strict();

/**
 * A coin that diverged from its held baseline in exactly one published
 * generation. The next comparison either confirms the divergence into an
 * alert or clears it, so a candidate never survives its confirming run.
 */
const TurnoverCandidateSchema = z.object({
  stablecoinId: z.string().min(1),
  generationId: z.string().min(1),
  jaccardDistance: z.number(),
  addedRouteCount: z.number().int().min(0),
  removedRouteCount: z.number().int().min(0),
}).strict();

const PendingTurnoverAlertSchema = z.object({
  generationId: z.string().min(1),
  threshold: z.number(),
  worstOffenders: z.array(z.object({ stablecoinId: z.string().min(1), jaccardDistance: z.number() }).strict())
    .max(MAX_WORST_OFFENDERS),
}).strict();

const TurnoverAlertStateSchema = z.object({
  active: z.boolean(),
  generationId: z.string().min(1).nullable(),
  sentAtSec: z.number().int().nonnegative().nullable(),
}).strict();

const RouteSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  generationId: z.string().min(1),
  /**
   * Last confirmed baseline route set per coin. A coin with an open candidate
   * keeps its pre-divergence baseline here instead of advancing, so the
   * confirming comparison is measured against the last stable route set.
   */
  coins: z.array(z.object({
    stablecoinId: z.string().min(1),
    routes: z.array(RouteEvidenceSchema).max(MAX_DEX_EXIT_ROUTE_OBSERVATIONS),
  }).strict()).max(1_024),
  /**
   * Divergent-but-unconfirmed coins. Absent in payloads written before the
   * sustain window existed; an absent or unknown candidate state means no
   * candidate.
   */
  candidates: z.array(TurnoverCandidateSchema).max(1_024).optional(),
  /**
   * Evidence for an alerting run (a divergence sustained across two published
   * generations). The per-coin baseline advances in the run that alerts, so
   * original alert stays here until transport accepts it, independently of
   * subsequent comparisons.
   */
  pendingAlert: PendingTurnoverAlertSchema.optional(),
}).strict();

type RouteEvidence = z.infer<typeof RouteEvidenceSchema>;
type RouteSnapshot = z.infer<typeof RouteSnapshotSchema>;
type PendingTurnoverAlert = z.infer<typeof PendingTurnoverAlertSchema>;
type TurnoverCandidate = z.infer<typeof TurnoverCandidateSchema>;
type TurnoverAlertState = z.infer<typeof TurnoverAlertStateSchema>;

export interface DexExitRouteTurnoverWatchdogOptions {
  /** Operator chat; absent credentials leave the alert pending for the next run. */
  operatorTelegramCreds?: TelegramCreds | null;
}

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
    .flatMap((coin) => {
      const currentRoutes = currentById.get(coin.stablecoinId);
      // A baseline coin with no row in the newest published generation was
      // not observed (for example it left the active roster), not observed
      // with zero routes (R1). Keep its baseline instead of alerting.
      if (currentRoutes === undefined) return [];
      return [evaluateCoinTurnover(coin.stablecoinId, coin.routes, currentRoutes)];
    })
    .sort((left, right) =>
      right.jaccardDistance - left.jaccardDistance
      || right.evidenceKindChangedCount - left.evidenceKindChangedCount
      || left.stablecoinId.localeCompare(right.stablecoinId),
    );
}

function meetsAlertCriteria(evaluation: TurnoverEvaluation): boolean {
  // Losing every published route is the strongest turnover signal regardless
  // of how few routes the coin had; it still needs the sustain window.
  if (evaluation.previousRouteCount > 0 && evaluation.currentRouteCount === 0) return true;
  // Turnover is exit capacity disappearing, so the churn gate counts removed
  // routes only. Pure additions — staged CoinGecko evidence revived by a
  // discovery refresh, or a new venue listing — and one-for-one route swaps
  // cross the Jaccard threshold without removing exit capacity and must not
  // degrade the sentinel.
  return evaluation.jaccardDistance >= DEX_EXIT_ROUTE_TURNOVER_ALERT_THRESHOLD
    && evaluation.removedRouteCount >= DEX_EXIT_ROUTE_TURNOVER_MIN_CHANGED_ROUTES;
}

function parseAlertState(value: string | null | undefined): TurnoverAlertState {
  if (value == null) return { active: false, generationId: null, sentAtSec: null };
  const parsed = parseJson(value);
  const state = parsed.ok ? TurnoverAlertStateSchema.safeParse(parsed.value) : null;
  if (!state?.success) throw new Error("Invalid DEX exit-route turnover alert state");
  return state.data;
}

function buildTurnoverAlertMessage(alert: PendingTurnoverAlert): string {
  const offenders = alert.worstOffenders
    .map((offender) => `${offender.stablecoinId} (${offender.jaccardDistance.toFixed(2)})`)
    .join(", ");
  return [
    "<b>Pharos DEX exit-route turnover</b>",
    "",
    "Producer: sync-dex-liquidity",
    `Published generation: ${escapeHtml(alert.generationId)}`,
    "Historical published event; current routes may have recovered.",
    `Budget: Jaccard >= ${DEX_EXIT_ROUTE_TURNOVER_ALERT_THRESHOLD} with >= ${DEX_EXIT_ROUTE_TURNOVER_MIN_CHANGED_ROUTES} removed routes, sustained 2 published generations`,
    `Coins: ${escapeHtml(offenders)}`,
  ].join("\n");
}

export async function runDexExitRouteTurnoverWatchdog(
  db: D1Database,
  signal?: AbortSignal,
  options: DexExitRouteTurnoverWatchdogOptions = {},
): Promise<CronResult> {
  throwIfAborted(signal);
  const nowSec = Math.floor(Date.now() / 1000);
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
  const [previousCache, alertStateCache] = await Promise.all([
    getCache(db, DEX_EXIT_ROUTE_TURNOVER_SNAPSHOT_CACHE_KEY, signal),
    getCache(db, DEX_EXIT_ROUTE_TURNOVER_ALERT_STATE_CACHE_KEY, signal),
  ]);
  throwIfAborted(signal);

  const previous = previousCache === null
    ? null
    : parsePreviousRouteSnapshot(previousCache.value);
  if (previous !== null && "invalidReason" in previous) {
    // Unread state cannot prove that no historical notification is pending.
    throw new Error(`Invalid DEX exit-route turnover snapshot: ${previous.invalidReason}`);
  }
  const comparable = previous;
  let alertState = parseAlertState(alertStateCache?.value);
  let alertSent = false;
  let alertDeliveryFailed = false;
  // Legacy snapshots may retain an already acknowledged episode payload.
  let pendingAlert = alertState.active ? undefined : comparable?.pendingAlert;
  const finish = async (
    result: CronResult,
    snapshot: RouteSnapshot | null = comparable,
    alertingComparison: boolean | null = null,
  ): Promise<CronResult> => {
    const persistSnapshot = async () => {
      if (snapshot) {
        const { pendingAlert: _previousPending, ...baseline } = snapshot;
        await setCache(db, DEX_EXIT_ROUTE_TURNOVER_SNAPSHOT_CACHE_KEY,
          JSON.stringify(pendingAlert ? { ...baseline, pendingAlert } : baseline), signal);
      }
    };
    if (snapshot !== comparable || (comparable?.pendingAlert && !pendingAlert)) await persistSnapshot();
    const recordReceipt = () => recordOperatorAlertReceipt(db, "turnover", {
      nowSec,
      operatorConfigured: options.operatorTelegramCreds != null,
      pending: pendingAlert != null,
      delivered: alertSent,
      reason: options.operatorTelegramCreds == null ? "operator-alert-credentials-missing"
        : alertDeliveryFailed ? "operator-alert-delivery-failed" : null,
    }, signal);
    // Persist both payload and pending age before transport can accept the event.
    await recordReceipt();
    if (pendingAlert && options.operatorTelegramCreds != null) {
      const delivery = await deliverOperatorAlert(
        options.operatorTelegramCreds, buildTurnoverAlertMessage(pendingAlert), signal,
      );
      alertDeliveryFailed = !delivery.ok;
      if (delivery.ok) {
        alertState = { active: true, generationId: pendingAlert.generationId, sentAtSec: nowSec };
        await setCache(db, DEX_EXIT_ROUTE_TURNOVER_ALERT_STATE_CACHE_KEY, JSON.stringify(alertState), signal);
        alertSent = true;
        pendingAlert = undefined;
        await persistSnapshot();
      }
      await recordReceipt();
    }
    if (alertingComparison === false && alertState.active) {
      alertState = { active: false, generationId: null, sentAtSec: null };
      await setCache(db, DEX_EXIT_ROUTE_TURNOVER_ALERT_STATE_CACHE_KEY, JSON.stringify(alertState), signal);
    }
    const metadata = JSON.parse(String(result.metadata));
    metadata.operatorAlert = {
      episodeActive: pendingAlert != null || alertState.active,
      sent: alertSent,
      deliveryFailed: alertDeliveryFailed,
    };
    metadata.pendingAlertCleared = comparable?.pendingAlert != null && pendingAlert == null;
    if (alertDeliveryFailed) metadata.reason = "operator-alert-delivery-failed";
    return { ...result, status: alertDeliveryFailed ? "degraded" : result.status, metadata: JSON.stringify(metadata) };
  };
  if (generation === null) {
    return finish(createCronResult({
      status: "skipped_neutral",
      itemCount: 0,
      metadata: { reason: "no-published-dex-generation" },
    }));
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

  // The sustain window counts published generations, not watchdog runs: a
  // rerun that still sees the last compared generation must not confirm or
  // clear candidate state against the same observation twice.
  if (comparable !== null && comparable.generationId === current.generationId) {
    return finish(createCronResult({
      status: "skipped_neutral",
      itemCount: 0,
      metadata: {
        reason: "no-new-published-dex-generation",
        currentGenerationId: current.generationId,
      },
    }));
  }

  let result: CronResult;
  let nextSnapshot: RouteSnapshot = current;
  let alertingComparison = false;
  if (comparable === null) {
    result = createCronResult({
      status: "ok",
      itemCount: 0,
      metadata: {
        currentGenerationId: current.generationId,
        previousGenerationId: null,
        baselineCreated: true,
        recoveredFromInvalidBaseline: previous !== null,
        comparedCoinCount: 0,
        evidenceKindChangedRouteCount: 0,
        alertingCoinCount: 0,
        candidateCoinCount: 0,
        turnoverAlertThreshold: DEX_EXIT_ROUTE_TURNOVER_ALERT_THRESHOLD,
        worstOffenders: [],
      },
    });
  } else {
    const evaluations = compareRouteSnapshots(comparable, current);
    const changedCoinCount = evaluations.filter(
      (evaluation) => evaluation.jaccardDistance > 0 || evaluation.evidenceKindChangedCount > 0,
    ).length;
    const evidenceKindChangedRouteCount = evaluations.reduce(
      (sum, evaluation) => sum + evaluation.evidenceKindChangedCount,
      0,
    );
    const candidateByCoin = new Map(
      (comparable.candidates ?? []).map((candidate) => [candidate.stablecoinId, candidate]),
    );
    const alerting: TurnoverEvaluation[] = [];
    const heldCandidates: TurnoverCandidate[] = [];
    const clearedCandidates: TurnoverCandidate[] = [];
    for (const evaluation of evaluations) {
      const candidate = candidateByCoin.get(evaluation.stablecoinId) ?? null;
      if (!meetsAlertCriteria(evaluation)) {
        // Back at (near) baseline: confirm the current route set and clear
        // any open candidate without alerting.
        if (candidate !== null) clearedCandidates.push(candidate);
        continue;
      }
      if (candidate === null) {
        // First divergent generation against the held baseline: hold the
        // baseline and open a candidate, so a single-generation source blip
        // that recovers next generation never alerts.
        heldCandidates.push({
          stablecoinId: evaluation.stablecoinId,
          generationId: current.generationId,
          jaccardDistance: evaluation.jaccardDistance,
          addedRouteCount: evaluation.addedRouteCount,
          removedRouteCount: evaluation.removedRouteCount,
        });
      } else {
        alerting.push(evaluation);
      }
    }
    // The per-coin baseline advances except where a fresh candidate holds it.
    // A candidate never survives its confirming comparison either way, so it
    // cannot linger.
    const heldCoinIds = new Set(heldCandidates.map((candidate) => candidate.stablecoinId));
    // Unobserved baselines are retained: a coin absent from this generation
    // keeps its last observed route set for when the roster returns it.
    const baselineByCoin = new Map<string, RouteEvidence[]>(
      comparable.coins.map((coin) => [coin.stablecoinId, coin.routes]),
    );
    for (const coin of current.coins) {
      if (!heldCoinIds.has(coin.stablecoinId)) baselineByCoin.set(coin.stablecoinId, coin.routes);
    }
    const baselineCoins = [...baselineByCoin.entries()]
      .map(([stablecoinId, routes]) => ({ stablecoinId, routes }))
      .sort((left, right) => left.stablecoinId.localeCompare(right.stablecoinId));
    nextSnapshot = {
      schemaVersion: 1,
      generationId: current.generationId,
      coins: baselineCoins,
      ...(heldCandidates.length > 0 ? { candidates: heldCandidates } : {}),
    };
    // Comparison advancement must not replace an undelivered historical event.
    const carriedAlert = comparable.pendingAlert ?? null;
    alertingComparison = alerting.length > 0;
    if (alertingComparison && !pendingAlert && !alertState.active) {
      pendingAlert = {
        generationId: current.generationId,
        threshold: DEX_EXIT_ROUTE_TURNOVER_ALERT_THRESHOLD,
        worstOffenders: alerting.slice(0, MAX_WORST_OFFENDERS).map((evaluation) => ({
          stablecoinId: evaluation.stablecoinId,
          jaccardDistance: evaluation.jaccardDistance,
        })),
      };
    }
    const metadata = JSON.stringify({
      currentGenerationId: current.generationId,
      previousGenerationId: comparable.generationId,
      baselineCreated: false,
      comparedCoinCount: evaluations.length,
      changedCoinCount,
      evidenceKindChangedRouteCount,
      alertingCoinCount: alerting.length,
      candidateCoinCount: heldCandidates.length,
      candidates: heldCandidates.slice(0, MAX_WORST_OFFENDERS),
      clearedCandidateCount: clearedCandidates.length,
      clearedCandidates: clearedCandidates.slice(0, MAX_WORST_OFFENDERS),
      turnoverAlertThreshold: DEX_EXIT_ROUTE_TURNOVER_ALERT_THRESHOLD,
      minChangedRouteCount: DEX_EXIT_ROUTE_TURNOVER_MIN_CHANGED_ROUTES,
      highestObservedTurnover: evaluations[0]?.jaccardDistance ?? 0,
      worstOffenders: alerting.slice(0, MAX_WORST_OFFENDERS),
      carriedPendingAlert: carriedAlert,
      ...(alertingComparison ? { quality: { reason: "dex-route-turnover-threshold" } } : {}),
      firedRuleIds: alertingComparison ? ["dex-route-turnover"] : [],
    });
    result = { status: "ok", itemCount: evaluations.length, metadata };
  }

  return finish(result, nextSnapshot, alertingComparison);
}

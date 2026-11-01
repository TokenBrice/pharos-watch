import {
  CACHE_FRESHNESS_LANES,
  type CacheFreshnessLaneKey,
  type CacheFreshnessLaneConfig,
} from "@shared/lib/api-freshness";
import { CRON_JOB_DEFINITIONS, type CronJobMeta } from "@shared/lib/cron-jobs";
import { CRON_RUNS_RETENTION_SEC } from "@shared/lib/retention-policy";
import { TELEGRAM_MESSAGE_CHUNK_LIMIT } from "@shared/lib/telegram-delivery-policy";
import type { CacheStatus } from "@shared/types/status";
import { runWithOverloadRetry } from "../lib/d1-overload-retry";
import { DETAIL_WRITE_FAILURE_KEY_PREFIX } from "../lib/constants";
import type { CronResult } from "../lib/cron-logger";
import { chunkArray, D1_MAX_BOUND_PARAMETERS, runChunkedInFilter } from "../lib/db";
import { buildCacheStatuses } from "../lib/api-freshness";
import { getCache, setCache } from "../lib/db-cache";
import { escapeHtml, type TelegramCreds } from "../telegram/delivery/telegram";
import {
  classifyFreshness,
  loadProducerFreshnessFacts,
  type ProducerFreshnessFact,
} from "../lib/status/freshness-oracle";
import { rethrowIfAborted } from "../lib/abort";
import { loadSafetyScoreV9PublicationHealth } from "../lib/safety-score-v9/publication-health";
import type { WorkerCanaryMode } from "../lib/worker-canary-mode";
import { recordOperatorAlertReceipt } from "../lib/status/operator-alert-health";
import {
  buildSupplyIntegrityConditions,
  compactSupplyIntegrityReport,
  confirmSupplyIntegrityConditions,
  loadSupplyIntegrityReport,
} from "../lib/supply-integrity";
import { deliverOperatorAlert } from "./cron-sentinel-rules";
import { loadCanaryOperatorWatch } from "./operator-watch-canary";
import { loadProbeOperatorWatch } from "./operator-watch-probe";
import { buildPricingOperatorConditions, pricingOperatorRuleIds } from "./operator-watch-pricing";
import { loadBlacklistConfigWatchConditions } from "./operator-watch-blacklist";
import { loadMintBurnStuckConfigWatchConditions } from "./operator-watch-mintburn";
import { loadDexYieldWatchConditions } from "./operator-watch-dex-yield";

// Registry-derived lanes prove freshness from cron_runs MAX(started_at), and
// prune-cron-history deletes cron_runs rows older than one week. A producer
// whose 3x-interval staleness threshold exceeds that retention (e.g. the
// monthly yield-coverage-audit) can never be observed fresh here and would
// alert forever; such cadences need their own audit trail, not this watchdog.

const WATCHDOG_STATE_KEY = "cron-staleness-watchdog:producer-state:v1";
const WATCHDOG_ALERT_KEY = "cron-staleness-watchdog:alert:direct:v1";
export const CRON_STALENESS_ALERT_COOLDOWN_SEC = 30 * 60;

export interface ProducerFreshnessLane {
  producerJob: string;
  laneKey: CacheFreshnessLaneKey | null;
  cacheKey: string | null;
  producerIntervalSec: number;
  thresholdSec: number;
}

export function deriveCronFreshnessProducers(
  definitions: readonly CronJobMeta[] = CRON_JOB_DEFINITIONS,
): ProducerFreshnessLane[] {
  const cacheLaneByProducer = new Map(
    (Object.entries(CACHE_FRESHNESS_LANES) as Array<[CacheFreshnessLaneKey, CacheFreshnessLaneConfig]>).map(
      ([laneKey, lane]) => [lane.producerJob, { laneKey, lane }],
    ),
  );

  return definitions.flatMap((definition): ProducerFreshnessLane[] => {
    if (definition.freshnessSurface === "none") return [];
    const cacheLane = cacheLaneByProducer.get(definition.job);
    if (cacheLane) {
      return [{
        producerJob: definition.job,
        laneKey: cacheLane.laneKey,
        cacheKey: cacheLane.lane.cacheKey,
        producerIntervalSec: cacheLane.lane.producerIntervalSec,
        thresholdSec: cacheLane.lane.producerIntervalSec * 2,
      }];
    }
    if (definition.intervalSec * 3 > CRON_RUNS_RETENTION_SEC) return [];
    return [{
      producerJob: definition.job,
      laneKey: null,
      cacheKey: null,
      producerIntervalSec: definition.intervalSec,
      // Registry producers without an existing lane budget tolerate two missed
      // runs and become stale at 3x their canonical producer interval.
      thresholdSec: definition.intervalSec * 3,
    }];
  });
}

// Markers written by the detail handler when a per-coin cache write fails or
// exceeds the D1 value cap (see stablecoin-detail/shared.ts). Demand-refreshed
// detail rows can't be age-monitored like cron lanes (an old row may just be
// an unvisited coin), so the write failure itself is the staleness signal. An
// unresolved marker stays a failure until the recovery fence deletes it, not
// until it merely ages out of a freshness window.
const DETAIL_WRITE_FAILURE_RETENTION_SEC = 7 * 24 * 3600;
/** Per-invocation delete budget for expired markers (hourly sentinel lane). */
const DETAIL_WRITE_FAILURE_PRUNE_BUDGET = 500;

export interface DetailWriteFailureObservation {
  stablecoinId: string;
  reason: string;
  bytes: number | null;
  ageSeconds: number;
}

export async function loadDetailWriteFailures(
  db: D1Database,
  nowSec: number,
): Promise<DetailWriteFailureObservation[]> {
  // Prune markers past retention so resolved incidents age out of the table.
  // Bounded per invocation: an unbounded DELETE over the marker family made
  // this watchdog the heaviest writer in the sentinel lane.
  await runWithOverloadRetry(() =>
    db
      .prepare(
        `DELETE FROM cache WHERE rowid IN (
           SELECT rowid FROM cache WHERE key LIKE ? AND updated_at < ? LIMIT ?
         )`,
      )
      .bind(
        `${DETAIL_WRITE_FAILURE_KEY_PREFIX}%`,
        nowSec - DETAIL_WRITE_FAILURE_RETENTION_SEC,
        DETAIL_WRITE_FAILURE_PRUNE_BUDGET,
      )
      .run(),
  );

  const rows = await runWithOverloadRetry(() =>
    db
      .prepare("SELECT key, value, updated_at FROM cache WHERE key LIKE ? AND updated_at >= ?")
      .bind(`${DETAIL_WRITE_FAILURE_KEY_PREFIX}%`, nowSec - DETAIL_WRITE_FAILURE_RETENTION_SEC)
      .all<{ key: string; value: string; updated_at: number }>(),
  );

  const markerRows = rows.results ?? [];

  // Batch-read the corresponding detail rows' updated_at in a single IN query
  // instead of one getCacheUpdatedAt round-trip per marker.
  const detailKeyByMarkerKey = new Map(
    markerRows.map((row) => [row.key, `detail:${row.key.slice(DETAIL_WRITE_FAILURE_KEY_PREFIX.length)}`]),
  );
  const detailUpdatedAtByKey = new Map<string, number>();
  if (detailKeyByMarkerKey.size > 0) {
    await runChunkedInFilter(
      [...new Set(detailKeyByMarkerKey.values())],
      (inClauseSql) => `SELECT key, updated_at FROM cache WHERE key IN (${inClauseSql})`,
      async (sql, binds) => {
        const detailRows = await runWithOverloadRetry(() =>
          db
            .prepare(sql)
            .bind(...binds)
            .all<{ key: string; updated_at: number }>(),
        );
        for (const detailRow of detailRows.results ?? []) {
          detailUpdatedAtByKey.set(detailRow.key, detailRow.updated_at);
        }
      },
    );
  }

  const failures: DetailWriteFailureObservation[] = [];
  const recoveredMarkers: typeof markerRows = [];
  for (const row of markerRows) {
    const stablecoinId = row.key.slice(DETAIL_WRITE_FAILURE_KEY_PREFIX.length);

    // A detail row written after the marker means a later cache write
    // succeeded; the coin has recovered, so drop the stale marker instead of
    // degrading runs for up to 24h.
    const detailUpdatedAt = detailUpdatedAtByKey.get(detailKeyByMarkerKey.get(row.key) ?? "");
    if (detailUpdatedAt != null && detailUpdatedAt > row.updated_at) {
      recoveredMarkers.push(row);
      continue;
    }

    let reason = "unknown";
    let bytes: number | null = null;
    try {
      const parsed = JSON.parse(row.value) as { reason?: unknown; bytes?: unknown };
      if (typeof parsed.reason === "string") reason = parsed.reason;
      if (typeof parsed.bytes === "number") bytes = parsed.bytes;
    } catch {
      // keep defaults
    }
    failures.push({
      stablecoinId,
      reason,
      bytes,
      ageSeconds: Math.max(0, nowSec - row.updated_at),
    });
  }

  // Fence cleanup to the scanned marker, including same-second replacements,
  // and recheck recovery in the DELETE rather than trusting the earlier read.
  for (const chunk of chunkArray(recoveredMarkers, Math.floor(D1_MAX_BOUND_PARAMETERS / 4))) {
    await runWithOverloadRetry(() =>
      db
        .prepare(
          `WITH recovered(marker_key, marker_updated_at, marker_value, detail_key) AS (
             VALUES ${chunk.map(() => "(?, ?, ?, ?)").join(", ")}
           )
           DELETE FROM cache WHERE EXISTS (
             SELECT 1 FROM recovered JOIN cache AS detail ON detail.key = recovered.detail_key
             WHERE cache.key = recovered.marker_key
               AND cache.updated_at = recovered.marker_updated_at
               AND cache.value = recovered.marker_value
               AND detail.updated_at > cache.updated_at
           )`,
        )
        .bind(...chunk.flatMap((row) => [
          row.key, row.updated_at, row.value, detailKeyByMarkerKey.get(row.key)!,
        ]))
        .run(),
    );
  }
  return failures;
}

export interface CronStalenessObservation {
  laneKey: CacheFreshnessLaneKey | null;
  cacheKey: string | null;
  producerJob: string;
  ageSeconds: number | null;
  publishedAt: number | null;
  generationId: string | null;
  assessedAt: number;
  thresholdSec: number;
  producerThresholdSec: number;
  endpointThresholdSec: number;
  availabilityThresholdSec: number;
  availabilityImpacting: boolean;
}

function isAgeStale(ageSeconds: number | null, thresholdSec: number): boolean {
  return ageSeconds == null || Number.isNaN(ageSeconds) || Math.max(0, ageSeconds) > thresholdSec;
}

function buildFullObservation(
  laneKey: CacheFreshnessLaneKey,
  lane: CacheFreshnessLaneConfig,
  cache: Pick<CacheStatus, "ageSeconds" | "publishedAt" | "generationId"> | undefined,
  assessedAt: number,
): CronStalenessObservation {
  const thresholdSec = lane.producerIntervalSec * 2;
  const ageSeconds = cache?.ageSeconds ?? null;
  return {
    laneKey,
    cacheKey: lane.cacheKey,
    producerJob: lane.producerJob,
    ageSeconds,
    publishedAt: cache?.publishedAt ?? null,
    generationId: cache?.generationId ?? null,
    assessedAt,
    thresholdSec,
    producerThresholdSec: thresholdSec,
    endpointThresholdSec: lane.endpointMaxAgeSec,
    availabilityThresholdSec: lane.availabilityMaxAgeSec,
    availabilityImpacting: isAgeStale(ageSeconds, lane.availabilityMaxAgeSec),
  };
}

function buildCronObservation(
  producer: ProducerFreshnessLane,
  fact: ProducerFreshnessFact | undefined,
  nowSec: number,
): CronStalenessObservation {
  const classification = classifyFreshness(
    fact ?? {
      job: producer.producerJob,
      lastSuccessAt: null,
      lastRunAt: null,
      expectedIntervalSec: producer.producerIntervalSec,
      lastStatus: null,
    },
    {
      watchAt: { multiplier: 2 },
      staleAt: { multiplier: 3 },
    },
    nowSec,
  );
  const ageSeconds = classification.ageSec;
  return {
    laneKey: producer.laneKey,
    cacheKey: producer.cacheKey,
    producerJob: producer.producerJob,
    ageSeconds,
    publishedAt: fact?.lastSuccessAt ?? null,
    generationId: null,
    assessedAt: nowSec,
    thresholdSec: producer.thresholdSec,
    producerThresholdSec: producer.thresholdSec,
    endpointThresholdSec: producer.thresholdSec,
    availabilityThresholdSec: producer.thresholdSec,
    availabilityImpacting: classification.state === "stale",
  };
}

function isStale(observation: CronStalenessObservation): boolean {
  return isAgeStale(observation.ageSeconds, observation.thresholdSec);
}

function buildDependencyRecoveryChecks(observations: readonly CronStalenessObservation[]): Array<{
  root: string;
  dependent: string;
  state: "both-stale" | "root-recovered-dependent-stale" | "healthy" | "unknown";
  rootAgeSeconds: number | null;
  dependentAgeSeconds: number | null;
}> {
  const byCacheKey = new Map(
    observations.flatMap((observation) => observation.cacheKey == null ? [] : [[observation.cacheKey, observation] as const]),
  );
  const dexLiquidity = byCacheKey.get("dex-liquidity");
  const dews = byCacheKey.get("dews");
  if (!dexLiquidity || !dews) {
    return [
      {
        root: "dex-liquidity",
        dependent: "dews",
        state: "unknown",
        rootAgeSeconds: dexLiquidity?.ageSeconds ?? null,
        dependentAgeSeconds: dews?.ageSeconds ?? null,
      },
    ];
  }

  const rootStale = isStale(dexLiquidity);
  const dependentStale = isStale(dews);
  const state =
    rootStale && dependentStale
      ? "both-stale"
      : !rootStale && dependentStale
        ? "root-recovered-dependent-stale"
        : "healthy";
  return [
    {
      root: "dex-liquidity",
      dependent: "dews",
      state,
      rootAgeSeconds: dexLiquidity.ageSeconds,
      dependentAgeSeconds: dews.ageSeconds,
    },
  ];
}

function buildObservation(
  laneKey: CacheFreshnessLaneKey,
  lane: CacheFreshnessLaneConfig,
  cache: Pick<CacheStatus, "ageSeconds" | "publishedAt" | "generationId"> | undefined,
  assessedAt: number,
): CronStalenessObservation | null {
  const observation = buildFullObservation(laneKey, lane, cache, assessedAt);
  return isStale(observation) ? observation : null;
}

export function evaluateCronStaleness(
  caches: Record<string, Pick<CacheStatus, "ageSeconds" | "publishedAt" | "generationId"> | undefined>,
  laneKeys: readonly CacheFreshnessLaneKey[] = deriveCronFreshnessProducers()
    .flatMap((producer) => producer.laneKey == null ? [] : [producer.laneKey]),
  assessedAt = Math.floor(Date.now() / 1000),
): CronStalenessObservation[] {
  return laneKeys.flatMap((laneKey) => {
    const lane = CACHE_FRESHNESS_LANES[laneKey];
    const observation = buildObservation(laneKey, lane, caches[lane.cacheKey], assessedAt);
    return observation ? [observation] : [];
  });
}

type ProducerFreshnessState = Record<string, "ok" | "stale">;

/**
 * Operator conditions share the producer transition state. Producer keys are
 * bare job names; every other section prefixes its key with `<section>:` so a
 * condition that disappears (a recovered detail write, a released hold) is
 * reported as recovered instead of silently dropped.
 */
export interface OperatorWatchCondition {
  section: OperatorWatchSection;
  /** Stable identity within the section (job name, coin id, rule name). */
  id: string;
  /** Operator-facing detail; defaults to `id`. */
  label?: string;
  active: boolean;
  /** This condition's evidence could not be read this run: keep its prior state. */
  unknown?: boolean;
}

export type OperatorWatchSection = "producer" | "detail-write" | "dependency" | "safety-publication" | "supply" | "canary" | "probe" | "fx-rates" | "daily-lane" | "producer-quality";

const OPERATOR_SECTION_TITLES: Record<OperatorWatchSection, { raised: string; recovered: string }> = {
  producer: { raised: "Stale producers", recovered: "Recovered producers" },
  "detail-write": { raised: "Detail cache write failures", recovered: "Detail cache writes recovered" },
  dependency: { raised: "Dependency still stale after root recovery", recovered: "Dependency caught up" },
  "safety-publication": { raised: "Safety Score publication held", recovered: "Safety Score publication released" },
  supply: { raised: "Supply integrity findings", recovered: "Supply integrity recovered" },
  canary: { raised: "Canary findings raised", recovered: "Canary findings recovered" },
  probe: { raised: "Probe paths persistently failing", recovered: "Probe paths recovered" },
  "fx-rates": { raised: "FX rate publication degraded", recovered: "FX rate publication recovered" },
  "daily-lane": { raised: "Daily pricing lanes incomplete", recovered: "Daily pricing lanes complete" },
  "producer-quality": { raised: "Producer quality regressions", recovered: "Producer quality recovered" },
};

// Every section can raise and recover in one message: at most two lines per
// section (raised/recovered). Budget each line from the repo's conservative
// chunk limit so a systemic detail-write cohort cannot exceed Telegram's
// sendMessage cap and block every pending transition in the same message.
const OPERATOR_ALERT_SECTION_LINES = Object.keys(OPERATOR_SECTION_TITLES).length * 2;
const OPERATOR_ALERT_SECTION_CHARS =
  Math.floor(TELEGRAM_MESSAGE_CHUNK_LIMIT / OPERATOR_ALERT_SECTION_LINES) - 16;

function boundedOperatorSection(title: string, labels: readonly string[]): string {
  const prefix = `<b>${title}</b>: `;
  const escaped = labels.map(escapeHtml);
  const full = `${prefix}${escaped.join(", ")}`;
  if (full.length <= OPERATOR_ALERT_SECTION_CHARS) return full;
  const shown: string[] = [];
  let length = prefix.length;
  for (const label of escaped) {
    const separator = shown.length > 0 ? ", " : "";
    const hiddenAfter = escaped.length - shown.length - 1;
    const suffix = hiddenAfter > 0 ? `, +${hiddenAfter} more` : "";
    if (length + separator.length + label.length + suffix.length > OPERATOR_ALERT_SECTION_CHARS) break;
    length += separator.length + label.length;
    shown.push(label);
  }
  const hidden = escaped.length - shown.length;
  const body = shown.join(", ");
  return `${prefix}${body}${hidden > 0 ? `${body ? ", " : ""}+${hidden} more` : ""}`;
}

function conditionKey(condition: Pick<OperatorWatchCondition, "section" | "id">): string {
  return condition.section === "producer" ? condition.id : `${condition.section}:${condition.id}`;
}

function sectionOfKey(key: string): OperatorWatchSection {
  const prefix = key.slice(0, key.indexOf(":"));
  return key.includes(":") && prefix in OPERATOR_SECTION_TITLES && prefix !== "producer"
    ? prefix as OperatorWatchSection
    : "producer";
}

function parseProducerFreshnessState(value: string | null | undefined): ProducerFreshnessState {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, "ok" | "stale"] =>
        entry[1] === "ok" || entry[1] === "stale"),
    );
  } catch {
    return {};
  }
}

export interface CronStalenessWatchdogOptions {
  /**
   * Private operator chat credentials. Freshness transitions are ops signal,
   * not audience content: they must never be sent with the public digest
   * channel creds. Null suppresses delivery and leaves transitions pending.
   */
  operatorTelegramCreds?: TelegramCreds | null;
  /** Selects the active canary cohort for the operator transition set. */
  workerCanaryMode?: WorkerCanaryMode;
}

async function alertOnFreshnessTransitions(params: {
  db: D1Database;
  conditions: readonly OperatorWatchCondition[];
  /** Sections whose evidence could not be read this run keep their prior state. */
  unknownSections?: readonly OperatorWatchSection[];
  nowSec: number;
  operatorTelegramCreds: TelegramCreds | null;
  signal?: AbortSignal;
}): Promise<{
  stale: string[];
  recovered: string[];
  sent: boolean;
  cooldown: boolean;
  deliveryFailed?: boolean;
  /** A transition exists but no operator chat is configured; nothing was sent. */
  credentialsMissing?: boolean;
}> {
  const [stateCache, alertCache] = await Promise.all([
    getCache(params.db, WATCHDOG_STATE_KEY, params.signal),
    getCache(params.db, WATCHDOG_ALERT_KEY, params.signal),
  ]);
  const previous = parseProducerFreshnessState(stateCache?.value);
  const next: ProducerFreshnessState = {};
  const stale: string[] = [];
  const recovered: string[] = [];
  const raisedLines = new Map<OperatorWatchSection, string[]>();
  const recoveredLines = new Map<OperatorWatchSection, string[]>();
  const push = (lines: Map<OperatorWatchSection, string[]>, section: OperatorWatchSection, line: string) => {
    lines.set(section, [...(lines.get(section) ?? []), line]);
  };

  for (const condition of params.conditions) {
    const key = conditionKey(condition);
    const current = condition.active ? "stale" : "ok";
    const prior = previous[key] ?? "ok";
    if (condition.unknown) {
      if (prior === "stale") next[key] = prior;
      continue;
    }
    // Only producers keep an explicit "ok"; other sections are a set of active keys.
    if (condition.section === "producer" || current === "stale") next[key] = current;
    if (prior === current) continue;
    if (current === "stale") {
      stale.push(key);
      push(raisedLines, condition.section, condition.label ?? condition.id);
    } else {
      recovered.push(key);
      push(recoveredLines, condition.section, condition.id);
    }
  }
  const unknown = new Set(params.unknownSections ?? []);
  for (const [key, prior] of Object.entries(previous)) {
    const section = sectionOfKey(key);
    if (section === "producer" || key in next) continue;
    if (unknown.has(section)) {
      next[key] = prior;
      continue;
    }
    if (prior !== "stale") continue;
    recovered.push(key);
    push(recoveredLines, section, key.slice(section.length + 1));
  }

  if (stale.length === 0 && recovered.length === 0) {
    await setCache(params.db, WATCHDOG_STATE_KEY, JSON.stringify(next), params.signal);
    return { stale, recovered, sent: false, cooldown: false };
  }
  const lastAlertAt = Number(alertCache?.value);
  const cooldown = Number.isFinite(lastAlertAt) && params.nowSec - lastAlertAt < CRON_STALENESS_ALERT_COOLDOWN_SEC;
  if (cooldown || !params.operatorTelegramCreds) {
    return { stale, recovered, sent: false, cooldown, credentialsMissing: !params.operatorTelegramCreds };
  }

  const sections = (Object.keys(OPERATOR_SECTION_TITLES) as OperatorWatchSection[]).flatMap((section) => [
    raisedLines.has(section)
      ? boundedOperatorSection(OPERATOR_SECTION_TITLES[section].raised, raisedLines.get(section)!)
      : null,
    recoveredLines.has(section)
      ? boundedOperatorSection(OPERATOR_SECTION_TITLES[section].recovered, recoveredLines.get(section)!)
      : null,
  ]).filter((section): section is string => section != null);
  const delivery = await deliverOperatorAlert(
    params.operatorTelegramCreds,
    `<b>Pharos freshness watchdog</b>\n\n${sections.join("\n")}`,
    params.signal,
  );
  if (!delivery.ok) {
    return { stale, recovered, sent: false, cooldown: false, deliveryFailed: true };
  }
  await setCache(params.db, WATCHDOG_STATE_KEY, JSON.stringify(next), params.signal);
  await setCache(params.db, WATCHDOG_ALERT_KEY, String(params.nowSec), params.signal);
  return { stale, recovered, sent: true, cooldown: false };
}

export async function runCronStalenessWatchdog(
  db: D1Database,
  signal?: AbortSignal,
  options: CronStalenessWatchdogOptions = {},
): Promise<CronResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const status = await buildCacheStatuses(db, nowSec);
  const producers = deriveCronFreshnessProducers(CRON_JOB_DEFINITIONS);
  const cronOnlyProducers = producers.filter((producer) => producer.laneKey == null);
  const producerFacts = await loadProducerFreshnessFacts(
    db,
    nowSec,
    CRON_JOB_DEFINITIONS.filter((definition) =>
      cronOnlyProducers.some((producer) => producer.producerJob === definition.job),
    ),
  );
  const factByJob = new Map(producerFacts.map((fact) => [fact.job, fact]));
  const watchedObservations = producers.map((producer) => producer.laneKey == null
    ? buildCronObservation(
        producer,
        factByJob.get(producer.producerJob),
        nowSec,
      )
    : buildFullObservation(
        producer.laneKey,
        CACHE_FRESHNESS_LANES[producer.laneKey],
        status.caches[CACHE_FRESHNESS_LANES[producer.laneKey].cacheKey],
        nowSec,
      ));
  const stale = watchedObservations.filter(isStale);
  const dependencyRecoveryChecks = buildDependencyRecoveryChecks(watchedObservations);

  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("cron staleness watchdog aborted");
  }

  const [detailWriteFailures, safetyPublication, canaryWatch, probeWatch] = await Promise.all([
    loadDetailWriteFailures(db, nowSec),
    loadSafetyScoreV9PublicationHealth(db, signal).then(
      (health) => ({ ok: true as const, health }),
      (error: unknown) => {
        rethrowIfAborted(error, signal);
        return { ok: false as const };
      },
    ),
    loadCanaryOperatorWatch(db, nowSec, options.workerCanaryMode),
    loadProbeOperatorWatch(db, nowSec),
  ]);
  const safetyPublicationHeld = safetyPublication.ok && safetyPublication.health?.status === "held";
  const supplyWatch = await (async () => {
    const report = await loadSupplyIntegrityReport(db, nowSec, { signal });
    const conditions = await confirmSupplyIntegrityConditions(
      db,
      buildSupplyIntegrityConditions(report),
      { signal },
    );
    return { ok: true as const, report, conditions };
  })().then(
    (watch) => watch,
    (error: unknown) => {
      rethrowIfAborted(error, signal);
      return { ok: false as const, report: null, conditions: [] };
    },
  );
  const dexYieldWatch = await loadDexYieldWatchConditions(db, nowSec, signal).catch((error: unknown) => {
    rethrowIfAborted(error, signal);
    return null;
  });
  const unknownSections: OperatorWatchSection[] = [
    ...(safetyPublication.ok ? [] : ["safety-publication" as const]),
    ...(supplyWatch.ok ? [] : ["supply" as const]),
    ...(canaryWatch.unknown ? ["canary" as const] : []),
    ...(probeWatch.unknown ? ["probe" as const] : []),
    ...(dexYieldWatch == null ? ["producer-quality" as const] : []),
  ];
  const pricingConditions = await buildPricingOperatorConditions(
    db,
    { caches: status.caches, nowSec },
    signal,
  );
  const [blacklistConfigWatch, mintBurnStuckWatch] = await Promise.all([
    loadBlacklistConfigWatchConditions(db, nowSec, signal),
    loadMintBurnStuckConfigWatchConditions(db, signal),
  ]);
  const blacklistConfigStale = blacklistConfigWatch.conditions.some((condition) => condition.active);
  const mintBurnConfigStuck = mintBurnStuckWatch.conditions.some((condition) => condition.active);
  const producerQualityConditions = dexYieldWatch?.conditions ?? [];
  const producerQualityActive = producerQualityConditions.filter((condition) => condition.active);
  const alertTransitions = await alertOnFreshnessTransitions({
    db,
    conditions: [
      ...watchedObservations.map((observation): OperatorWatchCondition => ({
        section: "producer",
        id: observation.producerJob,
        active: isStale(observation),
      })),
      ...detailWriteFailures.map((failure): OperatorWatchCondition => ({
        section: "detail-write",
        id: failure.stablecoinId,
        label: `${failure.stablecoinId} (${failure.reason})`,
        active: true,
      })),
      ...dependencyRecoveryChecks.map((check): OperatorWatchCondition => ({
        section: "dependency",
        id: `${check.root}->${check.dependent}`,
        active: check.state === "root-recovered-dependent-stale",
        // A dependent still stale while its root regressed (or an unreadable
        // observation pair) is not evidence that it caught up.
        unknown: check.state === "both-stale" || check.state === "unknown",
      })),
      ...(safetyPublication.ok ? [{
        section: "safety-publication" as const,
        id: "v9",
        label: safetyPublicationHeld && safetyPublication.health
          ? `v9 (${safetyPublication.health.reasons.map((reason) => reason.code).join(", ") || "no reason code"})`
          : "v9",
        active: safetyPublicationHeld,
      }] : []),
      ...canaryWatch.conditions.map((condition): OperatorWatchCondition => ({
        section: "canary",
        id: condition.id,
        ...(condition.label ? { label: condition.label } : {}),
        active: condition.active,
      })),
      ...probeWatch.conditions.map((condition): OperatorWatchCondition => ({
        section: "probe",
        id: condition.id,
        ...(condition.label ? { label: condition.label } : {}),
        active: condition.active,
      })),
      ...pricingConditions,
      ...supplyWatch.conditions.map((condition): OperatorWatchCondition => ({
        section: "supply",
        id: condition.id,
        label: condition.label,
        active: condition.active,
        unknown: condition.unknown,
      })),
      ...blacklistConfigWatch.conditions,
      ...mintBurnStuckWatch.conditions,
      ...producerQualityConditions,
    ],
    unknownSections,
    nowSec,
    operatorTelegramCreds: options.operatorTelegramCreds ?? null,
    signal,
  });
  const activeSupplyConditions = supplyWatch.conditions.filter((condition) => condition.active);
  const qualityReasons = [
    ...(stale.length > 0 ? ["producer-output-stale"] : []),
    ...(detailWriteFailures.length > 0 ? ["detail-cache-write-failed"] : []),
    ...(canaryWatch.conditions.some((condition) => condition.active) ? ["canary-finding-active"] : []),
    ...(probeWatch.conditions.some((condition) => condition.active) ? ["probe-path-persistent-failure"] : []),
    ...(activeSupplyConditions.length > 0 ? ["supply-integrity-findings"] : []),
    ...(blacklistConfigStale ? ["blacklist-config-stale"] : []),
    ...(mintBurnConfigStuck ? ["mint-burn-config-stuck"] : []),
    ...(blacklistConfigWatch.readFailed ? ["blacklist-config-watch-unavailable"] : []),
    ...(mintBurnStuckWatch.readFailed ? ["mint-burn-config-watch-unavailable"] : []),
    ...(producerQualityActive.length > 0 ? ["producer-quality-regression"] : []),
  ];
  const pendingTransition = (alertTransitions.stale.length > 0 || alertTransitions.recovered.length > 0)
    && !alertTransitions.sent;
  const alertReceipt = await recordOperatorAlertReceipt(db, "freshness", {
    nowSec,
    operatorConfigured: options.operatorTelegramCreds != null,
    pending: pendingTransition,
    delivered: alertTransitions.sent,
    reason: alertTransitions.sent ? null
      : alertTransitions.deliveryFailed ? "operator-alert-delivery-failed"
        : alertTransitions.credentialsMissing ? "operator-alert-credentials-missing"
          : alertTransitions.cooldown ? "operator-alert-cooldown" : null,
  }, signal);
  const operatorAlertDegraded = alertTransitions.deliveryFailed
    || (pendingTransition && alertTransitions.credentialsMissing === true);
  const perConfigActiveCount =
    blacklistConfigWatch.conditions.filter((condition) => condition.active).length
    + mintBurnStuckWatch.conditions.filter((condition) => condition.active).length;

  return {
    status: status.failures.length > 0 || operatorAlertDegraded || !supplyWatch.ok
      || activeSupplyConditions.length > 0
      ? "degraded"
      : "ok",
    itemCount: stale.length + detailWriteFailures.length + activeSupplyConditions.length
      + perConfigActiveCount + producerQualityActive.length,
    metadata: JSON.stringify({
      ...(status.failures.length > 0 ? { reason: "freshness-evidence-read-failed" }
        : !supplyWatch.ok ? { reason: "supply-integrity-read-failed" }
          : alertTransitions.deliveryFailed ? { reason: "operator-alert-delivery-failed" }
            : operatorAlertDegraded ? { reason: "operator-alert-credentials-missing" } : {}),
      ...(qualityReasons.length > 0 ? { quality: { reasons: qualityReasons } } : {}),
      firedRuleIds: [
        ...(stale.length > 0 ? ["producer-stale"] : []),
        ...(detailWriteFailures.length > 0 ? ["detail-write-failure"] : []),
        ...(dependencyRecoveryChecks.some((check) => check.state === "root-recovered-dependent-stale")
          ? ["dependency-recovery-lag"] : []),
        ...(safetyPublicationHeld ? ["safety-publication-held"] : []),
        ...(canaryWatch.conditions.some((condition) => condition.active) ? ["canary-finding"] : []),
        ...(probeWatch.conditions.some((condition) => condition.active) ? ["probe-path-persistent-failure"] : []),
        ...pricingOperatorRuleIds(pricingConditions),
        ...activeSupplyConditions.map((condition) => `supply-${condition.id}`),
        ...(blacklistConfigStale ? ["blacklist-config-stale"] : []),
        ...(mintBurnConfigStuck ? ["mint-burn-config-stuck"] : []),
        ...producerQualityActive.map((condition) => condition.id),
      ],
      canaryWatch: { active: canaryWatch.conditions.length, unknown: canaryWatch.unknown },
      probeWatch: { active: probeWatch.conditions.length, unknown: probeWatch.unknown },
      alerting: alertReceipt,
      checkedProducers: watchedObservations.map((observation) => observation.producerJob),
      stale,
      detailWriteFailures,
      supplyIntegrity: supplyWatch.ok && supplyWatch.report
        ? {
            ...compactSupplyIntegrityReport(supplyWatch.report),
            conditions: supplyWatch.conditions.map((condition) => ({
              id: condition.id,
              active: condition.active,
              unknown: condition.unknown,
              signature: condition.signature.slice(0, 200),
            })),
          }
        : { status: "unknown", reason: "supply-integrity-read-failed" },
      blacklistConfigWatch,
      mintBurnStuckWatch,
      producerQuality: producerQualityConditions,
      alertTransitions,
      dependencyRecoveryChecks,
      warnings: status.warnings,
      failures: status.failures,
      diagnostics: status.diagnostics,
    }),
  };
}

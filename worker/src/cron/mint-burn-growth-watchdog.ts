import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { CronResult } from "../lib/cron-logger";
import { createCronResult } from "../lib/cron-result";
import { throwIfAborted } from "../lib/abort";
import { includeActiveTrackedIds } from "./shared/exclude-frozen";
import { MINT_BURN_CONFIGS } from "../lib/mint-burn-contracts";
import {
  mintBurnDisabledReason,
  readMintBurnDisabledKeys,
  resolveMintBurnDisabledSymbolPolicy,
} from "../lib/mint-burn-publication";
import { mintBurnConfigKey } from "../lib/mint-burn-pipeline/sync-state";
import { normalizeDisabledConfigIdSet, normalizeDisabledSymbolSet } from "./mint-burn/run-state";

/**
 * `mint_burn_events` normally turns over through the critical producer's
 * bounded retention pass after rows are valued, aggregated, and projected to
 * Tape. Count the current retained events independently of prior watchdog runs.
 * ~2.3M rows is the proxy for the agreed ~5 GB revisit point; crossing it
 * reports an operator quality warning before D1 approaches its cap.
 */
export const MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD = 2_300_000;

/**
 * Per-leg volume collapse: a leg with a real 30-day baseline that records no
 * counted event for a full week is silent unless a content check compares it
 * with history. Unsupported conservation legs never had a supply-delta fence.
 */
export const MINT_BURN_ACTIVITY_BASELINE_WINDOW_SEC = 30 * DAY_SECONDS;
export const MINT_BURN_ACTIVITY_RECENT_WINDOW_SEC = 7 * DAY_SECONDS;
export const MINT_BURN_ACTIVITY_MIN_BASELINE_EVENTS = 30;
const MINT_BURN_ACTIVITY_SAMPLE_LIMIT = 10;

interface MintBurnActivityRow {
  stablecoin_id: string;
  chain_id: string;
  recent_events: number | null;
  baseline_events: number | null;
}

export interface MintBurnGrowthWatchdogOptions {
  /** Runtime disable switch; the same authority the producer scans with. */
  disabledIds?: readonly string[];
  disabledSymbols?: readonly string[];
}

async function activeMintBurnPairs(
  db: D1Database,
  disabledIds: ReadonlySet<string>,
  disabledSymbols: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<{ keys: Set<string>; json: string }> {
  const activeConfigs = includeActiveTrackedIds(MINT_BURN_CONFIGS, (config) => config.stablecoinId);
  // Mirror the producer's disable scope: an ambiguous env ticker disables no
  // coin by itself, but the durable keys it retained must stay paused here too.
  const priorDisabledKeys = disabledSymbols.size > 0
    ? await readMintBurnDisabledKeys(db, signal)
    : new Set<string>();
  const policy = resolveMintBurnDisabledSymbolPolicy(activeConfigs, disabledSymbols, priorDisabledKeys);
  const pairs = activeConfigs
    .filter((config) => mintBurnDisabledReason(config, disabledIds, policy.symbols) == null
      && !policy.retainedKeys.has(mintBurnConfigKey(config)))
    .map((config) => [config.stablecoinId, config.chain.chainId] as [string, string]);
  return {
    keys: new Set(pairs.map(([stablecoinId, chainId]) => `${stablecoinId}|${chainId}`)),
    json: JSON.stringify(pairs),
  };
}

type CollapsedLeg = {
  stablecoinId: string;
  chainId: string;
  baselineEvents: number;
};

type CollapsedLegsResult =
  | { failed: false; legs: CollapsedLeg[] }
  | { failed: true; reason: "mint-burn-activity-baseline-unavailable" | "mint-burn-disabled-policy-unavailable" };

async function loadCollapsedLegs(
  db: D1Database,
  nowSec: number,
  disabledIds: ReadonlySet<string>,
  disabledSymbols: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<CollapsedLegsResult> {
  let activePairs: Awaited<ReturnType<typeof activeMintBurnPairs>>;
  try {
    activePairs = await activeMintBurnPairs(db, disabledIds, disabledSymbols, signal);
  } catch {
    throwIfAborted(signal);
    return { failed: true, reason: "mint-burn-disabled-policy-unavailable" };
  }
  try {
    const rows = await db
      .prepare(
        `/* pharos:mint-burn-activity-collapse */
         SELECT stablecoin_id, chain_id,
                SUM(CASE WHEN hour_ts >= ? THEN mint_count + burn_count ELSE 0 END) AS recent_events,
                SUM(mint_count + burn_count) AS baseline_events
           FROM mint_burn_hourly
          WHERE hour_ts >= ?
            AND (stablecoin_id, chain_id) IN (
              SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)
            )
          GROUP BY stablecoin_id, chain_id
         HAVING baseline_events >= ? AND recent_events = 0
          LIMIT 200`,
      )
      .bind(
        nowSec - MINT_BURN_ACTIVITY_RECENT_WINDOW_SEC,
        nowSec - MINT_BURN_ACTIVITY_BASELINE_WINDOW_SEC,
        activePairs.json,
        MINT_BURN_ACTIVITY_MIN_BASELINE_EVENTS,
      )
      .all<MintBurnActivityRow>();
    throwIfAborted(signal);
    return {
      failed: false,
      legs: (rows.results ?? [])
        .filter((row) => activePairs.keys.has(`${row.stablecoin_id}|${row.chain_id}`))
        .flatMap((row) => {
          const baselineEvents = row.baseline_events;
          if (typeof baselineEvents !== "number" || !Number.isSafeInteger(baselineEvents)
            || baselineEvents < MINT_BURN_ACTIVITY_MIN_BASELINE_EVENTS) return [];
          return [{
            stablecoinId: row.stablecoin_id,
            chainId: row.chain_id,
            baselineEvents,
          }];
        }),
    };
  } catch {
    throwIfAborted(signal);
    return { failed: true, reason: "mint-burn-activity-baseline-unavailable" };
  }
}

export async function runMintBurnGrowthWatchdog(
  db: D1Database,
  signal?: AbortSignal,
  options: MintBurnGrowthWatchdogOptions = {},
): Promise<CronResult> {
  throwIfAborted(signal);
  const row = await db
    .prepare("SELECT COUNT(*) AS rowCount FROM mint_burn_events")
    .first<{ rowCount: number }>();
  throwIfAborted(signal);
  if (!row || !Number.isSafeInteger(row.rowCount) || row.rowCount < 0) {
    throw new Error("Mint/burn growth watchdog row count unavailable");
  }
  const rowCount = row.rowCount;
  const activity = await loadCollapsedLegs(
    db,
    Math.floor(Date.now() / 1000),
    normalizeDisabledConfigIdSet(options.disabledIds),
    normalizeDisabledSymbolSet(options.disabledSymbols),
    signal,
  );
  const metadata = {
    rowCount,
    thresholdRows: MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD,
    ...(!activity.failed
      ? { activityCollapse: activity.legs.slice(0, MINT_BURN_ACTIVITY_SAMPLE_LIMIT) }
      : activity.reason === "mint-burn-disabled-policy-unavailable"
        ? { disabledPolicyUnavailable: true }
        : { activityBaselineUnavailable: true }),
  };
  if (activity.failed) {
    return createCronResult({
      status: "degraded",
      itemCount: rowCount,
      metadata: {
        ...metadata,
        reason: activity.reason,
        firedRuleIds: [],
      },
    });
  }

  const growthFinding = rowCount >= MINT_BURN_EVENTS_ROW_ALERT_THRESHOLD;
  const activityFinding = activity.legs.length > 0;
  if (!growthFinding && !activityFinding) {
    return createCronResult({
      itemCount: rowCount,
      metadata: { ...metadata, firedRuleIds: [] },
    });
  }

  return createCronResult({
    status: "ok",
    itemCount: rowCount,
    metadata: {
      ...metadata,
      rowCountThresholdExceeded: growthFinding,
      ...(activityFinding
        ? {
            quality: {
              reason: "mint-burn-activity-collapse",
              coinCount: activity.legs.length,
              coins: activity.legs.slice(0, MINT_BURN_ACTIVITY_SAMPLE_LIMIT),
            },
          }
        : { quality: { reason: "row-count-threshold" } }),
      firedRuleIds: [
        ...(growthFinding ? ["mint-burn-row-growth"] : []),
        ...(activityFinding ? ["mint-burn-activity-collapse"] : []),
      ],
    },
  });
}

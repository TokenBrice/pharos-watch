import type { z } from "zod";
import type { OgPageUnavailableReason, OgRouteSupportItem, OgRouteVisual } from "@shared/lib/og-route-cards";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { getCacheRatioThresholds } from "@shared/lib/status-thresholds";
import { assessFreshnessTimestamp } from "../../lib/api-freshness-age";

/**
 * Admission budget of a cron-backed card source: the same "fresh" ceiling the
 * owner endpoint publishes in `_meta.status` (endpoint budget × the cache's
 * fresh ratio), so a card shows its figure exactly while the page reads fresh
 * and drops to timeless once the page itself would warn. Never stricter than
 * two producer intervals, so a card does not flap between runs.
 */
function admissionBudgetSec(
  producer: string,
  endpoint: keyof typeof API_FRESHNESS_MAX_AGE_SEC,
  cacheKey?: string,
): number {
  const intervalSec = CRON_INTERVALS[producer];
  if (intervalSec == null) throw new Error(`Unknown OG source producer: ${producer}`);
  const freshCeilingSec = API_FRESHNESS_MAX_AGE_SEC[endpoint] * getCacheRatioThresholds(cacheKey).degraded;
  return Math.max(2 * intervalSec, freshCeilingSec);
}

export const OG_SOURCE_BUDGET_SEC = {
  stablecoins: admissionBudgetSec("sync-stablecoins", "stablecoins"),
  chains: admissionBudgetSec("sync-stablecoins", "chains"),
  pegSummary: admissionBudgetSec("sync-stablecoins", "pegSummary"),
  stabilityIndex: admissionBudgetSec("stability-index", "stabilityIndex"),
  mintBurnFlows: admissionBudgetSec("sync-mint-burn", "mintBurnFlows"),
  dexLiquidity: admissionBudgetSec("sync-dex-liquidity", "dexLiquidity"),
  yieldRankings: admissionBudgetSec("sync-yield-data", "yieldRankings", "yield-data"),
  reportCards: admissionBudgetSec("compute-safety-score-v9", "reportCards"),
} as const;

/** A live figure read this run from its owner, with the generation that produced it. */
export interface OgPageFigure {
  kind: "ok";
  hero: string;
  context: string;
  /** Preformatted support items; each failed independently and was dropped, never zeroed. */
  support: OgRouteSupportItem[];
  /** Optional geometry over figures the card already prints as text. */
  visual?: OgRouteVisual;
  /** Generation time of the hero's source — the stamp, never the render clock. */
  asOfSec: number;
  /** Freshness budget the hero was admitted under. */
  budgetSec: number;
  /** When the figure stops being admissible; defaults to `asOfSec + budgetSec`. Bounds the image cache lifetime. */
  freshUntilSec?: number;
  /** Machine-readable generation identity for `X-Og-Generation`. */
  generation: string;
  /** Methodology or basis note appended to the stamp. */
  stampNote?: string;
}

export interface OgPageUnavailable {
  kind: "unavailable";
  reason: OgPageUnavailableReason;
}

export type OgPageLoad = OgPageFigure | OgPageUnavailable;

export type OgPageLoader = (db: D1Database, nowSec: number) => Promise<OgPageLoad>;

export function unavailable(reason: OgPageUnavailableReason): OgPageUnavailable {
  return { kind: "unavailable", reason };
}

/** `null` when `timestampSec` is a valid generation time within `budgetSec`. */
export function freshnessReason(
  nowSec: number,
  timestampSec: number | null | undefined,
  budgetSec: number,
): OgPageUnavailableReason | null {
  const age = assessFreshnessTimestamp(nowSec, timestampSec);
  if (age.reason != null) return "cache-missing";
  return age.ageSeconds > budgetSec ? "stale-cache" : null;
}

/** Request URL for an in-process owner handler; only its path and query are read. */
export function ownerUrl(pathAndQuery: string): URL {
  return new URL(pathAndQuery, "https://api.pharos.watch");
}

/**
 * Parse the body an owner handler would serve publicly. A non-200 or a body
 * that fails the published schema is unavailable, never a partial read.
 */
export async function readOwnerJson<S extends z.ZodType>(response: Response, schema: S): Promise<z.output<S> | null> {
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  const parsed = schema.safeParse(await response.json().catch(() => undefined));
  return parsed.success ? parsed.data : null;
}

/** Support items fail independently: a rejected or null item is dropped. */
export async function settleSupport(items: ReadonlyArray<Promise<OgRouteSupportItem | null>>): Promise<OgRouteSupportItem[]> {
  const settled = await Promise.allSettled(items);
  return settled.flatMap((result) => (result.status === "fulfilled" && result.value != null ? [result.value] : []));
}

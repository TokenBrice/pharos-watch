import { API_PATHS } from "@shared/lib/api-endpoints";
import { formatPercent } from "@shared/lib/format";
import { dedupeYieldRankings } from "@shared/lib/yield-rankings";
import { YieldRankingsSummaryResponseSchema } from "@shared/types/yield-summary";
import { handleYieldRankings } from "../yield-rankings-cache";
import { freshnessReason, ownerUrl, readOwnerJson, unavailable, type OgPageLoader, OG_SOURCE_BUDGET_SEC } from "./types";

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * `/yield` card: how many yields Pharos ranks, with the median 30-day APY of
 * the A/B-graded rows as support — deliberately not the top APY, which reads
 * as an offer when shared.
 */
export const loadYieldOgPage: OgPageLoader = async (db, nowSec) => {
  const body = await readOwnerJson(
    await handleYieldRankings(db, ownerUrl(API_PATHS.yieldRankingsSummary())),
    YieldRankingsSummaryResponseSchema,
  );
  if (!body) return unavailable("owner-error");
  const budgetSec = OG_SOURCE_BUDGET_SEC.yieldRankings;
  const stale = freshnessReason(nowSec, body.updatedAt, budgetSec);
  if (stale) return unavailable(stale);
  // The page keeps showing a degraded generation with a notice; only a stale verdict withholds it.
  if (body._meta?.status === "stale") return unavailable("stale-cache");

  const rows = dedupeYieldRankings(body.rankings);
  if (rows.length === 0) return unavailable("figure-null");
  // Grades are blanked to null when the safety publication is unavailable, leaving no A/B cohort.
  const abMedian = median(rows.flatMap((row) =>
    row.safetyGrade && /^[AB]/.test(row.safetyGrade) && row.apy30d != null ? [row.apy30d] : []));
  return {
    kind: "ok",
    hero: String(rows.length),
    context: "stablecoin yield sources ranked by Pharos",
    support: abMedian == null ? [] : [`Median 30D APY, A/B safety grade: ${formatPercent(abMedian)}`],
    asOfSec: body.updatedAt,
    budgetSec,
    generation: `yield-rankings:${body.updatedAt}`,
  };
};

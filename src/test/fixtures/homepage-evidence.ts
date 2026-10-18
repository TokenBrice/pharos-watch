import type { HomepageSnapshot, HomepageLaneMeta } from "@shared/types/homepage";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";

export const HOMEPAGE_EVIDENCE_TEST_NOW = Date.parse("2026-10-18T12:00:00Z");

export function makeHomepageEvidence(updatedAt = HOMEPAGE_EVIDENCE_TEST_NOW / 1000): HomepageSnapshot {
  function meta(source: string, freshBudgetSec: number): HomepageLaneMeta {
    return {
      source, updatedAt, ageSeconds: 0, assessedAt: updatedAt,
      freshBudgetSec, degradedBudgetSec: freshBudgetSec * 2,
      status: "fresh", reason: null, warning: null,
    };
  }
  return {
    market: {
      data: {
        asOfISO: new Date(updatedAt * 1000).toISOString(), totalUsd: 100, nonUsdUsd: 0, nonUsdShare: 0,
        supplyObservedCount: 1, supplyExpectedCount: 1, supplyMissingCount: 0, supplyUnavailableCount: 0,
        cohort: { ts: updatedAt * 1000, usdt: 100, usdc: 0, sky: 0, others: 0, nonUsd: 0, total: 100 },
      },
      meta: meta("stablecoins", API_FRESHNESS_MAX_AGE_SEC.stablecoins),
    },
    psi: {
      data: { score: 91.9, band: "BEDROCK", computedAt: updatedAt },
      meta: meta("stability-index", API_FRESHNESS_MAX_AGE_SEC.stabilityIndex),
    },
    incidents: {
      data: { activeDepegCount: 1 },
      meta: meta("peg-summary", API_FRESHNESS_MAX_AGE_SEC.pegSummary),
    },
  };
}

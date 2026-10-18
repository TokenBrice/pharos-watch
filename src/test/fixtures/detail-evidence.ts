import type { DetailEvidence } from "@/lib/detail-evidence-selection";

export const DETAIL_EVIDENCE_TEST_NOW = Date.parse("2026-10-18T12:00:00Z");
export function makeDetailEvidence(at = DETAIL_EVIDENCE_TEST_NOW / 1000 - 60, price = 1): DetailEvidence {
  return {
    data: {
      price, priceSource: "coingecko", priceConfidence: "high", priceUpdatedAt: at,
      priceObservedAt: at, supplyObservedAt: at, circulating: { peggedUSD: 100 },
      circulatingPrevDay: { peggedUSD: 99 }, circulatingPrevWeek: { peggedUSD: 98 },
      circulatingPrevMonth: { peggedUSD: 97 }, nativeSupply: { current: 100, prevWeek: 98, prevMonth: 97 },
    },
    meta: { updatedAt: at, ageSeconds: 60, status: "fresh", assessedAt: DETAIL_EVIDENCE_TEST_NOW / 1000,
      freshBudgetSec: 600, degradedBudgetSec: 7200 },
  };
}

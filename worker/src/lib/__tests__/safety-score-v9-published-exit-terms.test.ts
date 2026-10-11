import { describe, expect, it } from "vitest";
import { buildSafetyScoreV9RetainedRedemptionRoutes, buildSafetyScoreV9RouteReviews } from "../safety-score-v9/extension-routes";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import { makeV9FixedInput, makeV9Extension } from "../../test-helpers/v9-fixed-input";
import { rebuildFixed } from "./safety-score-v9-fact-set.test-support";
import { makeSupplyFullRedemption } from "./redemption-backstops-store.test-support";
import { withRedemptionBackstopConfig } from "./safety-score-v9-extension-routes.test-support";
import { getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import { resolveReviewedRedemptionSettlementDelay } from "@shared/lib/redemption-backstop-configs/settlement";
import type { ReportCardsFixedInput } from "../report-cards-fixed-input";

const assetId = "usdc-circle";
const clockSec = Date.parse("2026-07-13T12:00:00Z") / 1000;
const publishedFeeSchedule = {
  reviewedAt: "2026-07-01", reviewer: "Exit terms regression fixture",
  docs: [{ label: "Binding maximum", url: "https://example.com/fees", supports: ["fees" as const] }],
  rationale: "The published protocol tariff binds every modelled withdrawal deduction at this maximum.",
};
function fixture(clock = clockSec) {
  const draft = makeV9FixedInput({ assetId, clockSec: clock });
  const row = makeSupplyFullRedemption({ stablecoinId: assetId, feeBps: null,
    feeConfidence: "formula", feeModelKind: "formula", updatedAt: clock });
  draft.redemptionBackstopMap = { [assetId]: row };
  draft.redemptionStale = false;
  draft.redemptionGenerationId = "redemption:published-terms-regression";
  draft.inputFreshness.redemptionBackstops = { updatedAt: clock, ageSeconds: 0, stale: false };
  const captured = buildSafetyScoreV9RetainedRedemptionRoutes(draft, assetId)[0]!.observation;
  row.capacityProfile = { ...row.capacityProfile!, exitRouteObservations: [{ ...captured,
    feeEvidence: "disclosed-unquantified", settlementBoundUnproven: true,
    executionCostBps: 0, capacityCurve: captured.capacityCurve?.map((point) => ({ ...point, executionCostBps: 0 })),
  }] };
  return rebuildFixed(draft);
}
function compile(fixed: ReportCardsFixedInput) {
  const extension = structuredClone(makeV9Extension({ assetId, clockSec: fixed.clockSec, registryFingerprint: fixed.registryFingerprint }));
  extension.assets[0]!.routeReviews = buildSafetyScoreV9RouteReviews(fixed, assetId);
  extension.assets[0]!.retainedRoutes = buildSafetyScoreV9RetainedRedemptionRoutes(fixed, assetId);
  return compileSafetyScoreV9FactSetFromFixedInput(fixed, extension).assets[0]!.exitRoutes.find((route) => route.lane === "redemption")!;
}

describe("published exit terms reach consumer factor statuses", () => {
  it("clears a superseded unknown fee without promoting an above-budget bound into capacity", () => {
    withRedemptionBackstopConfig(assetId, {
      costModel: { kind: "dynamic-or-unclear", confidence: "formula" },
      v9RouteCostTerms: { feeBpsMax: 1000, publishedFeeSchedule }, v9RouteReviewTerms: undefined,
    }, () => {
      const route = compile(fixture());
      expect(route).not.toHaveProperty("feeEvidence");
      expect(route.factorStatuses!.cost!.observationState).toBe("known");
      expect(route.capacityCurve.every((point) => point.executionCostBps === 1000 && point.executableUsd === 0)).toBe(true);
    });
  });
  it("keeps same-day/unadmitted review cost missing despite an old zero-fee capture", () => {
    withRedemptionBackstopConfig(assetId, {
      costModel: { kind: "dynamic-or-unclear", confidence: "formula" },
      v9RouteCostTerms: { feeBpsMax: 1000, publishedFeeSchedule: { ...publishedFeeSchedule, reviewedAt: "2026-07-13" } },
      v9RouteReviewTerms: undefined,
    }, () => {
      const route = compile(fixture());
      expect(route.feeEvidence).toBe("disclosed-unquantified");
      expect(route.factorStatuses!.cost!.observationState).toBe("missing");
    });
  });
  it("clears an old unproven-settlement marker only with a current completed-endpoint SLA", () => {
    const terms = { settlementModel: "days" as const, settlementDelaySec: 12 * 86400,
      reviewedAt: "2026-07-01", docs: [{ label: "Binding cash completion", url: "https://example.com/settlement", supports: ["settlement" as const] }] };
    withRedemptionBackstopConfig(assetId, { costModel: { kind: "fee-bps", feeBps: 10 },
      v9RouteCostTerms: undefined, v9RouteReviewTerms: terms }, () => {
      const route = compile(fixture());
      expect(route.settlementBoundUnproven).toBe(false);
      expect(route.settlementSlaSec).toBe(12 * 86400);
      expect(route.factorStatuses!.settlement!.observationState).toBe("known");
    });
  });
  it("admits EURI's eligible receipt-day calendar bound, not an initial unverified request", () => {
    const config = getRedemptionBackstopConfig("euri-banking-circle")!;
    expect(config.holderEligibility).toBe("verified-customer");
    expect(config.v9RouteReviewTerms!.businessDayTerms!.accessPrerequisites).toHaveLength(2);
    const afterReview = Date.parse("2026-10-11T00:00:00Z") / 1000;
    const maximum = resolveReviewedRedemptionSettlementDelay(config.v9RouteReviewTerms, afterReview);
    expect(maximum).toBeDefined();
    expect(maximum!).toBeGreaterThan(5 * 86400);
  });
});

import { describe, expect, it } from "vitest";
import { RedemptionBackstopConfigSchema } from "../redemption-backstop-configs/schema";
import { cloneRedemptionBackstopConfig, resolveV9RedemptionRouteCostBpsAtNotional } from "../redemption-backstop-configs/shared";
import { getRedemptionBackstopConfig } from "../redemption-backstops";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "../safety-score-v9/evidence";
import type { RedemptionFiatReferenceContext } from "../redemption-fiat-reference";

const clockSec = Date.parse("2026-07-02T00:00:00Z") / 1000;
const context: RedemptionFiatReferenceContext = { clockSec, pegDataById: {
  idr: { pegCurrency: "IDR", pegReference: { valueUsd: 0.0000625, source: "fx", contributorCount: 0, asOf: clockSec - 60 } },
} };
const schedule = {
  reviewedAt: "2026-07-01", reviewer: "Published fee regression fixture",
  docs: [{ label: "Binding fee terms", url: "https://example.com/terms", supports: ["fees" as const] }],
  rationale: "The complete published route schedule binds its maximum percentage and native-currency flat charge.",
};
function config() {
  return { ...getRedemptionBackstopConfig("usdc-circle")!,
    costModel: { kind: "dynamic-or-unclear" as const, confidence: "formula" as const },
    v9RouteCostTerms: { feeBpsMax: 50, publishedFeeSchedule: schedule,
      feeComponents: [{ currency: "IDR", terms: { flatAmount: 6500 } }] },
  };
}

describe("published conservative redemption fee bounds", () => {
  it("evaluates the complete flat-plus-bps schedule at the request with admitted FX", () => {
    expect(resolveV9RedemptionRouteCostBpsAtNotional(config(), 10_000, 0, context)).toBeCloseTo(50.40625);
    expect(resolveV9RedemptionRouteCostBpsAtNotional(config(), 100_000, 0, context)).toBeCloseTo(50.040625);
  });
  it("does not substitute an observed lower fee for a published conservative maximum", () => {
    const bound = { ...config(), v9RouteCostTerms: { feeBpsMax: 1000, publishedFeeSchedule: schedule } };
    expect(resolveV9RedemptionRouteCostBpsAtNotional(bound, 1_000_000, 0, context)).toBe(1000);
  });
  it.each([clockSec - 1, clockSec + V9_REVIEW_EVIDENCE_MAX_AGE_SEC])("does not revive an unadmitted or expired schedule at %s", (clock) => {
    expect(resolveV9RedemptionRouteCostBpsAtNotional(config(), 10_000, 0, { ...context, clockSec: clock })).toBeNull();
  });
  it("fails closed with missing or stale FX even when captured telemetry claims zero", () => {
    expect(resolveV9RedemptionRouteCostBpsAtNotional(config(), 10_000, 0, { clockSec, pegDataById: {} })).toBeNull();
    expect(resolveV9RedemptionRouteCostBpsAtNotional(config(), 10_000, 0, { ...context, clockSec: clockSec + 86_401 })).toBeNull();
  });
  it("requires an explicit ceiling and fee-scoped sources, never a partial tariff", () => {
    expect(RedemptionBackstopConfigSchema.safeParse(config()).success).toBe(true);
    expect(RedemptionBackstopConfigSchema.safeParse({ ...config(), v9RouteCostTerms: { publishedFeeSchedule: schedule } }).success).toBe(false);
    expect(RedemptionBackstopConfigSchema.safeParse({ ...config(), v9RouteCostTerms: { feeBpsMax: 50,
      publishedFeeSchedule: { ...schedule, docs: [{ ...schedule.docs[0]!, supports: ["route"] }] } } }).success).toBe(false);
  });
  it("deep-clones schedule provenance and source support arrays", () => {
    const original = config();
    const cloned = cloneRedemptionBackstopConfig(original);
    cloned.v9RouteCostTerms!.publishedFeeSchedule!.docs[0]!.supports!.push("route");
    expect(original.v9RouteCostTerms.publishedFeeSchedule.docs[0]!.supports).toEqual(["fees"]);
  });
});

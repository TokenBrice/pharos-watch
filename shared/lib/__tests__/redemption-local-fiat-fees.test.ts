import { describe, expect, it } from "vitest";
import { RedemptionBackstopConfigSchema } from "../redemption-backstop-configs/schema";
import { cloneRedemptionBackstopConfig, resolveRedemptionCostBpsAtNotional } from "../redemption-backstop-configs/shared";
import { getRedemptionBackstopConfig } from "../redemption-backstops";
import type { RedemptionCostModel } from "../redemption-backstops";
import { resolveRedemptionFiatReference, type RedemptionFiatReferenceContext } from "../redemption-fiat-reference";

const clockSec = 1_791_539_240;
const references: RedemptionFiatReferenceContext = { clockSec, pegDataById: {
  idr: { pegCurrency: "IDR", pegReference: { valueUsd: 0.0000625, source: "fx", contributorCount: 0, asOf: clockSec - 60 } },
  chf: { pegCurrency: "CHF", pegReference: { valueUsd: 1.25, source: "fx", contributorCount: 0, asOf: clockSec - 60 } },
  jpy: { pegCurrency: "JPY", pegReference: { valueUsd: 0.00625, source: "fx", contributorCount: 0, asOf: clockSec - 60 } },
} };

describe("captured local-fiat redemption fees", () => {
  it.each([["CHF", 30, 37.5], ["JPY", 3000, 18.75]])(
    "converts %s flat charges without treating native amounts as dollars", (currency, flatAmount, feeUsd) => {
      const cost = resolveRedemptionCostBpsAtNotional({ kind: "fee-bps", feeBps: 50,
        feeComponents: [{ currency, terms: { flatAmount } }] }, 10_000, null, references);
      expect(cost).toBeCloseTo(50 + feeUsd);
    });

  it("selects native-notional tiers with an exclusive upper boundary", () => {
    const model: RedemptionCostModel = { kind: "fee-bps", feeBps: 0, feeComponents: [{ currency: "IDR", tiers: [
      { upToNotional: 250_000_000, terms: { flatAmount: 5000 } }, { terms: { flatAmount: 35000 } },
    ] }] };
    expect(resolveRedemptionCostBpsAtNotional(model, 15_624, null, references)).toBeCloseTo(0.3125 / 15_624 * 10_000);
    expect(resolveRedemptionCostBpsAtNotional(model, 15_625, null, references)).toBe(1.4);
  });

  it("applies percentage minimum and maximum in the declared currency", () => {
    const usd: RedemptionCostModel = { kind: "dynamic-or-unclear", confidence: "formula", feeBpsMax: 0, feeComponents: [
      { currency: "USD", terms: { feeBps: 10, minAmount: 50, maxAmount: 5000 } },
    ] };
    expect(resolveRedemptionCostBpsAtNotional(usd, 10_000)).toBe(50);
    expect(resolveRedemptionCostBpsAtNotional(usd, 1_000_000)).toBe(10);
    expect(resolveRedemptionCostBpsAtNotional(usd, 10_000_000)).toBe(5);
    expect(resolveRedemptionCostBpsAtNotional({ ...usd, feeComponents: [
      { currency: "CHF", terms: { feeBps: 10, minAmount: 50, maxAmount: 5000 } },
    ] }, 10_000, null, references)).toBe(62.5);
  });

  it("does not let a known component erase the unbounded remainder of a formula", () => {
    expect(resolveRedemptionCostBpsAtNotional({ kind: "dynamic-or-unclear", confidence: "formula",
      feeComponents: [{ currency: "CHF", terms: { flatAmount: 300 } }] }, 10_000, null, references)).toBeNull();
  });

  it.each([undefined,
    { ...references, clockSec: clockSec - 61 },
    { clockSec, pegDataById: { chf: { ...references.pegDataById.chf!, pegReferenceUnavailable: true } } },
    { clockSec, pegDataById: { chf: { pegCurrency: "CHF", pegReference: { valueUsd: 1.25,
      source: "fallback" as const, contributorCount: 0, asOf: clockSec } } } },
  ])("fails closed for absent, stale, future, unadmitted or static FX", (context) => {
    expect(resolveRedemptionCostBpsAtNotional({ kind: "fee-bps", feeBps: 0,
      feeComponents: [{ currency: "CHF", terms: { flatAmount: 30 } }] }, 10_000, 0, context)).toBeNull();
  });

  it("rejects equal-clock conflicting references", () => {
    expect(resolveRedemptionFiatReference("CHF", { ...references, pegDataById: {
      ...references.pegDataById, conflicting: { pegCurrency: "CHF", pegReference: {
        ...references.pegDataById.chf!.pegReference!, valueUsd: 1.26,
      } },
    } })).toBeNull();
  });

  it("validates complete increasing tiers, percentage/flat terms and caps", () => {
    const config = getRedemptionBackstopConfig("usdc-circle")!;
    const parse = (feeComponents: unknown) => RedemptionBackstopConfigSchema.safeParse({ ...config,
      costModel: { kind: "fee-bps", feeBps: 0, feeComponents } }).success;
    expect(parse([{ currency: "CHF", terms: { feeBps: 10, minAmount: 50, maxAmount: 5000 } }])).toBe(true);
    expect(parse([{ currency: "CHF", terms: {} }])).toBe(false);
    expect(parse([{ currency: "CHF", terms: { flatAmount: 1, minAmount: 5, maxAmount: 2 } }])).toBe(false);
    expect(parse([{ currency: "IDR", tiers: [{ upToNotional: 10, terms: { flatAmount: 1 } }] }])).toBe(false);
    expect(parse([{ currency: "IDR", tiers: [{ upToNotional: 10, terms: { flatAmount: 1 } },
      { upToNotional: 5, terms: { flatAmount: 2 } }, { terms: { flatAmount: 3 } }] }])).toBe(false);
  });

  it("deep-clones component and tier terms", () => {
    const component = { currency: "IDR", tiers: [{ upToNotional: 10, terms: { flatAmount: 1 } },
      { terms: { flatAmount: 2 } }] };
    const config = { ...getRedemptionBackstopConfig("usdc-circle")!,
      costModel: { kind: "fee-bps" as const, feeBps: 0, feeComponents: [component] },
      v9RouteCostTerms: { feeComponents: [component] } };
    const cloned = cloneRedemptionBackstopConfig(config);
    cloned.costModel.feeComponents![0]!.tiers![0]!.terms.flatAmount = 99;
    cloned.v9RouteCostTerms!.feeComponents![0]!.tiers![1]!.terms.flatAmount = 99;
    expect(component.tiers.map((tier) => tier.terms.flatAmount)).toEqual([1, 2]);
  });

});

import { describe, expect, it } from "vitest";
import { valuePhysicalCommodityDelivery } from "../physical-commodity-delivery";
import { isV9ExitRouteOutputResolved } from "../safety-score-v9/exit";

const terms = {
  commodity: "XAU" as const,
  deliverableOuncesPerToken: 1 / 31.1035,
  minimumDeliveryTokens: 100,
  deliveryTermsUnbounded: false,
  feeModel: { bps: 45, flatUsd: 100, deliveryUsd: 50 },
  sameNotionalEligible: false as const,
};

describe("physical commodity delivery", () => {
  it("values grams at the ounce reference, net of percentage and fixed delivery fees", () => {
    const value = valuePhysicalCommodityDelivery(terms, 3110.35, 20_000)!;
    expect(value.expectedUnitValueUsd).toBeCloseTo(100);
    expect(value.minimumDeliveryUsd).toBeCloseTo(10_000);
    expect(value.unitValueUsd).toBeCloseTo(98.8);
  });
  it("values unbounded delivery using only published fees and carries the lower policy tier", () => {
    const value = valuePhysicalCommodityDelivery({ ...terms, deliveryTermsUnbounded: true }, 3110.35, 20_000)!;
    expect(value.unitValueUsd).toBeCloseTo(99.05);
    expect(value.unboundedDeliveryCap).toBe(55);
    expect(valuePhysicalCommodityDelivery(terms, 3110.35, 20_000)?.unboundedDeliveryCap).toBeUndefined();
  });
  it("withholds the entire lot below the physical minimum and floors fees at zero", () => {
    expect(valuePhysicalCommodityDelivery(terms, 3110.35, 9999)?.unitValueUsd).toBe(0);
    expect(valuePhysicalCommodityDelivery({ ...terms, feeModel: { bps: 0, flatUsd: 30_000, deliveryUsd: 0 } }, 3110.35, 20_000)?.unitValueUsd).toBe(0);
  });
  it("does not grant same-notional credit to a known physical valuation", () => {
    expect(isV9ExitRouteOutputResolved({ status: { observationState: "known" }, valuation: { unitValueUsd: 100 }, sameNotionalEligible: false })).toBe(false);
  });
});

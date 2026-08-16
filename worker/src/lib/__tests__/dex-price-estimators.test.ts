import { describe, expect, it } from "vitest";
import { computeWeightedMedianPrice } from "../dex-price-estimators";

describe("computeWeightedMedianPrice", () => {
  it("preserves the lower discrete value at an exact half-weight boundary", () => {
    expect(computeWeightedMedianPrice([
      { price: 1.01, weight: 5 },
      { price: 0.99, weight: 5 },
    ])).toBe(0.99);
  });

  it("keeps price-domain filtering around the shared weighted median", () => {
    expect(computeWeightedMedianPrice([
      { price: -1, weight: 100 },
      { price: 1, weight: 0 },
      { price: 1.02, weight: 2 },
      { price: Number.NaN, weight: 50 },
    ])).toBe(1.02);
    expect(computeWeightedMedianPrice([])).toBeNull();
  });
});

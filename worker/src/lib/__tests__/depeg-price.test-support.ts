import type { classifyPrimaryDepegTrust } from "../depeg-trust-policy";

type PrimaryPriceFixture = Parameters<typeof classifyPrimaryDepegTrust>[0];

export function makePythDepegPrice(
  nowSec: number,
  overrides: PrimaryPriceFixture = {},
): PrimaryPriceFixture {
  return {
    price: 0.999,
    priceSource: "pyth",
    priceConfidence: "single-source",
    priceObservedAt: nowSec - 60,
    agreeSources: ["pyth"],
    ...overrides,
  };
}

export function makeSoftAgreementDepegPrice(
  nowSec: number,
  overrides: PrimaryPriceFixture = {},
): PrimaryPriceFixture {
  return {
    price: 0.999,
    priceSource: "coingecko+defillama-list",
    priceConfidence: "high",
    priceObservedAt: nowSec - 60,
    agreeSources: ["coingecko", "defillama-list"],
    ...overrides,
  };
}

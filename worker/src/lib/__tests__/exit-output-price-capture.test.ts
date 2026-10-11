import { describe, expect, it } from "vitest";
import { ExitOutputPriceObservationSchema } from "@shared/types/exit-output-price";
import { buildExitOutputPriceById } from "../report-cards-snapshot";
import { makeAsset } from "../../test-helpers/__shared/fixtures";

const NOW = 1_791_672_421;

function quote(overrides: Parameters<typeof makeAsset>[0] = {}) {
  return makeAsset({ id: "usdc-circle", price: 0.998713,
    priceSource: "coingecko+defillama", priceConfidence: "high",
    priceObservedAt: NOW - 60, priceUpdatedAt: NOW - 10,
    priceObservedAtMode: "upstream", priceSyncedAt: NOW,
    agreeSources: ["coingecko", "defillama", "coingecko-onchain-address"],
    ...overrides });
}

describe("Exit current output price capture", () => {
  it("retains the exact USD quote and original source clock rather than a refresh clock or par", () => {
    const result = buildExitOutputPriceById([quote()], NOW);
    expect(result["usdc-circle"]).toMatchObject({ priceUsd: 0.998713, observedAtSec: NOW - 60,
      sourceId: "coingecko+defillama", confidence: "high" });
    expect(() => ExitOutputPriceObservationSchema.parse(result["usdc-circle"])).not.toThrow();
  });

  it.each([
    { priceObservedAt: NOW - 1_801 }, { priceObservedAt: NOW + 1 },
    { priceObservedAt: null, priceUpdatedAt: null }, { price: null }, { price: 0 },
    { priceSource: "protocol-par", agreeSources: ["protocol-par"] },
    { priceConfidence: "low" as const, agreeSources: [] }, { id: "not-a-tracked-output" },
  ])("withholds an unadmitted output quote %#", (fault) => {
    expect(buildExitOutputPriceById([quote(fault)], NOW)).toEqual({});
  });

  it("admits a fresh exact protocol NAV for sUSN, but not a cached-rate or market substitute", () => {
    const nav = quote({ id: "susn-noon", price: 1.0837, priceSource: "protocol-redeem",
      priceConfidence: "high", agreeSources: ["protocol-redeem"] });
    expect(buildExitOutputPriceById([nav], NOW)["susn-noon"]).toMatchObject({
      priceUsd: 1.0837, admission: "guarded-nav", observedAtSec: NOW - 60,
    });
    expect(buildExitOutputPriceById([{ ...nav, priceConfidence: "low" }], NOW)).toEqual({});
    expect(buildExitOutputPriceById([{ ...nav, priceSource: "coingecko" }], NOW)).toEqual({});
  });
});

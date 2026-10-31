import { describe, expect, it } from "vitest";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { deriveCurrentPegObservationMap } from "../current-peg-observations";

const AS_OF = 1_700_000_000;

describe("deriveCurrentPegObservationMap peg-unit authority", () => {
  it("withholds a GOLD coin's deviation when the snapshot still labels it peggedUSD", () => {
    // The curated registry entry says GOLD, but the persisted snapshot row kept
    // the upstream USD label. The trust gate is fed the registry currency while
    // the reference comes from the snapshot pegType, which would otherwise
    // measure a $5,000 gold token against the hardcoded USD reference of 1.
    const xaut = makeAsset({
      id: "xaut-tether",
      name: "Tether Gold",
      symbol: "XAUT",
      geckoId: "tether-gold",
      pegType: "peggedUSD",
      price: 5_000,
      circulating: { peggedUSD: 500_000_000 },
    });

    const observation = deriveCurrentPegObservationMap({
      peggedAssets: [xaut],
      asOf: AS_OF,
    }).get("xaut-tether");

    expect(observation).toMatchObject({
      currentDeviationBps: null,
      currentSignal: null,
      pegReference: null,
      pegReferenceUnavailable: true,
    });
  });

  it("withholds a USD coin's deviation when the snapshot labels it peggedJPY", () => {
    // Mirror case: the registry USD identity short-circuits the trust gate, but
    // the one-coin JPY group's median is the coin's own quote, so the deviation
    // would be a self-referential zero.
    const usdc = makeAsset({
      id: "usdc-circle",
      name: "USD Coin",
      symbol: "USDC",
      geckoId: "usd-coin",
      pegType: "peggedJPY",
      price: 150,
      circulating: { peggedJPY: 500_000_000 },
    });

    const observation = deriveCurrentPegObservationMap({
      peggedAssets: [usdc],
      asOf: AS_OF,
    }).get("usdc-circle");

    expect(observation).toMatchObject({
      currentDeviationBps: null,
      currentSignal: null,
      pegReference: null,
      pegReferenceUnavailable: true,
    });
  });
});

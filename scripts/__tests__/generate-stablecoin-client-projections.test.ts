import { describe, expect, it } from "vitest";
import {
  buildStablecoinClientProjections,
  type StablecoinClientProjectionCoin,
} from "../build-data/generate-stablecoin-client-projections";

const usd = {
  id: "usd-core",
  name: "USD Core",
  symbol: "USDC",
  flags: { pegCurrency: "USD" },
} satisfies StablecoinClientProjectionCoin;

const eur = {
  id: "eur-core",
  name: "EUR Core",
  symbol: "EURC",
  status: "active",
  flags: { pegCurrency: "EUR" },
} satisfies StablecoinClientProjectionCoin;

const frozen = {
  id: "usd-frozen",
  name: "Frozen USD",
  symbol: "FUSD",
  status: "frozen",
  frozenAt: "2026-08-01",
  flags: { pegCurrency: "USD" },
} satisfies StablecoinClientProjectionCoin;

const preLaunch = {
  id: "gbp-preview",
  name: "GBP Preview",
  symbol: "GBPP",
  status: "pre-launch",
  flags: { pegCurrency: "GBP" },
} satisfies StablecoinClientProjectionCoin;

describe("stablecoin client projection generator", () => {
  it("projects ordered lightweight values from a tiny registry fixture", () => {
    const projection = buildStablecoinClientProjections({
      tracked: [usd, eur, frozen, preLaunch],
      active: [usd, eur],
      coreAggregateActive: [eur, usd],
      activeVariants: [eur],
      activeStableValueInvestments: [],
      preLaunch: [preLaunch],
      dead: [{ id: "dead" }, { id: "deader" }],
      pegOrder: ["EUR", "USD", "GBP"],
    });

    expect(projection).toEqual({
      trackedStablecoinCount: 4,
      activeStablecoinCount: 2,
      coreAggregateStablecoinCount: 2,
      activeVariantStablecoinCount: 1,
      activeStableValueInvestmentCount: 0,
      preLaunchStablecoinCount: 1,
      deadStablecoinCount: 2,
      activePegCurrencyCounts: { USD: 1, EUR: 1 },
      activePegCurrencies: ["EUR", "USD"],
      activeStablecoinIds: ["usd-core", "eur-core"],
      homepageTopCoreStablecoins: [
        { id: "eur-core", name: "EUR Core", symbol: "EURC" },
        { id: "usd-core", name: "USD Core", symbol: "USDC" },
      ],
      commandPaletteStablecoins: [
        ["usd-core", "USD Core", "USDC"],
        ["eur-core", "EUR Core", "EURC"],
        ["usd-frozen", "Frozen USD", "FUSD", "frozen", "2026-08-01"],
        ["gbp-preview", "GBP Preview", "GBPP", "pre-launch"],
      ],
    });
  });
});

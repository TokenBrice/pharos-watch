import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { buildStablecoinDetailHeroViewModel } from "../stablecoin-detail-view-model";

type HeroParams = Parameters<typeof buildStablecoinDetailHeroViewModel>[0];

export function buildDetailHero(overrides: Partial<HeroParams> & Pick<HeroParams, "coin">) {
  return buildStablecoinDetailHeroViewModel({
    coinData: makeStablecoin({ id: overrides.coin.id, name: overrides.coin.name, symbol: overrides.coin.symbol, circulating: { peggedUSD: 100 } }),
    isNavToken: false,
    mcap: 100,
    supply: 100,
    prevDay: null,
    prevWeek: null,
    prevMonth: null,
    performanceVsUsd1y: null,
    pegRef: 1,
    deviationBps: 0,
    gaugeDeviationBps: 0,
    pegReferenceUnavailable: false,
    pegScoreResult: null,
    liquidityData: undefined,
    yieldRanking: null,
    stressSignal: null,
    reportCard: null,
    verdict: { archetype: "uncategorized", label: "Uncategorized" },
    resolvedMechanismArchetype: null,
    mintAuthority: { status: "not-reviewed" } as HeroParams["mintAuthority"],
    redemptionBackstop: null,
    ...overrides,
  });
}

import type { MergedRow, YieldSourceCandidate } from "../types";
import { makeMergedRowWithIdentity } from "./fixture";

/** Strong primary versus a separately observed, venue-preferred alternate. */
export function makeYieldRailRow(
  alternate: Partial<YieldSourceCandidate> = {},
  overrides: Partial<MergedRow> = {},
): MergedRow {
  const primary: YieldSourceCandidate = {
    sourceKey: "primary-wrapper", protocol: "Issuer savings", chain: "ethereum",
    yieldType: "nav-appreciation", apy30d: 10, pharosYieldScore: 80,
    sourceTvlUsd: 100_000_000, dataSource: "test", sourceRiskScore: 10,
    venueRiskTier: "low", deploymentPlace: "native-wrapper", sourceDepthRatio: 0.02,
    sourceSwitchCount30d: 0, observationCount30d: 30,
    freshness: { capturedAt: 1_700_000_000, ageSeconds: 60 }, isPrimary: true,
  };
  return makeMergedRowWithIdentity({ id: "usdc-circle", symbol: "USDC", name: "USD Coin" }, {
    apy30d: 10, benchmarkRate: 4, sourceRiskScore: 10, pharosYieldScore: 80,
    apyVariance30d: 0.1, yieldProtocolSlug: primary.protocol, yieldVenueChain: primary.chain,
    yieldSources: [primary, {
      ...primary, sourceKey: "alternate-lending", protocol: "Lending venue", chain: "arbitrum",
      yieldType: "lending-vault", apy30d: 5, pharosYieldScore: null, sourceRiskScore: 70,
      venueRiskTier: "high", deploymentPlace: "lending", sourceTvlUsd: 50_000_000,
      observationCount30d: 2, sourceSwitchCount30d: 1, isPrimary: false,
      ...alternate,
    }],
    ...overrides,
  });
}

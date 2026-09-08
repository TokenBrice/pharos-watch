import type { PriceSourceDepthAudit } from "../maintenance/audit-price-source-depth";

type Row = PriceSourceDepthAudit["rows"][number];

export function diaAuditRow(overrides: Partial<Row> = {}): Row {
  const sources = overrides.consensusSources ?? ["coingecko", "pyth"];
  return {
    coinId: "alpha-usd", symbol: "ALPHA", name: "Alpha USD", status: "active", marketCapUsd: 500,
    price: 1, priceSource: "coingecko", priceConfidence: "single-source", primaryTrust: "single-source",
    pegSummaryPresent: true, stablecoinPresent: true, consensusSources: sources, agreeSources: [...sources],
    authoritativeAgreeSources: [], candidateSourceCount: sources.length, agreeSourceCount: sources.length,
    authoritativeAgreeSourceCount: 0, sourceClassifications: [],
    metadata: { geckoId: true, llamaId: false, cmcSlug: false, contracts: 1, tradedContracts: 0 },
    candidateTriage: {
      currentSources: [...sources], missingFields: [], fieldAlreadyPresent: ["contracts"], potentialNewSource: null,
      pipelineLane: "primary", expectedMetricImpact: sources.length >= 3 ? "no-count-impact" : "needs-runtime-provider-change",
      expectedTrustImpact: "unknown", verificationSourceUrl: "", blocker: "",
    },
    fallbackOnlyFill: false, missingOrUnusablePrice: false,
    ...overrides,
  };
}

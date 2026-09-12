export function yieldCacheRow(key: string, updatedAt: number, payload: unknown) {
  return { key, updated_at: updatedAt, value: JSON.stringify(payload) };
}

export function healthyYieldProvenance(now: number, coveredCount: number, overrides: Record<string, unknown> = {}) {
  return {
    safetySnapshot: { coverageRatio: 1, coveredCount, trackedCount: coveredCount, reason: null },
    benchmark: {
      fetchedAt: now - 3600,
      ageSeconds: 3600,
      source: "tbill-cache",
      isFallback: false,
      fallbackMode: null,
    },
    ...overrides,
  };
}

export function emptyYieldAudit(overrides: Record<string, unknown> = {}) {
  return {
    manifestMissingCount: 0,
    yieldBearingMissingFromRankingsCount: 0,
    unmatchedHighTvlPoolCount: 0,
    missingProtocolCount: 0,
    nativeExactPoolRecommendationCount: 0,
    sourceFamilyAdapterRecommendationCount: 0,
    lendingAllowlistRecommendationCount: 0,
    venueRiskConfigMissingCount: 0,
    staleAutoLendingOverrideCount: 0,
    staleVenueRiskScoreCount: 0,
    ...overrides,
  };
}

export function stampedSafetyIdentity(overrides: Record<string, unknown> = {}) {
  return {
    model: "v9",
    schemaVersion: 1,
    methodologyVersion: "9.1",
    evaluationBuildDigest: "a".repeat(64),
    baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
    publicationGenerationId: "safety-score-v9:2026-09-11T08:00:00Z",
    policyId: "safety-score-v9-policy",
    policyDigest: "c".repeat(64),
    ...overrides,
  };
}

interface LiveShapeRow {
  dataSource: string;
  apyBase: number | null;
  apyReward: number | null;
  deploymentPlace: string | null;
  hasDepth: boolean;
  hasRewardShare: boolean;
  isBest: boolean;
}

/**
 * The measured 2026-09-11 payload shape: 270 source rows (157 best + 113 alt),
 * 64 derivation-method rows whose venue is the asset itself, 34 single-rate
 * onchain/protocol-api reads with no incentive split, 172 split-capable rows
 * that each publish a reward share, 199 of the 206 venue-backed rows carrying a
 * depth ratio, and 137 best rows benchmarked to USD of which 4 selected it as a
 * documented proxy.
 */
export function liveShapeSourceRows(): LiveShapeRow[] {
  const rows: LiveShapeRow[] = [];
  const push = (count: number, build: (index: number) => LiveShapeRow) => {
    for (let index = 0; index < count; index += 1) rows.push(build(index));
  };

  // 45 price-derived + 19 rate-derived: the asset is its own venue.
  push(45, () => ({
    dataSource: "price-derived",
    apyBase: 4,
    apyReward: null,
    deploymentPlace: "price-derived",
    hasDepth: false,
    hasRewardShare: false,
    isBest: true,
  }));
  push(19, () => ({
    dataSource: "rate-derived",
    apyBase: 3,
    apyReward: null,
    deploymentPlace: "rate-derived",
    hasDepth: false,
    hasRewardShare: false,
    isBest: true,
  }));
  // 34 single-rate reads: a venue exists, an incentive split does not. Seven of
  // them are NAV oracles that publish no venue TVL, so they carry no depth.
  push(34, (index) => ({
    dataSource: index % 2 === 0 ? "onchain" : "protocol-api",
    apyBase: 5,
    apyReward: null,
    deploymentPlace: "native-wrapper",
    hasDepth: index >= 7,
    hasRewardShare: false,
    isBest: index < 20,
  }));
  // 172 split-capable DeFiLlama rows: every one publishes a reward share.
  push(172, (index) => ({
    dataSource: index % 4 === 0 ? "defillama-auto" : "defillama",
    apyBase: 6,
    apyReward: index % 5 === 0 ? 1 : 0,
    deploymentPlace: "lending-market",
    hasDepth: true,
    hasRewardShare: true,
    isBest: index < 73,
  }));
  return rows;
}

function liveShapeSourceRisk(row: LiveShapeRow) {
  return {
    sourceRiskPenalty: 1.1,
    sourceRiskScore: 80,
    sourceAgeSeconds: 120,
    observationCount30d: 20,
    deploymentPlace: row.deploymentPlace,
    ...(row.hasDepth ? { sourceDepthRatio: 0.2 } : {}),
    ...(row.hasRewardShare ? { rewardShare: row.apyReward === 0 ? 0 : 0.3 } : {}),
  };
}

/**
 * Best rows become rankings (137 on USD, 4 of them proxy selections, 20 on EUR);
 * alternates ride on the first ranking, mirroring the published payload where an
 * alt row carries `dataSource` and `sourceRisk` but no APY split.
 */
export function liveShapeRankings(rows: LiveShapeRow[]) {
  const bestRows = rows.filter((row) => row.isBest);
  const altSources = rows
    .filter((row) => !row.isBest)
    .map((row, index) => ({
      sourceKey: `alt-${index}`,
      dataSource: row.dataSource,
      sourceRisk: liveShapeSourceRisk(row),
    }));
  return bestRows.map((row, index) => ({
    id: `coin-${index}`,
    dataSource: row.dataSource,
    apyBase: row.apyBase,
    apyReward: row.apyReward,
    benchmarkKey: index < 137 ? "USD" : "EUR",
    ...(index < 4 ? { benchmarkSelectionMode: "fallback-usd" } : {}),
    sourceRisk: liveShapeSourceRisk(row),
    ...(index === 0 ? { altSources } : {}),
  }));
}

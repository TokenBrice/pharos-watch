import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";

interface DataHealthPreset {
  label: string;
  staleTime: number;
}

export const DATA_HEALTH_PRESETS = {
  stablecoins: { label: "Prices", staleTime: API_FRESHNESS_MAX_AGE_SEC.stablecoins * 1000 },
  chains: { label: "Chain Data", staleTime: API_FRESHNESS_MAX_AGE_SEC.chains * 1000 },
  pegSummary: { label: "Peg Data", staleTime: API_FRESHNESS_MAX_AGE_SEC.pegSummary * 1000 },
  stressSignals: { label: "DEWS", staleTime: API_FRESHNESS_MAX_AGE_SEC.stressSignals * 1000 },
  depegEvents: { label: "Depeg Events", staleTime: API_FRESHNESS_MAX_AGE_SEC.depegEvents * 1000 },
  reportCards: { label: "Report Cards", staleTime: API_FRESHNESS_MAX_AGE_SEC.reportCards * 1000 },
  redemptionBackstops: { label: "Redemption Backstops", staleTime: API_FRESHNESS_MAX_AGE_SEC.redemptionBackstops * 1000 },
  stabilityIndex: { label: "Stability Index", staleTime: API_FRESHNESS_MAX_AGE_SEC.stabilityIndex * 1000 },
  mintBurnFlows: { label: "Mint/Burn Flows", staleTime: API_FRESHNESS_MAX_AGE_SEC.mintBurnFlows * 1000 },
  blacklist: { label: "Blacklist", staleTime: API_FRESHNESS_MAX_AGE_SEC.blacklist * 1000 },
  dexLiquidity: { label: "Liquidity", staleTime: API_FRESHNESS_MAX_AGE_SEC.dexLiquidity * 1000 },
  yieldRankings: { label: "Yield Rankings", staleTime: API_FRESHNESS_MAX_AGE_SEC.yieldRankings * 1000 },
  dailyDigest: { label: "Daily Digest", staleTime: API_FRESHNESS_MAX_AGE_SEC.dailyDigest * 1000 },
  digestArchive: { label: "Digests", staleTime: API_FRESHNESS_MAX_AGE_SEC.digestArchive * 1000 },
  bluechip: { label: "Bluechip", staleTime: API_FRESHNESS_MAX_AGE_SEC.bluechip * 1000 },
} as const satisfies Record<string, DataHealthPreset>;

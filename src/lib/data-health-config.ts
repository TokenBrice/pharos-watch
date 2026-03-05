import { CRON_15MIN, CRON_20MIN, CRON_30MIN, CRON_24H } from "@/lib/cron-intervals";

export interface DataHealthPreset {
  label: string;
  staleTime: number;
}

export const DATA_HEALTH_PRESETS = {
  stablecoins: { label: "Prices", staleTime: CRON_15MIN },
  pegSummary: { label: "Peg Data", staleTime: CRON_15MIN },
  stressSignals: { label: "DEWS", staleTime: CRON_15MIN },
  depegEvents: { label: "Depeg Events", staleTime: CRON_15MIN },
  reportCards: { label: "Report Cards", staleTime: CRON_15MIN },
  stabilityIndex: { label: "Stability Index", staleTime: CRON_15MIN },
  mintBurnFlows: { label: "Mint/Burn Flows", staleTime: CRON_20MIN },
  blacklist: { label: "Blacklist", staleTime: CRON_20MIN },
  dexLiquidity: { label: "Liquidity", staleTime: CRON_30MIN },
  yieldRankings: { label: "Yield Rankings", staleTime: CRON_30MIN },
  dailyDigest: { label: "Daily Digest", staleTime: CRON_24H },
  digestArchive: { label: "Digests", staleTime: CRON_24H },
  bluechip: { label: "Bluechip", staleTime: CRON_24H },
} as const satisfies Record<string, DataHealthPreset>;

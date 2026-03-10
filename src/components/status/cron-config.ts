type StatusCronGroupKey =
  | "quarter-hourly"
  | "twenty-minute"
  | "half-hourly"
  | "daily"
  | "other";

interface StatusCronGroupDefinition {
  key: StatusCronGroupKey;
  title: string;
  badge: string;
  description: string;
}

interface StatusCronDisplayMeta {
  group: StatusCronGroupKey;
  label: string;
}

export const STATUS_CRON_GROUPS: readonly StatusCronGroupDefinition[] = [
  {
    key: "quarter-hourly",
    title: "15-minute slot",
    badge: "*/15",
    description: "Core ingestion, FX rates, derived score recompute, operator self-checks, and alert fan-out.",
  },
  {
    key: "twenty-minute",
    title: "20-minute slot",
    badge: "~20 min",
    description: "On-chain intake jobs (blacklist, mint/burn, DEX discovery) on isolated triggers for connection pool separation.",
  },
  {
    key: "half-hourly",
    title: "30-minute slot",
    badge: "~30 min",
    description: "Stablecoin charts, DEX liquidity scoring, and yield refresh.",
  },
  {
    key: "daily",
    title: "Daily 08:00 UTC",
    badge: "08:00 UTC",
    description: "Snapshots, slower monitors, and digest generation.",
  },
  {
    key: "other",
    title: "Other cadence",
    badge: "unmapped",
    description: "Fallback bucket for jobs that do not yet have status-page display metadata.",
  },
] as const;

const STATUS_CRON_DISPLAY: Record<string, StatusCronDisplayMeta> = {
  "sync-stablecoins": { group: "quarter-hourly", label: "Stablecoin sync" },
  "sync-stablecoin-charts": { group: "half-hourly", label: "Stablecoin charts" },
  "sync-fx-rates": { group: "quarter-hourly", label: "FX rates" },
  "stability-index": { group: "quarter-hourly", label: "PSI compute" },
  "compute-dews": { group: "quarter-hourly", label: "DEWS compute" },
  "status-self-check": { group: "quarter-hourly", label: "Status self-check" },
  "dispatch-telegram-alerts": { group: "quarter-hourly", label: "Telegram alerts" },
  "sync-blacklist": { group: "twenty-minute", label: "Blacklist sync" },
  "sync-mint-burn": { group: "twenty-minute", label: "Mint/burn critical" },
  "sync-mint-burn-extended": { group: "twenty-minute", label: "Mint/burn extended" },
  "sync-dex-discovery": { group: "twenty-minute", label: "DEX pool discovery" },
  "sync-dex-liquidity": { group: "half-hourly", label: "DEX liquidity scoring" },
  "sync-yield-data": { group: "half-hourly", label: "Yield sync" },
  "snapshot-supply": { group: "daily", label: "Supply snapshot" },
  "snapshot-safety-grade-history": { group: "daily", label: "Safety grade snapshot" },
  "fetch-tbill-rate": { group: "daily", label: "T-bill rate" },
  "snapshot-psi": { group: "daily", label: "PSI snapshot" },
  "sync-usds-status": { group: "daily", label: "USDS status" },
  "sync-bluechip": { group: "daily", label: "Bluechip sync" },
  "daily-digest": { group: "daily", label: "Daily digest" },
};

export function getStatusCronDisplay(job: string): StatusCronDisplayMeta {
  return STATUS_CRON_DISPLAY[job] ?? { group: "other", label: job };
}

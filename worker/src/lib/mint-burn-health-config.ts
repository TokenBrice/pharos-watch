const MINT_BURN_MAJOR_SYMBOLS = [
  "USDT",
  "USDC",
  "DAI",
  "USDS",
  "GHO",
  "FRXUSD",
  "BOLD",
  "reUSD",
] as const;

const MINT_BURN_STALE_WARN_SEC = 6 * 3600;
const MINT_BURN_STALE_CRIT_SEC = 24 * 3600;
const MINT_BURN_ALERT_COOLDOWN_SEC = 3600;
const MINT_BURN_CRITICAL_LANE_INTERVAL_SEC = 30 * 60;

export const MINT_BURN_PUBLIC_FRESHNESS_MAX_AGE_SEC = MINT_BURN_CRITICAL_LANE_INTERVAL_SEC * 2;

export interface MintBurnFreshnessConfig {
  majorSymbols: string[];
  staleWarnSec: number;
  staleCritSec: number;
  alertCooldownSec: number;
}

interface MintBurnFreshnessEnv {
  MINT_BURN_MAJOR_SYMBOLS?: string;
  MINT_BURN_STALE_WARN_SEC?: string;
  MINT_BURN_STALE_CRIT_SEC?: string;
  MINT_BURN_ALERT_COOLDOWN_SEC?: string;
}

function parseCsvSymbols(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveMintBurnFreshnessConfig(env?: MintBurnFreshnessEnv): MintBurnFreshnessConfig {
  const envMajorSymbols = parseCsvSymbols(env?.MINT_BURN_MAJOR_SYMBOLS);
  return {
    majorSymbols: envMajorSymbols.length > 0 ? envMajorSymbols : [...MINT_BURN_MAJOR_SYMBOLS],
    staleWarnSec: parsePositiveInt(env?.MINT_BURN_STALE_WARN_SEC, MINT_BURN_STALE_WARN_SEC),
    staleCritSec: parsePositiveInt(env?.MINT_BURN_STALE_CRIT_SEC, MINT_BURN_STALE_CRIT_SEC),
    alertCooldownSec: parsePositiveInt(env?.MINT_BURN_ALERT_COOLDOWN_SEC, MINT_BURN_ALERT_COOLDOWN_SEC),
  };
}

export type MintBurnSyncFreshnessStatus = "fresh" | "degraded" | "stale";

export interface MintBurnSyncHealth {
  lastSuccessfulSyncAt: number | null;
  freshnessStatus: MintBurnSyncFreshnessStatus;
  warning: string | null;
  criticalLaneHealthy: boolean;
}

export function computeMintBurnSyncFreshnessStatus(
  nowSec: number,
  lastSuccessfulSyncAt: number | null,
): MintBurnSyncFreshnessStatus {
  if (lastSuccessfulSyncAt == null) return "stale";
  const ageSec = Math.max(0, nowSec - lastSuccessfulSyncAt);
  const ratio = ageSec / MINT_BURN_PUBLIC_FRESHNESS_MAX_AGE_SEC;
  if (ratio <= 1) return "fresh";
  if (ratio <= 1.5) return "degraded";
  return "stale";
}

export function buildMintBurnSyncHealth(
  nowSec: number,
  lastSuccessfulSyncAt: number | null,
  latestRunStatus: string | null,
): MintBurnSyncHealth {
  const freshnessStatus = computeMintBurnSyncFreshnessStatus(nowSec, lastSuccessfulSyncAt);
  const criticalLaneHealthy =
    latestRunStatus === "ok" || latestRunStatus === "degraded" || latestRunStatus === "skipped_locked";

  let warning: string | null = null;
  if (latestRunStatus === "error") {
    warning = "Critical mint/burn lane last run errored; cached or partial data may be served.";
  } else if (latestRunStatus === "degraded") {
    warning = "Critical mint/burn lane is running in degraded mode; coverage may be partial.";
  } else if (freshnessStatus === "stale") {
    warning = "Mint/burn sync freshness is stale versus the 30-minute cron cadence.";
  } else if (freshnessStatus === "degraded") {
    warning = "Mint/burn sync freshness is degraded versus the 30-minute cron cadence.";
  }

  return {
    lastSuccessfulSyncAt,
    freshnessStatus,
    warning,
    criticalLaneHealthy,
  };
}

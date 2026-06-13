import type { FreshnessStatus } from "@shared/lib/status-thresholds";

const DEFAULT_MINT_BURN_MAJOR_SYMBOLS = [
  "USDT",
  "USDC",
  "DAI",
  "USDS",
  "GHO",
  "FRXUSD",
  "BOLD",
  "reUSD",
] as const;

const SECONDS_PER_HOUR = 3600;
const DEFAULT_MINT_BURN_STALE_WARN_SEC = 6 * SECONDS_PER_HOUR;
const DEFAULT_MINT_BURN_STALE_CRIT_SEC = 24 * SECONDS_PER_HOUR;
const DEFAULT_MINT_BURN_ALERT_COOLDOWN_SEC = SECONDS_PER_HOUR;
const MINT_BURN_CRITICAL_LANE_INTERVAL_SEC = 30 * 60;
// Public freshness tolerates one missed critical-lane run; the next half-window is degraded.
const MINT_BURN_PUBLIC_FRESHNESS_ALLOWED_MISSED_RUNS = 2;
const MINT_BURN_PUBLIC_FRESHNESS_DEGRADED_RATIO = 1.5;

export const MINT_BURN_PUBLIC_FRESHNESS_MAX_AGE_SEC =
  MINT_BURN_CRITICAL_LANE_INTERVAL_SEC * MINT_BURN_PUBLIC_FRESHNESS_ALLOWED_MISSED_RUNS;

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
    majorSymbols: envMajorSymbols.length > 0 ? envMajorSymbols : [...DEFAULT_MINT_BURN_MAJOR_SYMBOLS],
    staleWarnSec: parsePositiveInt(env?.MINT_BURN_STALE_WARN_SEC, DEFAULT_MINT_BURN_STALE_WARN_SEC),
    staleCritSec: parsePositiveInt(env?.MINT_BURN_STALE_CRIT_SEC, DEFAULT_MINT_BURN_STALE_CRIT_SEC),
    alertCooldownSec: parsePositiveInt(
      env?.MINT_BURN_ALERT_COOLDOWN_SEC,
      DEFAULT_MINT_BURN_ALERT_COOLDOWN_SEC,
    ),
  };
}

export interface MintBurnSyncHealth {
  lastSuccessfulSyncAt: number | null;
  freshnessStatus: FreshnessStatus;
  warning: string | null;
  criticalLaneHealthy: boolean;
}

export function computeMintBurnSyncFreshnessStatus(
  nowSec: number,
  lastSuccessfulSyncAt: number | null,
): FreshnessStatus {
  if (lastSuccessfulSyncAt == null) return "stale";
  const ageSec = Math.max(0, nowSec - lastSuccessfulSyncAt);
  const ratio = ageSec / MINT_BURN_PUBLIC_FRESHNESS_MAX_AGE_SEC;
  if (ratio <= 1) return "fresh";
  if (ratio <= MINT_BURN_PUBLIC_FRESHNESS_DEGRADED_RATIO) return "degraded";
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

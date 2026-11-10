import type { FreshnessStatus } from "@shared/lib/status-thresholds";
import { MINT_BURN_PUBLIC_FRESHNESS_DEGRADED_RATIO } from "@shared/lib/public-health";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { parseCsvEnv } from "./env";
import { assessFreshnessTimestamp } from "./api-freshness-age";

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

export const MINT_BURN_PUBLIC_FRESHNESS_MAX_AGE_SEC =
  API_FRESHNESS_MAX_AGE_SEC.mintBurnFlows;

/**
 * A `finalized` header older than this is a cached or lagging provider head,
 * not current finality evidence. Ethereum finality trails ~13 minutes; rollup
 * `finalized` tags (Base, Arbitrum) wait for L1 finality of their batches and
 * routinely trail by longer, so they get a wider bound.
 */
const MINT_BURN_FINALIZED_HEAD_MAX_AGE_SEC_BY_CHAIN: Readonly<Record<string, number>> = {
  ethereum: 30 * 60,
};
const MINT_BURN_FINALIZED_HEAD_DEFAULT_MAX_AGE_SEC = 2 * SECONDS_PER_HOUR;

export function mintBurnFinalizedHeadMaxAgeSec(chainId: string): number {
  return MINT_BURN_FINALIZED_HEAD_MAX_AGE_SEC_BY_CHAIN[chainId] ?? MINT_BURN_FINALIZED_HEAD_DEFAULT_MAX_AGE_SEC;
}

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

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveMintBurnFreshnessConfig(env?: MintBurnFreshnessEnv): MintBurnFreshnessConfig {
  const envMajorSymbols = parseCsvEnv(env?.MINT_BURN_MAJOR_SYMBOLS);
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
  const { ageSeconds: ageSec } = assessFreshnessTimestamp(nowSec, lastSuccessfulSyncAt);
  if (ageSec == null) return "stale";
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
    lastSuccessfulSyncAt: assessFreshnessTimestamp(nowSec, lastSuccessfulSyncAt).reason == null ? lastSuccessfulSyncAt : null,
    freshnessStatus,
    warning,
    criticalLaneHealthy,
  };
}

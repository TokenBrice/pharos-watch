import { getCacheImpactStatus } from "./cache-health";
import { getCircuitScope } from "./circuit-sources";
import { CRON_INTERVALS } from "./cron-jobs";
import { DATA_SURFACE_DESCRIPTORS } from "./data-surface-descriptors";
import { STATUS_PUBLIC_PRODUCER_GRACE_RATIOS } from "./status-thresholds";
import type { CacheStatus, CircuitRecord, HealthResponse, PublicComponentBudget, StatusHealthValue } from "../types/status";

export type PublicStatusTone = StatusHealthValue;

/**
 * Worker mint/burn sync freshness (`sync.freshnessStatus`, admin and the flows
 * API) tolerates one missed critical-lane run; the next half-window is degraded.
 * Public status no longer reads it: mint/burn is graded by the producer grace
 * rule (`getPublicProducerGraceBudget`), one authority per public verdict (R5).
 */
export const MINT_BURN_PUBLIC_FRESHNESS_DEGRADED_RATIO = 1.5;

/** Upstream providers with an open source-wide circuit required to affect public availability and admin causes. */
export const PUBLIC_CIRCUIT_IMPACT_QUORUM = 3;

/**
 * Public component grace: an age-graded component past its stale band stays
 * `degraded` (last good data still served) until its age reaches this multiple
 * of the stale band, which proves the stale state has persisted for at least one
 * further full stale budget. Only then does the public projection report an
 * outage. The multiple is printed with every age-graded verdict (R3).
 */
export const PUBLIC_COMPONENT_OUTAGE_GRACE_MULTIPLIER = 2;

/** Producer intervals of the components graded by the public producer grace rule. */
export const PUBLIC_PRODUCER_INTERVAL_SEC = {
  safetyScores: DATA_SURFACE_DESCRIPTORS.reportCards.producerIntervalSec,
  mintBurn: CRON_INTERVALS["sync-mint-burn"],
} as const;

/** Named public budget for a producer: delayed 3×, degraded 6×, outage 12× its interval (R3). */
export function getPublicProducerGraceBudget(producerIntervalSec: number): PublicComponentBudget {
  const degradedAfterSec = producerIntervalSec * STATUS_PUBLIC_PRODUCER_GRACE_RATIOS.degraded;
  return {
    delayedAfterSec: producerIntervalSec * STATUS_PUBLIC_PRODUCER_GRACE_RATIOS.delayed,
    degradedAfterSec,
    outageAfterSec: degradedAfterSec * PUBLIC_COMPONENT_OUTAGE_GRACE_MULTIPLIER,
  };
}

/** Raw three-level tone of a producer age: `degraded` past the delayed band, `stale` past the degraded band. */
function getProducerAgeStatus(ageSeconds: number, producerIntervalSec: number): PublicStatusTone {
  const budget = getPublicProducerGraceBudget(producerIntervalSec);
  if (ageSeconds > budget.degradedAfterSec) return "stale";
  return ageSeconds > budget.delayedAfterSec ? "degraded" : "healthy";
}

const STATUS_SEVERITY: Record<PublicStatusTone, number> = {
  healthy: 0,
  degraded: 1,
  stale: 2,
};

export function getStatusSeverity(status: PublicStatusTone): number {
  return STATUS_SEVERITY[status];
}

export function maxPublicStatus(...statuses: PublicStatusTone[]): PublicStatusTone {
  let result: PublicStatusTone = "healthy";
  for (const status of statuses) {
    if (STATUS_SEVERITY[status] > STATUS_SEVERITY[result]) {
      result = status;
    }
  }
  return result;
}

/**
 * Graded by the last successful sync's age only. A partial or failed latest run
 * is an operational notice: a failed run does not advance the success clock, so
 * a run of failures still surfaces through age.
 */
export function getPublicMintBurnStatus(sync: HealthResponse["mintBurn"]["sync"], now: number): PublicStatusTone {
  if (sync.freshnessStatus == null || sync.criticalLaneHealthy == null) return "degraded";
  if (sync.lastSuccessfulSyncAt == null) return "stale";
  return getProducerAgeStatus(Math.max(0, now - sync.lastSuccessfulSyncAt), PUBLIC_PRODUCER_INTERVAL_SEC.mintBurn);
}

/**
 * The accepted publication clock, not a newer held attempt, owns freshness. A
 * hold is an operational notice while the accepted scores stay inside budget.
 */
export function getPublicSafetyScoreStatus(
  publication: HealthResponse["safetyScorePublication"],
  now: number,
): PublicStatusTone {
  if (!publication || publication.acceptedAtSec == null) return "degraded";
  return getProducerAgeStatus(Math.max(0, now - publication.acceptedAtSec), PUBLIC_PRODUCER_INTERVAL_SEC.safetyScores);
}

export function getOverallCacheImpactStatus(caches: Record<string, CacheStatus>): PublicStatusTone {
  let worstStatus: PublicStatusTone = "healthy";

  for (const [key, cache] of Object.entries(caches)) {
    worstStatus = maxPublicStatus(worstStatus, getCacheImpactStatus(cache, key));
    if (worstStatus === "stale") {
      return worstStatus;
    }
  }

  return worstStatus;
}

export function getCircuitImpactStatus(openCircuitCount: number | null): PublicStatusTone {
  return openCircuitCount == null || openCircuitCount >= PUBLIC_CIRCUIT_IMPACT_QUORUM ? "degraded" : "healthy";
}

export function isPublicImpactCircuitKey(key: string): boolean {
  return getCircuitScope(key) === "source-wide";
}

/**
 * Circuit keys that share one upstream provider. The quorum counts providers,
 * not keys: DexScreener's price and refresh breakers opening together are one
 * vendor failure, not two. Unlisted keys are their own provider.
 */
const CIRCUIT_PROVIDER_BY_KEY: Readonly<Record<string, string>> = {
  "dexscreener-prices": "dexscreener",
  "dexscreener-prices-refresh": "dexscreener",
  "dexscreener-address-prices": "dexscreener",
  "coingecko-prices": "coingecko",
  "coingecko-mcap": "coingecko",
  "coingecko-onchain": "coingecko",
  "coingecko-detail-platforms": "coingecko",
  "coingecko-ticker": "coingecko",
  "coingecko-confirm": "coingecko",
  "defillama-stablecoins": "defillama",
  "defillama-stablecoin-detail": "defillama",
  "defillama-coins": "defillama",
  "defillama-yields": "defillama",
  "defillama-protocols": "defillama",
  "alchemy": "alchemy",
  "alchemy-prices": "alchemy",
  "kinesis-kau-horizon": "kinesis",
  "kinesis-kag-horizon": "kinesis",
};

export function getCircuitProvider(key: string): string {
  return CIRCUIT_PROVIDER_BY_KEY[key] ?? key;
}

/** Distinct upstream providers with an open source-wide circuit. */
export function countPublicImpactOpenCircuits(circuits: Record<string, CircuitRecord>): number {
  return new Set(Object.entries(circuits)
    .filter(([key, circuit]) => isPublicImpactCircuitKey(key) && circuit.state === "open")
    .map(([key]) => getCircuitProvider(key))).size;
}

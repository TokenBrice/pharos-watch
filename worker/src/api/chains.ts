import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import { aggregateChains } from "@shared/lib/chains/aggregator";
import { derivePegRates } from "@shared/lib/peg-rates";
import { CHAIN_META } from "@shared/lib/chains";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { CORE_AGGREGATE_ACTIVE_IDS } from "@shared/lib/stablecoins/aggregate-registry";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import type { FreshnessStatus } from "@shared/lib/status-thresholds";
import { errorResponse, jsonResponseWithHeaders } from "../lib/api-response";
import { CACHE_PROFILES } from "../lib/constants";
import type { SafetyScorePublicationIdentity } from "@shared/types/safety-score-publication";
import {
  loadActiveSafetyScoreSource,
  type ActiveSafetyScoreSource,
} from "../lib/safety-score-active-source";
import { SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "../lib/safety-score-v9/consumer-freshness";

const CHAINS_FRESHNESS_MAX_AGE_SEC = API_FRESHNESS_MAX_AGE_SEC.chains;
const CHAINS_STALE_THRESHOLD_SEC = CHAINS_FRESHNESS_MAX_AGE_SEC * 2;

type ChainsDependencyStatus = FreshnessStatus | "unavailable";

interface ChainsDependencyMeta {
  updatedAt?: number | null;
  ageSeconds?: number | null;
  status: ChainsDependencyStatus;
  reason?: string | null;
  inputsStale?: boolean;
  staleInputs?: string[];
}

interface ChainsFreshnessMeta {
  updatedAt: number;
  ageSeconds: number;
  status: FreshnessStatus;
  warning?: string | null;
  dependencies?: {
    reportCards: ChainsDependencyMeta;
  };
  safetyScoreIdentity: SafetyScorePublicationIdentity | null;
}

function getDependencyAgeSeconds(updatedAt: number | null | undefined, nowSec: number): number | null {
  if (updatedAt == null) return null;
  return Math.max(0, nowSec - updatedAt);
}

function buildV9ExpectedDependencyMeta(
  activeSource: ActiveSafetyScoreSource,
  nowSec: number,
): ChainsDependencyMeta {
  if (activeSource.kind === "error") {
    return {
      updatedAt: null,
      ageSeconds: null,
      status: "unavailable",
      reason: activeSource.reason,
    };
  }
  const updatedAt = activeSource.snapshot.updatedAt;
  const ageSeconds = getDependencyAgeSeconds(updatedAt, nowSec);
  if (activeSource.kind === "held") {
    return {
      updatedAt,
      ageSeconds,
      status: "degraded",
      reason: "publication-held",
    };
  }
  if (
    ageSeconds !== null &&
    ageSeconds > SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC
  ) {
    return {
      updatedAt,
      ageSeconds,
      status: "stale",
      reason: "stale-cache",
    };
  }
  return {
    updatedAt,
    ageSeconds,
    status: "fresh",
  };
}

export function isActiveChainAggregateAsset(asset: {
  id: string;
  frozen?: boolean;
  isDefunct?: boolean;
  defunct?: boolean;
}): boolean {
  return (
    CORE_AGGREGATE_ACTIVE_IDS.has(asset.id) &&
    asset.frozen !== true &&
    asset.isDefunct !== true &&
    asset.defunct !== true
  );
}

function buildChainsFreshnessMeta(
  updatedAt: number,
  reportCards: ChainsDependencyMeta,
  safetyScoreIdentity: SafetyScorePublicationIdentity | null,
): { headers: Record<string, string>; meta: ChainsFreshnessMeta } {
  const nowSec = Math.floor(Date.now() / 1000);
  const ageSeconds = Math.max(0, nowSec - updatedAt);
  let status: FreshnessStatus;

  if (ageSeconds <= CHAINS_FRESHNESS_MAX_AGE_SEC) {
    status = "fresh";
  } else if (ageSeconds <= CHAINS_STALE_THRESHOLD_SEC) {
    status = "degraded";
  } else {
    status = "stale";
  }

  const warnings: string[] = [];
  if (status !== "fresh") {
    warnings.push(`110 - "Response is ${status} (${ageSeconds}s old, max ${CHAINS_FRESHNESS_MAX_AGE_SEC}s)"`);
  }

  if (reportCards.status !== "fresh") {
    if (status === "fresh") {
      status = "degraded";
    }
    const reportCardAgeSuffix = reportCards.ageSeconds != null ? ` (${reportCards.ageSeconds}s old)` : "";
    const reportCardReason = (reportCards.reason ?? reportCards.status).replace(/-/g, " ");
    warnings.push(`safety-score dependency ${reportCardReason}${reportCardAgeSuffix}`);
  }

  const warning = warnings.length > 0 ? warnings.join("; ") : null;

  return {
    headers: {
      "Cache-Control": status === "fresh" ? CACHE_PROFILES.producerBacked : "no-store",
      "X-Data-Age": String(ageSeconds),
      ...(warning ? { Warning: warning } : {}),
    },
    meta: {
      updatedAt,
      ageSeconds,
      status,
      dependencies: {
        reportCards,
      },
      safetyScoreIdentity,
      ...(warning ? { warning } : {}),
    },
  };
}

export const handleChains = async (db: D1Database, url?: URL): Promise<Response> => {
  const stablecoinsResult = await loadStablecoinsCache(db, {
    mode: "strict",
    contract: "published",
  });
  if (stablecoinsResult.kind !== "ok") {
    return errorResponse(503, "Data not yet available");
  }

  const { peggedAssets, fxFallbackRates } = stablecoinsResult.payload;
  const activePeggedAssets = peggedAssets.filter(isActiveChainAggregateAsset);

  // Optional chain scope: publish the full per-chain coin rows the chain-detail
  // route renders. Unknown ids are rejected rather than silently dropping the
  // detail payload, so a stale client cannot mistake a filtered leaderboard for
  // a chain with no supply.
  const rawDetailChainId = url?.searchParams.get("chain") ?? null;
  const detailChainId = rawDetailChainId === "" ? null : rawDetailChainId;
  if (detailChainId != null && !(detailChainId in CHAIN_META)) {
    return errorResponse(400, "Unknown chain");
  }

  // Derive peg rates for non-USD peg stability calculation
  const { rates: pegRates } = derivePegRates(activePeggedAssets, TRACKED_META_BY_ID, fxFallbackRates);

  const activeSource = await loadActiveSafetyScoreSource(db);
  const safetyScores: Record<string, number> = {};
  const reportCards = buildV9ExpectedDependencyMeta(activeSource, Math.floor(Date.now() / 1000));
  const safetyScoreIdentity =
    activeSource.kind === "error" ? null : activeSource.snapshot.safetyScoreIdentity;
  if (activeSource.kind !== "error" && reportCards.status === "fresh") {
    for (const card of activeSource.snapshot.cards) {
      if (card.score !== null) safetyScores[card.id] = card.score;
    }
  }

  const response = aggregateChains({
    peggedAssets: activePeggedAssets,
    safetyScores,
    pegRates,
    ...(detailChainId != null ? { detailChainId } : {}),
  });

  const freshness = buildChainsFreshnessMeta(stablecoinsResult.updatedAt, reportCards, safetyScoreIdentity);

  return jsonResponseWithHeaders(
    {
      ...response,
      updatedAt: stablecoinsResult.updatedAt,
      safetyScoreIdentity,
      _meta: freshness.meta,
    },
    freshness.headers,
  );
};

import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import {
  loadReportCardCache,
  REPORT_CARD_CACHE_MAX_AGE_MS,
  type ReportCardCacheInputStatus,
  type ReportCardCacheLoadResult,
} from "../lib/report-card-cache";
import { aggregateChains } from "@shared/lib/chain-aggregator";
import { derivePegRates } from "@shared/lib/peg-rates";
import { ACTIVE_IDS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import type { FreshnessStatus } from "@shared/lib/status-thresholds";
import { errorResponse, jsonResponse, withErrorHandler } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import type { SafetyScoreV8PublicationIdentity } from "@shared/types/safety-score-publication";
import { isCurrentSafetyScoreV8Identity } from "../lib/safety-score-current-identity";

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
  safetyScoreIdentity: SafetyScoreV8PublicationIdentity | null;
}

function getDependencyAgeSeconds(updatedAt: number | null | undefined, nowSec: number): number | null {
  if (updatedAt == null) return null;
  return Math.max(0, nowSec - updatedAt);
}

function reportCardInputsAreStale(inputStatus: ReportCardCacheInputStatus | undefined): boolean {
  return inputStatus?.inputsStale === true;
}

function buildReportCardDependencyMeta(
  reportCardResult: ReportCardCacheLoadResult,
  nowSec: number,
): ChainsDependencyMeta {
  if (reportCardResult.kind === "ok") {
    if (reportCardInputsAreStale(reportCardResult.payload.degradedInputs)) {
      return {
        updatedAt: reportCardResult.updatedAt,
        ageSeconds: getDependencyAgeSeconds(reportCardResult.updatedAt, nowSec),
        status: "degraded",
        reason: "inputs stale",
        inputsStale: true,
        staleInputs: reportCardResult.payload.degradedInputs?.staleInputs ?? [],
      };
    }

    return {
      updatedAt: reportCardResult.updatedAt,
      ageSeconds: getDependencyAgeSeconds(reportCardResult.updatedAt, nowSec),
      status: "fresh",
    };
  }

  const ageSeconds = getDependencyAgeSeconds(reportCardResult.updatedAt, nowSec);
  const status: ChainsDependencyStatus = reportCardResult.reason === "stale-cache"
    ? "stale"
    : "unavailable";

  return {
    updatedAt: reportCardResult.updatedAt,
    ageSeconds,
    status,
    reason: reportCardResult.reason.replace(/-/g, " "),
  };
}

export function isActiveChainAggregateAsset(asset: { id: string; frozen?: boolean; isDefunct?: boolean; defunct?: boolean }): boolean {
  return ACTIVE_IDS.has(asset.id)
    && asset.frozen !== true
    && asset.isDefunct !== true
    && asset.defunct !== true;
}

function buildChainsFreshnessMeta(
  updatedAt: number,
  reportCardResult: ReportCardCacheLoadResult,
): { headers: Record<string, string>; meta: ChainsFreshnessMeta } {
  const nowSec = Math.floor(Date.now() / 1000);
  const ageSeconds = Math.max(0, nowSec - updatedAt);
  const reportCards = buildReportCardDependencyMeta(reportCardResult, nowSec);
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
    const reportCardReason = reportCards.reason ?? reportCards.status;
    warnings.push(`report-card cache ${reportCardReason}${reportCardAgeSuffix}`);
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
      safetyScoreIdentity: reportCardResult.kind === "ok"
        ? reportCardResult.payload.safetyScoreIdentity ?? null
        : null,
      ...(warning ? { warning } : {}),
    },
  };
}

export const handleChains = withErrorHandler("chains", async (db: D1Database): Promise<Response> => {
  const stablecoinsResult = await loadStablecoinsCache(db, {
    mode: "strict",
    contract: "published",
    allowLegacyArray: false,
  });
  if (stablecoinsResult.kind !== "ok") {
    return errorResponse(503, "Data not yet available");
  }

  const { peggedAssets, fxFallbackRates } = stablecoinsResult.payload;
  const activePeggedAssets = peggedAssets.filter(isActiveChainAggregateAsset);

  // Derive peg rates for non-USD peg stability calculation
  const { rates: pegRates } = derivePegRates(activePeggedAssets, TRACKED_META_BY_ID, fxFallbackRates);

  // Load safety scores from report card cache (one D1 read)
  const safetyScores: Record<string, number> = {};
  const loadedReportCardResult = await loadReportCardCache(db, {
    maxAgeMs: REPORT_CARD_CACHE_MAX_AGE_MS,
    requireCompleteness: true,
  });
  const reportCardResult: ReportCardCacheLoadResult = loadedReportCardResult.kind === "ok"
    && !isCurrentSafetyScoreV8Identity(loadedReportCardResult.payload.safetyScoreIdentity)
    ? { kind: "error", reason: "identity-mismatch", updatedAt: loadedReportCardResult.updatedAt }
    : loadedReportCardResult;
  if (reportCardResult.kind === "ok") {
    for (const [id, entry] of Object.entries(reportCardResult.payload.scores)) {
      safetyScores[id] = entry.score;
    }
  }

  const response = aggregateChains({
    peggedAssets: activePeggedAssets,
    safetyScores,
    pegRates,
  });

  const freshness = buildChainsFreshnessMeta(stablecoinsResult.updatedAt, reportCardResult);

  return jsonResponse(
    {
      ...response,
      updatedAt: stablecoinsResult.updatedAt,
      safetyScoreIdentity: reportCardResult.kind === "ok"
        ? reportCardResult.payload.safetyScoreIdentity
        : null,
      _meta: freshness.meta,
    },
    freshness.headers,
  );
});

import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import { loadReportCardCache, REPORT_CARD_CACHE_MAX_AGE_MS, type ReportCardCacheLoadResult } from "../lib/report-card-cache";
import { aggregateChains } from "@shared/lib/chain-aggregator";
import { derivePegRates } from "@shared/lib/peg-rates";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { errorResponse, jsonResponse, withErrorHandler } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";

const CHAINS_FRESHNESS_MAX_AGE_SEC = 600;
const CHAINS_STALE_THRESHOLD_SEC = CHAINS_FRESHNESS_MAX_AGE_SEC * 2;

type ChainsFreshnessStatus = "fresh" | "degraded" | "stale";
type ChainsDependencyStatus = "fresh" | "degraded" | "stale" | "unavailable";

interface ChainsDependencyMeta {
  updatedAt?: number | null;
  ageSeconds?: number | null;
  status: ChainsDependencyStatus;
  reason?: string | null;
}

interface ChainsFreshnessMeta {
  updatedAt: number;
  ageSeconds: number;
  status: ChainsFreshnessStatus;
  warning?: string | null;
  dependencies?: {
    reportCards: ChainsDependencyMeta;
  };
}

function getDependencyAgeSeconds(updatedAt: number | null | undefined, nowSec: number): number | null {
  if (updatedAt == null) return null;
  return Math.max(0, nowSec - updatedAt);
}

function buildReportCardDependencyMeta(
  reportCardResult: ReportCardCacheLoadResult,
  nowSec: number,
): ChainsDependencyMeta {
  if (reportCardResult.kind === "ok") {
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

function buildChainsFreshnessMeta(
  updatedAt: number,
  reportCardResult: ReportCardCacheLoadResult,
): { headers: Record<string, string>; meta: ChainsFreshnessMeta } {
  const nowSec = Math.floor(Date.now() / 1000);
  const ageSeconds = Math.max(0, nowSec - updatedAt);
  const reportCards = buildReportCardDependencyMeta(reportCardResult, nowSec);
  let status: ChainsFreshnessStatus;

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
      "Cache-Control": status === "fresh" ? CACHE_PROFILES.realtime : "no-store",
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
      ...(warning ? { warning } : {}),
    },
  };
}

export const handleChains = withErrorHandler("chains", async (db: D1Database): Promise<Response> => {
  const stablecoinsResult = await loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: false });
  if (stablecoinsResult.kind !== "ok") {
    return errorResponse(503, "Data not yet available");
  }

  const { peggedAssets, fxFallbackRates } = stablecoinsResult.payload;

  // Derive peg rates for non-USD peg stability calculation
  const { rates: pegRates } = derivePegRates(peggedAssets, TRACKED_META_BY_ID, fxFallbackRates);

  // Load safety scores from report card cache (one D1 read)
  const safetyScores: Record<string, number> = {};
  const reportCardResult = await loadReportCardCache(db, { maxAgeMs: REPORT_CARD_CACHE_MAX_AGE_MS });
  if (reportCardResult.kind === "ok") {
    for (const [id, entry] of Object.entries(reportCardResult.payload.scores)) {
      safetyScores[id] = entry.score;
    }
  }

  const response = aggregateChains({
    peggedAssets,
    safetyScores,
    pegRates,
  });

  const freshness = buildChainsFreshnessMeta(stablecoinsResult.updatedAt, reportCardResult);

  return jsonResponse(
    {
      ...response,
      updatedAt: stablecoinsResult.updatedAt,
      _meta: freshness.meta,
    },
    freshness.headers,
  );
});

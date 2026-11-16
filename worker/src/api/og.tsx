import { PSI_CONDITION_BAND_VALUES } from "@shared/types/stability-constants";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { logWorkerEvent, logWorkerEventArgs } from "../lib/structured-log";
import * as React from "react";
import { renderPng } from "../lib/og-render";
import { handleScorecardOg } from "./og-scorecard";
import { StablecoinCard, type StablecoinCardData } from "../lib/og-templates/stablecoin-card";
import { SafetyScoresCard, type SafetyScoresCardData } from "../lib/og-templates/safety-scores-card";
import { DepegCard, type DepegCardData } from "../lib/og-templates/depeg-card";
import { StabilityIndexCard, type StabilityIndexCardData } from "../lib/og-templates/stability-index-card";
import { CardFrame } from "../lib/og-templates/shared";
import { ChainCard, ChainUnavailableCard, type ChainCardData } from "../lib/og-templates/chain-card";
import { RouteCard } from "../lib/og-templates/route-card";
import { formatOgStampTime, isOgPageSlug, type OgPageSlug, type OgPageUnavailableReason } from "@shared/lib/og-route-cards";
import { OG_PAGE_LOADERS, type OgPageLoad } from "./og-page";
import { isActiveChainAggregateAsset } from "./chains";
import { aggregateChains } from "@shared/lib/chains/aggregator";
import { ratioToPercentage } from "@shared/lib/stats";
import { CHAIN_META } from "@shared/types/chain-identity";
import { resolveOrReject } from "../lib/api-params";
import { getCirculatingRawOrNull, getPrevWeekRawOrNull } from "@shared/lib/supply";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { ACTIVE_IDS, FROZEN_IDS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { hasUsableStablecoinsPayload, loadStablecoinsCache } from "../lib/stablecoins-cache";
import { API_CACHE_PROFILES, buildOgImageCacheControl } from "@shared/lib/api-cache-profiles";
import { API_FRESHNESS_MAX_AGE_SEC, STRESS_SIGNALS_DEGRADED_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { loadStressSignalCurrentRowForCoin } from "../lib/stress-signals-current-rows";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { summarizeMintBurnValuation } from "@shared/lib/mint-burn-valuation";
import { summarizeMintBurnClassification } from "@shared/lib/mint-burn-classification";
import { hasMintBurnClassificationReview } from "../lib/mint-burn-classification";
import type { MintBurnValuationCompleteness } from "@shared/types/mint-burn";
import {
  MINT_BURN_HOURLY_CLASSIFICATION_TALLY_SQL,
  MINT_BURN_HOURLY_VALUATION_TALLY_SQL,
  type MintBurnClassificationTallyRow,
  type MintBurnValuationTallyRow,
  readMintBurnClassificationTallyRow,
  readMintBurnValuationTallyRow,
} from "../lib/mint-burn-hourly-valuation";
import { MINT_BURN_CONFIGS } from "../lib/mint-burn-contracts";
import { readMintBurnWindowContext } from "../lib/mint-burn-flows-service";
import { decodeMintBurnScanCoverage, mintBurnScanCoverageAdmits, prepareMintBurnScanCoverage, type MintBurnScanSegment } from "../lib/mint-burn-pipeline/scan-coverage";
import { getVariantDisplay } from "@shared/lib/variant-display";
import { loadActiveSafetyScoreIndex, type SafetyScoreGradeSnapshot } from "../lib/safety-score-index";
import { isSafetyScoreV9SnapshotFresh, SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "../lib/safety-score-v9/consumer-freshness";
import { assessFreshnessTimestamp } from "../lib/api-freshness-age";
import { addFreshnessHeaders } from "../lib/api-freshness";
import { classifyDepegClosure } from "@shared/lib/depeg-closure";
import { isDisputedAuditVerdict } from "@shared/lib/depeg-audit";
import { notDisputedAuditVerdictSql } from "../lib/depeg-audit";
import { deriveCurrentPegObservationMap, type CurrentPegObservation } from "../lib/current-peg-observations";
import { deriveDepegSignal } from "@shared/lib/depeg-signals";
import { isReferenceDeviationHeld } from "@shared/lib/reference-market-hours";
import {
  getNativeEventPriceObservation, isNativePegEvent,
  type NativeEventPriceEvidence,
  PSI_NATIVE_EVIDENCE_MAX_AGE_SEC,
} from "@shared/lib/depeg-quote-domain";
import { decodeNativeEventQuote, NATIVE_EVENT_QUOTE_CACHE_PREFIX } from "../lib/native-peg-quote-cache";


function ogSourceAsOf(source: string, timestamp: number | null | undefined, now: number): string {
  const age = assessFreshnessTimestamp(now, timestamp);
  if (age.reason != null) return `${source} unavailable (${age.reason})`;
  const label = new Date(timestamp! * 1000).toISOString().slice(0, 16).replace("T", " ");
  return `${source} ${label} UTC`;
}


const CACHE_HEADERS = {
  "Content-Type": "image/png",
  "Cache-Control": API_CACHE_PROFILES.ogImage,
};

function ogErrorResponse(msg: string, status: number, extra?: Record<string, string>): Response {
  return new Response(msg, {
    status,
    headers: { "Content-Type": "text/plain", ...extra },
  });
}

function ogDataNotYetAvailable(): Response {
  return ogErrorResponse("Data not yet available", 503, {
    "Retry-After": "60",
    "Cache-Control": "no-store",
  });
}

/** Use the owning source's budget; future clocks cannot certify present evidence. */
function ogObservationFreshUntil(timestamp: number | null | undefined, budgetSec: number, nowSec: number): number | null {
  const age = assessFreshnessTimestamp(nowSec, timestamp, 0);
  return age.reason == null && age.ageSeconds <= budgetSec ? timestamp! + budgetSec : null;
}

function observedOgResponse(png: Uint8Array, freshUntilSec: number, headers: Record<string, string> = CACHE_HEADERS): Response {
  const secondsLeft = freshUntilSec - Date.now() / 1000;
  if (secondsLeft <= 0) return ogDataNotYetAvailable();
  return new Response(png, { headers: { ...headers, "Cache-Control": buildOgImageCacheControl(secondsLeft) } });
}

type OgSafetyScoreEntry = SafetyScoreGradeSnapshot["cards"][number];

type OgSafetyScoreSource =
  | {
      kind: "ok";
      model: "v9";
      methodologyVersion: string;
      asOfSec: number;
      publishedAtSec: number;
      publicationGenerationId: string;
      assessedAtSec: number;
      expectedCount: number;
      publicationFingerprint: string;
      scores: Record<string, OgSafetyScoreEntry>;
    }
  | {
      kind: "error";
      reason: string;
      publishedAtSec?: number;
      publicationGenerationId?: string;
      assessedAtSec: number;
    };

async function loadOgSafetyScoreSource(db: D1Database): Promise<OgSafetyScoreSource> {
  const assessedAtSec = Math.floor(Date.now() / 1000);
  const active = await loadActiveSafetyScoreIndex(db);
  if (active.kind === "error") {
    return {
      kind: "error",
      reason: active.reason,
      assessedAtSec,
    };
  }

  if (active.kind === "held" || !isSafetyScoreV9SnapshotFresh(active.snapshot, assessedAtSec)
    || ogObservationFreshUntil(active.snapshot.asOfSec, SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC, assessedAtSec) == null) {
    return {
      kind: "error",
      reason: active.kind === "held" ? active.reason : "stale-cache",
      publishedAtSec: active.snapshot.updatedAt,
      publicationGenerationId: active.snapshot.safetyScoreIdentity.publicationGenerationId,
      assessedAtSec,
    };
  }
  return {
    kind: "ok",
    model: "v9",
    methodologyVersion: active.snapshot.safetyScoreIdentity.methodologyVersion,
    asOfSec: active.snapshot.asOfSec,
    publishedAtSec: active.snapshot.updatedAt,
    publicationGenerationId: active.snapshot.safetyScoreIdentity.publicationGenerationId,
    assessedAtSec,
    expectedCount: active.snapshot.completeness.expectedCount,
    publicationFingerprint: stableJsonStringifyV1({
      identity: active.snapshot.safetyScoreIdentity,
      asOfSec: active.snapshot.asOfSec,
      publishedAtSec: active.snapshot.updatedAt,
      completeness: active.snapshot.completeness,
      cards: active.snapshot.cards,
    }),
    scores: Object.fromEntries(active.snapshot.cards.map((card) => [card.id, card])),
  };
}

function safetyScoreOgPresentation(
  safetySource: OgSafetyScoreSource,
): { lastUpdated: string; headers: Record<string, string> } {
  const freshnessHeaders = {
    "X-Safety-Score-Freshness-Budget": String(SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC),
    "X-Safety-Score-Assessed-At": String(safetySource.assessedAtSec),
    "X-Safety-Score-Updated-At": safetySource.publishedAtSec == null ? "unknown" : String(safetySource.publishedAtSec),
    "X-Safety-Score-Generation": safetySource.publicationGenerationId ?? "unknown",
  };
  if (safetySource.kind === "ok") {
    return {
      lastUpdated: `Methodology v${safetySource.methodologyVersion} \u00b7 ${ogSourceAsOf("Observed", safetySource.asOfSec, safetySource.assessedAtSec)} \u00b7 ${ogSourceAsOf("Published", safetySource.publishedAtSec, safetySource.assessedAtSec)}`,
      headers: addFreshnessHeaders({
        ...CACHE_HEADERS,
        ...freshnessHeaders,
        "X-Safety-Score-Model": safetySource.model,
        "X-Safety-Score-Methodology": safetySource.methodologyVersion,
        "X-Safety-Score-Status": "current",
      }, safetySource.publishedAtSec, SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC, {
        assessedAt: safetySource.assessedAtSec, freshBudgetSec: SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC,
      }),
    };
  }

  return {
    lastUpdated: "Safety publication unavailable",
    headers: {
      // Keep degraded OG renders edge-cacheable: /api/og/* is public and
      // unauthenticated, and rendering each miss runs the WASM PNG pipeline.
      // The explicit degraded headers keep consumers from treating the image as
      // current safety-score evidence while avoiding no-store render amplification.
      ...CACHE_HEADERS,
      ...freshnessHeaders,
      "X-Safety-Score-Model": "v9",
      "X-Safety-Score-Status": "degraded",
      "X-Safety-Score-Reason": safetySource.reason,
    },
  };
}

/** Re-admit the exact accepted publication and health after the renderer yields. */
async function safetyScoreOgResponse(
  db: D1Database,
  png: Uint8Array,
  source: OgSafetyScoreSource,
  freshUntilSec = Infinity,
  headers: Record<string, string> = {},
): Promise<Response> {
  if (source.kind === "ok") {
    const current = await loadOgSafetyScoreSource(db);
    if (current.kind !== "ok" || current.publicationFingerprint !== source.publicationFingerprint) {
      return ogDataNotYetAvailable();
    }
    freshUntilSec = Math.min(freshUntilSec, Math.min(source.asOfSec, source.publishedAtSec) + SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC);
  }
  const assessedAtSec = Math.floor(Date.now() / 1000);
  return observedOgResponse(png, freshUntilSec, {
    ...safetyScoreOgPresentation({ ...source, assessedAtSec }).headers,
    ...headers,
  });
}


interface StablecoinOgCoinInput {
  name: string;
  symbol: string;
  price?: number | null;
  priceSource?: string | null;
  priceObservedAtMode?: string | null;
  circulating: Record<string, number>;
  circulatingPrevWeek?: Record<string, number> | null;
}

/** Seven-day stored mint/burn window: known-valuation subtotals with their completeness. */
interface OgMintBurnFlow7d {
  knownNetUsd: number;
  knownGrossUsd: number;
  completeness: MintBurnValuationCompleteness;
}

interface StablecoinOgSignalsInput {
  coin: StablecoinOgCoinInput;
  dewsBand: string | null | undefined;
  grade: string | null | undefined;
  sparklineRows: Array<{ price: number }>;
  hasActiveDepeg: boolean;
  /** `null` when no hourly bucket exists in the window. */
  mintBurn7d: OgMintBurnFlow7d | null;
  variantLabel?: string | null;
  variantParentSymbol?: string | null;
  isFrozen?: boolean;
}

export function deriveStablecoinOgCardData({
  coin,
  dewsBand,
  grade,
  sparklineRows,
  hasActiveDepeg,
  mintBurn7d,
  variantLabel,
  variantParentSymbol,
  isFrozen,
}: StablecoinOgSignalsInput): StablecoinCardData {
  const pegPrice = typeof coin.price === "number" && Number.isFinite(coin.price) && coin.price > 0 ? coin.price : null;
  const mcap = getCirculatingRawOrNull(coin);
  const prevWeekMcap = getPrevWeekRawOrNull(coin);
  // New snapshot rows never carry a nominal par price, but rows written before
  // mint-burn-flow v6.23 can: a coin currently published as a nominal reference
  // draws no price line from them.
  const sparklineData = isObservedPrice(coin) ? sparklineRows.map((row) => row.price).reverse() : [];
  const supplyDelta = mcap != null && prevWeekMcap != null ? mcap - prevWeekMcap : null;
  // A partial window shows only its known gross subtotal as a lower bound; a
  // signed partial net is not a bound. Legacy (unknown) buckets keep their net,
  // labelled as unverified.
  let flow7d: number | null = supplyDelta;
  let flow7dSource: StablecoinCardData["flow7dSource"] = supplyDelta != null ? "supply-delta" : null;
  if (mintBurn7d?.completeness === "partial") {
    flow7d = mintBurn7d.knownGrossUsd;
    flow7dSource = "mint-burn-partial-gross";
  } else if (mintBurn7d) {
    flow7d = mintBurn7d.knownNetUsd;
    flow7dSource = mintBurn7d.completeness === "complete" ? "mint-burn" : "mint-burn-coverage-unknown";
  }

  return {
    name: coin.name,
    symbol: coin.symbol,
    grade: grade ?? "Unavailable",
    pegPrice,
    pegPriceIsNominal: pegPrice != null && coin.priceObservedAtMode === "nominal_reference",
    dewsBand: dewsBand ?? null,
    flow7d,
    flow7dSource,
    sparklineData: sparklineData.length >= 2 ? sparklineData : null,
    hasActiveDepeg,
    variantLabel: variantLabel ?? null,
    variantParentSymbol: variantParentSymbol ?? null,
    isFrozen: isFrozen ?? false,
  };
}

// ---------------------------------------------------------------------------
// /api/og/stablecoin/:id
// ---------------------------------------------------------------------------

async function readOgMintBurnFlow(db: D1Database, id: string, now: number): Promise<OgMintBurnFlow7d | null> {
  if (!ACTIVE_IDS.has(id) || !MINT_BURN_CONFIGS.some((config) => config.stablecoinId === id)) return null;
  try {
    const flowScope = await readMintBurnWindowContext(db, now,
      MINT_BURN_CONFIGS.filter((config) => ACTIVE_IDS.has(config.stablecoinId)));
    // Partial scope or unresolved classification has no publishable signed net.
    if (flowScope.partialCoinIds.has(id)) return null;
    const flowConfigs = flowScope.configs.filter((config) => config.stablecoinId === id);
    const flowEnd = Math.floor(now / 3600) * 3600;
    const flowStart = flowEnd - 7 * DAY_SECONDS;
    const flowSnapshot = await db.batch([
      db.prepare(
        `SELECT COUNT(*) AS bucket_count,
                SUM(net_flow_usd) AS net_flow,
                SUM(mint_volume_usd + burn_volume_usd) AS gross_flow,
                ${MINT_BURN_HOURLY_VALUATION_TALLY_SQL},
                ${MINT_BURN_HOURLY_CLASSIFICATION_TALLY_SQL}
         FROM mint_burn_hourly
         WHERE stablecoin_id = ? AND hour_ts >= ? AND hour_ts < ?
           AND chain_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(id, flowStart, flowEnd, JSON.stringify([...new Set(flowConfigs.map((config) => config.chain.chainId))])),
      prepareMintBurnScanCoverage(db, flowConfigs, flowStart, flowEnd),
    ]);
    const flowRow = flowSnapshot[0].results[0] as
      ({ bucket_count: number; net_flow: number | null; gross_flow: number | null } & MintBurnValuationTallyRow & MintBurnClassificationTallyRow) | undefined;
    const flowComplete = mintBurnScanCoverageAdmits(flowConfigs,
      decodeMintBurnScanCoverage(flowSnapshot[1] as D1Result<MintBurnScanSegment>), flowStart, flowEnd);
    return flowComplete && flowRow && flowRow.bucket_count > 0
      && summarizeMintBurnClassification(readMintBurnClassificationTallyRow(flowRow, hasMintBurnClassificationReview(id))).completeness === "complete"
      ? {
          knownNetUsd: flowRow.net_flow ?? 0,
          knownGrossUsd: flowRow.gross_flow ?? 0,
          completeness: summarizeMintBurnValuation(readMintBurnValuationTallyRow(flowRow)).completeness,
        }
      : null;
  } catch (error) {
    logWorkerEventArgs("api", "warn", "[og] mint-burn-scope-unavailable", id, error);
    return null;
  }
}

async function handleStablecoinOg(db: D1Database, coinId: string): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const resolved = resolveOrReject(coinId);
  if (resolved instanceof Response) {
    return ogErrorResponse("Unknown stablecoin", 404);
  }
  const id = resolved.canonicalId;

  const isFrozen = FROZEN_IDS.has(id);

  const [stablecoinsPayload, dewsRow, safetySource, sparklineRows, activeDepegRow, mintBurn7d] = await Promise.all([
    loadStablecoinsCache(db, { mode: "strict", contract: "published" }),
    loadStressSignalCurrentRowForCoin(db, id, now, { staleAfterSec: STRESS_SIGNALS_DEGRADED_MAX_AGE_SEC }),
    loadOgSafetyScoreSource(db),
    db.prepare("SELECT price FROM supply_history WHERE stablecoin_id = ? AND price IS NOT NULL ORDER BY snapshot_date DESC LIMIT 7")
      .bind(id).all<{ price: number }>(),
    db.prepare("SELECT id FROM depeg_events WHERE stablecoin_id = ? AND ended_at IS NULL LIMIT 1")
      .bind(id).first<{ id: number }>(),
    readOgMintBurnFlow(db, id, now),
  ]);

  if (!hasUsableStablecoinsPayload(stablecoinsPayload)) {
    return ogDataNotYetAvailable();
  }
  const marketFreshUntil = ogObservationFreshUntil(stablecoinsPayload.updatedAt, API_FRESHNESS_MAX_AGE_SEC.stablecoins, now);
  if (marketFreshUntil == null) return ogDataNotYetAvailable();

  const { peggedAssets } = stablecoinsPayload.payload;
  const coin = peggedAssets.find((a) => a.id === id);
  if (!coin) {
    return ogErrorResponse("Stablecoin not found in cache", 404);
  }

  const meta = TRACKED_META_BY_ID.get(id);
  const reportCardRow = safetySource.kind === "ok"
    ? safetySource.scores[id] ?? null
    : null;

  const quoteFreshUntil = ogObservationFreshUntil(coin.priceObservedAt ?? coin.priceUpdatedAt, API_FRESHNESS_MAX_AGE_SEC.stablecoins, now);
  const dewsFreshUntil = dewsRow && ogObservationFreshUntil(dewsRow.computed_at, STRESS_SIGNALS_DEGRADED_MAX_AGE_SEC, now);
  const variantLabel = meta?.variantKind ? getVariantDisplay(meta.variantKind).shortLabel : null;
  const variantParentSymbol = meta?.variantOf
    ? (TRACKED_META_BY_ID.get(meta.variantOf)?.symbol ?? meta.variantOf)
    : null;

  const safetyPresentation = safetyScoreOgPresentation(safetySource);
  const data = {
    ...deriveStablecoinOgCardData({
      coin: quoteFreshUntil == null ? { ...coin, price: null } : coin,
      dewsBand: dewsFreshUntil == null ? null : dewsRow?.band,
      grade: reportCardRow ? reportCardRow.grade ?? "Pipeline gap" : "Unavailable",
      sparklineRows: sparklineRows.results ?? [],
      hasActiveDepeg: activeDepegRow !== null,
      mintBurn7d,
      variantLabel,
      variantParentSymbol,
      isFrozen,
    }),
    safetyMethodologyVersion: safetySource.kind === "ok" ? safetySource.methodologyVersion : null,
    lastUpdated: [
      ogSourceAsOf("Market", stablecoinsPayload.updatedAt, now),
      quoteFreshUntil == null ? "Quote unavailable" : ogSourceAsOf("Quote", coin.priceObservedAt ?? coin.priceUpdatedAt, now),
      safetyPresentation.lastUpdated,
      ...(reportCardRow?.partialEvidence && reportCardRow.grade !== null ? ["Partial evidence: pipeline gap"] : []),
    ].join(" \u00b7 "),
  };

  const png = await renderPng(<StablecoinCard data={data} />);
  let freshUntil = marketFreshUntil;
  if (data.pegPrice != null && quoteFreshUntil != null) freshUntil = Math.min(freshUntil, quoteFreshUntil);
  if (!data.hasActiveDepeg && (data.dewsBand === "DANGER" || data.dewsBand === "ALERT" || data.dewsBand === "WARNING") && dewsFreshUntil != null) {
    freshUntil = Math.min(freshUntil, dewsFreshUntil);
  }
  return safetyScoreOgResponse(db, png, safetySource, freshUntil, {
    "X-Market-Updated-At": String(stablecoinsPayload.updatedAt),
    "X-Market-Freshness-Budget": String(API_FRESHNESS_MAX_AGE_SEC.stablecoins),
  });
}

// ---------------------------------------------------------------------------
// /api/og/safety-scores
// ---------------------------------------------------------------------------

async function handleSafetyScoresOg(db: D1Database): Promise<Response> {
  const safetySource = await loadOgSafetyScoreSource(db);

  const gradeDistribution: Record<string, number> = {
    "A+": 0, A: 0, "A-": 0,
    "B+": 0, B: 0, "B-": 0,
    "C+": 0, C: 0, "C-": 0,
    D: 0, F: 0, NR: 0,
  };

  let pulseScore = 0;
  let ratedCount = 0;
  let unavailableCount = 0;
  const totalCoins = safetySource.kind === "ok" ? safetySource.expectedCount : ACTIVE_IDS.size;

  if (safetySource.kind === "ok") {
    for (const entry of Object.values(safetySource.scores)) {
      if (entry.ratingStatus === "pipeline-gap" || entry.grade === null) {
        unavailableCount++;
      } else if (entry.ratingStatus === "not-rated") {
        gradeDistribution.NR++;
      } else if (entry.grade in gradeDistribution && entry.score !== null) {
        gradeDistribution[entry.grade]++;
        pulseScore += entry.score;
        ratedCount++;
      } else {
        unavailableCount++;
      }
    }
  }

  const avgScore = ratedCount > 0 ? pulseScore / ratedCount : null;

  const safetyPresentation = safetyScoreOgPresentation(safetySource);
  const data: SafetyScoresCardData = {
    gradeDistribution,
    // An average score is not an asset-level grade under either methodology.
    pulseScore: avgScore,
    coverageRatio: safetySource.kind === "ok" && totalCoins > 0 ? ratedCount / totalCoins : null,
    totalCoins,
    unavailableCount: safetySource.kind === "ok" ? unavailableCount : null,
    lastUpdated: safetyPresentation.lastUpdated,
  };

  const png = await renderPng(<SafetyScoresCard data={data} />);
  return safetyScoreOgResponse(db, png, safetySource);
}

// ---------------------------------------------------------------------------
// /api/og/depeg
// ---------------------------------------------------------------------------

async function handleDepegOg(db: D1Database): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const oneDayAgo = now - DAY_SECONDS;
  const [stablecoins, openEvents, closedEvents, newTodayResult] = await Promise.all([
    loadStablecoinsCache(db, { mode: "strict", contract: "published" }),
    db.prepare(`SELECT e.stablecoin_id, e.symbol, e.direction, e.peak_deviation_bps, e.peg_reference,
                       e.peg_type, e.source, e.started_at, e.start_price, p.quote_mode, p.audit_verdict,
                       nq.value AS current_native_quote
                FROM depeg_events e LEFT JOIN depeg_event_provenance p ON p.event_id = e.id
                LEFT JOIN cache nq ON nq.key = '${NATIVE_EVENT_QUOTE_CACHE_PREFIX}' || e.id
                WHERE e.ended_at IS NULL`)
      .all<NativeEventPriceEvidence & {
        stablecoin_id: string; symbol: string; direction: "above" | "below";
        peak_deviation_bps: number; current_native_quote: string | null;
        audit_verdict: string | null;
      }>(),
    db.prepare(`SELECT e.ended_at, e.close_reason, e.recovery_price, p.audit_verdict
                FROM depeg_events e LEFT JOIN depeg_event_provenance p ON p.event_id = e.id
                WHERE e.ended_at IS NOT NULL AND e.ended_at > ?`)
      .bind(oneDayAgo).all<{
        ended_at: number; close_reason: string | null; recovery_price: number | null; audit_verdict: string | null;
      }>(),
    (() => {
      const newTodayAudit = notDisputedAuditVerdictSql("p.audit_verdict");
      return db.prepare(`SELECT COUNT(*) as count
                FROM depeg_events e LEFT JOIN depeg_event_provenance p ON p.event_id = e.id
                WHERE e.started_at > ? AND ${newTodayAudit.sql}`)
        .bind(oneDayAgo, ...newTodayAudit.binds).first<{ count: number }>();
    })(),
  ]);
  const marketFreshUntil = stablecoins.kind === "ok"
    ? ogObservationFreshUntil(stablecoins.updatedAt, API_FRESHNESS_MAX_AGE_SEC.stablecoins, now) : null;
  const assets = stablecoins.kind === "ok" ? stablecoins.payload.peggedAssets : [];
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const observations = marketFreshUntil != null && stablecoins.kind === "ok"
    ? deriveCurrentPegObservationMap({
        peggedAssets: assets, fxFallbackRates: stablecoins.payload.fxFallbackRates, asOf: stablecoins.updatedAt,
      })
    : new Map<string, CurrentPegObservation>();
  let freshUntil = Infinity;
  const eligibleEvents = (openEvents.results ?? []).filter((row) =>
    ACTIVE_IDS.has(row.stablecoin_id) && !FROZEN_IDS.has(row.stablecoin_id) && !isDisputedAuditVerdict(row.audit_verdict));
  const openEventById = new Map<string, (typeof eligibleEvents)[number]>();
  for (const row of eligibleEvents) {
    const existing = openEventById.get(row.stablecoin_id);
    if (!existing || Math.abs(row.peak_deviation_bps) > Math.abs(existing.peak_deviation_bps)) {
      openEventById.set(row.stablecoin_id, row);
    }
  }
  const nativeQuoteTimes: number[] = [];
  let hasNativeEvent = false;
  const activeDepegs = [...openEventById.values()].map((row) => {
    const asset = assetById.get(row.stablecoin_id);
    const quoteFreshUntil = ogObservationFreshUntil(asset?.priceObservedAt ?? asset?.priceUpdatedAt, API_FRESHNESS_MAX_AGE_SEC.stablecoins, now);
    const nativeEvent = isNativePegEvent(row);
    hasNativeEvent ||= nativeEvent;
    const nativeObservation = nativeEvent
      ? getNativeEventPriceObservation(row, now, decodeNativeEventQuote(row.current_native_quote))
      : null;
    if (nativeObservation) {
      nativeQuoteTimes.push(nativeObservation.observedAt);
      freshUntil = Math.min(freshUntil, nativeObservation.observedAt + PSI_NATIVE_EVIDENCE_MAX_AGE_SEC);
    }
    const usdAvailable = marketFreshUntil != null && asset && isObservedPrice(asset) &&
      typeof asset.price === "number" && Number.isFinite(asset.price) && asset.price > 0 && quoteFreshUntil != null;
    if (!nativeEvent && usdAvailable) freshUntil = Math.min(freshUntil, marketFreshUntil!, quoteFreshUntil!);
    const currentPrice = nativeEvent ? nativeObservation?.value ?? null : usdAvailable ? asset.price! : null;
    // A USD-domain row reads today's authoritative reference, as PSI does, never the one stored at opening.
    const deviation = nativeEvent
      ? currentPrice != null ? deriveDepegSignal(currentPrice, row.peg_reference) : null
      : usdAvailable ? observations.get(row.stablecoin_id)?.currentSignal ?? null : null;
    // A held deviation is unknown while its 24/5 reference market repeats a close.
    const deviationHeld = deviation != null && isReferenceDeviationHeld(
      TRACKED_META_BY_ID.get(row.stablecoin_id)?.flags.pegCurrency,
      (nativeEvent ? nativeObservation?.observedAt : asset?.priceObservedAt ?? asset?.priceUpdatedAt)
        ?? stablecoins.updatedAt ?? now,
      deviation.absRawBps,
    );
    return {
      symbol: row.symbol,
      // A held deviation is an unavailable current reading, never a peg move claim.
      deviationBps: deviationHeld ? null : deviation?.bps ?? null,
      ...(deviationHeld ? { deviationHeld } : {}),
      peakBps: row.direction === "below" ? -Math.abs(row.peak_deviation_bps) : Math.abs(row.peak_deviation_bps),
    };
  }).sort((a, b) => {
    if (a.deviationBps == null) return b.deviationBps == null ? Math.abs(b.peakBps) - Math.abs(a.peakBps) : 1;
    if (b.deviationBps == null) return -1;
    return Math.abs(b.deviationBps) - Math.abs(a.deviationBps);
  }).slice(0, 3);
  const recoveredToday = (closedEvents.results ?? []).filter((row) => {
    if (isDisputedAuditVerdict(row.audit_verdict)) return false;
    const closure = classifyDepegClosure({ endedAt: row.ended_at, closeReason: row.close_reason, recoveryPrice: row.recovery_price });
    return closure === "recovered" || closure === "legacy_recovered";
  }).length;
  const data: DepegCardData = {
    activeDepegCount: openEventById.size,
    activeDepegs,
    recoveredToday,
    newToday: newTodayResult?.count ?? null,
    lastUpdated: [
      ogSourceAsOf("Market", stablecoins.updatedAt, now),
      ...(hasNativeEvent ? [ogSourceAsOf("Native peg", nativeQuoteTimes.length ? Math.min(...nativeQuoteTimes) : null, now)] : []),
    ].join(" · "),
  };
  const png = await renderPng(<DepegCard data={data} />);
  return observedOgResponse(png, freshUntil);
}

// ---------------------------------------------------------------------------
// /api/og/stability-index
// ---------------------------------------------------------------------------

function StabilityIndexNeutralCard() {
  return (
    <CardFrame
      title="Pharos Stability Index"
      subtitle="Market-wide Peg Health"
      borderTopColor="#64748b"
    >
      <div style={{ display: "flex", flex: 1 }} />
    </CardFrame>
  );
}

async function handleStabilityIndexOg(db: D1Database): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = now - 7 * DAY_SECONDS;

  const [
    latestSample, 
    avg7dRow,
    historyRows,
    retainedHighRow,
    retainedLowRow,
  ] = await Promise.all([
    db
      .prepare("SELECT score, band, stored_at FROM stability_index_samples ORDER BY stored_at DESC LIMIT 1")
      .first<{ score: number; band: string; stored_at: number }>(),
    // New: 7-day average
    db
      .prepare("SELECT AVG(score) as avg FROM stability_index_samples WHERE stored_at > ?")
      .bind(sevenDaysAgo)
      .first<{ avg: number | null }>(),
    db
      .prepare("SELECT score FROM stability_index ORDER BY computed_at DESC LIMIT 14")
      .all<{ score: number }>(),
    // Extrema of retained instantaneous samples, not lifetime or daily scores.
    db
      .prepare("SELECT MAX(score) as max FROM stability_index_samples")
      .first<{ max: number | null }>(),
    db
      .prepare("SELECT MIN(score) as min FROM stability_index_samples")
      .first<{ min: number | null }>(),
  ]);

  const latestAge = assessFreshnessTimestamp(now, latestSample?.stored_at);
  const freshnessHeaders = {
    ...CACHE_HEADERS,
    "X-Data-Age": latestAge.ageSeconds == null ? "unavailable" : String(latestAge.ageSeconds),
    "X-Data-Updated-At": latestSample == null || !Number.isFinite(latestSample.stored_at) ? "unknown" : String(latestSample.stored_at),
    "X-Data-Freshness-Budget": String(API_FRESHNESS_MAX_AGE_SEC.stabilityIndex),
    "X-Data-Assessed-At": String(now),
    ...(latestAge.reason != null ? { "X-Data-Freshness": "unknown", "X-Data-Freshness-Reason": latestAge.reason } : {}),
    ...(latestAge.ageSeconds != null && latestAge.ageSeconds > API_FRESHNESS_MAX_AGE_SEC.stabilityIndex
      ? { "X-Data-Freshness": "stale", "X-Data-Freshness-Reason": "psi-source-stale" } : {}),
  };

  if (!latestSample) {
    const png = await renderPng(<StabilityIndexNeutralCard />);
    return new Response(png, { headers: freshnessHeaders });
  }

  const sourceAsOf = ogSourceAsOf("PSI", latestSample.stored_at, now);
  if (latestAge.reason != null || latestAge.ageSeconds > API_FRESHNESS_MAX_AGE_SEC.stabilityIndex) {
    const png = await renderPng(<StabilityIndexNeutralCard />);
    return new Response(png, { headers: freshnessHeaders });
  }
  const psiScore = latestSample.score;
  const psiBand = latestSample.band;
  const baselineAt = latestSample.stored_at - DAY_SECONDS;
  const priorSample = await db
    .prepare("SELECT score, stored_at FROM stability_index_samples WHERE stored_at <= ? AND stored_at >= ? ORDER BY stored_at DESC LIMIT 1")
    .bind(baselineAt, baselineAt - API_FRESHNESS_MAX_AGE_SEC.stabilityIndex)
    .first<{ score: number; stored_at: number }>();
  const delta24h = priorSample != null && Number.isFinite(priorSample.score)
    ? psiScore - priorSample.score : null;
  const avg7d = avg7dRow?.avg ?? null;

  // Build sparkline from daily history (newest first → reverse for chronological)
  const history = (historyRows.results ?? []).map((r) => r.score).filter(Number.isFinite).reverse();
  const sparklineData = history.length >= 2 ? history : null;

  const allBands: Array<{ name: string; active: boolean }> =
    PSI_CONDITION_BAND_VALUES.map((name) => ({ name, active: name === psiBand }));

  const data: StabilityIndexCardData = {
    psiScore,
    psiBand,
    delta24h: delta24h == null ? null : Math.round(delta24h * 100) / 100,
    sparklineData,
    bands: allBands,
    avg7d,
    retainedSampleHigh: retainedHighRow?.max ?? null,
    retainedSampleLow: retainedLowRow?.min ?? null,
    lastUpdated: sourceAsOf,
  };

  const png = await renderPng(<StabilityIndexCard data={data} />);
  const assessedAt = Math.floor(Date.now() / 1000);
  const secondsLeft = latestSample.stored_at + API_FRESHNESS_MAX_AGE_SEC.stabilityIndex - Date.now() / 1000;
  if (secondsLeft < 0) return ogDataNotYetAvailable();
  return new Response(png, {
    headers: addFreshnessHeaders({
      ...freshnessHeaders,
      "Cache-Control": buildOgImageCacheControl(secondsLeft),
      "X-Data-Assessed-At": String(assessedAt),
    }, latestSample.stored_at, API_FRESHNESS_MAX_AGE_SEC.stabilityIndex, {
      assessedAt, freshBudgetSec: API_FRESHNESS_MAX_AGE_SEC.stabilityIndex,
    }),
  });
}

// ---------------------------------------------------------------------------
// /api/og/chain/:id
// ---------------------------------------------------------------------------

async function handleChainOg(db: D1Database, chainId: string): Promise<Response> {
  if (!CHAIN_META[chainId]) {
    return ogErrorResponse("Unknown chain", 404);
  }
  const now = Math.floor(Date.now() / 1000);

  const stablecoinsResult = await loadStablecoinsCache(db, {
    mode: "strict",
    contract: "published",
  });
  if (stablecoinsResult.kind !== "ok") {
    return ogDataNotYetAvailable();
  }
  const marketFreshUntil = ogObservationFreshUntil(stablecoinsResult.updatedAt, API_FRESHNESS_MAX_AGE_SEC.chains, now);
  if (marketFreshUntil == null) return ogDataNotYetAvailable();

  const activePeggedAssets = stablecoinsResult.payload.peggedAssets.filter(isActiveChainAggregateAsset);
  const aggregated = aggregateChains({
    peggedAssets: activePeggedAssets,
    safetyScores: {},
    pegRates: {},
    updatedAt: stablecoinsResult.updatedAt,
  });
  const chain = aggregated.chains.find((entry) => entry.id === chainId);

  // Keep legacy links resolving when a chain has no current supply observation.
  // Absence is not an observed zero, so this card carries no supply figure.
  if (!chain) {
    const png = await renderPng(
      <ChainUnavailableCard
        name={CHAIN_META[chainId].name}
        lastUpdated={ogSourceAsOf("Market", stablecoinsResult.updatedAt, now)}
      />,
    );
    const response = observedOgResponse(png, marketFreshUntil);
    if (response.status === 200) {
      response.headers.set("X-Og-Status", "degraded");
      response.headers.set("X-Og-Reason", "chain-not-in-aggregate");
    }
    return response;
  }
  if (chain.unavailableSupplyObservationCount == null || !aggregated.supplyCoverage) {
    return ogDataNotYetAvailable();
  }
  const data: ChainCardData = {
    name: chain.name,
    totalUsd: chain.totalUsd,
    change7dPercent: chain.change7dPct == null ? null : ratioToPercentage(chain.change7dPct),
    stablecoinCount: chain.stablecoinCount,
    dominanceShare: chain.dominanceShare,
    unavailableSupplyObservationCount: chain.unavailableSupplyObservationCount,
    aggregateUnavailableAssetCount: aggregated.supplyCoverage.aggregateUnavailableAssetCount,
    topStablecoins: (chain.topStablecoins ?? []).slice(0, 3).map((coin) => ({
      symbol: coin.symbol,
      share: coin.share,
    })),
    lastUpdated: ogSourceAsOf("Market", stablecoinsResult.updatedAt, now),
  };

  const png = await renderPng(<ChainCard data={data} />);
  return observedOgResponse(png, marketFreshUntil, addFreshnessHeaders(CACHE_HEADERS, stablecoinsResult.updatedAt,
    API_FRESHNESS_MAX_AGE_SEC.chains, { assessedAt: Math.floor(Date.now() / 1000), freshBudgetSec: API_FRESHNESS_MAX_AGE_SEC.chains }));
}

// ---------------------------------------------------------------------------
// /api/og/page/:slug — live route share cards
// ---------------------------------------------------------------------------

// A timeless card is true at any age, but a short cache lets the live card
// return quickly once its source recovers.
const TIMELESS_CACHE_CONTROL = API_CACHE_PROFILES.custom;

async function renderOgPageTimeless(slug: OgPageSlug, reason: OgPageUnavailableReason, nowSec: number): Promise<Response> {
  // A by-decision timeless route is the expected path, not a degraded card.
  const byDecision = reason === "timeless-by-decision";
  logWorkerEvent({
    scope: "api",
    level: byDecision ? "info" : reason === "render-error" || reason === "owner-error" ? "error" : "warn",
    event: "og.page_timeless",
    route: "/api/og/page",
    message: byDecision ? "Route card is timeless by decision" : "Live route card unavailable; serving the timeless card",
    metadata: { slug, reason },
  });
  const png = await renderPng(<RouteCard cardKey={slug} variant="timeless" />);
  return new Response(png, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": TIMELESS_CACHE_CONTROL,
      "X-Og-Status": "timeless",
      "X-Og-Reason": reason,
      "X-Og-Assessed-At": String(nowSec),
    },
  });
}

/**
 * Live route card. The hero is the page's own published figure, read in
 * process from the owner the public endpoint uses and stamped with its
 * generation. A missing, stale, held, partial or failed source — and a render
 * failure — serves the figure-free timeless card (200), never a stale number.
 */
async function handleOgPage(db: D1Database, slug: string): Promise<Response> {
  if (!isOgPageSlug(slug)) return ogErrorResponse("Unknown OG page", 404);
  const nowSec = Math.floor(Date.now() / 1000);
  let load: OgPageLoad;
  try {
    load = await OG_PAGE_LOADERS[slug](db, nowSec);
  } catch (err) {
    logWorkerEventArgs("api", "error", `[og] Page loader error (${slug}):`, err);
    load = { kind: "unavailable", reason: "owner-error" };
  }
  if (load.kind === "unavailable") return renderOgPageTimeless(slug, load.reason, nowSec);

  try {
    const png = await renderPng(
      <RouteCard
        cardKey={slug}
        variant="live"
        data={{
          hero: load.hero,
          context: load.context,
          support: load.support,
          visual: load.visual,
          stamp: `As of ${formatOgStampTime(load.asOfSec)}${load.stampNote ? ` · ${load.stampNote}` : ""}`,
        }}
      />,
    );
    const assessedAtSec = Date.now() / 1000;
    const freshSecondsLeft = (load.freshUntilSec ?? load.asOfSec + load.budgetSec) - assessedAtSec;
    if (freshSecondsLeft <= 0) return renderOgPageTimeless(slug, "stale-cache", Math.floor(assessedAtSec));
    return new Response(png, {
      headers: {
        "Content-Type": "image/png",
        // Never cached past the figure's admission budget.
        "Cache-Control": buildOgImageCacheControl(freshSecondsLeft),
        "X-Og-Status": "live",
        "X-Og-Generation": load.generation,
        "X-Og-As-Of": String(load.asOfSec),
        "X-Og-Freshness-Budget": String(load.budgetSec),
        "X-Og-Assessed-At": String(Math.floor(assessedAtSec)),
      },
    });
  } catch (err) {
    logWorkerEventArgs("api", "error", `[og] Page render error (${slug}):`, err);
    return renderOgPageTimeless(slug, "render-error", nowSec);
  }
}


const STABLECOIN_OG_PATTERN = /^\/api\/og\/(?:v2\/)?stablecoin\/(.+)$/;
const CHAIN_OG_PATTERN = /^\/api\/og\/(?:v2\/)?chain\/([a-z0-9-]+)$/;
const PAGE_OG_PATTERN = /^\/api\/og\/(?:v2\/)?page\/([a-z-]+)$/;

function decodeOgCapture(raw: string): string | Response {
  try {
    const decoded = decodeURIComponent(raw);
    return encodeURIComponent(decoded) === raw ? decoded : ogErrorResponse("Not found", 404);
  } catch {
    return ogErrorResponse("Malformed URI", 400);
  }
}

interface OgRoute {
  pattern: RegExp;
  /** Decode/normalize the captured segment; a Response short-circuits routing. */
  resolveCapture?: (capture: string) => string | Response;
  render: (db: D1Database, capture: string) => Promise<Response>;
}

const OG_ROUTES: readonly OgRoute[] = [
  {
    pattern: STABLECOIN_OG_PATTERN,
    resolveCapture: decodeOgCapture,
    render: (db, coinId) => handleStablecoinOg(db, coinId),
  },
  {
    pattern: CHAIN_OG_PATTERN,
    render: (db, chainId) => handleChainOg(db, chainId),
  },
  { pattern: PAGE_OG_PATTERN, render: (db, slug) => handleOgPage(db, slug) },
  { pattern: /^\/api\/og\/(?:v2\/)?safety-scores$/, render: (db) => handleSafetyScoresOg(db) },
  { pattern: /^\/api\/og\/(?:v2\/)?depeg$/, render: (db) => handleDepegOg(db) },
  { pattern: /^\/api\/og\/(?:v2\/)?stability-index$/, render: (db) => handleStabilityIndexOg(db) },
  {
    pattern: /^\/api\/og\/v2\/scorecard\/([^/]+)$/,
    resolveCapture: decodeOgCapture,
    render: (db, id) => handleScorecardOg(db, id),
  },
];

export async function handleOg(db: D1Database, path: string, _method = "GET"): Promise<Response | null> {
  const route = OG_ROUTES.find((candidate) => candidate.pattern.test(path));
  if (!route) return null;

  const rawCapture = path.match(route.pattern)?.[1] ?? "";
  const capture = route.resolveCapture ? route.resolveCapture(rawCapture) : rawCapture;
  if (capture instanceof Response) return capture;

  try {
    return await route.render(db, capture);
  } catch (err) {
    logWorkerEventArgs("api", "error", "[og] Render error:", err);
    // Render-internal/transient failure (satori throw, resvg WASM crash, missing
    // font, D1 read failure). Permanent errors (unknown coin, malformed input)
    // return their own 4xx earlier and never reach this catch. Use 503 + no-store
    // so the CDN does not pin a failure response, and surface error.name for
    // diagnostics without leaking the full message.
    const errorClass = err instanceof Error ? err.name : "UnknownError";
    return ogErrorResponse("OG image generation failed", 503, {
      "Retry-After": "60",
      "Cache-Control": "no-store",
      "X-Render-Error-Class": errorClass,
    });
  }
}

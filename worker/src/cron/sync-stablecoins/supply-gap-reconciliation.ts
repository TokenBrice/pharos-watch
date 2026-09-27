import {
  canonicalizeChainCirculating,
  type ChainCirculatingNormalizationDiagnostics,
} from "@shared/lib/chains/circulating";

import { CHAIN_META } from "@shared/lib/chains";
import { pegTypeFromCurrency } from "@shared/lib/peg-taxonomy";
import { getCirculatingRaw, getCirculatingRawOrNull, getPrevDayRawOrNull, getPrevMonthRawOrNull, getPrevWeekRawOrNull } from "@shared/lib/supply";
import type { SupplyGapFillProvenance } from "@shared/types/market";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { cgHeaders, cgSimplePricePath, cgUrl } from "../../lib/coingecko";
import { DEFILLAMA_BASE, USER_AGENT } from "../../lib/constants";
import { fetchTextWithRetry } from "../../lib/fetch-retry";
import { throwIfAborted } from "../../lib/abort";
import { logWorkerEvent } from "../../lib/structured-log";
import { validatePricingSourceFreshness } from "../../lib/pricing-source-freshness";
import type { PeggedAsset } from "./enrich-prices";
import { fetchCuratedAggregateOnChainMcap, toPublicChainCirculating } from "./supplemental-assets/onchain-supply";
import { toPositiveFiniteNumber } from "./supplemental-assets/shared";

/**
 * DEC-01 CoinGecko aggregate gap-fill limits (ratio = CoinGecko market cap / DefiLlama list total).
 * OWNER REVIEWS AT PR. Derived from the 2026-09-27 observed distribution recorded in
 * docs/supply-snapshot.md ("CoinGecko aggregate gap-fill limits"): across 157 tracked DefiLlama assets the
 * median ratio is 1.0000 and p90 is 1.31, while assets with complete chain coverage (no missing-chain story)
 * already diverge 1.07-1.47 for four assets and >= 1.65 for eight, so a larger ratio is provider-methodology
 * disagreement rather than a proven missing deployment. `maxRatio` is the hard ceiling at current and every
 * compared historical bucket; `entryMaxRatio`/`retainMinRatio` are the hysteresis band edges that stop an
 * asset flapping between CoinGecko and DefiLlama at either threshold.
 */
export const COINGECKO_GAP_FILL_POLICY = {
  /** A not-yet-filled asset enters only when CG exceeds DL by more than 5%... */
  entryMinRatio: 1.05,
  /** ...and by at most 45%. */
  entryMaxRatio: 1.45,
  /** A row published as gap-filled last run stays filled while CG exceeds DL by more than 2%... */
  retainMinRatio: 1.02,
  /** ...and never above the hard ceiling. Out-of-bound contribution cannot enter the aggregate. */
  maxRatio: 1.5,
} as const;
const COINGECKO_GAP_HISTORY_DAYS = 40;
const MAX_SUPPLY_GAP_CANDIDATES = 15;
const DEFILLAMA_ZERO_SUPPLY_MIN_MARKET_CAP = 1_000_000;
const MAX_CURRENT_POINT_AGE_MS = 2 * 24 * 60 * 60 * 1000;
const MAX_LOOKBACK_POINT_DISTANCE_MS = 3 * 24 * 60 * 60 * 1000;

// Two missed 15-minute publications bridge a transient outage without indefinite stale gap-fill.
const MAX_GAP_FILL_CARRY_RUNS = 2;

/** Carry one coherent previous observation, never a fresh-price/old-chain synthetic supply. */
export function carryForwardSupplyGapFill(asset: PeggedAsset, previous: PeggedAsset | undefined): boolean {
  const provenance = previous?.supplyGapFill;
  if (previous?.supplySource !== "coingecko-gap-fill" || !provenance) return false;
  const runs = provenance.carryForwardRuns ?? 0;
  if (runs >= MAX_GAP_FILL_CARRY_RUNS) return false;
  asset.circulating = previous.circulating;
  asset.circulatingPrevDay = previous.circulatingPrevDay;
  asset.circulatingPrevWeek = previous.circulatingPrevWeek;
  asset.circulatingPrevMonth = previous.circulatingPrevMonth;
  asset.chainCirculating = previous.chainCirculating;
  asset.chains = previous.chains;
  asset.supplySource = previous.supplySource;
  asset.supplyObservedAt = previous.supplyObservedAt;
  asset.supplyRestored = true;
  asset.supplyGapFill = { ...provenance, carryForwardRuns: runs + 1 };
  return true;
}

interface CoinGeckoCurrentMcapRow {
  usd_market_cap?: number;
  last_updated_at?: number;
}

interface CoinGeckoRecentMarketChart {
  market_caps?: unknown;
}

interface DefiLlamaChartPoint {
  date?: number | string;
  totalCirculatingUSD?: Record<string, number>;
}

interface MarketCapObservation {
  value: number;
  observedAt: number;
}

interface SupplyGapBaselineMismatch {
  id: string;
  expectedCurrent: number;
  attributedCurrent: number;
  tolerance: number;
  droppedRows: number;
  droppedChainIds: string[];
}

export type CoinGeckoGapFillRejectionReason =
  | "ratio-out-of-band"
  | "multiple-missing-chains"
  | "baseline-mismatch"
  | "history-incomplete"
  | "history-ratio-above-bound";

export interface CoinGeckoGapFillRejection {
  id: string;
  reason: CoinGeckoGapFillRejectionReason;
  ratio: number | null;
}

interface MissingChainGapApplication {
  reconciledCurrent: number | null;
  baselineMismatch?: SupplyGapBaselineMismatch;
  rejection?: CoinGeckoGapFillRejectionReason;
}

interface MissingChainSupplyGapCandidate {
  kind: "missing-chain";
  asset: PeggedAsset;
  geckoId: string;
  pegKey: string;
  missingChainIds: string[];
  /** `retained` when the previous publication already carried this asset's gap-fill (hysteresis). */
  admission: SupplyGapFillProvenance["admission"];
}

interface ZeroSupplyCollapseCandidate {
  kind: "zero-supply-collapse";
  asset: PeggedAsset;
  llamaId: string;
  pegKey: string;
}

export type SupplyGapReconciliationReason =
  | "defillama-history-gap-fill"
  | "coingecko-gap-fill"
  | "onchain-total-supply";

export interface SupplyGapReconciliationAsset {
  id: string;
  reason: SupplyGapReconciliationReason;
  fromSource: string | null;
  toValue: number;
  observedAt: number | null;
  observedAgeSec: number | null;
}

export interface SupplyGapReconciliationResult {
  reconciledIds: string[];
  totalReconciled: number;
  byReason: Record<SupplyGapReconciliationReason, number>;
  assets: SupplyGapReconciliationAsset[];
  baselineMismatches: SupplyGapBaselineMismatch[];
  /** Missing-chain assets whose CoinGecko contribution failed the DEC-01 limits; DL facts stay published. */
  gapFillRejections: CoinGeckoGapFillRejection[];
}

type SupplyGapCandidate = MissingChainSupplyGapCandidate | ZeroSupplyCollapseCandidate;

export function prioritizeSupplyGapCandidateOrder<
  T extends { kind: SupplyGapCandidate["kind"] },
>(candidates: readonly T[]): T[] {
  return [...candidates].sort((left, right) =>
    Number(left.kind !== "zero-supply-collapse") - Number(right.kind !== "zero-supply-collapse")
  );
}

function createEmptyReasonCounts(): Record<SupplyGapReconciliationReason, number> {
  return {
    "defillama-history-gap-fill": 0,
    "coingecko-gap-fill": 0,
    "onchain-total-supply": 0,
  };
}

function buildMetadataChainIds(assetId: string): string[] {
  const meta = ACTIVE_META_BY_ID.get(assetId);
  if (!meta?.contracts?.length) return [];

  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const contract of meta.contracts) {
    if (seen.has(contract.chain)) continue;
    seen.add(contract.chain);
    ordered.push(contract.chain);
  }
  return ordered;
}

function buildKnownDisplayChains(assetId: string, existing: string[] | undefined): string[] {
  const labels = new Set<string>(Array.isArray(existing) ? existing.filter(Boolean) : []);

  for (const chainId of buildMetadataChainIds(assetId)) {
    labels.add(CHAIN_META[chainId]?.name ?? chainId);
  }

  return [...labels];
}

function findNearestMarketCap(
  points: [number, number][],
  targetMs: number,
  maxDistanceMs: number,
): MarketCapObservation | null {
  let bestValue: number | null = null;
  let bestTimestampMs: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const [timestampMs, marketCap] of points) {
    const value = toPositiveFiniteNumber(marketCap);
    if (value == null || !Number.isFinite(timestampMs) || timestampMs <= 0) continue;

    const distance = Math.abs(timestampMs - targetMs);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestValue = value;
      bestTimestampMs = timestampMs;
    }
  }

  if (bestDistance > maxDistanceMs || bestValue == null || bestTimestampMs == null) return null;
  return {
    value: bestValue,
    observedAt: Math.floor(bestTimestampMs / 1000),
  };
}

function normalizeChartTimestampMs(value: unknown): number | null {
  const numeric = typeof value === "string" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
}

async function fetchCurrentCoinGeckoMarketCaps(
  geckoIds: string[],
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
): Promise<Record<string, CoinGeckoCurrentMcapRow>> {
  if (geckoIds.length === 0) return {};

  const result = await fetchTextWithRetry(
    cgUrl(
      cgSimplePricePath(
        `ids=${encodeURIComponent(geckoIds.join(","))}&vs_currencies=usd&include_market_cap=true&include_last_updated_at=true`,
      ),
      coingeckoApiKey ?? null,
    ),
    {
      headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }, coingeckoApiKey ?? null),
      signal,
    },
  );

  if (!result?.response.ok) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "sync-stablecoins.coingecko-current-market-cap-failed",
      job: "sync-stablecoins",
      message: "CoinGecko current market-cap fetch failed for supply gap reconciliation",
      metadata: { status: result?.response.status ?? "no response" },
    });
    return {};
  }

  try {
    return JSON.parse(result.body) as Record<string, CoinGeckoCurrentMcapRow>;
  } catch (error) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "sync-stablecoins.coingecko-current-market-cap-parse-failed",
      job: "sync-stablecoins",
      message: "CoinGecko current market-cap payload parse failed",
      error,
    });
    return {};
  }
}

async function fetchRecentCoinGeckoMarketCaps(
  geckoId: string,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
): Promise<[number, number][]> {
  const result = await fetchTextWithRetry(
    cgUrl(
      `/coins/${geckoId}/market_chart?vs_currency=usd&days=${COINGECKO_GAP_HISTORY_DAYS}`,
      coingeckoApiKey ?? null,
    ),
    {
      headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }, coingeckoApiKey ?? null),
      signal,
    },
  );

  if (!result?.response.ok) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "sync-stablecoins.coingecko-market-chart-failed",
      job: "sync-stablecoins",
      message: "CoinGecko market-chart fetch failed for candidate",
      metadata: { geckoId, status: result?.response.status ?? "no response" },
    });
    return [];
  }

  try {
    const payload = JSON.parse(result.body) as CoinGeckoRecentMarketChart;
    if (!Array.isArray(payload.market_caps)) return [];

    let malformedCount = 0;
    const points = payload.market_caps.flatMap((entry) => {
      if (!Array.isArray(entry) || entry.length < 2) {
        malformedCount++;
        return [];
      }
      const timestampMs = normalizeChartTimestampMs(entry[0]);
      const marketCap = toPositiveFiniteNumber(entry[1]);
      if (timestampMs == null || marketCap == null) {
        malformedCount++;
        return [];
      }
      return [[timestampMs, marketCap] as [number, number]];
    });
    if (malformedCount > 0) {
      logWorkerEvent({
        scope: "lib",
        level: "warn",
        event: "sync-stablecoins.coingecko-market-chart-points-dropped",
        job: "sync-stablecoins",
        message: "Dropped malformed CoinGecko market-chart points",
        metadata: { geckoId, malformedCount },
      });
    }
    return points;
  } catch (error) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "sync-stablecoins.coingecko-market-chart-parse-failed",
      job: "sync-stablecoins",
      message: "CoinGecko market-chart payload parse failed",
      metadata: { geckoId },
      error,
    });
    return [];
  }
}

async function fetchRecentDefiLlamaMarketCaps(
  llamaId: string,
  pegKey: string,
  signal?: AbortSignal,
): Promise<[number, number][]> {
  const result = await fetchTextWithRetry(
    `${DEFILLAMA_BASE}/stablecoincharts/all?stablecoin=${encodeURIComponent(llamaId)}`,
    {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal,
    },
  );

  if (!result?.response.ok) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "sync-stablecoins.defillama-chart-failed",
      job: "sync-stablecoins",
      message: "DefiLlama chart fetch failed for candidate",
      metadata: { llamaId, status: result?.response.status ?? "no response" },
    });
    return [];
  }

  try {
    const payload = JSON.parse(result.body);
    if (!Array.isArray(payload)) return [];

    let malformedCount = 0;
    const points = payload.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        malformedCount++;
        return [];
      }
      const point = entry as DefiLlamaChartPoint;
      const timestampMs = normalizeChartTimestampMs(point.date);
      const buckets = point.totalCirculatingUSD;
      const marketCap = buckets && typeof buckets === "object" && !Array.isArray(buckets)
        ? toPositiveFiniteNumber(buckets[pegKey])
        : null;
      if (timestampMs == null || marketCap == null) {
        malformedCount++;
        return [];
      }
      return [[timestampMs, marketCap] as [number, number]];
    });
    if (malformedCount > 0) {
      logWorkerEvent({
        scope: "lib",
        level: "warn",
        event: "sync-stablecoins.defillama-chart-points-dropped",
        job: "sync-stablecoins",
        message: "Dropped malformed DefiLlama market-chart points",
        metadata: { llamaId, malformedCount },
      });
    }
    return points;
  } catch (error) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "sync-stablecoins.defillama-chart-parse-failed",
      job: "sync-stablecoins",
      message: "DefiLlama chart payload parse failed for candidate",
      metadata: { llamaId },
      error,
    });
    return [];
  }
}

/**
 * DEC-01 band check with hysteresis. A previously gap-filled asset stays filled inside
 * (`retainMinRatio`, `maxRatio`]; any other asset enters only inside (`entryMinRatio`, `entryMaxRatio`].
 */
function resolveGapFillAdmission(
  ratio: number,
  previouslyFilled: boolean,
): SupplyGapFillProvenance["admission"] | null {
  if (!Number.isFinite(ratio)) return null;
  if (previouslyFilled) {
    return ratio > COINGECKO_GAP_FILL_POLICY.retainMinRatio && ratio <= COINGECKO_GAP_FILL_POLICY.maxRatio
      ? "retained"
      : null;
  }
  return ratio > COINGECKO_GAP_FILL_POLICY.entryMinRatio && ratio <= COINGECKO_GAP_FILL_POLICY.entryMaxRatio
    ? "entered"
    : null;
}

function buildSupplyGapCandidates(
  assets: PeggedAsset[],
  currentMarketCaps: Record<string, CoinGeckoCurrentMcapRow>,
  previousAssetsById: ReadonlyMap<string, PeggedAsset> | undefined,
  rejections: CoinGeckoGapFillRejection[],
): SupplyGapCandidate[] {
  const candidates: SupplyGapCandidate[] = [];

  for (const asset of assets) {
    const assetId = String(asset.id);
    const meta = ACTIVE_META_BY_ID.get(assetId);
    if (!meta || meta.detailProvider !== "defillama") continue;

    const pegKey = pegTypeFromCurrency(meta.flags.pegCurrency);
    if (!pegKey) continue;

    const dlMarketCap = getCirculatingRaw(asset);
    const metadataChainIds = buildMetadataChainIds(assetId);
    const knownChainIds = new Set<string>();
    for (const [chainId] of canonicalizeChainCirculating(asset.chainCirculating)) {
      knownChainIds.add(chainId);
    }

    if (dlMarketCap > 0 && metadataChainIds.length > 0 && meta.geckoId) {
      const missingChainIds = metadataChainIds.filter((chainId) => !knownChainIds.has(chainId));
      if (missingChainIds.length === 0) continue;

      const currentMarketCap = currentMarketCaps[meta.geckoId];
      const freshness = validatePricingSourceFreshness({
        source: "coingecko",
        observedAt: currentMarketCap?.last_updated_at,
        observedAtMode: "upstream",
        requireObservedAt: true,
      });
      const cgMarketCap = toPositiveFiniteNumber(currentMarketCap?.usd_market_cap);
      if (!freshness.accepted || cgMarketCap == null) {
        carryForwardSupplyGapFill(asset, previousAssetsById?.get(assetId));
        continue;
      }

      const ratio = cgMarketCap / dlMarketCap;
      const previouslyFilled = previousAssetsById?.get(assetId)?.supplySource === "coingecko-gap-fill";
      const triggerRatio = previouslyFilled
        ? COINGECKO_GAP_FILL_POLICY.retainMinRatio
        : COINGECKO_GAP_FILL_POLICY.entryMinRatio;
      if (!(ratio > triggerRatio)) continue;
      const admission = resolveGapFillAdmission(ratio, previouslyFilled);
      if (admission == null) {
        rejections.push({ id: assetId, reason: "ratio-out-of-band", ratio });
        continue;
      }
      // Remainder attribution needs exactly one unobserved deployment; several missing chains cannot
      // be attributed without inventing a split, so no supplemental contribution is admitted.
      if (missingChainIds.length !== 1) {
        rejections.push({ id: assetId, reason: "multiple-missing-chains", ratio });
        continue;
      }

      candidates.push({
        kind: "missing-chain",
        asset,
        geckoId: meta.geckoId,
        pegKey,
        missingChainIds,
        admission,
      });
      continue;
    }

    if (dlMarketCap <= 0 && meta.llamaId) {
      candidates.push({
        kind: "zero-supply-collapse",
        asset,
        llamaId: meta.llamaId,
        pegKey,
      });
    }
  }

  return candidates;
}

type HistoryBucketKey = "day" | "week" | "month";
/** Compared historical buckets; `field` names both the aggregate record and the chain-row scalar. */
const HISTORY_BUCKETS = [
  { key: "day", field: "circulatingPrevDay" },
  { key: "week", field: "circulatingPrevWeek" },
  { key: "month", field: "circulatingPrevMonth" },
] as const satisfies readonly { key: HistoryBucketKey; field: string }[];

/**
 * DEC-01 supplemental aggregate raise for one tracked asset missing exactly one deployment. Fail-closed:
 * the DL chain baseline must reconcile with every attributed chain observed; the CoinGecko series must
 * supply current plus every compared historical bucket; and CG/DL must stay inside the policy band at
 * current (with hysteresis) and at or under the hard ceiling at every bucket DL also observed. When
 * admitted, every published aggregate bucket comes from the single CoinGecko series (never a per-bucket
 * max that splices providers into a flow); a bucket DL did not observe stays absent because its
 * supplemental contribution cannot be bounded. The missing chain carries only the nonnegative remainder,
 * so no amount is counted twice, and the row records the retained DL facts as provenance.
 */
function applySingleMissingChainGap(
  candidate: MissingChainSupplyGapCandidate,
  totals: { current: number; day: number | null; week: number | null; month: number | null },
  observedAt: number,
): MissingChainGapApplication {
  const dlCurrent = getCirculatingRawOrNull(candidate.asset);
  if (dlCurrent == null || dlCurrent <= 0) return { reconciledCurrent: null, rejection: "baseline-mismatch" };
  const dlHistory: Record<HistoryBucketKey, number | null> = {
    day: getPrevDayRawOrNull(candidate.asset),
    week: getPrevWeekRawOrNull(candidate.asset),
    month: getPrevMonthRawOrNull(candidate.asset),
  };
  const diagnostics: ChainCirculatingNormalizationDiagnostics = {
    droppedRows: 0,
    droppedChainIds: [],
  };
  const canonicalRows = [...canonicalizeChainCirculating(candidate.asset.chainCirculating, diagnostics).values()];
  const unavailableChainRows = canonicalRows.filter((row) => row.current == null).length;
  const attributedCurrent = canonicalRows.reduce((sum, row) => sum + (row.current ?? 0), 0);
  const baselineTolerance = Math.max(0.01, dlCurrent * 1e-6);
  if (
    !Number.isFinite(attributedCurrent)
    || diagnostics.droppedRows > 0
    || unavailableChainRows > 0
    || Math.abs(attributedCurrent - dlCurrent) > baselineTolerance
  ) {
    return {
      reconciledCurrent: null,
      rejection: "baseline-mismatch",
      baselineMismatch: {
        id: candidate.asset.id,
        expectedCurrent: dlCurrent,
        attributedCurrent,
        tolerance: baselineTolerance,
        droppedRows: diagnostics.droppedRows + unavailableChainRows,
        droppedChainIds: diagnostics.droppedChainIds,
      },
    };
  }

  // Re-check the band on the CoinGecko series value actually published (the candidate gate used the
  // simple-price snapshot), keeping the admission mode chosen from the previous publication.
  const ratio = totals.current / dlCurrent;
  if (resolveGapFillAdmission(ratio, candidate.admission === "retained") == null) {
    return { reconciledCurrent: null, rejection: "ratio-out-of-band" };
  }

  const publishedHistory: Record<HistoryBucketKey, number | null> = { day: null, week: null, month: null };
  const remainderHistory: Record<HistoryBucketKey, number | undefined> = { day: undefined, week: undefined, month: undefined };
  for (const { key } of HISTORY_BUCKETS) {
    const cgValue = totals[key];
    if (cgValue == null) return { reconciledCurrent: null, rejection: "history-incomplete" };
    const dlValue = dlHistory[key];
    if (dlValue == null) continue;
    if (dlValue <= 0 || cgValue / dlValue > COINGECKO_GAP_FILL_POLICY.maxRatio) {
      return { reconciledCurrent: null, rejection: "history-ratio-above-bound" };
    }
    publishedHistory[key] = cgValue;
    // A CoinGecko bucket below DL's cannot be attributed to the missing chain; leave that remainder absent.
    if (cgValue >= dlValue) remainderHistory[key] = cgValue - dlValue;
  }

  const remainderCurrent = totals.current - dlCurrent;
  if (!(remainderCurrent > 0) || !Number.isFinite(remainderCurrent)) {
    return { reconciledCurrent: null, rejection: "ratio-out-of-band" };
  }

  const chainId = candidate.missingChainIds[0]!;
  const chainLabel = CHAIN_META[chainId]?.name ?? chainId;
  const chainCirculating = candidate.asset.chainCirculating ?? {};
  const remainderRow: Record<string, unknown> = { chainId, current: remainderCurrent };
  for (const { key, field } of HISTORY_BUCKETS) {
    const remainder = remainderHistory[key];
    if (remainder !== undefined) remainderRow[field] = remainder;
  }
  chainCirculating[chainLabel] = remainderRow;
  candidate.asset.chainCirculating = chainCirculating;
  candidate.asset.circulating = { [candidate.pegKey]: totals.current };
  for (const { key, field } of HISTORY_BUCKETS) {
    const value = publishedHistory[key];
    candidate.asset[field] = value == null ? null : { [candidate.pegKey]: value };
  }
  candidate.asset.supplySource = "coingecko-gap-fill";
  candidate.asset.supplyGapFill = {
    method: "coingecko-single-missing-chain",
    admission: candidate.admission,
    missingChainId: chainId,
    canonicalSource: "defillama",
    canonicalCurrentUsd: dlCurrent,
    supplementalSource: "coingecko",
    supplementalCurrentUsd: totals.current,
    ratio,
    maxRatio: COINGECKO_GAP_FILL_POLICY.maxRatio,
    observedAt,
  };
  return { reconciledCurrent: totals.current };
}

function getPegReferencePriceUsd(
  candidate: SupplyGapCandidate,
  fxFallbackRates?: Record<string, number>,
): number | null {
  const meta = ACTIVE_META_BY_ID.get(String(candidate.asset.id));
  if (meta?.flags.navToken || meta?.flags.yieldBearing) return null;
  if (meta?.flags.pegCurrency === "USD") return 1;

  const rate = toPositiveFiniteNumber(fxFallbackRates?.[candidate.pegKey]);
  return rate ?? null;
}

async function applyCuratedOnChainSupplyGap(input: {
  candidate: ZeroSupplyCollapseCandidate;
  chainRpcs?: Map<string, ChainRpcConfig>;
  fxFallbackRates?: Record<string, number>;
  signal?: AbortSignal;
}): Promise<{ mcap: number; observedAt: number | null } | null> {
  const meta = ACTIVE_META_BY_ID.get(String(input.candidate.asset.id));
  if (!meta) return null;

  const priceUsd = getPegReferencePriceUsd(input.candidate, input.fxFallbackRates);
  if (priceUsd == null) return null;

  const onChainMcap = await fetchCuratedAggregateOnChainMcap(
    meta,
    priceUsd,
    input.chainRpcs,
    input.signal,
  );
  if (!onChainMcap) return null;

  input.candidate.asset.circulating = { [input.candidate.pegKey]: onChainMcap.mcap };
  input.candidate.asset.circulatingPrevDay = null;
  input.candidate.asset.circulatingPrevWeek = null;
  input.candidate.asset.circulatingPrevMonth = null;
  input.candidate.asset.supplySource = onChainMcap.supplySource;
  input.candidate.asset.supplyObservedAt = onChainMcap.observedAt ?? null;
  input.candidate.asset.chains = buildKnownDisplayChains(input.candidate.asset.id, input.candidate.asset.chains);

  if (onChainMcap.chainCirculating) {
    input.candidate.asset.chainCirculating = toPublicChainCirculating(onChainMcap.chainCirculating);
  }

  return { mcap: onChainMcap.mcap, observedAt: onChainMcap.observedAt ?? null };
}

export async function reconcileTrackedSupplyGaps(
  assets: PeggedAsset[],
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
  chainRpcs?: Map<string, ChainRpcConfig>,
  fxFallbackRates?: Record<string, number>,
  /** Previous publication; its `coingecko-gap-fill` rows select the DEC-01 retain (hysteresis) band. */
  previousAssetsById?: ReadonlyMap<string, PeggedAsset>,
): Promise<SupplyGapReconciliationResult> {
  const candidateGeckoIds = [...new Set(
    assets.flatMap((asset) => {
      const assetId = String(asset.id);
      const meta = ACTIVE_META_BY_ID.get(assetId);
      if (!meta || meta.detailProvider !== "defillama" || !meta.geckoId) return [];

      if (getCirculatingRaw(asset) <= 0) return [];

      const metadataChainIds = buildMetadataChainIds(assetId);
      if (metadataChainIds.length === 0) return [];

      const knownChainIds = new Set<string>();
      for (const [chainId] of canonicalizeChainCirculating(asset.chainCirculating)) {
        knownChainIds.add(chainId);
      }

      const hasMissingTrackedChain = metadataChainIds.some((chainId) => !knownChainIds.has(chainId));
      return hasMissingTrackedChain ? [meta.geckoId] : [];
    }),
  )];

  const currentMarketCaps = await fetchCurrentCoinGeckoMarketCaps(candidateGeckoIds, signal, coingeckoApiKey);
  const gapFillRejections: CoinGeckoGapFillRejection[] = [];
  const allCandidates = buildSupplyGapCandidates(assets, currentMarketCaps, previousAssetsById, gapFillRejections);
  if (allCandidates.length > MAX_SUPPLY_GAP_CANDIDATES) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "sync-stablecoins.supply-gap-candidates-truncated",
      job: "sync-stablecoins",
      message: "Supply-gap candidates capped to bound per-cron API calls",
      metadata: {
        maxCandidates: MAX_SUPPLY_GAP_CANDIDATES,
        candidateCount: allCandidates.length,
      },
    });
  }
  const candidates = prioritizeSupplyGapCandidateOrder(allCandidates).slice(0, MAX_SUPPLY_GAP_CANDIDATES);
  const selectedIds = new Set(candidates.map((candidate) => candidate.asset.id));
  for (const candidate of allCandidates) {
    if (!selectedIds.has(candidate.asset.id)) {
      carryForwardSupplyGapFill(candidate.asset, previousAssetsById?.get(candidate.asset.id));
    }
  }
  if (candidates.length === 0) {
    return {
      reconciledIds: [],
      totalReconciled: 0,
      byReason: createEmptyReasonCounts(),
      assets: [],
      baselineMismatches: [],
      gapFillRejections,
    };
  }

  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const reconciledIds: string[] = [];
  const reconciledAssets: SupplyGapReconciliationAsset[] = [];
  const baselineMismatches: SupplyGapBaselineMismatch[] = [];
  const byReason = createEmptyReasonCounts();

  for (const candidate of candidates) {
    throwIfAborted(signal);
    const marketCaps = candidate.kind === "zero-supply-collapse"
      ? await fetchRecentDefiLlamaMarketCaps(candidate.llamaId, candidate.pegKey, signal)
      : await fetchRecentCoinGeckoMarketCaps(candidate.geckoId, signal, coingeckoApiKey);
    if (marketCaps.length === 0 && candidate.kind !== "zero-supply-collapse") {
      gapFillRejections.push({ id: candidate.asset.id, reason: "history-incomplete", ratio: null });
      carryForwardSupplyGapFill(candidate.asset, previousAssetsById?.get(candidate.asset.id));
      continue;
    }

    const currentFromHistory = findNearestMarketCap(marketCaps, nowMs, MAX_CURRENT_POINT_AGE_MS);
    const day = findNearestMarketCap(marketCaps, nowMs - (24 * 60 * 60 * 1000), MAX_LOOKBACK_POINT_DISTANCE_MS);
    const week = findNearestMarketCap(marketCaps, nowMs - (7 * 24 * 60 * 60 * 1000), MAX_LOOKBACK_POINT_DISTANCE_MS);
    const month = findNearestMarketCap(marketCaps, nowMs - (30 * 24 * 60 * 60 * 1000), MAX_LOOKBACK_POINT_DISTANCE_MS);

    if (
      candidate.kind === "zero-supply-collapse" &&
      (currentFromHistory == null || day == null || week == null || month == null ||
        currentFromHistory.value < DEFILLAMA_ZERO_SUPPLY_MIN_MARKET_CAP)
    ) {
      const fromSource = candidate.asset.supplySource ?? null;
      const onChainMcap = await applyCuratedOnChainSupplyGap({
        candidate,
        chainRpcs,
        fxFallbackRates,
        signal,
      });
      if (onChainMcap == null) continue;

      reconciledIds.push(candidate.asset.id);
      reconciledAssets.push({
        id: candidate.asset.id,
        reason: "onchain-total-supply",
        fromSource,
        toValue: onChainMcap.mcap,
        observedAt: onChainMcap.observedAt,
        observedAgeSec: onChainMcap.observedAt == null ? null : Math.max(0, nowSec - onChainMcap.observedAt),
      });
      byReason["onchain-total-supply"] += 1;
      continue;
    }
    if (candidate.kind === "missing-chain") {
      if (currentFromHistory == null) {
        gapFillRejections.push({ id: candidate.asset.id, reason: "history-incomplete", ratio: null });
        carryForwardSupplyGapFill(candidate.asset, previousAssetsById?.get(candidate.asset.id));
        continue;
      }
      const observedAt = currentFromHistory.observedAt;
      const fromSource = candidate.asset.supplySource ?? null;
      const application = applySingleMissingChainGap(candidate, {
        current: currentFromHistory.value,
        day: day?.value ?? null,
        week: week?.value ?? null,
        month: month?.value ?? null,
      }, observedAt);
      if (application.baselineMismatch) {
        baselineMismatches.push(application.baselineMismatch);
        logWorkerEvent({
          scope: "lib",
          level: "warn",
          event: "sync-stablecoins.supply-gap-baseline-mismatch",
          job: "sync-stablecoins",
          message: "Supply-gap baseline did not reconcile after chain canonicalization",
          metadata: { ...application.baselineMismatch },
        });
      }
      if (application.reconciledCurrent == null) {
        if (application.rejection) {
          if (application.rejection === "history-incomplete") {
            carryForwardSupplyGapFill(candidate.asset, previousAssetsById?.get(candidate.asset.id));
          }
          const dlCurrent = getCirculatingRawOrNull(candidate.asset);
          gapFillRejections.push({
            id: candidate.asset.id,
            reason: application.rejection,
            ratio: dlCurrent != null && dlCurrent > 0 ? currentFromHistory.value / dlCurrent : null,
          });
        }
        continue;
      }
      candidate.asset.supplyObservedAt = observedAt;
      delete candidate.asset.supplyRestored;
      candidate.asset.chains = buildKnownDisplayChains(candidate.asset.id, candidate.asset.chains);
      reconciledIds.push(candidate.asset.id);
      reconciledAssets.push({
        id: candidate.asset.id,
        reason: "coingecko-gap-fill",
        fromSource,
        toValue: application.reconciledCurrent,
        observedAt,
        observedAgeSec: Math.max(0, nowSec - observedAt),
      });
      byReason["coingecko-gap-fill"] += 1;
      continue;
    }
    if (currentFromHistory == null || day == null || week == null || month == null) continue;

    const totals = {
      current: currentFromHistory.value,
      day: day.value,
      week: week.value,
      month: month.value,
    };
    const observedAt = currentFromHistory.observedAt;
    const observedAgeSec = Math.max(0, nowSec - observedAt);

    const fromSource = candidate.asset.supplySource ?? null;
    const reason: SupplyGapReconciliationReason = "defillama-history-gap-fill";
    candidate.asset.supplyObservedAt = observedAt;
    candidate.asset.circulating = { [candidate.pegKey]: totals.current };
    candidate.asset.circulatingPrevDay = { [candidate.pegKey]: totals.day };
    candidate.asset.circulatingPrevWeek = { [candidate.pegKey]: totals.week };
    candidate.asset.circulatingPrevMonth = { [candidate.pegKey]: totals.month };
    candidate.asset.supplySource = reason;
    candidate.asset.chains = buildKnownDisplayChains(candidate.asset.id, candidate.asset.chains);
    reconciledIds.push(candidate.asset.id);
    reconciledAssets.push({
      id: candidate.asset.id,
      reason,
      fromSource,
      toValue: totals.current,
      observedAt,
      observedAgeSec,
    });
    byReason[reason] += 1;
  }

  return {
    reconciledIds,
    totalReconciled: reconciledIds.length,
    byReason,
    assets: reconciledAssets,
    baselineMismatches,
    gapFillRejections,
  };
}

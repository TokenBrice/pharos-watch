import { canonicalizeChainCirculating } from "@shared/lib/chain-circulating";
import { CHAIN_META } from "@shared/lib/chains";
import { normalizePegTypeFromCurrency } from "@shared/lib/peg-price-bounds";
import { sumPegBuckets } from "@shared/lib/supply";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { cgHeaders, cgUrl } from "../../lib/coingecko";
import { DEFILLAMA_BASE, USER_AGENT } from "../../lib/constants";
import { fetchTextWithRetry } from "../../lib/fetch-retry";
import { throwIfAborted } from "../../lib/abort";
import { logWorkerEvent } from "../../lib/structured-log";
import type { PeggedAsset } from "./enrich-prices";
import { fetchCuratedAggregateOnChainMcap } from "./supplemental-assets/onchain-supply";
import { toPositiveFiniteNumber } from "./supplemental-assets/shared";

const COINGECKO_GAP_THRESHOLD_RATIO = 1.05;
const COINGECKO_GAP_HISTORY_DAYS = 40;
const MAX_SUPPLY_GAP_CANDIDATES = 15;
const DEFILLAMA_ZERO_SUPPLY_MIN_MARKET_CAP = 1_000_000;
const MAX_CURRENT_POINT_AGE_MS = 2 * 24 * 60 * 60 * 1000;
const MAX_LOOKBACK_POINT_DISTANCE_MS = 3 * 24 * 60 * 60 * 1000;

interface CoinGeckoCurrentMcapRow {
  usd_market_cap?: number;
}

interface CoinGeckoRecentMarketChart {
  market_caps?: [number, number][];
}

interface DefiLlamaChartPoint {
  date?: number | string;
  totalCirculatingUSD?: Record<string, number>;
}

interface MissingChainSupplyGapCandidate {
  kind: "missing-chain";
  asset: PeggedAsset;
  geckoId: string;
  pegKey: string;
  missingChainIds: string[];
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
}

export interface SupplyGapReconciliationResult {
  reconciledIds: string[];
  totalReconciled: number;
  byReason: Record<SupplyGapReconciliationReason, number>;
  assets: SupplyGapReconciliationAsset[];
}

type SupplyGapCandidate = MissingChainSupplyGapCandidate | ZeroSupplyCollapseCandidate;

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

function sumCanonicalChainTotals(
  asset: PeggedAsset,
): { current: number; day: number; week: number; month: number } {
  let current = 0;
  let day = 0;
  let week = 0;
  let month = 0;

  for (const entry of canonicalizeChainCirculating(asset.chainCirculating)) {
    const point = entry[1];
    current += point.current;
    day += point.circulatingPrevDay;
    week += point.circulatingPrevWeek;
    month += point.circulatingPrevMonth;
  }

  return { current, day, week, month };
}

function findNearestMarketCap(
  points: [number, number][],
  targetMs: number,
  maxDistanceMs: number,
): number | null {
  let bestValue: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const [timestampMs, marketCap] of points) {
    const value = toPositiveFiniteNumber(marketCap);
    if (value == null) continue;

    const distance = Math.abs(timestampMs - targetMs);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestValue = value;
    }
  }

  return bestDistance <= maxDistanceMs ? bestValue : null;
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
      `/simple/price?ids=${encodeURIComponent(geckoIds.join(","))}&vs_currencies=usd&include_market_cap=true`,
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
    return Array.isArray(payload.market_caps) ? payload.market_caps : [];
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

    return payload.flatMap((entry) => {
      const point = entry as DefiLlamaChartPoint;
      const timestampMs = normalizeChartTimestampMs(point.date);
      const marketCap = toPositiveFiniteNumber(point.totalCirculatingUSD?.[pegKey]);
      return timestampMs != null && marketCap != null ? [[timestampMs, marketCap] as [number, number]] : [];
    });
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

function buildSupplyGapCandidates(
  assets: PeggedAsset[],
  currentMarketCaps: Record<string, CoinGeckoCurrentMcapRow>,
): SupplyGapCandidate[] {
  const candidates: SupplyGapCandidate[] = [];

  for (const asset of assets) {
    const assetId = String(asset.id);
    const meta = ACTIVE_META_BY_ID.get(assetId);
    if (!meta || meta.detailProvider !== "defillama") continue;

    const pegKey = normalizePegTypeFromCurrency(meta.flags.pegCurrency);
    if (!pegKey) continue;

    const dlMarketCap = sumPegBuckets(asset.circulating);
    const metadataChainIds = buildMetadataChainIds(assetId);
    const knownChainIds = new Set<string>();
    for (const [chainId] of canonicalizeChainCirculating(asset.chainCirculating)) {
      knownChainIds.add(chainId);
    }

    if (dlMarketCap > 0 && metadataChainIds.length > 0 && meta.geckoId) {
      const missingChainIds = metadataChainIds.filter((chainId) => !knownChainIds.has(chainId));
      if (missingChainIds.length === 0) continue;

      const cgMarketCap = toPositiveFiniteNumber(currentMarketCaps[meta.geckoId]?.usd_market_cap);
      if (cgMarketCap == null || cgMarketCap <= dlMarketCap * COINGECKO_GAP_THRESHOLD_RATIO) {
        continue;
      }

      candidates.push({
        kind: "missing-chain",
        asset,
        geckoId: meta.geckoId,
        pegKey,
        missingChainIds,
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

function applySingleMissingChainRemainder(
  candidate: MissingChainSupplyGapCandidate,
  totals: { current: number; day: number; week: number; month: number },
): void {
  if (candidate.missingChainIds.length !== 1) return;

  const existingTotals = sumCanonicalChainTotals(candidate.asset);
  const remainderCurrent = totals.current - existingTotals.current;
  const remainderDay = totals.day - existingTotals.day;
  const remainderWeek = totals.week - existingTotals.week;
  const remainderMonth = totals.month - existingTotals.month;

  if (
    !Number.isFinite(remainderCurrent) ||
    !Number.isFinite(remainderDay) ||
    !Number.isFinite(remainderWeek) ||
    !Number.isFinite(remainderMonth) ||
    remainderCurrent < 0 ||
    remainderDay < 0 ||
    remainderWeek < 0 ||
    remainderMonth < 0
  ) {
    return;
  }

  const chainId = candidate.missingChainIds[0];
  const chainLabel = CHAIN_META[chainId]?.name ?? chainId;
  const chainCirculating = candidate.asset.chainCirculating ?? {};
  chainCirculating[chainLabel] = {
    current: remainderCurrent,
    circulatingPrevDay: remainderDay,
    circulatingPrevWeek: remainderWeek,
    circulatingPrevMonth: remainderMonth,
  };
  candidate.asset.chainCirculating = chainCirculating;
}

function getPegReferencePriceUsd(
  candidate: SupplyGapCandidate,
  fxFallbackRates?: Record<string, number>,
): number | null {
  const meta = ACTIVE_META_BY_ID.get(String(candidate.asset.id));
  if (meta?.flags.pegCurrency === "USD") return 1;

  const rate = toPositiveFiniteNumber(fxFallbackRates?.[candidate.pegKey]);
  return rate ?? null;
}

async function applyCuratedOnChainSupplyGap(input: {
  candidate: ZeroSupplyCollapseCandidate;
  chainRpcs?: Map<string, ChainRpcConfig>;
  fxFallbackRates?: Record<string, number>;
  signal?: AbortSignal;
}): Promise<number | null> {
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
  input.candidate.asset.chains = buildKnownDisplayChains(input.candidate.asset.id, input.candidate.asset.chains);

  if (onChainMcap.chainCirculating) {
    input.candidate.asset.chainCirculating = Object.fromEntries(
      Object.entries(onChainMcap.chainCirculating).map(([chainLabel, current]) => [
        chainLabel,
        {
          current,
          circulatingPrevDay: 0,
          circulatingPrevWeek: 0,
          circulatingPrevMonth: 0,
        },
      ]),
    );
  }

  return onChainMcap.mcap;
}

export async function reconcileTrackedSupplyGaps(
  assets: PeggedAsset[],
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
  chainRpcs?: Map<string, ChainRpcConfig>,
  fxFallbackRates?: Record<string, number>,
): Promise<SupplyGapReconciliationResult> {
  const candidateGeckoIds = [...new Set(
    assets.flatMap((asset) => {
      const assetId = String(asset.id);
      const meta = ACTIVE_META_BY_ID.get(assetId);
      if (!meta || meta.detailProvider !== "defillama" || !meta.geckoId) return [];

      if (sumPegBuckets(asset.circulating) <= 0) return [];

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
  const allCandidates = buildSupplyGapCandidates(assets, currentMarketCaps);
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
  const candidates = allCandidates.slice(0, MAX_SUPPLY_GAP_CANDIDATES);
  if (candidates.length === 0) {
    return {
      reconciledIds: [],
      totalReconciled: 0,
      byReason: createEmptyReasonCounts(),
      assets: [],
    };
  }

  const nowMs = Date.now();
  const reconciledIds: string[] = [];
  const reconciledAssets: SupplyGapReconciliationAsset[] = [];
  const byReason = createEmptyReasonCounts();

  for (const candidate of candidates) {
    throwIfAborted(signal);
    const marketCaps = candidate.kind === "zero-supply-collapse"
      ? await fetchRecentDefiLlamaMarketCaps(candidate.llamaId, candidate.pegKey, signal)
      : await fetchRecentCoinGeckoMarketCaps(candidate.geckoId, signal, coingeckoApiKey);
    if (marketCaps.length === 0 && candidate.kind !== "zero-supply-collapse") continue;

    const currentFromHistory = findNearestMarketCap(marketCaps, nowMs, MAX_CURRENT_POINT_AGE_MS);
    const day = findNearestMarketCap(marketCaps, nowMs - (24 * 60 * 60 * 1000), MAX_LOOKBACK_POINT_DISTANCE_MS);
    const week = findNearestMarketCap(marketCaps, nowMs - (7 * 24 * 60 * 60 * 1000), MAX_LOOKBACK_POINT_DISTANCE_MS);
    const month = findNearestMarketCap(marketCaps, nowMs - (30 * 24 * 60 * 60 * 1000), MAX_LOOKBACK_POINT_DISTANCE_MS);

    if (
      candidate.kind === "zero-supply-collapse" &&
      (currentFromHistory == null || day == null || week == null || month == null ||
        currentFromHistory < DEFILLAMA_ZERO_SUPPLY_MIN_MARKET_CAP)
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
        toValue: onChainMcap,
      });
      byReason["onchain-total-supply"] += 1;
      continue;
    }
    if (currentFromHistory == null || day == null || week == null || month == null) continue;

    const totals = {
      current: currentFromHistory,
      day,
      week,
      month,
    };

    const fromSource = candidate.asset.supplySource ?? null;
    const reason: SupplyGapReconciliationReason = candidate.kind === "zero-supply-collapse"
      ? "defillama-history-gap-fill"
      : "coingecko-gap-fill";
    candidate.asset.circulating = { [candidate.pegKey]: totals.current };
    candidate.asset.circulatingPrevDay = { [candidate.pegKey]: totals.day };
    candidate.asset.circulatingPrevWeek = { [candidate.pegKey]: totals.week };
    candidate.asset.circulatingPrevMonth = { [candidate.pegKey]: totals.month };
    candidate.asset.supplySource = reason;
    candidate.asset.chains = buildKnownDisplayChains(candidate.asset.id, candidate.asset.chains);

    if (candidate.kind === "missing-chain") {
      applySingleMissingChainRemainder(candidate, totals);
    }
    reconciledIds.push(candidate.asset.id);
    reconciledAssets.push({
      id: candidate.asset.id,
      reason,
      fromSource,
      toValue: totals.current,
    });
    byReason[reason] += 1;
  }

  return {
    reconciledIds,
    totalReconciled: reconciledIds.length,
    byReason,
    assets: reconciledAssets,
  };
}

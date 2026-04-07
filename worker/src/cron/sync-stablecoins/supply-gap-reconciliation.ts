import { canonicalizeChainCirculating } from "@shared/lib/chain-circulating";
import { CHAIN_META } from "@shared/lib/chains";
import { sumPegBuckets } from "@shared/lib/supply";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { cgHeaders, cgUrl } from "../../lib/coingecko";
import { DEFILLAMA_BASE, USER_AGENT } from "../../lib/constants";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { cancelResponseBodyQuietly } from "../../lib/response-body";
import type { PeggedAsset } from "./enrich-prices";

const COINGECKO_GAP_THRESHOLD_RATIO = 1.05;
const COINGECKO_GAP_HISTORY_DAYS = 40;
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

export interface SupplyGapReconciliationResult {
  reconciledCount: number;
  reconciledIds: string[];
}

type SupplyGapCandidate = MissingChainSupplyGapCandidate | ZeroSupplyCollapseCandidate;

function toPositiveFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function buildMetadataChainIds(assetId: string): string[] {
  const meta = TRACKED_META_BY_ID.get(assetId);
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

  const response = await fetchWithRetry(
    cgUrl(
      `/simple/price?ids=${encodeURIComponent(geckoIds.join(","))}&vs_currencies=usd&include_market_cap=true`,
      coingeckoApiKey ?? null,
    ),
    {
      headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }, coingeckoApiKey ?? null),
      signal,
    },
  );

  if (!response?.ok) {
    console.warn(
      `[sync-stablecoins] CoinGecko current market-cap fetch failed for supply gap reconciliation: ${response?.status ?? "no response"}`,
    );
    await cancelResponseBodyQuietly(response);
    return {};
  }

  try {
    return (await response.json()) as Record<string, CoinGeckoCurrentMcapRow>;
  } catch (error) {
    console.warn("[sync-stablecoins] CoinGecko current market-cap payload parse failed:", error);
    return {};
  }
}

async function fetchRecentCoinGeckoMarketCaps(
  geckoId: string,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
): Promise<[number, number][]> {
  const response = await fetchWithRetry(
    cgUrl(
      `/coins/${geckoId}/market_chart?vs_currency=usd&days=${COINGECKO_GAP_HISTORY_DAYS}`,
      coingeckoApiKey ?? null,
    ),
    {
      headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }, coingeckoApiKey ?? null),
      signal,
    },
  );

  if (!response?.ok) {
    console.warn(
      `[sync-stablecoins] CoinGecko market chart fetch failed for ${geckoId}: ${response?.status ?? "no response"}`,
    );
    await cancelResponseBodyQuietly(response);
    return [];
  }

  try {
    const payload = (await response.json()) as CoinGeckoRecentMarketChart;
    return Array.isArray(payload.market_caps) ? payload.market_caps : [];
  } catch (error) {
    console.warn(`[sync-stablecoins] CoinGecko market chart payload parse failed for ${geckoId}:`, error);
    return [];
  }
}

async function fetchRecentDefiLlamaMarketCaps(
  llamaId: string,
  pegKey: string,
  signal?: AbortSignal,
): Promise<[number, number][]> {
  const response = await fetchWithRetry(
    `${DEFILLAMA_BASE}/stablecoincharts/all?stablecoin=${encodeURIComponent(llamaId)}`,
    {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal,
    },
  );

  if (!response?.ok) {
    console.warn(
      `[sync-stablecoins] DefiLlama chart fetch failed for ${llamaId}: ${response?.status ?? "no response"}`,
    );
    await cancelResponseBodyQuietly(response);
    return [];
  }

  try {
    const payload = await response.json();
    if (!Array.isArray(payload)) return [];

    return payload.flatMap((entry) => {
      const point = entry as DefiLlamaChartPoint;
      const timestampMs = normalizeChartTimestampMs(point.date);
      const marketCap = toPositiveFiniteNumber(point.totalCirculatingUSD?.[pegKey]);
      return timestampMs != null && marketCap != null ? [[timestampMs, marketCap] as [number, number]] : [];
    });
  } catch (error) {
    console.warn(`[sync-stablecoins] DefiLlama chart payload parse failed for ${llamaId}:`, error);
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
    const meta = TRACKED_META_BY_ID.get(assetId);
    if (!meta || meta.detailProvider !== "defillama") continue;

    const pegKey = asset.pegType ?? Object.keys(asset.circulating ?? {})[0];
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

export async function reconcileTrackedSupplyGaps(
  assets: PeggedAsset[],
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
): Promise<SupplyGapReconciliationResult> {
  const candidateGeckoIds = [...new Set(
    assets.flatMap((asset) => {
      const assetId = String(asset.id);
      const meta = TRACKED_META_BY_ID.get(assetId);
      if (!meta || meta.detailProvider !== "defillama" || !meta.geckoId) return [];

      if (sumPegBuckets(asset.circulating) <= 0) {
        return [meta.geckoId];
      }

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
  const candidates = buildSupplyGapCandidates(assets, currentMarketCaps);
  if (candidates.length === 0) {
    return { reconciledCount: 0, reconciledIds: [] };
  }

  const nowMs = Date.now();
  const reconciledIds: string[] = [];

  for (const candidate of candidates) {
    const marketCaps = candidate.kind === "zero-supply-collapse"
      ? await fetchRecentDefiLlamaMarketCaps(candidate.llamaId, candidate.pegKey, signal)
      : await fetchRecentCoinGeckoMarketCaps(candidate.geckoId, signal, coingeckoApiKey);
    if (marketCaps.length === 0) continue;

    const currentFromHistory = findNearestMarketCap(marketCaps, nowMs, MAX_CURRENT_POINT_AGE_MS);
    const day = findNearestMarketCap(marketCaps, nowMs - (24 * 60 * 60 * 1000), MAX_LOOKBACK_POINT_DISTANCE_MS);
    const week = findNearestMarketCap(marketCaps, nowMs - (7 * 24 * 60 * 60 * 1000), MAX_LOOKBACK_POINT_DISTANCE_MS);
    const month = findNearestMarketCap(marketCaps, nowMs - (30 * 24 * 60 * 60 * 1000), MAX_LOOKBACK_POINT_DISTANCE_MS);

    if (currentFromHistory == null || day == null || week == null || month == null) {
      continue;
    }
    if (candidate.kind === "zero-supply-collapse" && currentFromHistory < DEFILLAMA_ZERO_SUPPLY_MIN_MARKET_CAP) {
      continue;
    }

    const totals = {
      current: currentFromHistory,
      day,
      week,
      month,
    };

    candidate.asset.circulating = { [candidate.pegKey]: totals.current };
    candidate.asset.circulatingPrevDay = { [candidate.pegKey]: totals.day };
    candidate.asset.circulatingPrevWeek = { [candidate.pegKey]: totals.week };
    candidate.asset.circulatingPrevMonth = { [candidate.pegKey]: totals.month };
    candidate.asset.supplySource = candidate.kind === "zero-supply-collapse"
      ? "defillama-history-gap-fill"
      : "coingecko-gap-fill";
    candidate.asset.chains = buildKnownDisplayChains(candidate.asset.id, candidate.asset.chains);

    if (candidate.kind === "missing-chain") {
      applySingleMissingChainRemainder(candidate, totals);
    }
    reconciledIds.push(candidate.asset.id);
  }

  return {
    reconciledCount: reconciledIds.length,
    reconciledIds,
  };
}

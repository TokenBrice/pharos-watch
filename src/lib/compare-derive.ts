/**
 * Pure derivation functions extracted from use-compare-data-model.
 * Keeping these separate makes them independently testable.
 */

import { COMPARE_COLORS } from "@/lib/compare-config";
import type {
  BluechipRating,
  DexLiquidityData,
  DexLiquidityMap,
  MintBurnCoinFlow,
  MintBurnPerCoinResponse,
  PegSummaryCoin,
  RedemptionBackstopEntry,
  ReportCardGrade,
  StablecoinData,
  StressSignalEntry,
  SupplyHistoryPoint,
  YieldRanking,
} from "@shared/types";
import type { StablecoinClientDetailMeta } from "@shared/types/stablecoin-client-meta";
import type {
  V9ConsumerCard,
  V9ConsumerIdentity,
} from "@/lib/safety-score-v9-consumers";
import type { NetFlowDirection24h, PressureShiftState } from "@shared/lib/mint-burn-signals";
import type { CompareRadarCohort } from "@/components/radar-chart-v9";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";

export type ComparisonMeta = Pick<
  StablecoinClientDetailMeta,
  | "blacklistStatus"
  | "collateralQuality"
  | "commodityOunces"
  | "custodyModel"
  | "flags"
  | "frozenAt"
  | "genius"
  | "id"
  | "launchDate"
  | "mechanismArchetype"
  | "mica"
  | "mintAuthoritySummary"
  | "name"
  | "reserves"
  | "status"
  | "symbol"
  | "variantKind"
  | "variantOf"
  | "yieldConfig"
>;

export interface ComparisonCoinEntry {
  id: string;
  symbol: string;
  name: string;
  data: StablecoinData;
  meta: ComparisonMeta;
  pegDetails?: PegSummaryCoin | null;
  liquidity?: DexLiquidityData | null;
  safetyCard?: V9ConsumerCard | null;
  redemption?: RedemptionBackstopEntry | null;
  yield?: YieldRanking | null;
  stress?: StressSignalEntry | null;
  flow?: MintBurnCoinFlow | null;
  bluechipRating?: BluechipRating | null;
}

export interface SupplySeriesEntry {
  id: string;
  label: string;
  data: { ts: number; value: number }[];
  color: string;
}

export interface FlowSeriesEntry {
  id: string;
  label: string;
  color: string;
  data: { ts: number; netFlowUsd: number }[];
}

export interface FlowCardEntry {
  id: string;
  symbol: string;
  color: string;
  netFlow24hUsd: number;
  pressureShiftScore: number | null;
  netFlowDirection24h: NetFlowDirection24h;
  pressureShiftState: PressureShiftState;
}

export interface CompareRadarCardEntry {
  card: V9ConsumerCard;
  identity: V9ConsumerIdentity;
  color: string;
  symbol: string;
}

export interface CompareRadarCohortBaseline {
  effectiveCohort: CompareRadarCohort;
  series: Array<Omit<CompareRadarCardEntry, "symbol">>;
  memberCount: number;
}

/**
 * Build the radar median baseline for the selected cohort. Peg and mechanism
 * cohorts with fewer than three rated members fall back to all rated cards.
 */
export function buildCompareRadarCohortBaseline(
  cards: readonly V9ConsumerCard[] | null | undefined,
  selectedRadarCards: readonly CompareRadarCardEntry[],
  cohort: CompareRadarCohort,
): CompareRadarCohortBaseline {
  const allCards = cards ?? [];
  if (allCards.length === 0 || selectedRadarCards.length === 0) {
    return {
      effectiveCohort: "all",
      series: [],
      memberCount: 0,
    };
  }

  const leadMeta = TRACKED_META_BY_ID.get(selectedRadarCards[0].card.id);
  const leadPeg = leadMeta?.flags.pegCurrency ?? null;
  const leadMechanism = leadMeta?.mechanismArchetype ?? null;
  const cohortCards =
    cohort === "peg"
      ? allCards.filter((card) => TRACKED_META_BY_ID.get(card.id)?.flags.pegCurrency === leadPeg)
      : cohort === "mechanism"
        ? allCards.filter((card) => TRACKED_META_BY_ID.get(card.id)?.mechanismArchetype === leadMechanism)
        : allCards;
  const useAllCards = cohort === "all" || cohortCards.length < 3;
  const resolvedCards = useAllCards ? allCards : cohortCards;

  return {
    effectiveCohort: useAllCards ? "all" : cohort,
    series: resolvedCards.map((card) => ({
      card,
      identity: selectedRadarCards[0].identity,
      color: "#64748b",
    })),
    memberCount: resolvedCards.length,
  };
}

/**
 * Build the comparison coin list from the asset map, meta registry, and
 * optional score sources. Returns only coins that have both asset data and
 * metadata present.
 */
export function deriveComparisonCoins({
  selectedIds,
  assetMap,
  metaMap,
  pegCoinMap,
  dexData,
  cardMap,
  flowCoinMap,
  bluechipMap,
  redemptionMap,
  yieldMap,
  stressMap,
}: {
  selectedIds: string[];
  assetMap: Map<string, StablecoinData>;
  metaMap: ReadonlyMap<string, ComparisonMeta>;
  pegCoinMap: Map<string, PegSummaryCoin>;
  dexData: DexLiquidityMap | undefined;
  cardMap: Map<string, V9ConsumerCard>;
  flowCoinMap: Map<string, MintBurnCoinFlow>;
  bluechipMap?: Record<string, BluechipRating> | null;
  redemptionMap?: Record<string, RedemptionBackstopEntry>;
  yieldMap?: Map<string, YieldRanking>;
  stressMap?: Record<string, StressSignalEntry>;
}): ComparisonCoinEntry[] {
  if (assetMap.size === 0) return [];
  return selectedIds
    .map((id) => {
      const data = assetMap.get(id);
      const meta = metaMap.get(id);
      if (!data || !meta) return null;
      const pegCoin = pegCoinMap.get(id);
      const dexCoin = dexData?.[id];
      const flowCoin = flowCoinMap.get(id);
      return {
        id,
        symbol: data.symbol,
        name: data.name,
        data,
        meta,
        pegDetails: pegCoin ?? null,
        liquidity: dexCoin ?? null,
        safetyCard: cardMap.get(id) ?? null,
        redemption: redemptionMap?.[id] ?? null,
        yield: yieldMap?.get(id) ?? null,
        stress: stressMap?.[id] ?? null,
        flow: flowCoin ?? null,
        bluechipRating: bluechipMap?.[id] ?? null,
      };
    })
    .filter((coin): coin is NonNullable<typeof coin> => coin != null);
}

/**
 * Build chart-ready supply series from per-coin history queries.
 */
export function deriveSupplySeries({
  selectedIds,
  histories,
  metaMap,
}: {
  selectedIds: string[];
  histories: (SupplyHistoryPoint[] | undefined)[];
  metaMap: ReadonlyMap<string, { name?: string; symbol?: string }>;
}): SupplySeriesEntry[] {
  return selectedIds
    .map((id, index) => {
      const history = histories[index] ?? [];
      if (history.length === 0) return null;
      const meta = metaMap.get(id);
      return {
        id,
        label: meta?.name ?? id,
        data: history.map((point) => ({ ts: point.date * 1000, value: point.circulatingUsd })),
        color: COMPARE_COLORS[index % COMPARE_COLORS.length],
      };
    })
    .filter((series): series is NonNullable<typeof series> => series != null);
}

/**
 * Build chart-ready hourly flow series from per-coin flow query results.
 */
export function deriveFlowSeries({
  selectedIds,
  flowDetails,
  metaMap,
}: {
  selectedIds: string[];
  flowDetails: (MintBurnPerCoinResponse | undefined)[];
  metaMap: ReadonlyMap<string, { symbol?: string }>;
}): FlowSeriesEntry[] {
  return selectedIds
    .map((id, index) => {
      const detail = flowDetails[index];
      if (!detail?.hourly?.length) return null;
      const meta = metaMap.get(id);
      return {
        id,
        label: meta?.symbol ?? id,
        color: COMPARE_COLORS[index % COMPARE_COLORS.length],
        data: detail.hourly.map((bucket) => ({ ts: bucket.hourTs * 1000, netFlowUsd: bucket.netFlowUsd })),
      };
    })
    .filter((series): series is NonNullable<typeof series> => series != null);
}

/**
 * Build flow card entries from the flow coin map for the selected ids.
 */
export function deriveFlowCardData({
  selectedIds,
  flowCoinMap,
  metaMap,
}: {
  selectedIds: string[];
  flowCoinMap: Map<string, MintBurnCoinFlow>;
  metaMap: ReadonlyMap<string, { symbol?: string }>;
}): FlowCardEntry[] {
  if (flowCoinMap.size === 0) return [];
  return selectedIds
    .map((id, index) => {
      const coin = flowCoinMap.get(id);
      if (!coin) return null;
      const meta = metaMap.get(id);
      return {
        id,
        symbol: meta?.symbol ?? id,
        color: COMPARE_COLORS[index % COMPARE_COLORS.length],
        netFlow24hUsd: coin.netFlow24hUsd,
        pressureShiftScore: coin.pressureShiftScore ?? null,
        netFlowDirection24h: coin.netFlowDirection24h ?? "inactive",
        pressureShiftState: coin.pressureShiftState ?? "nr",
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry != null);
}

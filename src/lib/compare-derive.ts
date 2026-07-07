/**
 * Pure derivation functions extracted from use-compare-data-model.
 * Keeping these separate makes them independently testable.
 */

import { COMPARE_COLORS } from "@/lib/compare-config";
import type {
  MintBurnPerCoinResponse,
  ReportCard,
  ReportCardGrade,
  StablecoinData,
  StablecoinMeta,
  SupplyHistoryPoint,
} from "@shared/types";
import type { NetFlowDirection24h, PressureShiftState } from "@shared/lib/mint-burn-signals";

export type ComparisonMeta = Pick<
  StablecoinMeta,
  "commodityOunces" | "flags" | "frozenAt" | "id" | "name" | "status" | "symbol"
>;

export interface ComparisonCoinEntry {
  id: string;
  symbol: string;
  name: string;
  data: StablecoinData;
  meta: ComparisonMeta;
  pegScore: number | null;
  liquidityScore: number | null;
  safetyGrade: ReportCardGrade | null;
  netFlow30d: number | null;
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

type PegCoinSlice = {
  id: string;
  pegScore?: number | null;
};

type DexDataMap = Record<string, { liquidityScore?: number | null } | undefined>;

type FlowCoinSlice = {
  stablecoinId: string;
  netFlow30dUsd?: number | null;
  netFlow24hUsd: number;
  pressureShiftScore?: number | null;
  netFlowDirection24h?: NetFlowDirection24h | null;
  pressureShiftState?: PressureShiftState | null;
};

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
}: {
  selectedIds: string[];
  assetMap: Map<string, StablecoinData>;
  metaMap: ReadonlyMap<string, ComparisonMeta>;
  pegCoinMap: Map<string, PegCoinSlice>;
  dexData: DexDataMap | undefined;
  cardMap: Map<string, ReportCard>;
  flowCoinMap: Map<string, FlowCoinSlice>;
}): ComparisonCoinEntry[] {
  if (assetMap.size === 0) return [];
  return selectedIds
    .map((id) => {
      const data = assetMap.get(id);
      const meta = metaMap.get(id);
      if (!data || !meta) return null;
      const pegCoin = pegCoinMap.get(id);
      const dexCoin = dexData?.[id];
      const safetyGrade = cardMap.get(id)?.overallGrade ?? null;
      const flowCoin = flowCoinMap.get(id);
      return {
        id,
        symbol: data.symbol,
        name: data.name,
        data,
        meta,
        pegScore: pegCoin?.pegScore ?? null,
        liquidityScore: dexCoin?.liquidityScore ?? null,
        safetyGrade,
        netFlow30d: flowCoin?.netFlow30dUsd ?? null,
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
  flowCoinMap: Map<string, FlowCoinSlice>;
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

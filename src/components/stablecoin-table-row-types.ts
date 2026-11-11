import type { ColumnId } from "@/hooks/use-preferences";
import type { TableDensity } from "@/hooks/use-table-density";
import type { DexLiquidityTableMap } from "@shared/types/dex-liquidity";
import type { PegSummaryCoin } from "@shared/types/peg";
import type { StablecoinData } from "@shared/types/supply";
import type { V9SafetyTableRow } from "@/lib/safety-score-v9-consumers";

export type StablecoinTableRowVariant = "default" | "figmaOverview";

export interface StablecoinVirtualRowProps {
  coin: StablecoinData;
  rank: number;
  virtualIndex?: number;
  isStriped: boolean;
  densityConfig: {
    rowHeight: number;
    iconSize: number;
  };
  density: TableDensity;
  variant?: StablecoinTableRowVariant;
  isVisible: (id: ColumnId) => boolean;
  logos?: Record<string, string>;
  pegScores?: Map<string, PegSummaryCoin>;
  dexLiquidity?: DexLiquidityTableMap;
  reportCards?: Record<string, V9SafetyTableRow>;
  showPinnedControl?: boolean;
  isPinned?: boolean;
  onTogglePinned?: (coinId: string) => void;
  onNavigate: (coinId: string) => void;
  onPrefetch: (coinId: string) => void;
  isCursor?: boolean;
  onCursorMouseEnter?: (index: number) => void;
  measureElement?: (element: HTMLTableRowElement | null) => void;
}

export type StablecoinTableRowCellProps = Omit<
  StablecoinVirtualRowProps,
  "virtualIndex" | "isStriped" | "onNavigate" | "isCursor" | "onCursorMouseEnter" | "measureElement"
>;

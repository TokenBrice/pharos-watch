"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";
import { usePinnedStablecoins } from "@/hooks/use-pinned-stablecoins";
import { getCoreNonUsdPeg } from "@shared/lib/alt-peg-snapshot";
import type { AltPegDistributionRow } from "@/lib/alt-peg-market";
import type {
  DexLiquidityTableMap,
  PegCurrency,
  PegSummaryCoin,
  StablecoinData,
} from "@shared/types";
import type { V9SafetyTableRow } from "@/lib/safety-score-v9-consumers";
import type { StablecoinTableSourceGenerations } from "@/components/stablecoin-table-logic";

const StablecoinTable = dynamic(
  () => import("@/components/stablecoin-table").then((mod) => mod.StablecoinTable),
  { loading: () => <Skeleton className="h-[720px] w-full rounded-xl" /> },
);

const EMPTY_FILTERS: readonly never[] = [];

interface AltPegStablecoinTableProps {
  data: StablecoinData[] | undefined;
  isLoading: boolean;
  /** True when the stablecoins read failed and retained nothing. */
  unavailable?: boolean;
  /** Ranking rows: the peg options and counts, from the same core universe as the table. */
  pegRows: readonly AltPegDistributionRow[];
  selectedPeg: PegCurrency | null;
  onSelectPeg: (peg: PegCurrency | null) => void;
  logos?: Record<string, string>;
  pegScores?: Map<string, PegSummaryCoin>;
  dexLiquidity?: DexLiquidityTableMap;
  reportCards?: Record<string, V9SafetyTableRow>;
  sourceGenerations?: StablecoinTableSourceGenerations;
}

/**
 * Core non-USD coins (the hero's universe), narrowed by the ranking's `?peg=`
 * filter. Non-core coins stay reachable from their dossiers and the screener.
 */
export function AltPegStablecoinTable({
  data,
  isLoading,
  unavailable = false,
  pegRows,
  selectedPeg,
  onSelectPeg,
  logos,
  pegScores,
  dexLiquidity,
  reportCards,
  sourceGenerations,
}: AltPegStablecoinTableProps) {
  const pinnedStablecoins = usePinnedStablecoins();

  const filteredData = useMemo(() => {
    if (!data) return undefined;
    const seen = new Set<string>();
    return data.filter((coin) => {
      const peg = getCoreNonUsdPeg(coin.id);
      if (peg === null || seen.has(coin.id)) return false;
      seen.add(coin.id);
      return selectedPeg === null || peg === selectedPeg;
    });
  }, [data, selectedPeg]);
  const totalCount = pegRows.reduce((sum, row) => sum + row.coinCount, 0);
  const selectedRow = pegRows.find((row) => row.peg === selectedPeg) ?? null;

  return (
    <section id="alt-peg-table" aria-labelledby="alt-peg-table-title" className="scroll-mt-24 space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 id="alt-peg-table-title" className="pharos-section-title">
            {selectedRow ? `${selectedRow.label} coins` : "Non-USD coins"}
          </h2>
          <p className="pharos-meta">
            Core coins only; wrapped and yield variants live on each coin&apos;s page and in the screener.
          </p>
        </div>
        <label className="flex w-full flex-col gap-1 text-xs text-muted-foreground md:hidden">
          Peg
          <select
            className="pharos-focus-ring min-h-11 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
            value={selectedPeg ?? ""}
            onChange={(event) => onSelectPeg((event.target.value || null) as PegCurrency | null)}
          >
            <option value="">All pegs ({totalCount})</option>
            {pegRows.map((row) => (
              <option key={row.peg} value={row.peg}>
                {row.label} ({row.coinCount})
              </option>
            ))}
          </select>
        </label>
      </div>

      <StablecoinTable
        data={filteredData}
        isLoading={isLoading}
        activeFilters={EMPTY_FILTERS}
        unavailable={unavailable}
        logos={logos}
        pegScores={pegScores}
        dexLiquidity={dexLiquidity}
        reportCards={reportCards}
        sourceGenerations={sourceGenerations}
        pinnedStablecoinIds={pinnedStablecoins.pinnedIds}
        onTogglePinnedStablecoin={pinnedStablecoins.togglePinned}
      />
    </section>
  );
}

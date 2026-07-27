"use client";

import { useCallback, useMemo } from "react";
import dynamic from "next/dynamic";
import { HomepageSectionBand } from "@/components/homepage-sections";
import { Skeleton } from "@/components/ui/skeleton";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { usePinnedStablecoins } from "@/hooks/use-pinned-stablecoins";
import { CLIENT_ACTIVE_STABLECOINS as ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import { buildAltPegLinkHubGroups } from "@/lib/alt-peg-market";
import type {
  DexLiquidityMap,
  PegCurrency,
  PegSummaryCoin,
  StablecoinData,
} from "@shared/types";
import type { V9SafetyTableRow } from "@/lib/safety-score-v9-consumers";

const StablecoinTable = dynamic(
  () => import("@/components/stablecoin-table").then((mod) => mod.StablecoinTable),
  { loading: () => <Skeleton className="h-[720px] w-full rounded-xl" /> },
);

const ALT_PEG_GROUPS = buildAltPegLinkHubGroups();

const PEG_BY_PARAM = new Map<string, PegCurrency>(
  ALT_PEG_GROUPS.flatMap((group) =>
    group.items.map((item) => [item.peg.toLowerCase(), item.peg]),
  ),
);

const ALL_NON_USD_COIN_COUNT = ACTIVE_STABLECOINS.filter(
  (sc) => sc.flags.pegCurrency !== "USD",
).length;

const EMPTY_FILTERS: readonly never[] = [];

interface AltPegStablecoinTableProps {
  data: StablecoinData[] | undefined;
  isLoading: boolean;
  logos?: Record<string, string>;
  pegRates?: Record<string, number>;
  pegScores?: Map<string, PegSummaryCoin>;
  dexLiquidity?: DexLiquidityMap;
  reportCards?: Record<string, V9SafetyTableRow>;
}

export function AltPegStablecoinTable({
  data,
  isLoading,
  logos,
  pegRates,
  pegScores,
  dexLiquidity,
  reportCards,
}: AltPegStablecoinTableProps) {
  const { searchParams, setParam } = useUrlFilters();
  const pinnedStablecoins = usePinnedStablecoins();

  const rawPeg = searchParams.get("peg");
  const selectedPeg = useMemo<PegCurrency | null>(() => {
    if (!rawPeg) return null;
    return PEG_BY_PARAM.get(rawPeg.toLowerCase()) ?? null;
  }, [rawPeg]);

  const setSelectedPeg = useCallback(
    (peg: PegCurrency | null) => {
      setParam("peg", peg ? peg.toLowerCase() : "");
    },
    [setParam],
  );

  const trackedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const sc of ACTIVE_STABLECOINS) {
      if (sc.flags.pegCurrency === "USD") continue;
      if (selectedPeg && sc.flags.pegCurrency !== selectedPeg) continue;
      ids.add(sc.id);
    }
    return ids;
  }, [selectedPeg]);

  const filteredData = useMemo(() => {
    if (!data) return undefined;
    return data.filter((coin) => trackedIds.has(coin.id));
  }, [data, trackedIds]);

  return (
    <section id="alt-peg-table" aria-label="Alt-peg stablecoin browser" className="scroll-mt-24 space-y-4">
      <HomepageSectionBand
        eyebrow="Cohort Details"
        title="Drill Into Each Alt-Peg Cohort"
        description="Browse every tracked non-USD stablecoin. Use the chips to narrow to a specific peg."
      />

      <AltPegChipStrip
        groups={ALT_PEG_GROUPS}
        allCount={ALL_NON_USD_COIN_COUNT}
        selected={selectedPeg}
        onSelect={setSelectedPeg}
      />

      <StablecoinTable
        data={filteredData}
        isLoading={isLoading}
        activeFilters={EMPTY_FILTERS}
        logos={logos}
        pegRates={pegRates}
        pegScores={pegScores}
        dexLiquidity={dexLiquidity}
        reportCards={reportCards}
        pinnedStablecoinIds={pinnedStablecoins.pinnedIds}
        onTogglePinnedStablecoin={pinnedStablecoins.togglePinned}
      />
    </section>
  );
}

interface AltPegChipStripProps {
  groups: ReturnType<typeof buildAltPegLinkHubGroups>;
  allCount: number;
  selected: PegCurrency | null;
  onSelect: (peg: PegCurrency | null) => void;
}

function AltPegChipStrip({ groups, allCount, selected, onSelect }: AltPegChipStripProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="pharos-kicker">Filter by peg</h3>
        {selected && (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="pharos-focus-ring text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            Clear
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70 mr-0.5">
            All
          </span>
          <AltPegChipButton
            label="All Alt-Pegs"
            count={allCount}
            colorHex="#94a3b8"
            isSelected={selected === null}
            onClick={() => onSelect(null)}
          />
        </div>
        {groups.map((group) => (
          <div key={group.label} className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70 mr-0.5">
              {group.label}
            </span>
            {group.items.map((item) => (
              <AltPegChipButton
                key={item.peg}
                label={item.label}
                count={item.coinCount}
                colorHex={item.colorHex}
                isSelected={selected === item.peg}
                onClick={() => onSelect(item.peg)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

interface AltPegChipButtonProps {
  label: string;
  count: number;
  colorHex: string;
  isSelected: boolean;
  onClick: () => void;
}

function AltPegChipButton({ label, count, colorHex, isSelected, onClick }: AltPegChipButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isSelected}
      className={
        isSelected
          ? "pharos-focus-ring pharos-control-pill pharos-control-pill-active gap-2"
          : "pharos-focus-ring pharos-control-pill gap-2"
      }
    >
      <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: colorHex }} aria-hidden="true" />
      <span>{label}</span>
      <span className="pharos-numeric text-[11px] text-muted-foreground/80">{count}</span>
    </button>
  );
}

"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDecimal } from "@shared/lib/format";
import type { BlacklistStablecoin, BlacklistSummaryResponse } from "@shared/types";
import { useIsMobile } from "@/hooks/use-is-mobile";

interface SovereigntyLatticeProps {
  coverage: BlacklistSummaryResponse["coverage"] | undefined;
  stats: BlacklistSummaryResponse["stats"] | undefined;
  chains: BlacklistSummaryResponse["chains"];
  isLoading: boolean;
  onCellSelect: (selection: { stablecoin: BlacklistStablecoin; chainId: string }) => void;
}

interface LatticeRow {
  stablecoin: BlacklistStablecoin;
  supportedChains: Set<string>;
  eventCount: number;
  frozenTotal: number;
}

const MOBILE_CHAIN_COLUMN_LIMIT = 4;

function formatCount(value: number): string {
  return formatDecimal(Number.isFinite(value) ? value : 0, 0, 0);
}

function buildRows(
  coverage: BlacklistSummaryResponse["coverage"] | undefined,
  stats: BlacklistSummaryResponse["stats"] | undefined,
): LatticeRow[] {
  const rowsByStablecoin = new Map<BlacklistStablecoin, LatticeRow>();

  for (const item of coverage?.supported ?? []) {
    const row = rowsByStablecoin.get(item.symbol) ?? {
      stablecoin: item.symbol,
      supportedChains: new Set<string>(),
      eventCount: stats?.perCoinTotalEvents[item.symbol] ?? 0,
      frozenTotal: stats?.perCoinFrozenTotal[item.symbol] ?? 0,
    };
    row.supportedChains.add(item.chainId);
    rowsByStablecoin.set(item.symbol, row);
  }

  return [...rowsByStablecoin.values()].sort((a, b) => {
    if (b.eventCount !== a.eventCount) return b.eventCount - a.eventCount;
    if (b.supportedChains.size !== a.supportedChains.size) return b.supportedChains.size - a.supportedChains.size;
    return a.stablecoin.localeCompare(b.stablecoin);
  });
}

export function SovereigntyLattice({ coverage, stats, chains, isLoading, onCellSelect }: SovereigntyLatticeProps) {
  const isMobile = useIsMobile();

  if (isLoading) {
    return (
      <section className="pharos-card-shell overflow-hidden">
        <div className="pharos-panel-header space-y-2">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-6 w-80 max-w-full" />
        </div>
        <div className="p-4 sm:p-5">
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </section>
    );
  }

  const rows = buildRows(coverage, stats);
  const visibleChains = chains.filter((chain) => rows.some((row) => row.supportedChains.has(chain.id)));
  const chainColumnLimit = isMobile ? MOBILE_CHAIN_COLUMN_LIMIT : visibleChains.length;
  const compactVisibleChains = visibleChains.slice(0, chainColumnLimit);
  const hasMoreChains = compactVisibleChains.length < visibleChains.length;
  const hiddenChains = hasMoreChains ? visibleChains.slice(compactVisibleChains.length) : [];
  const hiddenChainIds = new Set(hiddenChains.map((chain) => chain.id));
  const chainTrackDefinition = isMobile ? "2.75rem" : "minmax(2.5rem, 1fr)";
  const moreChainTrackDefinition = isMobile ? "2.75rem" : "2.5rem";
  const gridTemplateColumns = `7rem repeat(${compactVisibleChains.length}, ${chainTrackDefinition}) ${hasMoreChains ? `${moreChainTrackDefinition} ` : ""}5rem 6rem`;

  return (
    <section
      className="pharos-card-shell min-w-0 overflow-hidden animate-in fade-in duration-300"
      aria-labelledby="sovereignty-lattice-title"
    >
      <div className="pharos-panel-header flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <p className="pharos-kicker">Sovereignty Lattice</p>
          <h2 id="sovereignty-lattice-title" className="pharos-section-title">
            Where issuers can freeze you — by stablecoin and chain
          </h2>
        </div>
        <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
          Each frosted cell is a contract Pharos actively watches for issuer freezes. Empty cells mean no coverage, not
          no risk. Click a cell to filter the event ledger below.
        </p>
      </div>

      <div className="min-w-0 max-w-full overflow-x-auto p-4 sm:p-5">
        {rows.length > 0 && visibleChains.length > 0 ? (
          <div
            className="grid gap-1"
            style={{
              minWidth: isMobile ? "34rem" : "820px",
              gridTemplateColumns,
            }}
          >
            <div className="text-xs font-semibold uppercase text-muted-foreground">Stablecoin</div>
            {compactVisibleChains.map((chain) => (
              <div
                key={chain.id}
                className="truncate text-center text-xs font-semibold uppercase text-muted-foreground"
              >
                {chain.name}
              </div>
            ))}
            {hasMoreChains ? (
              <div className="text-center text-xs font-semibold uppercase text-muted-foreground">
                +{hiddenChains.length}
              </div>
            ) : null}
            <div className="text-right text-xs font-semibold uppercase text-muted-foreground">Events</div>
            <div className="text-right text-xs font-semibold uppercase text-muted-foreground">Frozen</div>

            {rows.map((row) => (
              <LatticeRowCells
                key={row.stablecoin}
                row={row}
                chains={compactVisibleChains}
                hiddenChainIds={hiddenChainIds}
                onCellSelect={onCellSelect}
                hasMoreChains={hasMoreChains}
              />
            ))}
          </div>
        ) : (
          <div className="flex min-h-56 items-center justify-center rounded-xl border border-border/60 bg-muted/20 text-sm text-muted-foreground">
            No live coverage configurations in the current summary.
          </div>
        )}
      </div>
    </section>
  );
}

function LatticeRowCells({
  row,
  chains,
  hiddenChainIds,
  onCellSelect,
  hasMoreChains,
}: {
  row: LatticeRow;
  chains: BlacklistSummaryResponse["chains"];
  onCellSelect: SovereigntyLatticeProps["onCellSelect"];
  hiddenChainIds: Set<string>;
  hasMoreChains: boolean;
}) {
  const hiddenSupportedCount = [...row.supportedChains].filter((chainId) => hiddenChainIds.has(chainId)).length;

  return (
    <>
      <div className="flex h-11 items-center rounded-l-lg border border-border/60 bg-background/70 px-2 font-mono text-xs font-semibold text-foreground sm:h-9">
        {row.stablecoin}
      </div>
      {chains.map((chain) => {
        const supported = row.supportedChains.has(chain.id);
        return (
          <button
            key={`${row.stablecoin}-${chain.id}`}
            type="button"
            disabled={!supported}
            aria-label={`${row.stablecoin} ${chain.name} coverage ${supported ? "supported" : "not supported"}`}
            title={`${row.stablecoin} on ${chain.name}`}
            className={cn(
              "relative h-11 min-w-11 overflow-hidden border border-border/60 text-xs transition-colors sm:h-9 sm:min-w-0",
              supported
                ? "pharos-focus-ring bg-frost-blue/35 text-foreground hover:bg-frost-blue/55"
                : "cursor-not-allowed bg-muted/15 text-muted-foreground/40",
            )}
            onClick={() => {
              if (supported) onCellSelect({ stablecoin: row.stablecoin, chainId: chain.id });
            }}
          >
            {supported ? (
              <>
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0"
                  style={{
                    backgroundImage:
                      "repeating-linear-gradient(135deg, oklch(1 0 0 / 0.18) 0 1.5px, transparent 1.5px 5px)",
                  }}
                />
                <span className="relative">●</span>
              </>
            ) : (
              ""
            )}
          </button>
        );
      })}
      {hasMoreChains ? (
        <div className="flex h-11 items-center justify-center border border-border/60 bg-background/70 px-2 text-xs text-muted-foreground sm:h-9">
          {hiddenSupportedCount > 0 ? `+${hiddenSupportedCount}` : ""}
        </div>
      ) : null}
      <div className="flex h-11 items-center justify-end border border-border/60 bg-background/70 px-2 pharos-numeric text-xs text-muted-foreground sm:h-9">
        {formatCount(row.eventCount)}
      </div>
      <div className="flex h-11 items-center justify-end rounded-r-lg border border-border/60 bg-background/70 px-2 pharos-numeric text-xs text-muted-foreground sm:h-9">
        {row.frozenTotal > 0 ? formatCurrency(row.frozenTotal, 0) : "—"}
      </div>
    </>
  );
}

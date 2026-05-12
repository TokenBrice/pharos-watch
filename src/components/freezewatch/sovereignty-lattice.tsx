"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@shared/lib/format";
import type { BlacklistStablecoin, BlacklistSummaryResponse } from "@shared/types";

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

const COUNT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

function formatCount(value: number): string {
  return COUNT_FORMATTER.format(Number.isFinite(value) ? value : 0);
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
  const visibleChains = chains.filter((chain) =>
    rows.some((row) => row.supportedChains.has(chain.id)),
  );

  return (
    <section
      className="pharos-card-shell overflow-hidden animate-in fade-in duration-300"
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

      <div className="overflow-x-auto p-4 sm:p-5">
        {rows.length > 0 && visibleChains.length > 0 ? (
          <div
            className="grid min-w-[820px] gap-1"
            style={{
              gridTemplateColumns: `7rem repeat(${visibleChains.length}, minmax(2.5rem, 1fr)) 5rem 6rem`,
            }}
          >
            <div className="text-xs font-semibold uppercase text-muted-foreground">Stablecoin</div>
            {visibleChains.map((chain) => (
              <div key={chain.id} className="truncate text-center text-xs font-semibold uppercase text-muted-foreground">
                {chain.name}
              </div>
            ))}
            <div className="text-right text-xs font-semibold uppercase text-muted-foreground">Events</div>
            <div className="text-right text-xs font-semibold uppercase text-muted-foreground">Frozen</div>

            {rows.map((row) => (
              <LatticeRowCells
                key={row.stablecoin}
                row={row}
                chains={visibleChains}
                onCellSelect={onCellSelect}
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
  onCellSelect,
}: {
  row: LatticeRow;
  chains: BlacklistSummaryResponse["chains"];
  onCellSelect: SovereigntyLatticeProps["onCellSelect"];
}) {
  return (
    <>
      <div className="flex h-9 items-center rounded-l-lg border border-border/60 bg-background/70 px-2 font-mono text-xs font-semibold text-foreground">
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
              "relative h-9 overflow-hidden border border-border/60 text-xs transition-colors",
              supported
                ? "bg-frost-blue/35 text-foreground hover:bg-frost-blue/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-frost-blue focus-visible:ring-offset-2"
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
      <div className="flex h-9 items-center justify-end border border-border/60 bg-background/70 px-2 font-mono text-xs tabular-nums text-muted-foreground">
        {formatCount(row.eventCount)}
      </div>
      <div className="flex h-9 items-center justify-end rounded-r-lg border border-border/60 bg-background/70 px-2 font-mono text-xs tabular-nums text-muted-foreground">
        {row.frozenTotal > 0 ? formatCurrency(row.frozenTotal, 0) : "—"}
      </div>
    </>
  );
}

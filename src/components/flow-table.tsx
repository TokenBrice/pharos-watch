"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  TableCell,
  TableRow,
  TableToolbarFrame,
} from "@/components/table";
import {
  DataTableEmptyRow,
  DataTableLoadingRows,
  DataTableShell,
  type DataTableColumn,
} from "@/components/data-table-shell";
import { StablecoinIdentity } from "@/components/stablecoin-identity";
import { InteractiveTableRow } from "@/components/interactive-table-row";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { logosById } from "@/lib/logos";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { useSortedTableRows } from "@/hooks/use-sorted-table-rows";
import { formatCurrency, formatSignedCurrency, getNetColor, getNetPrefix } from "@shared/lib/format";
import { resolveMintBurnValuation } from "@shared/lib/mint-burn-valuation";
import { getPressureShiftDisplay } from "@/lib/flow-intensity";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import type { MintBurnCoinFlow } from "@shared/types";
import { cn } from "@/lib/utils";
import {
  compareFlowRows,
  getCoverageBadge,
  getPressureScore,
  getPressureState,
  PRESSURE_VALUE_CLASS,
  type FlowTableSortKey,
} from "@/components/flow-table-logic";
import { MethodologyHint } from "@/components/methodology-hint";
import { OpsStatusChip } from "@/components/ops-status-chip";
import { FlowSignedNetValue, FlowVolumeValue } from "@/components/flow-valuation-value";
import { hasCompleteCoinScan, inferHas24hActivity, resolveCoinNetFlow, type MintBurnNetWindow } from "@shared/lib/mint-burn-coin-helpers";
import { RUN_LINE_EXCLUSION_LABELS, resolveRunLineExclusionReason } from "@/lib/flow-run-line-model";
import type { MintBurnSignedNetView } from "@shared/lib/mint-burn-valuation-display";
import { stablecoinLabel } from "@/lib/stablecoin-label";

interface FlowTableProps {
  coins: MintBurnCoinFlow[];
  isLoading: boolean;
}

const UNKNOWN_MARKED_WINDOWS = ["24h", "7d", "30d", "90d"] as const satisfies readonly MintBurnNetWindow[];
type UnknownCounts = Record<(typeof UNKNOWN_MARKED_WINDOWS)[number], number>;

/**
 * Coverage-unknown nets (legacy hours aggregated before valuation completeness
 * was recorded) keep their known-valuation value. The state is named once per
 * column as a chip with the count, rather than as a `*` on nearly every cell.
 */
function UnknownCoverageChip({ count, total, windowLabel }: { count: number; total: number; windowLabel: string }) {
  return (
    <OpsStatusChip label="Unverified" reasonCodes={["valuation-unknown"]} className="px-1.5 text-3xs">
      <p>
        {count} of {total} {windowLabel} nets include hours aggregated before valuation completeness was recorded, so
        their coverage is unknown. Each shows its known-valuation net; the screen-reader reading marks the affected
        cells.
      </p>
      <p className="text-muted-foreground">These hours age out of the window; nothing reconstructs them.</p>
    </OpsStatusChip>
  );
}

function buildFlowTableColumns(unknown: UnknownCounts, total: number): readonly DataTableColumn<FlowTableSortKey>[] {
  const chip = (window: keyof UnknownCounts, windowLabel: string) =>
    unknown[window] > 0 ? <UnknownCoverageChip count={unknown[window]} total={total} windowLabel={windowLabel} /> : undefined;
  return [
    { id: "coin", label: "Coin", className: "w-[126px] max-w-[126px] sm:w-[150px] sm:max-w-[150px]" },
    {
      id: "pressure",
      label: "Pressure vs 30d",
      headerAdornment: <MethodologyHint topic="pressureShift" />,
      sortKey: "pressure",
      className: "w-[124px] text-right sm:w-[156px]",
    },
    { id: "net24h", label: "Net 24h", headerAdornment: chip("24h", "24h"), sortKey: "net24h", className: "w-[108px] text-right" },
    { id: "mint24h", label: "Minted 24h", sortKey: "mint24h", className: "hidden w-[112px] text-right sm:table-cell" },
    { id: "burn24h", label: "Burned 24h", sortKey: "burn24h", className: "hidden w-[112px] text-right sm:table-cell" },
    { id: "net7d", label: "Net 7d", headerAdornment: chip("7d", "7-day"), sortKey: "net7d", className: "hidden w-[112px] text-right md:table-cell" },
    {
      id: "net30d",
      label: "Net 30d",
      headerAdornment: chip("30d", "30-day"),
      sortKey: "net30d",
      className: unknown["30d"] > 0 ? "hidden w-[188px] text-right lg:table-cell" : "hidden w-[112px] text-right lg:table-cell",
    },
    {
      id: "net90d",
      label: "Net 90d",
      headerAdornment: chip("90d", "90-day"),
      sortKey: "net90d",
      className: unknown["90d"] > 0 ? "hidden w-[188px] text-right xl:table-cell" : "hidden w-[112px] text-right xl:table-cell",
    },
    { id: "largest", label: "Largest event", sortKey: "largest", className: "hidden w-[124px] text-right xl:table-cell" },
  ];
}

function countUnknownNets(coins: readonly MintBurnCoinFlow[]): UnknownCounts {
  const counts: UnknownCounts = { "24h": 0, "7d": 0, "30d": 0, "90d": 0 };
  for (const coin of coins) {
    for (const window of UNKNOWN_MARKED_WINDOWS) {
      const net = resolveCoinNetFlow(coin, window);
      if (net.valueUsd != null && net.completeness === "unknown") counts[window] += 1;
    }
  }
  return counts;
}

const LOADING_COLUMNS = buildFlowTableColumns({ "24h": 0, "7d": 0, "30d": 0, "90d": 0 }, 0);

function FlowNetCell({
  net,
  hasWindow,
  cellClassName,
  windowLabel,
}: {
  net: MintBurnSignedNetView;
  hasWindow: boolean | undefined;
  cellClassName: string;
  windowLabel: string;
}) {
  const isPartial = hasWindow === false && net.valueUsd != null;
  return (
    <TableCell className={cellClassName}>
      <div
        className="flex items-center justify-end gap-1"
        title={
          isPartial
            ? `${windowLabel} window is incomplete; value reflects the covered portion only.`
            : undefined
        }
      >
        <FlowSignedNetValue
          net={net}
          format={formatSignedCurrency}
          colorClassName={getNetColor}
          className={cn(isPartial && "opacity-60")}
          unknownMarker="sr-only"
        />
        {isPartial && <span className="text-xs text-muted-foreground">partial</span>}
      </div>
    </TableCell>
  );
}

/** Hide only proven quiet windows; unknown scan activity is never idle. */
function hasNoObserved24hActivity(coin: MintBurnCoinFlow): boolean {
  const window24h = resolveMintBurnValuation(coin.valuation?.window24h);
  return (
    inferHas24hActivity(coin) === false &&
    coin.mintVolume24hUsd === 0 &&
    coin.burnVolume24hUsd === 0 &&
    window24h.mintCompleteness === "complete" &&
    window24h.burnCompleteness === "complete"
  );
}

export function FlowTable({ coins, isLoading }: FlowTableProps) {
  const router = useRouter();
  const [showIdle, setShowIdle] = useState(false);
  const {
    sortKey,
    sortDirection,
    toggleSort,
    getAriaSortValue,
    sortedRows: sorted,
  } = useSortedTableRows<MintBurnCoinFlow, FlowTableSortKey>(
    coins,
    // Worst pressure first: the table answers "who is stressed?".
    { defaultKey: "pressure", defaultDirection: "asc" },
    compareFlowRows,
  );
  const logos = logosById;
  const prefetch = usePrefetchStablecoin();

  const idleCount = sorted.filter(hasNoObserved24hActivity).length;
  const visibleRows = showIdle ? sorted : sorted.filter((coin) => !hasNoObserved24hActivity(coin));
  const columns = buildFlowTableColumns(countUnknownNets(visibleRows), visibleRows.length);

  const toolbar = (
    <TableToolbarFrame
      eyebrow="Per-coin flows"
      description="Minting and redemption per coin on each configured issuance chain, worst pressure against its 30-day norm first."
    />
  );

  if (isLoading) {
    return (
      <DataTableShell
        tableId="mint-burn-flow"
        testId="mint-burn-flow-table"
        columns={LOADING_COLUMNS}
        striped
        topSlot={toolbar}
      >
        <DataTableLoadingRows columns={LOADING_COLUMNS} rowCount={5} />
      </DataTableShell>
    );
  }

  return (
    <DataTableShell
      tableId="mint-burn-flow"
      testId="mint-burn-flow-table"
      columns={columns}
      striped
      tableClassName="min-w-[358px] table-fixed"
      topSlot={toolbar}
      sort={{
        sortKey,
        sortDirection,
        toggleSort,
        getAriaSortValue,
      }}
    >
      {visibleRows.map((coin) => {
            const meta = TRACKED_META_BY_ID.get(coin.stablecoinId);
            const name = meta?.name ?? coin.symbol;
            const label = stablecoinLabel({ id: coin.stablecoinId, symbol: coin.symbol });
            const pressureScore = getPressureScore(coin);
            const pressureState = getPressureState(coin);
            // Same reason vocabulary as the run line's stubs (one authority).
            const nrReason = resolveRunLineExclusionReason(coin);
            const coverageBadge = getCoverageBadge(coin);
            const window24h = resolveMintBurnValuation(coin.valuation?.window24h);
            const pressureDisplay = pressureScore != null
              ? getPressureShiftDisplay(pressureScore)
              : null;
            return (
              <InteractiveTableRow
                key={coin.stablecoinId}
                onActivate={() => router.push(buildStablecoinUrl(coin.stablecoinId))}
                onHover={() => prefetch(coin.stablecoinId)}
                role="link"
                ariaLabel={`Open ${label} flow detail`}
                className="h-11 sm:h-auto"
              >
                <TableCell className="w-[126px] max-w-[126px] overflow-hidden sm:w-[150px] sm:max-w-[150px]">
                  <StablecoinIdentity
                    logoSrc={logos?.[coin.stablecoinId]}
                    name={name}
                    symbol={label}
                    logoSize={24}
                    className="min-w-0"
                    textClassName="flex min-w-0 flex-col items-start gap-0.5"
                    symbolRowClassName="min-w-0 gap-1.5"
                    symbolClassName="whitespace-normal break-words"
                    details={
                      coverageBadge ? (
                        <span
                          className={cn(
                            "inline-flex rounded-full border px-1.5 py-0.5 text-xs font-medium leading-none",
                            coverageBadge.className,
                          )}
                        >
                          {coverageBadge.label}
                        </span>
                      ) : null
                    }
                  />
                </TableCell>
                <TableCell className="text-right">
                  <span
                    className={cn(
                      "pharos-numeric text-sm font-semibold",
                      PRESSURE_VALUE_CLASS[pressureState],
                    )}
                  >
                    {pressureDisplay != null
                      ? `${getNetPrefix(pressureDisplay)}${pressureDisplay}`
                      : (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span title={RUN_LINE_EXCLUSION_LABELS[nrReason]} data-reason-codes={nrReason}>
                                NR<span className="sr-only"> ({RUN_LINE_EXCLUSION_LABELS[nrReason]})</span>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>{RUN_LINE_EXCLUSION_LABELS[nrReason]}</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  <FlowSignedNetValue
                    net={resolveCoinNetFlow(coin, "24h")}
                    format={formatSignedCurrency}
                    colorClassName={getNetColor}
                    className="pharos-numeric text-sm font-semibold"
                    unknownMarker="sr-only"
                  />
                </TableCell>
                <TableCell className="hidden text-right pharos-numeric sm:table-cell">
                  <FlowVolumeValue
                    valueUsd={coin.mintVolume24hUsd}
                    completeness={window24h.mintCompleteness}
                    unpricedEventCount={window24h.unpricedMintEventCount}
                    scanComplete={hasCompleteCoinScan(coin, "24h")}
                    format={formatCurrency}
                  />
                </TableCell>
                <TableCell className="hidden text-right pharos-numeric sm:table-cell">
                  <FlowVolumeValue
                    valueUsd={coin.burnVolume24hUsd}
                    completeness={window24h.burnCompleteness}
                    unpricedEventCount={window24h.unpricedBurnEventCount}
                    scanComplete={hasCompleteCoinScan(coin, "24h")}
                    format={formatCurrency}
                  />
                </TableCell>
                <TableCell className="hidden text-right pharos-numeric md:table-cell">
                  <FlowSignedNetValue
                    net={resolveCoinNetFlow(coin, "7d")}
                    format={formatSignedCurrency}
                    colorClassName={getNetColor}
                    unknownMarker="sr-only"
                  />
                </TableCell>
                <FlowNetCell
                  net={resolveCoinNetFlow(coin, "30d")}
                  hasWindow={coin.coverage?.has30dWindow}
                  cellClassName="hidden text-right pharos-numeric lg:table-cell"
                  windowLabel="30-day"
                />
                <FlowNetCell
                  net={resolveCoinNetFlow(coin, "90d")}
                  hasWindow={coin.coverage?.has90dWindow}
                  cellClassName="hidden text-right pharos-numeric xl:table-cell"
                  windowLabel="90-day"
                />
                <TableCell className="hidden text-right pharos-numeric xl:table-cell">
                  {coin.largestEvent24h ? (
                    <span
                      className={
                        coin.largestEvent24h.direction === "mint"
                          ? "text-state-positive"
                          : "text-state-danger"
                      }
                    >
                      {coin.largestEvent24h.direction === "mint" ? "+" : "-"}
                      {formatCurrency(coin.largestEvent24h.amountUsd)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">&mdash;</span>
                  )}
                </TableCell>
              </InteractiveTableRow>
            );
      })}
      {idleCount > 0 && (
        <TableRow rowIntent="static">
          <TableCell colSpan={columns.length} className="py-3 text-center text-sm text-muted-foreground">
            <button
              type="button"
              onClick={() => setShowIdle((value) => !value)}
              aria-expanded={showIdle}
              className="pharos-focus-ring inline-flex min-h-11 items-center rounded-full border border-border/60 bg-background/60 px-4 py-2 text-foreground hover:bg-muted/40 sm:min-h-9"
            >
              {showIdle
                ? `Hide ${idleCount} coins with no 24h mint or burn`
                : `Show ${idleCount} coins with no mint or burn in the last 24h`}
            </button>
          </TableCell>
        </TableRow>
      )}
      {sorted.length === 0 && (
        <DataTableEmptyRow colSpan={columns.length}>
          No mint/burn events in this period.
        </DataTableEmptyRow>
      )}
    </DataTableShell>
  );
}

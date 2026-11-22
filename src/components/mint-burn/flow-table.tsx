"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
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
import { ControlPillToggle } from "@/components/control-pill-toggle";
import { FilterSearchInput } from "@/components/filter-search-input";
import { StablecoinIdentity } from "@/components/stablecoin-identity";
import { InteractiveTableRow } from "@/components/interactive-table-row";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { logosById } from "@/lib/logos";
import { usePrefetchStablecoin } from "@/hooks/use-prefetch-stablecoin";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { useSortedTableRows } from "@/hooks/use-sorted-table-rows";
import { formatCurrency, formatSignedCurrency, getNetPrefix } from "@shared/lib/format";
import { getNetColor } from "@shared/lib/classification/flows";
import { resolveMintBurnValuation } from "@shared/lib/mint-burn-valuation";
import { getPressureShiftDisplay } from "@/lib/flow-intensity";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import type { MintBurnCoinFlow } from "@shared/types/mint-burn";
import { cn } from "@/lib/utils";
import {
  compareFlowRows,
  getCoverageBadge,
  getPressureScore,
  getPressureState,
  PRESSURE_VALUE_CLASS,
  type FlowTableSortKey,
} from "@/components/mint-burn/flow-table-logic";
import { MethodologyHint } from "@/components/methodology-hint";
import { OpsStatusChip } from "@/components/ops-status-chip";
import { FlowSignedNetValue, FlowVolumeValue } from "@/components/mint-burn/flow-valuation-value";
import { hasCompleteCoinScan, inferHas24hActivity, resolveCoinNetFlow, type MintBurnNetWindow } from "@shared/lib/mint-burn-coin-helpers";
import { RUN_LINE_EXCLUSION_LABELS, resolveRunLineExclusionReason } from "@/lib/flow-run-line-model";
import type { MintBurnSignedNetView } from "@shared/lib/mint-burn-valuation-display";
import { stablecoinLabel } from "@/lib/stablecoin-label";

export type FlowTriageFilter = "all" | "minting" | "burning" | "high-intensity";

const FLOW_TRIAGE_OPTIONS: readonly { value: FlowTriageFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "minting", label: "Net minting" },
  { value: "burning", label: "Net burning" },
  { value: "high-intensity", label: "High intensity" },
];

const HIGH_INTENSITY_THRESHOLD = 30;

interface FlowTableProps {
  coins: MintBurnCoinFlow[];
  isLoading: boolean;
  /** Coin selected from the hero Run Line: scrolls smoothly to and highlights its row. */
  highlightedCoinId?: string | null;
  highlightRequestKey?: number;
}

const UNKNOWN_MARKED_WINDOWS = ["24h", "7d", "30d", "90d"] as const satisfies readonly MintBurnNetWindow[];
type UnknownCounts = Record<(typeof UNKNOWN_MARKED_WINDOWS)[number], number>;
const WINDOW_LABELS: Record<(typeof UNKNOWN_MARKED_WINDOWS)[number], string> = {
  "24h": "24h",
  "7d": "7-day",
  "30d": "30-day",
  "90d": "90-day",
};

/**
 * Coverage-unknown nets (legacy hours aggregated before valuation completeness
 * was recorded) keep their known-valuation value. Consolidated into one chip
 * in the toolbar naming every affected window, instead of 4 amber column chips.
 */
function ConsolidatedUnknownCoverageChip({
  unknown,
  total,
}: {
  unknown: UnknownCounts;
  total: number;
}) {
  const affected = UNKNOWN_MARKED_WINDOWS.filter((window) => unknown[window] > 0);
  if (affected.length === 0) return null;
  return (
    <OpsStatusChip
      label={affected.length === 1 ? `Unverified ${affected[0]}` : "Unverified"}
      reasonCodes={["valuation-unknown"]}
    >
      <p>
        Some nets include hours aggregated before valuation completeness was recorded, so their coverage is unknown.
        Each cell shows its known-valuation net; assistive text marks affected cells.
      </p>
      <ul className="space-y-0.5 text-muted-foreground">
        {affected.map((window) => (
          <li key={window}>
            <span className="font-medium text-foreground">{WINDOW_LABELS[window]}</span>:{" "}
            <span className="pharos-numeric">{unknown[window]}</span> of <span className="pharos-numeric">{total}</span> nets
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground">These hours age out of the window; nothing reconstructs them.</p>
    </OpsStatusChip>
  );
}

const FLOW_TABLE_COLUMNS: readonly DataTableColumn<FlowTableSortKey>[] = [
  { id: "coin", label: "Coin", className: "w-[126px] max-w-[126px] sm:w-[150px] sm:max-w-[150px]" },
  {
    id: "pressure",
    label: "Pressure vs 30d",
    headerAdornment: <MethodologyHint topic="pressureShift" />,
    sortKey: "pressure",
    className: "w-[124px] text-right sm:w-[156px]",
  },
  { id: "net24h", label: "Net 24h", sortKey: "net24h", className: "w-[108px] text-right" },
  { id: "mint24h", label: "Minted 24h", sortKey: "mint24h", className: "hidden w-[112px] text-right sm:table-cell" },
  { id: "burn24h", label: "Burned 24h", sortKey: "burn24h", className: "hidden w-[112px] text-right sm:table-cell" },
  { id: "net7d", label: "Net 7d", sortKey: "net7d", className: "hidden w-[112px] text-right md:table-cell" },
  { id: "net30d", label: "Net 30d", sortKey: "net30d", className: "hidden w-[112px] text-right lg:table-cell" },
  { id: "net90d", label: "Net 90d", sortKey: "net90d", className: "hidden w-[112px] text-right xl:table-cell" },
  { id: "largest", label: "Largest valued event", sortKey: "largest", className: "hidden w-[124px] text-right xl:table-cell" },
];

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

function matchesFlowTriage(coin: MintBurnCoinFlow, triage: FlowTriageFilter): boolean {
  if (triage === "all") return true;
  if (triage === "high-intensity") {
    const score = getPressureScore(coin);
    return score != null && Math.abs(score) >= HIGH_INTENSITY_THRESHOLD;
  }
  const net24h = resolveCoinNetFlow(coin, "24h", true).valueUsd;
  if (triage === "minting") return net24h != null && net24h > 0;
  return net24h != null && net24h < 0;
}

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
    (coin.classification?.window24h.completeness == null || coin.classification.window24h.completeness === "complete") &&
    inferHas24hActivity(coin) === false &&
    coin.mintVolume24hUsd === 0 &&
    coin.burnVolume24hUsd === 0 &&
    window24h.mintCompleteness === "complete" &&
    window24h.burnCompleteness === "complete"
  );
}

export function FlowTable({
  coins,
  isLoading,
  highlightedCoinId = null,
  highlightRequestKey = 0,
}: FlowTableProps) {
  const router = useRouter();
  const reducedMotion = usePrefersReducedMotion();
  const [showIdle, setShowIdle] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [triageFilter, setTriageFilter] = useState<FlowTriageFilter>("all");
  const [syncedHighlightKey, setSyncedHighlightKey] = useState(highlightRequestKey);
  if (highlightRequestKey !== syncedHighlightKey) {
    setSyncedHighlightKey(highlightRequestKey);
    if (highlightedCoinId) {
      setSearchQuery("");
      setTriageFilter("all");
    }
  }
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

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const hasFilters = normalizedQuery.length > 0 || triageFilter !== "all";

  // Reveal the coin if a Run Line selection targets a filtered or idle row, then scroll smoothly.
  useEffect(() => {
    if (!highlightedCoinId) return;
    const row = document.getElementById(`flow-row-${highlightedCoinId}`);
    if (row) {
      row.scrollIntoView?.({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
      row.querySelector<HTMLAnchorElement>("a[href]")?.focus({ preventScroll: true });
    }
  }, [highlightedCoinId, highlightRequestKey, reducedMotion, showIdle, searchQuery, triageFilter]);

  const filteredBySearchAndTriage = useMemo(
    () =>
      sorted.filter((coin) => {
        if (!matchesFlowTriage(coin, triageFilter)) return false;
        if (!normalizedQuery) return true;
        const meta = TRACKED_META_BY_ID.get(coin.stablecoinId);
        const name = meta?.name ?? coin.symbol;
        const label = stablecoinLabel({ id: coin.stablecoinId, symbol: coin.symbol });
        return (
          coin.symbol.toLowerCase().includes(normalizedQuery) ||
          name.toLowerCase().includes(normalizedQuery) ||
          label.toLowerCase().includes(normalizedQuery) ||
          coin.stablecoinId.toLowerCase().includes(normalizedQuery)
        );
      }),
    [normalizedQuery, sorted, triageFilter],
  );

  const idleCount = hasFilters ? 0 : sorted.filter(hasNoObserved24hActivity).length;
  const visibleRows = hasFilters || showIdle
    ? filteredBySearchAndTriage
    : filteredBySearchAndTriage.filter((coin) => !hasNoObserved24hActivity(coin) || coin.stablecoinId === highlightedCoinId);
  const unknownCounts = useMemo(() => countUnknownNets(visibleRows), [visibleRows]);

  const clearFilters = () => {
    setSearchQuery("");
    setTriageFilter("all");
  };

  const toolbar = (
    <TableToolbarFrame
      eyebrow={
        <span className="inline-flex flex-wrap items-center gap-2">
          <span>Per-coin flows</span>
          <ConsolidatedUnknownCoverageChip unknown={unknownCounts} total={visibleRows.length} />
        </span>
      }
      description="Minting and redemption per coin on each configured issuance chain, worst pressure against its 30-day norm first."
      actions={
        <>
          <ControlPillToggle
            ariaLabel="Filter by flow signal"
            options={FLOW_TRIAGE_OPTIONS}
            value={triageFilter}
            onChange={setTriageFilter}
            className="flex flex-wrap gap-1.5"
            buttonClassName="min-h-11 md:min-h-8"
          />
          <FilterSearchInput
            value={searchQuery}
            onValueChange={setSearchQuery}
            placeholder="Search coin..."
            ariaLabel="Search flow coins by name or symbol"
            className="relative w-full sm:w-44"
            inputClassName="h-11 pl-8 text-xs md:h-8"
          />
        </>
      }
    />
  );

  if (isLoading) {
    return (
      <DataTableShell
        tableId="mint-burn-flow"
        testId="mint-burn-flow-table"
        columns={FLOW_TABLE_COLUMNS}
        striped
        stickyHeader
        stickyMode="page"
        topSlot={toolbar}
      >
        <DataTableLoadingRows columns={FLOW_TABLE_COLUMNS} rowCount={5} />
      </DataTableShell>
    );
  }

  return (
    <DataTableShell
      tableId="mint-burn-flow"
      testId="mint-burn-flow-table"
      columns={FLOW_TABLE_COLUMNS}
      striped
      stickyHeader
      stickyMode="page"
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
            const isHighlighted = highlightedCoinId === coin.stablecoinId;
            return (
              <InteractiveTableRow
                key={coin.stablecoinId}
                id={`flow-row-${coin.stablecoinId}`}
                data-highlighted={isHighlighted ? "true" : undefined}
                onActivate={() => router.push(buildStablecoinUrl(coin.stablecoinId))}
                onHover={() => prefetch(coin.stablecoinId)}
                className={cn(
                  "h-11 sm:h-auto",
                  isHighlighted ? "border-l-2 border-l-brand-accent bg-muted/40" : "",
                )}
              >
                <TableCell className="w-[126px] max-w-[126px] overflow-hidden sm:w-[150px] sm:max-w-[150px]">
                  <Link
                    href={buildStablecoinUrl(coin.stablecoinId)}
                    prefetch={false}
                    aria-label={`Open ${label} flow detail`}
                    className="pharos-focus-ring block min-w-0 rounded-md"
                  >
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
                  </Link>
                </TableCell>
                <TableCell className="text-right">
                  <span
                    title={(coin.coverage?.windows?.window24h?.provenance ?? coin.coverage?.provenance) === "legacy-pre-cutover"
                      ? "24h scan evidence uses legacy pre-cutover coverage, not durable-v2 scan proof."
                      : undefined}
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
                <FlowNetCell
                  net={resolveCoinNetFlow(coin, "24h", true)}
                  hasWindow={coin.coverage?.has24hWindow}
                  cellClassName="text-right pharos-numeric text-sm font-semibold"
                  windowLabel="24h"
                />
                <TableCell className="hidden text-right pharos-numeric sm:table-cell">
                  <FlowVolumeValue
                    valueUsd={coin.mintVolume24hUsd}
                    classificationCompleteness={coin.classification?.window24h.mintCompleteness}
                    unresolvedEventCount={coin.classification?.window24h.unresolvedMintEventCount}
                    completeness={window24h.mintCompleteness}
                    unpricedEventCount={window24h.unpricedMintEventCount}
                    scanComplete={hasCompleteCoinScan(coin, "24h")}
                    format={formatCurrency}
                  />
                </TableCell>
                <TableCell className="hidden text-right pharos-numeric sm:table-cell">
                  <FlowVolumeValue
                    valueUsd={coin.burnVolume24hUsd}
                    classificationCompleteness={coin.classification?.window24h.burnCompleteness}
                    unresolvedEventCount={coin.classification?.window24h.unresolvedBurnEventCount}
                    completeness={window24h.burnCompleteness}
                    unpricedEventCount={window24h.unpricedBurnEventCount}
                    scanComplete={hasCompleteCoinScan(coin, "24h")}
                    format={formatCurrency}
                  />
                </TableCell>
                <FlowNetCell
                  net={resolveCoinNetFlow(coin, "7d", true)}
                  hasWindow={coin.coverage?.has7dWindow}
                  cellClassName="hidden text-right pharos-numeric md:table-cell"
                  windowLabel="7-day"
                />
                <FlowNetCell
                  net={resolveCoinNetFlow(coin, "30d", true)}
                  hasWindow={coin.coverage?.has30dWindow}
                  cellClassName="hidden text-right pharos-numeric lg:table-cell"
                  windowLabel="30-day"
                />
                <FlowNetCell
                  net={resolveCoinNetFlow(coin, "90d", true)}
                  hasWindow={coin.coverage?.has90dWindow}
                  cellClassName="hidden text-right pharos-numeric xl:table-cell"
                  windowLabel="90-day"
                />
                <TableCell className="hidden text-right pharos-numeric xl:table-cell">
                  {coin.largestEvent24h ? (
                    <span
                      title="Largest USD-valued counted event in the admitted tracked-chain scope over 24h"
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
          <TableCell colSpan={FLOW_TABLE_COLUMNS.length} className="py-3 text-center text-sm text-muted-foreground">
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
      {visibleRows.length === 0 && (
        <DataTableEmptyRow colSpan={FLOW_TABLE_COLUMNS.length}>
          {hasFilters ? (
            <span className="flex flex-col items-center gap-3">
              <span>No flow coins match the current search or filter.</span>
              <button
                type="button"
                onClick={clearFilters}
                className="pharos-focus-ring rounded-full border border-border/60 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                Clear filters
              </button>
            </span>
          ) : (
            "No mint/burn events in this period."
          )}
        </DataTableEmptyRow>
      )}
    </DataTableShell>
  );
}

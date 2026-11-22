"use client";

import Link from "next/link";
import { ArrowRight, X } from "lucide-react";
import {
  DataTableShell,
  type DataTableColumn,
  type DataTableSortControls,
} from "@/components/data-table-shell";
import { TableCell, TableRow } from "@/components/table";
import { TablePagination, type TablePaginationProps } from "@/components/table-pagination";
import { Button } from "@/components/ui/button";
import { SafetyGradeBadge } from "@/components/safety-scores/safety-grade-badge";
import { SafetyScoreTopDriver } from "@/components/safety-scores/safety-score-top-driver";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { MAX_COMPARE_COINS } from "@/lib/compare-config";
import { buildLiveCompareUrl } from "@/lib/compare-links";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";
import { describePartialEvidence, formatPartialEvidenceHeadline } from "@/lib/safety-score-reason-labels";
import type { V9TableConsumerCard as V9ConsumerCard } from "@/lib/safety-score-v9-consumers";
import type { TableDensity } from "@/hooks/use-table-density";
import { cn } from "@/lib/utils";
import { ECONOMIC_CONTROL_SHORT_LABEL } from "@shared/lib/classification";
import { formatCompactUsd } from "@shared/lib/format";
import { buildStablecoinUrl } from "@shared/lib/urls";
import type { QueryKey } from "@tanstack/react-query";
import {
  resolveSafetyCardMeta,
  resolveSafetyCardTopDriver,
  type V9SortKey,
} from "@/components/safety-scores/safety-card-helpers";

const MATRIX_REFRESH_QUERY_KEYS: readonly QueryKey[] = [
  FRONTEND_API_QUERY_DESCRIPTORS.reportCardsV9Table.queryKey,
  FRONTEND_API_QUERY_DESCRIPTORS.stablecoins.queryKey,
];

const MATRIX_COLUMNS: readonly DataTableColumn<V9SortKey>[] = [
  {
    id: "compare",
    label: <span className="sr-only">Compare</span>,
    className: "w-11 text-center",
    title: `Select up to ${MAX_COMPARE_COINS} coins to compare`,
  },
  {
    id: "coin",
    label: "Coin",
    sortKey: "coin",
    className: "min-w-[180px]",
  },
  {
    id: "overall",
    label: "Grade / Score",
    sortKey: "overall",
    className: "w-[132px]",
  },
  {
    id: "backing",
    label: "Backing",
    sortKey: "backing",
    className: "w-[104px] text-right",
    title: "Backing pillar score (0-100, 40% weight)",
  },
  {
    id: "exit",
    label: "Exit",
    sortKey: "exit",
    className: "w-[104px] text-right",
    title: "Exit pillar score (0-100, 35% weight)",
  },
  {
    id: "control",
    label: ECONOMIC_CONTROL_SHORT_LABEL,
    sortKey: "control",
    className: "w-[104px] text-right",
    title: "Economic Control pillar score (0-100, 25% weight)",
  },
  {
    id: "driver",
    label: "Top Driver / Cap",
    className: "min-w-[180px] max-w-[260px]",
  },
  {
    id: "mcap",
    label: "MCap",
    sortKey: "mcap",
    className: "w-[100px] text-right",
  },
  {
    id: "peg",
    label: "Peg",
    className: "w-[84px]",
  },
] as const;

function pillarFillClass(score: number): string {
  if (score < 40) return "bg-[var(--severity-severe)]";
  if (score < 60) return "bg-[var(--severity-moderate)]";
  return "bg-meter-neutral";
}

function PillarScoreCell({
  score,
  label,
  compact = false,
}: {
  score: number | null;
  label: string;
  compact?: boolean;
}) {
  const rounded = score === null ? null : Math.round(score);
  const bounded = score === null ? null : Math.max(0, Math.min(100, score));

  return (
    <div
      className={cn(
        "flex flex-col gap-1",
        compact ? "items-stretch" : "items-end",
      )}
      title={`${label}: ${rounded === null ? "Not scored" : `${rounded}/100`}`}
    >
      <span
        className={cn(
          "pharos-numeric text-xs leading-none",
          rounded === null ? "text-muted-foreground" : "font-medium text-foreground",
        )}
      >
        {rounded === null ? "—" : rounded}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "block h-1.5",
          compact ? "w-full" : "w-14",
          bounded === null
            ? "rounded-xs border border-dashed border-muted-foreground/50"
            : "overflow-hidden rounded-xs border border-meter-track-border bg-meter-track",
        )}
      >
        {bounded !== null ? (
          <span
            className={cn("block h-full", pillarFillClass(bounded))}
            style={{ width: `${bounded}%` }}
          />
        ) : null}
      </span>
    </div>
  );
}

function TopDriverCellContent({
  card,
  symbol,
}: {
  card: V9ConsumerCard;
  symbol: string;
}) {
  const driver = resolveSafetyCardTopDriver(card);
  if (driver !== null) {
    return (
      <SafetyScoreTopDriver
        driver={driver}
        coinId={card.id}
        subjectLabel={symbol}
        link
      />
    );
  }
  const partial = describePartialEvidence(card);
  if (partial !== null) {
    return (
      <span
        className="inline-flex max-w-full items-center rounded-full border border-border/60 bg-muted/30 px-2 py-1 text-3xs leading-none text-muted-foreground"
        title={partial.summary}
      >
        <span className="truncate">{formatPartialEvidenceHeadline(partial)}</span>
      </span>
    );
  }
  if (card.ratingStatus === "pipeline-gap") {
    return <span className="text-xs text-muted-foreground">Pipeline gap</span>;
  }
  return (
    <span className="text-xs text-muted-foreground" aria-label="No binding cap">
      —
    </span>
  );
}

export function SafetyCompareSelectionBar({
  selectedIds,
  logos,
  onRemove,
  onClear,
}: {
  selectedIds: readonly string[];
  logos?: Record<string, string>;
  onRemove: (coinId: string) => void;
  onClear: () => void;
}) {
  if (selectedIds.length === 0) return null;

  const compareHref = buildLiveCompareUrl(selectedIds);
  const canComparePair = selectedIds.length >= 2;

  return (
    <div
      role="region"
      aria-label="Compare selection"
      data-testid="safety-compare-bar"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-3.5 py-2.5"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-foreground">
          Compare ({selectedIds.length}/{MAX_COMPARE_COINS}):
        </span>
        <ul className="flex flex-wrap items-center gap-1.5">
          {selectedIds.map((coinId) => {
            const { name, symbol } = resolveSafetyCardMeta({ id: coinId });
            return (
              <li
                key={coinId}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 py-0.5 pl-1.5 pr-1 text-xs font-medium text-foreground"
              >
                <StablecoinLogo src={logos?.[coinId]} name={name} size={16} />
                <span>{symbol}</span>
                <button
                  type="button"
                  onClick={() => onRemove(coinId)}
                  aria-label={`Remove ${symbol} from comparison`}
                  className="pharos-focus-ring inline-flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClear}
          className="pharos-focus-ring min-h-11 text-xs sm:min-h-8"
        >
          Clear
        </Button>
        <Button
          asChild
          variant="default"
          size="sm"
          className="pharos-focus-ring min-h-11 gap-1.5 text-xs sm:min-h-8"
        >
          <Link href={compareHref}>
            <span>
              {canComparePair
                ? `Compare ${selectedIds.length} coins`
                : "Open in Compare"}
            </span>
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </div>
  );
}

export interface SafetyScoresMatrixTableProps {
  cards: readonly V9ConsumerCard[];
  mcapMap: ReadonlyMap<string, number | null>;
  logos?: Record<string, string>;
  sort: DataTableSortControls<V9SortKey>;
  density: TableDensity;
  pagination: TablePaginationProps;
  selectedCompareIds: readonly string[];
  onToggleCompare: (coinId: string) => void;
  toolbar?: React.ReactNode;
}

export function SafetyScoresMatrixTable({
  cards,
  mcapMap,
  logos,
  sort,
  density,
  pagination,
  selectedCompareIds,
  onToggleCompare,
  toolbar,
}: SafetyScoresMatrixTableProps) {
  const selectedSet = new Set(selectedCompareIds);
  const atCompareLimit = selectedCompareIds.length >= MAX_COMPARE_COINS;

  return (
    <div className="space-y-3">
      {/* Desktop / wide sortable Matrix Table (default at lg: and above). */}
      <div className="hidden lg:block">
        <DataTableShell<V9SortKey>
          tableId="safety-scores-matrix"
          testId="safety-scores-matrix-table"
          columns={MATRIX_COLUMNS}
          sort={sort}
          stickyHeader
          stickyMode="page"
          striped
          density={density}
          mobileScrollHint={false}
          topSlot={toolbar}
          pagination={pagination}
          refreshingQueryKeys={MATRIX_REFRESH_QUERY_KEYS}
          isPending={false}
        >
          {cards.map((card) => {
            const { name, symbol, pegLabel } = resolveSafetyCardMeta(card);
            const mcap = mcapMap.get(card.id) ?? null;
            const isSelected = selectedSet.has(card.id);
            const disableCheckbox = !isSelected && atCompareLimit;
            const backingScore = card.ratingStatus === "rated" ? card.pillars.backing.score : null;
            const exitScore = card.ratingStatus === "rated" ? card.pillars.exit.score : null;
            const controlScore = card.ratingStatus === "rated" ? card.pillars.control.score : null;

            return (
              <TableRow
                key={card.id}
                data-state={isSelected ? "selected" : undefined}
                data-testid="safety-matrix-row"
              >
                <TableCell className="w-11 text-center">
                  <label className="inline-flex size-8 cursor-pointer items-center justify-center">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      disabled={disableCheckbox}
                      onChange={() => onToggleCompare(card.id)}
                      aria-label={`Select ${name} (${symbol}) to compare`}
                      title={
                        disableCheckbox
                          ? `Maximum of ${MAX_COMPARE_COINS} coins selected`
                          : isSelected
                            ? `Remove ${symbol} from comparison`
                            : `Add ${symbol} to comparison`
                      }
                      className="pharos-focus-ring h-4 w-4 rounded-sm border-border accent-foreground disabled:cursor-not-allowed disabled:opacity-40"
                    />
                  </label>
                </TableCell>
                <TableCell className="min-w-[180px] max-w-[260px]">
                  <Link
                    href={buildStablecoinUrl(card.id)}
                    className="pharos-focus-ring group flex min-w-0 items-center gap-2.5 rounded-sm"
                    title={`${name} (${symbol})`}
                  >
                    <StablecoinLogo src={logos?.[card.id]} name={name} size={22} />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-semibold leading-tight text-foreground transition-colors group-hover:text-brand-accent-text">
                        {symbol}
                      </span>
                      <span className="truncate text-2xs leading-tight text-muted-foreground">
                        {name}
                      </span>
                    </span>
                  </Link>
                </TableCell>
                <TableCell className="w-[132px]">
                  <SafetyGradeBadge
                    grade={card.grade}
                    score={card.score}
                    showScore
                    size="sm"
                  />
                </TableCell>
                <TableCell className="w-[104px] text-right">
                  <PillarScoreCell score={backingScore} label="Backing" />
                </TableCell>
                <TableCell className="w-[104px] text-right">
                  <PillarScoreCell score={exitScore} label="Exit" />
                </TableCell>
                <TableCell className="w-[104px] text-right">
                  <PillarScoreCell score={controlScore} label="Economic Control" />
                </TableCell>
                <TableCell className="min-w-[180px] max-w-[260px]">
                  <TopDriverCellContent card={card} symbol={symbol} />
                </TableCell>
                <TableCell className="w-[100px] text-right">
                  <span
                    className={cn(
                      "pharos-numeric text-xs",
                      mcap === null ? "text-muted-foreground" : "font-medium text-foreground",
                    )}
                  >
                    {mcap === null ? "—" : formatCompactUsd(mcap)}
                  </span>
                </TableCell>
                <TableCell className="w-[84px]">
                  <span className="text-xs text-muted-foreground">{pegLabel}</span>
                </TableCell>
              </TableRow>
            );
          })}
        </DataTableShell>
      </div>

      {/* Narrow / mobile responsive card list (below lg:, zero horizontal table scroll trap). */}
      <div className="space-y-3 lg:hidden" data-testid="safety-scores-mobile-list">
        {toolbar ? (
          <div className="pharos-card-shell overflow-hidden">{toolbar}</div>
        ) : null}
        <ul className="space-y-2.5">
          {cards.map((card) => {
            const { name, symbol, pegLabel } = resolveSafetyCardMeta(card);
            const mcap = mcapMap.get(card.id) ?? null;
            const isSelected = selectedSet.has(card.id);
            const disableCheckbox = !isSelected && atCompareLimit;
            const backingScore = card.ratingStatus === "rated" ? card.pillars.backing.score : null;
            const exitScore = card.ratingStatus === "rated" ? card.pillars.exit.score : null;
            const controlScore = card.ratingStatus === "rated" ? card.pillars.control.score : null;

            return (
              <li
                key={card.id}
                className="pharos-card-shell space-y-2.5 p-3.5 [contain-intrinsic-size:auto_156px] [content-visibility:auto]"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <label className="-ml-2 inline-flex size-11 shrink-0 cursor-pointer items-center justify-center">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        disabled={disableCheckbox}
                        onChange={() => onToggleCompare(card.id)}
                        aria-label={`Select ${name} (${symbol}) to compare`}
                        className="pharos-focus-ring h-4 w-4 rounded-sm border-border accent-foreground disabled:cursor-not-allowed disabled:opacity-40"
                      />
                    </label>
                    <Link
                      href={buildStablecoinUrl(card.id)}
                      className="pharos-focus-ring group flex min-w-0 items-center gap-2 rounded-sm"
                    >
                      <StablecoinLogo src={logos?.[card.id]} name={name} size={24} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-foreground group-hover:text-brand-accent-text">
                          {symbol}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {name}
                        </span>
                      </span>
                    </Link>
                  </div>
                  <SafetyGradeBadge
                    grade={card.grade}
                    score={card.score}
                    showScore
                    size="sm"
                    className="shrink-0"
                  />
                </div>

                <div className="grid grid-cols-3 gap-2 border-t border-border/40 pt-2.5">
                  <div className="space-y-1">
                    <span className="block text-3xs font-medium uppercase text-muted-foreground">Backing</span>
                    <PillarScoreCell score={backingScore} label="Backing" compact />
                  </div>
                  <div className="space-y-1">
                    <span className="block text-3xs font-medium uppercase text-muted-foreground">Exit</span>
                    <PillarScoreCell score={exitScore} label="Exit" compact />
                  </div>
                  <div className="space-y-1">
                    <span className="block text-3xs font-medium uppercase text-muted-foreground">
                      {ECONOMIC_CONTROL_SHORT_LABEL}
                    </span>
                    <PillarScoreCell score={controlScore} label="Economic Control" compact />
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-2 text-xs">
                  <div className="min-w-0 flex-1">
                    <TopDriverCellContent card={card} symbol={symbol} />
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-2xs text-muted-foreground">
                    <span>{pegLabel}</span>
                    <span aria-hidden="true">·</span>
                    <span className="pharos-numeric font-medium text-foreground">
                      {mcap === null ? "—" : formatCompactUsd(mcap)}
                    </span>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="pharos-card-shell overflow-hidden">
          <TablePagination {...pagination} bordered={false} />
        </div>
      </div>
    </div>
  );
}

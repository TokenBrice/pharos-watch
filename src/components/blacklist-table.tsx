"use client";

import { useCallback } from "react";
import { TableCell, TableRow } from "@/components/ui/table";
import { DataTableLoadingRows, DataTableShell, type DataTableColumn } from "@/components/data-table-shell";
import { MobileSortPills } from "@/components/mobile-sort-pills";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Download, ExternalLink } from "lucide-react";
import { downloadCsv } from "@/lib/csv-export";
import { getNextSortState } from "@/hooks/use-sort";
import { formatAddress, formatEventDate, formatCurrency } from "@shared/lib/format";
import { isGoldBlacklistStablecoin } from "@shared/lib/blacklist";
import { EVENT_BADGE_STYLES, EVENT_LABELS } from "@shared/lib/classification";
import type { BlacklistEvent, BlacklistSortDirection, BlacklistSortKey } from "@shared/types";

function formatBlacklistAmountCell(evt: BlacklistEvent): string {
  if (evt.amountUsdAtEvent != null) return formatCurrency(evt.amountUsdAtEvent);
  if (evt.amountNative != null && !(evt.amountNative === 0 && evt.eventType !== "destroy")) {
    const digits = isGoldBlacklistStablecoin(evt.stablecoin) ? 4 : 2;
    return `${evt.amountNative.toLocaleString(undefined, { maximumFractionDigits: digits })} ${evt.stablecoin}`;
  }
  if (evt.amountStatus === "permanently_unavailable") return "N/A";
  return "\u2014";
}

const AMOUNT_STATUS_TOOLTIPS: Record<string, string> = {
  recoverable_pending: "Amount not yet recovered from historical balance — backfill pass pending.",
  provider_failed: "Amount recovery failed at the data provider; next backfill pass will retry.",
  ambiguous: "Multiple candidate amounts; manual review required.",
  permanently_unavailable: "Amount cannot be recovered (e.g., EURC mirror-zero or Tron legacy row).",
};

const AMOUNT_SOURCE_LABELS: Record<string, string> = {
  event: "Event",
  historical_balance: "Historical",
  current_balance_snapshot: "Snapshot",
  derived: "Derived",
  legacy_migration: "Legacy",
  unavailable: "Unavailable",
};

const AMOUNT_SOURCE_TOOLTIPS: Record<string, string> = {
  event: "Amount came directly from the emitted event.",
  historical_balance: "Amount was recovered from a historical balance lookup.",
  current_balance_snapshot: "Amount is a last-known freeze-ledger snapshot, not event-time precision.",
  derived: "Legacy derived amount retained for audit compatibility.",
  legacy_migration: "Legacy migration amount retained for audit compatibility.",
  unavailable: "No amount source is available for this row.",
};

interface BlacklistTableProps {
  events: BlacklistEvent[];
  isLoading: boolean;
  page: number;
  pageSize: number;
  sortKey: BlacklistSortKey;
  sortDirection: BlacklistSortDirection;
  onSortChange: (sortKey: BlacklistSortKey, sortDirection: BlacklistSortDirection) => void;
}

const BLACKLIST_COLUMNS: readonly DataTableColumn<BlacklistSortKey>[] = [
  { id: "rank", label: "#", className: "w-[50px] text-right" },
  { id: "date", label: "Date", sortKey: "date" },
  { id: "stablecoin", label: "Stablecoin", sortKey: "stablecoin" },
  { id: "chain", label: "Chain", sortKey: "chain" },
  { id: "event", label: "Event", sortKey: "event" },
  { id: "address", label: "Address", className: "hidden md:table-cell" },
  { id: "amount", label: "Amount / Value", className: "hidden sm:table-cell text-right" },
  { id: "tx", label: "Tx", className: "hidden sm:table-cell text-center" },
] as const;

const MOBILE_SORT_OPTIONS: Array<{ key: BlacklistSortKey; label: string }> = [
  { key: "date", label: "Date" },
  { key: "stablecoin", label: "Asset" },
  { key: "chain", label: "Chain" },
  { key: "event", label: "Action" },
];

export function BlacklistTable({
  events,
  isLoading,
  page,
  pageSize,
  sortKey,
  sortDirection,
  onSortChange,
}: BlacklistTableProps) {
  const toggleSort = useCallback(
    (key: BlacklistSortKey) => {
      const next = getNextSortState({ key: sortKey, direction: sortDirection }, key);
      onSortChange(next.key, next.direction);
    },
    [onSortChange, sortDirection, sortKey],
  );

  const getAriaSortValue = useCallback(
    (columnKey: BlacklistSortKey): "ascending" | "descending" | "none" => {
      if (sortKey !== columnKey) return "none";
      return sortDirection === "asc" ? "ascending" : "descending";
    },
    [sortDirection, sortKey],
  );

  const handleCsvExport = useCallback(() => {
    downloadCsv(
      events,
      [
        { header: "Date", accessor: (row) => formatEventDate(row.timestamp) },
        { header: "Stablecoin", accessor: (row) => row.stablecoin },
        { header: "Chain", accessor: (row) => row.chainName },
        { header: "Event", accessor: (row) => EVENT_LABELS[row.eventType] ?? row.eventType },
        { header: "Address", accessor: (row) => row.address },
        {
          header: "Amount (Native)",
          accessor: (row) =>
            row.amountNative == null
              ? ""
              : row.amountNative.toLocaleString(undefined, {
                  maximumFractionDigits: isGoldBlacklistStablecoin(row.stablecoin) ? 4 : 2,
                }),
        },
        { header: "Amount Unit", accessor: (row) => row.stablecoin },
        { header: "Amount (USD at event)", accessor: (row) => row.amountUsdAtEvent },
        { header: "Amount Source", accessor: (row) => row.amountSource },
        { header: "Amount Status", accessor: (row) => row.amountStatus },
        { header: "Contract Address", accessor: (row) => row.contractAddress ?? "" },
        { header: "Config Key", accessor: (row) => row.configKey ?? "" },
        { header: "Event Signature", accessor: (row) => row.eventSignature ?? "" },
        { header: "Event Topic0", accessor: (row) => row.eventTopic0 ?? "" },
        { header: "Tx URL", accessor: (row) => row.explorerTxUrl },
      ],
      "pharos-freeze-events",
    );
  }, [events]);

  if (isLoading) {
    return (
      <DataTableShell
        columns={BLACKLIST_COLUMNS}
        striped
        containerClassName="rounded-xl border"
        headerClassName="bg-muted"
        mobileScrollHint={false}
      >
        <DataTableLoadingRows columns={BLACKLIST_COLUMNS} rowCount={10} />
      </DataTableShell>
    );
  }

  return (
    <TooltipProvider delayDuration={220}>
      <div className="space-y-3 md:hidden">
        <div className="rounded-xl border border-border/70 bg-card/80 px-3 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="pharos-kicker">Event Cards</p>
              <p className="text-xs text-muted-foreground">Sorted by {sortKey} {sortDirection === "asc" ? "ascending" : "descending"}.</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="pharos-focus-ring min-h-11"
              onClick={handleCsvExport}
              disabled={events.length === 0}
            >
              <Download className="h-3.5 w-3.5" />
              CSV
            </Button>
          </div>
          <MobileSortPills
            options={MOBILE_SORT_OPTIONS}
            sortKey={sortKey}
            sortDirection={sortDirection}
            onSort={toggleSort}
            ariaLabel="Sort freeze events"
            className="mt-3 flex flex-wrap gap-2"
          />
        </div>
        {events.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/70 bg-background/35 px-4 py-8 text-center text-sm text-muted-foreground">
            No freeze events match your filters.
          </div>
        ) : (
          <div className="space-y-3">
            {events.map((evt, index) => (
              <BlacklistEventCard key={evt.id} event={evt} rank={(page - 1) * pageSize + index + 1} />
            ))}
          </div>
        )}
      </div>

      <div className="hidden md:block">
        <DataTableShell
          columns={BLACKLIST_COLUMNS}
          sort={{
            sortKey,
            sortDirection,
            toggleSort,
            getAriaSortValue,
          }}
          striped
          containerClassName="rounded-xl border"
          headerClassName="bg-muted"
          mobileScrollHint={false}
          topSlot={
            <div className="flex items-center justify-end px-3 py-1.5 border-b bg-muted/30">
              <Button
                variant="outline"
                size="sm"
                className="pharos-focus-ring min-h-11 sm:min-h-8"
                onClick={handleCsvExport}
                disabled={events.length === 0}
              >
                <Download className="h-3.5 w-3.5" />
                Export current page CSV
              </Button>
            </div>
          }
        >
          {events.map((evt, index) => (
            <BlacklistEventRow key={evt.id} event={evt} rank={(page - 1) * pageSize + index + 1} />
          ))}
          {events.length === 0 && (
            <TableRow>
              <TableCell colSpan={BLACKLIST_COLUMNS.length} className="text-center text-muted-foreground py-12">
                No freeze events match your filters.
              </TableCell>
            </TableRow>
          )}
        </DataTableShell>
      </div>
    </TooltipProvider>
  );
}

function BlacklistEventRow({ event: evt, rank }: { event: BlacklistEvent; rank: number }) {
  return (
    <TableRow>
      <TableCell className="text-right text-muted-foreground text-xs tabular-nums">
        {rank}
      </TableCell>
      <TableCell className="whitespace-nowrap font-mono text-xs">{formatEventDate(evt.timestamp)}</TableCell>
      <TableCell className="font-medium">{evt.stablecoin}</TableCell>
      <TableCell>{evt.chainName}</TableCell>
      <TableCell>
        <Badge variant="outline" className={EVENT_BADGE_STYLES[evt.eventType] ?? ""}>
          {EVENT_LABELS[evt.eventType] ?? evt.eventType}
        </Badge>
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <a
          href={evt.explorerAddressUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="pharos-focus-ring block max-w-[120px] sm:max-w-none truncate sm:overflow-visible font-mono text-xs hover:underline"
          aria-label={`View address ${evt.address} on ${evt.chainName}`}
        >
          {formatAddress(evt.address)}
        </a>
      </TableCell>
      <TableCell className="hidden sm:table-cell text-right font-mono">
        <BlacklistAmount event={evt} />
      </TableCell>
      <TableCell className="hidden sm:table-cell text-center">
        <BlacklistTxLink event={evt} />
      </TableCell>
    </TableRow>
  );
}

function BlacklistAmount({ event: evt }: { event: BlacklistEvent }) {
  const sourceTooltip = AMOUNT_SOURCE_TOOLTIPS[evt.amountSource];
  const statusTooltip = AMOUNT_STATUS_TOOLTIPS[evt.amountStatus];
  return (
    <>
      {formatBlacklistAmountCell(evt)}
      {evt.amountSource !== "unavailable" || evt.amountStatus === "resolved" ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="ml-1 inline-flex cursor-help rounded border border-border px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
              aria-label={sourceTooltip ?? undefined}
            >
              {AMOUNT_SOURCE_LABELS[evt.amountSource] ?? evt.amountSource.replace(/_/g, " ")}
            </span>
          </TooltipTrigger>
          {sourceTooltip ? (
            <TooltipContent className="max-w-[260px] text-[11px]">{sourceTooltip}</TooltipContent>
          ) : null}
        </Tooltip>
      ) : null}
      {evt.amountStatus !== "resolved" && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="ml-1 inline-flex cursor-help items-center rounded border border-border px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
              aria-label={statusTooltip ?? undefined}
            >
              {evt.amountStatus.replace(/_/g, " ")}
            </span>
          </TooltipTrigger>
          {statusTooltip ? (
            <TooltipContent className="max-w-[260px] text-[11px]">{statusTooltip}</TooltipContent>
          ) : null}
        </Tooltip>
      )}
    </>
  );
}

function BlacklistTxLink({ event: evt }: { event: BlacklistEvent }) {
  return (
    <a
      href={evt.explorerTxUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="pharos-focus-ring inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground sm:min-h-8 sm:min-w-8"
      aria-label={`Open ${evt.chainName} transaction ${evt.txHash} in explorer`}
      title={`View tx ${evt.txHash.slice(0, 10)}... on ${evt.chainName}`}
    >
      <ExternalLink className="h-4 w-4" />
    </a>
  );
}

function BlacklistEventCard({ event: evt, rank }: { event: BlacklistEvent; rank: number }) {
  return (
    <article className="pharos-card-shell rounded-xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-foreground">{evt.stablecoin}</span>
            <Badge variant="outline" className={EVENT_BADGE_STYLES[evt.eventType] ?? ""}>
              {EVENT_LABELS[evt.eventType] ?? evt.eventType}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            #{rank} · {evt.chainName} · <span className="font-mono">{formatEventDate(evt.timestamp)}</span>
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="pharos-kicker">Amount</p>
          <p className="font-mono text-sm font-semibold tabular-nums text-foreground">{formatBlacklistAmountCell(evt)}</p>
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-border/60 bg-background/45 px-3 py-2">
        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">Address</p>
        <a
          href={evt.explorerAddressUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="pharos-focus-ring mt-1 inline-flex min-h-11 max-w-full items-center rounded-md font-mono text-xs text-foreground underline-offset-4 hover:underline"
          aria-label={`View address ${evt.address} on ${evt.chainName}`}
        >
          {formatAddress(evt.address)}
        </a>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          {evt.amountSource !== "unavailable" || evt.amountStatus === "resolved" ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="cursor-help rounded border border-border px-1.5 py-1"
                  aria-label={AMOUNT_SOURCE_TOOLTIPS[evt.amountSource] ?? undefined}
                >
                  {AMOUNT_SOURCE_LABELS[evt.amountSource] ?? evt.amountSource.replace(/_/g, " ")}
                </span>
              </TooltipTrigger>
              {AMOUNT_SOURCE_TOOLTIPS[evt.amountSource] ? (
                <TooltipContent className="max-w-[260px] text-[11px]">
                  {AMOUNT_SOURCE_TOOLTIPS[evt.amountSource]}
                </TooltipContent>
              ) : null}
            </Tooltip>
          ) : null}
          {evt.amountStatus !== "resolved" ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="cursor-help rounded border border-border px-1.5 py-1"
                  aria-label={AMOUNT_STATUS_TOOLTIPS[evt.amountStatus] ?? undefined}
                >
                  {evt.amountStatus.replace(/_/g, " ")}
                </span>
              </TooltipTrigger>
              {AMOUNT_STATUS_TOOLTIPS[evt.amountStatus] ? (
                <TooltipContent className="max-w-[260px] text-[11px]">
                  {AMOUNT_STATUS_TOOLTIPS[evt.amountStatus]}
                </TooltipContent>
              ) : null}
            </Tooltip>
          ) : null}
        </div>
        <BlacklistTxLink event={evt} />
      </div>
    </article>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, Copy, Download, ExternalLink, Info } from "lucide-react";
import { TableCell, TableRow } from "@/components/table";
import { DataTableEmptyRow, DataTableLoadingRows, DataTableShell, type DataTableColumn } from "@/components/data-table-shell";
import { MobileSortPanel, MobileSortPills } from "@/components/mobile-sort-pills";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { coinIdBySymbol } from "@/lib/coin-id-by-symbol";
import { logosById } from "@/lib/logos";
import { downloadCsv } from "@/lib/exports/csv";
import { getNextSortState } from "@/hooks/use-sort";
import { resolveQueryViewState } from "@/lib/query-view-state";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { formatAddress, formatEventDate } from "@shared/lib/format";
import { EVENT_BADGE_STYLES, EVENT_LABELS } from "@shared/lib/classification";
import type { BlacklistEvent, BlacklistSortDirection, BlacklistSortKey } from "@shared/types/blacklist";
import {
  formatBlacklistAmountOrStatus,
  getBlacklistAmountSourceLabel,
} from "@/lib/blacklist-event-presentation";

const AMOUNT_STATUS_TOOLTIPS: Record<string, string> = {
  recoverable_pending: "Amount not yet recovered from historical balance; backfill pass pending.",
  provider_failed: "Amount recovery failed at the data provider; next backfill pass will retry.",
  ambiguous: "Multiple candidate amounts; manual review required.",
  permanently_unavailable: "Amount cannot be recovered (e.g., EURC mirror-zero or Tron legacy row).",
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
  /** The ledger read failed. Without retained rows this is unavailable, never an empty result. */
  error?: unknown | null;
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
  { id: "address", label: "Address" },
  { id: "amount", label: "Amount / Value", className: "text-right" },
  { id: "tx", label: "Tx", className: "text-center" },
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
  error = null,
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
            row.amountNative != null && Number.isFinite(row.amountNative) ? row.amountNative : null,
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
        tableId="freezewatch-events"
        testId="freezewatch-events-table"
        columns={BLACKLIST_COLUMNS}
        striped
        stickyHeader
        stickyMode="page"
        containerClassName="rounded-xl border"
        mobileScrollHint={false}
      >
        <DataTableLoadingRows columns={BLACKLIST_COLUMNS} rowCount={10} />
      </DataTableShell>
    );
  }

  // A failed ledger read with no retained rows is unavailable, not an empty match set (R2).
  const viewState = resolveQueryViewState({ hasData: events.length > 0, isLoading, error });
  if (viewState === "unavailable") return null;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="@container">
        <div className="space-y-3 @3xl:hidden">
          <MobileSortPanel kicker="Event cards">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                Sorted by {sortKey} {sortDirection === "asc" ? "ascending" : "descending"}.
              </p>
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
          </MobileSortPanel>
          {events.length === 0 ? (
            <div className="pharos-empty-note py-8 text-center">
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

        <div className="hidden @3xl:block">
          <DataTableShell
            tableId="freezewatch-events"
            testId="freezewatch-events-table"
            columns={BLACKLIST_COLUMNS}
            sort={{
              sortKey,
              sortDirection,
              toggleSort,
              getAriaSortValue,
            }}
            striped
            stickyHeader
            stickyMode="page"
            containerClassName="rounded-xl border"
            mobileScrollHint={false}
            topSlot={
              <div className="pharos-table-toolbar flex-row items-center justify-end">
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
              <DataTableEmptyRow colSpan={BLACKLIST_COLUMNS.length}>
                No freeze events match your filters.
              </DataTableEmptyRow>
            )}
          </DataTableShell>
        </div>
      </div>
    </TooltipProvider>
  );
}

function StablecoinCellLink({ symbol }: { symbol: string }) {
  const coinId = coinIdBySymbol(symbol);
  const logoSrc = coinId ? logosById[coinId] : undefined;

  if (!coinId) {
    return (
      <span className="inline-flex items-center gap-2 font-medium text-foreground">
        <StablecoinLogo src={logoSrc} name={symbol} size={20} />
        <span>{symbol}</span>
      </span>
    );
  }

  return (
    <Link
      href={buildStablecoinUrl(coinId)}
      className="pharos-focus-ring inline-flex items-center gap-2 rounded-sm font-medium text-foreground transition-colors hover:text-brand-accent-text hover:underline"
    >
      <StablecoinLogo src={logoSrc} name={symbol} size={20} />
      <span>{symbol}</span>
    </Link>
  );
}

function CopyAddressButton({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = useCallback(() => {
    void navigator.clipboard?.writeText(address).then(() => {
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1800);
    });
  }, [address]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? `Copied address ${address}` : `Copy address ${address}`}
      title={copied ? "Copied" : "Copy full address"}
      className="pharos-focus-ring inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground sm:min-h-7 sm:min-w-7"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-state-positive" aria-hidden="true" />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}

function BlacklistEventRow({ event: evt, rank }: { event: BlacklistEvent; rank: number }) {
  return (
    <TableRow>
      <TableCell className="text-right text-xs text-muted-foreground pharos-numeric">
        {rank}
      </TableCell>
      <TableCell className="whitespace-nowrap pharos-numeric text-xs">{formatEventDate(evt.timestamp)}</TableCell>
      <TableCell>
        <StablecoinCellLink symbol={evt.stablecoin} />
      </TableCell>
      <TableCell>{evt.chainName}</TableCell>
      <TableCell>
        <Badge variant="outline" className={EVENT_BADGE_STYLES[evt.eventType] ?? ""}>
          {EVENT_LABELS[evt.eventType] ?? evt.eventType}
        </Badge>
      </TableCell>
      <TableCell>
        <div className="inline-flex items-center gap-1">
          <a
            href={evt.explorerAddressUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="pharos-focus-ring block max-w-[132px] truncate rounded-sm font-mono text-xs hover:underline sm:max-w-none"
            aria-label={`View address ${evt.address} on ${evt.chainName}`}
          >
            {formatAddress(evt.address)}
          </a>
          <CopyAddressButton address={evt.address} />
        </div>
      </TableCell>
      <TableCell className="text-right pharos-numeric">
        <BlacklistAmount event={evt} />
      </TableCell>
      <TableCell className="text-center">
        <BlacklistTxLink event={evt} />
      </TableCell>
    </TableRow>
  );
}

function BlacklistAmount({ event: evt }: { event: BlacklistEvent }) {
  return (
    <span className="inline-flex items-center justify-end gap-1.5">
      <span>{formatBlacklistAmountOrStatus(evt)}</span>
      <AmountProvenanceInfo event={evt} />
    </span>
  );
}

function AmountProvenanceInfo({ event: evt }: { event: BlacklistEvent }) {
  const showSource = evt.amountSource !== "unavailable" || evt.amountStatus === "resolved";
  const showStatus = evt.amountStatus !== "resolved";
  if (!showSource && !showStatus) return null;

  const sourceLabel = getBlacklistAmountSourceLabel(evt).replace(/^./, (char) => char.toUpperCase());
  const sourceTooltip = AMOUNT_SOURCE_TOOLTIPS[evt.amountSource];
  const statusLabel = evt.amountStatus.replace(/_/g, " ");
  const statusTooltip = AMOUNT_STATUS_TOOLTIPS[evt.amountStatus];

  const summaryParts = [
    showSource ? `Source: ${sourceLabel}` : null,
    showStatus ? `Status: ${statusLabel}` : null,
  ].filter(Boolean);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`Amount provenance (${summaryParts.join(", ")})`}
          className={
            showStatus
              ? "pharos-focus-ring inline-flex min-h-6 min-w-6 items-center justify-center rounded-full text-state-warn transition-colors hover:bg-muted/60"
              : "pharos-focus-ring inline-flex min-h-6 min-w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          }
        >
          <Info className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[260px] space-y-1 text-2xs">
        {showSource ? (
          <p>
            <span className="font-semibold">Source: {sourceLabel}.</span>{" "}
            {sourceTooltip}
          </p>
        ) : null}
        {showStatus ? (
          <p>
            <span className="font-semibold">Status: {statusLabel}.</span>{" "}
            {statusTooltip}
          </p>
        ) : null}
      </TooltipContent>
    </Tooltip>
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
            <StablecoinCellLink symbol={evt.stablecoin} />
            <Badge variant="outline" className={EVENT_BADGE_STYLES[evt.eventType] ?? ""}>
              {EVENT_LABELS[evt.eventType] ?? evt.eventType}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            #{rank} · {evt.chainName} · <span className="pharos-numeric">{formatEventDate(evt.timestamp)}</span>
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="pharos-label">Amount</p>
          <p className="pharos-numeric text-sm font-semibold text-foreground">
            <BlacklistAmount event={evt} />
          </p>
        </div>
      </div>

      <div className="mt-3 pharos-inset px-3 py-2">
        <p className="pharos-label">Address</p>
        <div className="mt-1 flex items-center justify-between gap-2">
          <a
            href={evt.explorerAddressUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="pharos-focus-ring inline-flex min-h-11 max-w-full items-center rounded-md font-mono text-xs text-foreground underline-offset-4 hover:underline"
            aria-label={`View address ${evt.address} on ${evt.chainName}`}
          >
            {formatAddress(evt.address)}
          </a>
          <CopyAddressButton address={evt.address} />
        </div>
      </div>

      <div className="mt-3 flex items-center justify-end">
        <BlacklistTxLink event={evt} />
      </div>
    </article>
  );
}

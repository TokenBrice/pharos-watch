"use client";

import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ExternalLink, ArrowDownUp } from "lucide-react";
import { useMintBurnEvents } from "@/hooks/use-mint-burn-flows";
import {
  formatCurrency,
  formatTokenAmount,
  timeAgo,
  formatEventDate,
} from "@shared/lib/format";
import { CHAIN_META } from "@shared/lib/chains";
import type { MintBurnEvent } from "@shared/types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface FlowEventFeedProps {
  stablecoinId: string;
  limit?: number;
  scope?: "all" | "counted";
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTxHash(hash: string): string {
  if (hash.length <= 12) return hash;
  return `${hash.slice(0, 6)}...${hash.slice(-4)}`;
}

function chainName(chainId: string): string {
  return CHAIN_META[chainId]?.name ?? chainId;
}

function getEventBadge(event: MintBurnEvent): {
  label: string;
  className: string;
} {
  if (event.flowType === "atomic_roundtrip") {
    return {
      label: "Roundtrip",
      className: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20 text-xs",
    };
  }

  if (event.direction === "burn" && event.burnType === "bridge_burn") {
    return {
      label: "Bridge burn",
      className: "bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-500/20 text-xs",
    };
  }

  if (event.direction === "burn" && event.burnType === "review_required") {
    return {
      label: "Review burn",
      className: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-300 border-yellow-500/20 text-xs",
    };
  }

  if (event.direction === "mint") {
    return {
      label: "Mint",
      className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20 text-xs",
    };
  }

  return {
    label: "Burn",
    className: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20 text-xs",
  };
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function FeedSkeleton() {
  return (
    <div className="rounded-xl border overflow-hidden">
      <div className="bg-muted/50 h-10" />
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-2 border-t">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-5 w-12 rounded-full" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-16" />
          <div className="flex-1" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-4 shrink-0" />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function FeedEmpty() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
      <ArrowDownUp className="h-10 w-10 opacity-40" />
      <p className="text-sm">No mint/burn events recorded yet.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error state
// ---------------------------------------------------------------------------

function FeedError({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
      Unable to load event data. {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function FlowEventFeed({ stablecoinId, limit, scope = "all" }: FlowEventFeedProps) {
  const pageSize = limit ?? DEFAULT_PAGE_SIZE;
  const [page, setPage] = useState(0);

  const { data, isLoading, isError, error } = useMintBurnEvents(stablecoinId, {
    scope,
    limit: pageSize,
    offset: page * pageSize,
  });

  if (isLoading) return <FeedSkeleton />;
  if (isError) return <FeedError message={error instanceof Error ? error.message : "Unknown error"} />;
  if (!data || data.events.length === 0) {
    if (page === 0) return <FeedEmpty />;
    // If we paginated past the end, show the table with a "no more" message
  }

  const events = data?.events ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const showingStart = Math.min(page * pageSize + 1, total);
  const showingEnd = Math.min((page + 1) * pageSize, total);

  return (
    <div className="space-y-3">
      <div className="rounded-xl border overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/80 backdrop-blur-sm">
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Direction</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="hidden sm:table-cell">Chain</TableHead>
              <TableHead className="text-center">Tx</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.map((evt) => {
              const badge = getEventBadge(evt);
              return (
                <TableRow key={evt.id}>
                  <TableCell
                    className="whitespace-nowrap text-xs"
                    title={formatEventDate(evt.timestamp)}
                  >
                    <span className="font-mono">{timeAgo(evt.timestamp)}</span>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={badge.className}
                    >
                      {badge.label}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums text-sm">
                    {evt.amountUsd != null ? (
                      formatCurrency(evt.amountUsd)
                    ) : evt.amount > 0 ? (
                      <div className="flex flex-col items-end gap-1">
                        <span>{formatTokenAmount(evt.amount)} {evt.symbol}</span>
                        <Badge variant="outline" className="text-[10px]">
                          Unpriced
                        </Badge>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">&mdash;</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell text-sm">
                    {chainName(evt.chainId)}
                  </TableCell>
                  <TableCell className="text-center">
                    <a
                      href={evt.explorerTxUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <span className="hidden md:inline">{formatTxHash(evt.txHash)}</span>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </TableCell>
                </TableRow>
              );
            })}
            {events.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground py-12">
                  No more events.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {total > 0 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Showing{" "}
            <span className="font-mono">{showingStart}</span>
            &ndash;
            <span className="font-mono">{showingEnd}</span>
            {" "}of{" "}
            <span className="font-mono">{total}</span> events
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page <= 0}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

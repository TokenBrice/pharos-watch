"use client";

import Link from "next/link";
import { RotateCcw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/table";
import {
  EmptyStateIllustration,
  type EmptyStateKind,
} from "@/components/empty-state-illustration";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { buildStablecoinUrl } from "@shared/lib/urls";
import type { FilterTag, StablecoinData } from "@shared/types";

interface StablecoinTableEmptyStateProps {
  searchQuery?: string;
  activeFilters: readonly FilterTag[];
  data?: StablecoinData[];
  logos?: Record<string, string>;
  onClearSearch?: () => void;
  onClearFilters?: () => void;
}

export function StablecoinTableEmptyState({
  searchQuery,
  activeFilters,
  data,
  logos,
  onClearSearch,
  onClearFilters,
}: StablecoinTableEmptyStateProps) {
  // Map the local state (search vs filters vs cold-start) onto the canonical
  // EmptyStateKind enum so this surface stops shipping bespoke copy.
  const kind: EmptyStateKind = searchQuery
    ? "no-results"
    : activeFilters.length > 0
      ? "no-matches"
      : "no-data";
  const title = searchQuery
    ? `No results for "${searchQuery}"`
    : activeFilters.length > 0
      ? "No stablecoins match your filters"
      : "No stablecoin data available";
  const description =
    activeFilters.length > 0 || searchQuery
      ? "Try adjusting your filters or clearing them to see the full tracked universe."
      : "Check back soon — we're constantly monitoring the market.";
  const showActions = !!searchQuery || activeFilters.length > 0;
  return (
    <TableRow>
      <TableCell colSpan={99} className="py-10">
        <div className="flex flex-col items-center text-center">
          <EmptyStateIllustration
            kind={kind}
            title={title}
            description={description}
            action={
              showActions ? (
                <>
                  {activeFilters.length > 0 && onClearFilters ? (
                    <Button
                      variant="default"
                      size="sm"
                      onClick={onClearFilters}
                      className="gap-1.5 rounded-full"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      Clear all filters
                    </Button>
                  ) : null}
                  {searchQuery && onClearSearch ? (
                    <Button
                      variant={activeFilters.length > 0 ? "outline" : "default"}
                      size="sm"
                      onClick={onClearSearch}
                      className="gap-1.5 rounded-full"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      Clear search
                    </Button>
                  ) : null}
                </>
              ) : undefined
            }
          />
          {(searchQuery || activeFilters.length > 0) && data && data.length > 0 && (
            <div className="mt-6 border-t border-border/50 pt-5">
              <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Popular stablecoins
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {data.slice(0, 5).map((coin) => (
                  <Link
                    key={coin.id}
                    href={buildStablecoinUrl(coin.id)}
                    className="pharos-focus-ring inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/60 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent/50 hover:text-foreground"
                  >
                    <StablecoinLogo src={logos?.[coin.id]} name={coin.name} size={16} />
                    {coin.symbol}
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

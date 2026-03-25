"use client";

import { useMemo } from "react";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { StablecoinFilteredTable } from "@/components/stablecoin-filtered-table";
import { pegCurrencyToFilterTag } from "@shared/types";
import type { PegCurrency } from "@shared/types";

export function PegLandingClient({ pegCurrency }: { pegCurrency: PegCurrency }) {
  const filterTag = pegCurrencyToFilterTag(pegCurrency);
  const activeFilters = useMemo(() => [filterTag], [filterTag]);

  return (
    <SectionErrorBoundary name="Stablecoins">
      <StablecoinFilteredTable
        activeFilters={activeFilters}
        renderNotice={({ pegRateSources }) =>
          pegRateSources[`pegged${pegCurrency}`] === "fallback" ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Peg reference uses ECB FX rate (not market-derived) — fewer than 3 coins tracked for {pegCurrency}.
            </p>
          ) : null
        }
      />
    </SectionErrorBoundary>
  );
}

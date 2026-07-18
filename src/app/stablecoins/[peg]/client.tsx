"use client";

import { useMemo } from "react";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { StablecoinFilteredTable } from "@/components/stablecoin-filtered-table";
import { pegCurrencyToFilterTag } from "@shared/lib/filter-tags";
import type { PegCurrency } from "@shared/types";

export function PegLandingClient({ pegCurrency }: { pegCurrency: PegCurrency }) {
  const filterTag = pegCurrencyToFilterTag(pegCurrency);
  const activeFilters = useMemo(() => [filterTag], [filterTag]);

  return (
    <SectionErrorBoundary name="Stablecoins">
      <StablecoinFilteredTable
        activeFilters={activeFilters}
        renderNotice={({ pegRateSources }) =>
          pegRateSources[`pegged${pegCurrency}`] === "fx" ? (
            <p className="text-xs text-[color:var(--severity-mild)]">
              Peg reference uses the live fiat FX rate rather than a stablecoin peer median.
            </p>
          ) : null
        }
      />
    </SectionErrorBoundary>
  );
}

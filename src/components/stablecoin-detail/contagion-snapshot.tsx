"use client";

import { useMemo, type ReactNode } from "react";
import Link from "next/link";
import { useReportCardsV9 } from "@/hooks/api-hooks";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { buildStablecoinUrl } from "@/lib/urls";
import { CollateralUsageSection } from "./collateral-usage-section";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import {
  DETAIL_MODULE_BODY_CLASS,
  DETAIL_MODULE_HEADER_CLASS,
  DETAIL_MODULE_SHELL_CLASS,
  DETAIL_MODULE_TITLE_CLASS,
} from "@/components/stablecoin-detail/section-title-class";
import type { CollateralUsageEntry } from "@/lib/collateral-usage-model";
import { QueryStateNotice } from "@/components/query-state-notice";

interface ContagionSnapshotProps {
  stablecoinId: string;
  variantRelationshipCard?: ReactNode;
  hasCollateralUsage?: boolean;
  collateralUsageEntries?: readonly CollateralUsageEntry[];
}

export function ContagionSnapshot({
  stablecoinId,
  variantRelationshipCard,
  hasCollateralUsage,
  collateralUsageEntries = [],
}: ContagionSnapshotProps) {
  const reportCardsQuery = useReportCardsV9();
  const { data: rc } = reportCardsQuery;
  const hasVariantCard = Boolean(variantRelationshipCard);
  const hasRightColumn = hasVariantCard || Boolean(hasCollateralUsage);
  const edges = useMemo(
    () => (rc?.dependencyGraph.edges ?? []).filter((edge) => edge.from === stablecoinId || edge.to === stablecoinId),
    [rc?.dependencyGraph.edges, stablecoinId],
  );
  const hasContagion = edges.length > 0;
  const sourceError = reportCardsQuery.error;
  const hasSourceData = rc !== undefined;
  const sourceDataUpdatedAt = reportCardsQuery.dataUpdatedAt;

  if (!hasContagion && !hasRightColumn && !sourceError) {
    return null;
  }

  const rightColumn = (
    <div className="space-y-6">
      {variantRelationshipCard}
      {hasCollateralUsage ? (
        <div className={hasVariantCard ? "border-t border-border/40 pt-6" : undefined}>
          <CollateralUsageSection entries={collateralUsageEntries} />
        </div>
      ) : null}
    </div>
  );

  const isSplit = hasContagion && hasRightColumn;
  const layoutClass = isSplit ? "grid gap-6 lg:grid-cols-2" : hasContagion ? undefined : "mx-auto max-w-2xl";

  return (
    <section className={DETAIL_MODULE_SHELL_CLASS}>
      <div className={DETAIL_MODULE_HEADER_CLASS}>
        <DetailSectionTitle className={DETAIL_MODULE_TITLE_CLASS}>Dependency Context</DetailSectionTitle>
      </div>
      <div className={DETAIL_MODULE_BODY_CLASS}>
        {sourceError ? (
          <QueryStateNotice
            state={hasSourceData ? "stale-with-data" : "unavailable"}
            label="Dependency graph data"
            dataUpdatedAt={sourceDataUpdatedAt}
            onRetry={() => {
              void reportCardsQuery.refetch();
            }}
          />
        ) : null}
        <div className={layoutClass}>
          {hasContagion ? (
            <ul className="divide-y divide-border/40 border-y border-border/40">
              {edges.map((edge) => {
                const otherId = edge.from === stablecoinId ? edge.to : edge.from;
                const meta = CLIENT_TRACKED_META_BY_ID.get(otherId);
                return (
                  <li key={`${edge.from}-${edge.to}-${edge.materiality}`} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <Link
                      href={buildStablecoinUrl(otherId)}
                      className="pharos-focus-ring rounded-sm text-sm font-medium text-frost-blue hover:underline"
                    >
                      {meta?.symbol ?? otherId}
                    </Link>
                    <span className="font-mono text-xs text-muted-foreground">
                      {edge.from === stablecoinId ? "depends on this asset" : "upstream dependency"} ·{" "}
                      {edge.materiality.replaceAll("-", " ")}
                      {edge.weight === null ? "" : ` · ${(edge.weight * 100).toFixed(0)}%`}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {hasRightColumn ? rightColumn : null}
        </div>
      </div>
    </section>
  );
}

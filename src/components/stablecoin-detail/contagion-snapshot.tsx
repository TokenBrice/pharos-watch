"use client";

import type { ReactNode } from "react";
import { useReportCards } from "@/hooks/api-hooks";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useLogos } from "@/hooks/use-logos";
import { ContagionGraph } from "@/components/contagion-graph";
import { getCirculatingRaw } from "@shared/lib/supply";
import { CollateralUsageSection } from "./collateral-usage-section";
import type { CollateralUsageEntry } from "@/lib/collateral-usage-model";

interface ContagionSnapshotProps {
  stablecoinId: string;
  variantRelationshipCard?: ReactNode;
  hasCollateralUsage?: boolean;
  collateralUsageEntries?: readonly CollateralUsageEntry[];
}

const DETAIL_NODE_LIMIT = 500;

export function ContagionSnapshot({
  stablecoinId,
  variantRelationshipCard,
  hasCollateralUsage,
  collateralUsageEntries = [],
}: ContagionSnapshotProps) {
  const { data: rc } = useReportCards();
  const { data: list } = useStablecoins();
  const { data: logos } = useLogos();
  if (!rc?.cards || !list?.peggedAssets) return null;
  const focus = rc.cards.find((c) => c.id === stablecoinId);
  if (!focus) return null;
  const edges = rc.dependencyGraph?.edges ?? [];
  const liveCardIds = new Set(rc.cards.filter((c) => !c.isDefunct).map((c) => c.id));
  const hasContagion = edges.some(
    (e) =>
      liveCardIds.has(e.from)
      && liveCardIds.has(e.to)
      && (e.from === stablecoinId || e.to === stablecoinId),
  );
  const hasVariantCard = Boolean(variantRelationshipCard);
  const hasRightColumn = hasVariantCard || Boolean(hasCollateralUsage);

  if (!hasContagion && !hasRightColumn) {
    return null;
  }

  const mcapMap = new Map<string, number>();
  for (const coin of list.peggedAssets) {
    mcapMap.set(coin.id, getCirculatingRaw(coin));
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
  const layoutClass = isSplit
    ? "grid gap-6 lg:grid-cols-2"
    : hasContagion
      ? undefined
      : "mx-auto max-w-2xl";

  return (
    <section className="pharos-card-shell px-4 py-4 sm:px-5 sm:py-5">
      <h2 className="pharos-section-title mb-4">Dependency Context</h2>
      <div className={layoutClass}>
        {hasContagion ? (
          <ContagionGraph
            cards={rc.cards}
            dependencyEdges={edges}
            mcapMap={mcapMap}
            logos={logos}
            focusCoinId={stablecoinId}
            minimalChrome
            maxNodes={DETAIL_NODE_LIMIT}
          />
        ) : null}
        {hasRightColumn ? rightColumn : null}
      </div>
    </section>
  );
}

"use client";

import { useMemo, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useReportCardsV9 } from "@/hooks/api-hooks";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useLogos } from "@/hooks/use-logos";
import { getCirculatingRaw } from "@shared/lib/supply";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
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

/** Detail pages only draw the focus coin's own neighborhood, so the cap is generous. */
const DETAIL_NODE_LIMIT = 500;
const EMPTY_MCAP_MAP = new Map<string, number>();

const ContagionGraph = dynamic(() => import("@/components/contagion-graph").then((mod) => mod.ContagionGraph), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-[22rem] items-center justify-center rounded-xl border border-border/60 bg-card/40 text-sm text-muted-foreground">
      Loading dependency graph...
    </div>
  ),
});

export function ContagionSnapshot({
  stablecoinId,
  variantRelationshipCard,
  hasCollateralUsage,
  collateralUsageEntries = [],
}: ContagionSnapshotProps) {
  const reportCardsQuery = useReportCardsV9();
  const stablecoinsQuery = useStablecoins();
  const { data: rc } = reportCardsQuery;
  const { data: list } = stablecoinsQuery;
  const { data: logos } = useLogos();
  const hasVariantCard = Boolean(variantRelationshipCard);
  const hasRightColumn = hasVariantCard || Boolean(hasCollateralUsage);
  const cards = useMemo(
    () =>
      (rc?.cards ?? []).map((card) => ({
        id: card.id,
        symbol: CLIENT_TRACKED_META_BY_ID.get(card.id)?.symbol ?? card.id,
        grade: card.grade,
      })),
    [rc?.cards],
  );
  // Both endpoints must be published cards, otherwise the graph would drop the
  // edge and leave an empty stage where the map belongs.
  const edges = useMemo(() => {
    const cardIds = new Set(cards.map((card) => card.id));
    return (rc?.dependencyGraph.edges ?? []).filter(
      (edge) =>
        (edge.from === stablecoinId || edge.to === stablecoinId) && cardIds.has(edge.from) && cardIds.has(edge.to),
    );
  }, [cards, rc?.dependencyGraph.edges, stablecoinId]);
  const hasContagion = edges.length > 0;
  const mcapMap = useMemo(() => {
    const peggedAssets = list?.peggedAssets;
    if (!peggedAssets) return EMPTY_MCAP_MAP;
    return new Map(peggedAssets.map((coin) => [coin.id, getCirculatingRaw(coin)]));
  }, [list?.peggedAssets]);
  const sourceError = reportCardsQuery.error ?? stablecoinsQuery.error;
  const hasSourceData = rc !== undefined && list !== undefined;
  const sourceUpdatedTimes = [reportCardsQuery.dataUpdatedAt, stablecoinsQuery.dataUpdatedAt].filter(
    (value) => value > 0,
  );
  const sourceDataUpdatedAt = sourceUpdatedTimes.length > 0 ? Math.min(...sourceUpdatedTimes) : 0;

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
  // The map is the scenic half and needs the wider column; the variants and
  // used-by lists stay readable at the narrower measure.
  const layoutClass = isSplit
    ? "grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]"
    : hasContagion
      ? undefined
      : "mx-auto max-w-2xl";

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
              void stablecoinsQuery.refetch();
            }}
          />
        ) : null}
        <div className={layoutClass}>
          {hasContagion ? (
            <ContagionGraph
              cards={cards}
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
      </div>
    </section>
  );
}

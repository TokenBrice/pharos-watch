"use client";

import { useMemo, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useReportCards } from "@/hooks/api-hooks";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useLogos } from "@/hooks/use-logos";
import { getCirculatingRaw } from "@shared/lib/supply";
import { CollateralUsageSection } from "./collateral-usage-section";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import {
  DETAIL_MODULE_BODY_CLASS,
  DETAIL_MODULE_HEADER_CLASS,
  DETAIL_MODULE_SHELL_CLASS,
  DETAIL_MODULE_TITLE_CLASS,
} from "@/components/stablecoin-detail/section-title-class";
import type { CollateralUsageEntry } from "@/lib/collateral-usage-model";
import type { ReportCard, ReportCardsResponse, StablecoinData } from "@shared/types";

interface ContagionSnapshotProps {
  stablecoinId: string;
  variantRelationshipCard?: ReactNode;
  hasCollateralUsage?: boolean;
  collateralUsageEntries?: readonly CollateralUsageEntry[];
}

const DETAIL_NODE_LIMIT = 500;
const EMPTY_CARDS: ReportCard[] = [];
const EMPTY_DEPENDENCY_EDGES: ReportCardsResponse["dependencyGraph"]["edges"] = [];
const EMPTY_PEGGED_ASSETS: StablecoinData[] = [];
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
  const { data: rc } = useReportCards();
  const { data: list } = useStablecoins();
  const { data: logos } = useLogos();
  const hasVariantCard = Boolean(variantRelationshipCard);
  const hasRightColumn = hasVariantCard || Boolean(hasCollateralUsage);
  const cards = rc?.cards ?? EMPTY_CARDS;
  const dependencyEdges = rc?.dependencyGraph?.edges ?? EMPTY_DEPENDENCY_EDGES;
  const peggedAssets = list?.peggedAssets ?? EMPTY_PEGGED_ASSETS;
  const hasStablecoinsPayload = Boolean(list?.peggedAssets);
  const focus = useMemo(() => cards.find((c) => c.id === stablecoinId), [cards, stablecoinId]);
  const edges = focus ? dependencyEdges : EMPTY_DEPENDENCY_EDGES;
  const liveCardIds = useMemo(() => new Set(cards.filter((c) => !c.isDefunct).map((c) => c.id)), [cards]);
  const hasContagion = useMemo(
    () =>
      Boolean(
        focus &&
        hasStablecoinsPayload &&
        edges.some(
          (e) => liveCardIds.has(e.from) && liveCardIds.has(e.to) && (e.from === stablecoinId || e.to === stablecoinId),
        ),
      ),
    [edges, focus, hasStablecoinsPayload, liveCardIds, stablecoinId],
  );
  const mcapMap = useMemo(() => {
    if (!hasContagion) return EMPTY_MCAP_MAP;
    return new Map(peggedAssets.map((coin) => [coin.id, getCirculatingRaw(coin)]));
  }, [hasContagion, peggedAssets]);

  if (!hasContagion && !hasRightColumn) {
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

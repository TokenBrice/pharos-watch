"use client";

import { useMemo, type ReactNode } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useReportCardsV9 } from "@/hooks/api-hooks";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { logosById } from "@/lib/logos";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { CollateralUsageSection, type PublishedCollateralUsageEntry } from "./collateral-usage-section";
import { buildDetailDependencyContext, hasDependencyContextRows } from "./dependency-context-model";
import { DependencyContextDetails } from "./dependency-context-details";
import { StablecoinModuleTitle } from "@/components/stablecoin-detail/module-title";
import {
  DETAIL_MODULE_BODY_CLASS,
  DETAIL_MODULE_HEADER_CLASS,
  DETAIL_MODULE_SHELL_CLASS,
  DETAIL_MODULE_TITLE_CLASS,
} from "@/components/stablecoin-detail/section-title-class";
import { QueryStateNotice } from "@/components/query-state-notice";
import { LazySection } from "@/components/lazy-section";

interface ContagionSnapshotProps {
  stablecoinId: string;
  variantRelationshipCard?: ReactNode;
}

/** Detail pages only draw the focus coin's own neighborhood, so the cap is generous. */
const DETAIL_NODE_LIMIT = 500;
const EMPTY_MCAP_MAP: ReadonlyMap<string, number | null> = new Map();

function DependencyGraphPlaceholder() {
  return (
    <div className="flex min-h-[22rem] items-center justify-center rounded-xl border border-border/60 bg-card/40 text-sm text-muted-foreground">
      Loading dependency graph...
    </div>
  );
}

const ContagionGraph = dynamic(() => import("@/components/contagion-graph-root").then((mod) => mod.ContagionGraph), {
  ssr: false,
  loading: DependencyGraphPlaceholder,
});

export function ContagionSnapshot({
  stablecoinId,
  variantRelationshipCard,
}: ContagionSnapshotProps) {
  const reportCardsQuery = useReportCardsV9();
  const stablecoinsQuery = useStablecoins();
  const { data: rc } = reportCardsQuery;
  const { data: list } = stablecoinsQuery;
  const logos = logosById;
  const hasVariantCard = Boolean(variantRelationshipCard);
  const cards = useMemo(
    () =>
      (rc?.cards ?? []).map((card) => ({
        id: card.id,
        symbol: CLIENT_TRACKED_META_BY_ID.get(card.id)?.symbol ?? card.id,
        grade: card.grade,
        sharedBookId: card.sharedBookId,
      })),
    [rc?.cards],
  );
  const focusCard = rc?.cards.find((card) => card.id === stablecoinId);
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
  const mcapMap = useMemo<ReadonlyMap<string, number | null>>(() => {
    const peggedAssets = list?.peggedAssets;
    if (!peggedAssets) return EMPTY_MCAP_MAP;
    return new Map(peggedAssets.map((coin) => [coin.id, getCirculatingRawOrNull(coin)]));
  }, [list?.peggedAssets]);
  const marketCapAsOf = stablecoinsQuery.meta?.updatedAt ?? null;
  const dependencyContext = useMemo(
    () => buildDetailDependencyContext(stablecoinId, rc?.cards ?? [], rc?.dependencyGraph.edges ?? [], mcapMap, marketCapAsOf),
    [stablecoinId, rc?.cards, rc?.dependencyGraph.edges, mcapMap, marketCapAsOf],
  );
  // Keep the existing whole-module empty behavior when no context has a published row.
  const detailCard = focusCard && hasDependencyContextRows(focusCard, dependencyContext) ? focusCard : undefined;
  const collateralUsageEntries = useMemo<PublishedCollateralUsageEntry[]>(
    () => edges.filter((edge) => edge.from === stablecoinId).map((edge) => {
      const meta = CLIENT_TRACKED_META_BY_ID.get(edge.to);
      return {
        coin: { id: edge.to, name: meta?.name ?? edge.to, symbol: meta?.symbol ?? edge.to },
        edgeType: edge.kind,
        relationshipType: edge.dependencyType ?? (edge.kind === "basket" ? "collateral"
          : meta?.variantOf === edge.from ? "wrapper" : "serial-claim"),
        weight: edge.weight,
        marketCap: mcapMap.get(edge.to) ?? null,
      };
    }),
    [edges, stablecoinId, mcapMap],
  );
  const hasCollateralUsage = collateralUsageEntries.length > 0;
  const hasRightColumn = hasVariantCard || hasCollateralUsage;
  const sourceError = reportCardsQuery.error ?? stablecoinsQuery.error;
  const hasSourceData = rc !== undefined && list !== undefined;
  const sourceUpdatedTimes = [reportCardsQuery.dataUpdatedAt, stablecoinsQuery.dataUpdatedAt].filter(
    (value) => value > 0,
  );
  const sourceDataUpdatedAt = sourceUpdatedTimes.length > 0 ? Math.min(...sourceUpdatedTimes) : 0;

  if (!detailCard && !hasContagion && !hasRightColumn && !sourceError) {
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
        <StablecoinModuleTitle className={DETAIL_MODULE_TITLE_CLASS}>Dependency Context</StablecoinModuleTitle>
        <Link
          href={`/dependency-map/?focus=${encodeURIComponent(stablecoinId)}`}
          className="pharos-focus-ring inline-flex min-h-11 items-center text-sm text-muted-foreground hover:text-foreground"
        >
          Open in Dependency Map
        </Link>
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
        {detailCard ? <DependencyContextDetails card={detailCard} context={dependencyContext} marketCapAsOf={marketCapAsOf} /> : null}
        <div className={layoutClass}>
          {hasContagion ? (
            <LazySection placeholder={<DependencyGraphPlaceholder />}>
              <ContagionGraph
                cards={cards}
                dependencyEdges={rc?.dependencyGraph.edges ?? []}
                mcapMap={mcapMap}
                logos={logos}
                focusCoinId={stablecoinId}
                minimalChrome
                maxNodes={DETAIL_NODE_LIMIT}
              />
            </LazySection>
          ) : null}
          {hasRightColumn ? rightColumn : null}
        </div>
      </div>
    </section>
  );
}

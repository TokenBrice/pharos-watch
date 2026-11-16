"use client";

import { Fragment, useMemo, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { ArrowRight } from "lucide-react";
import { IntentLink } from "@/components/intent-link";
import { useReportCardsV9Detail } from "@/hooks/api-hooks";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { logosById } from "@/lib/logos";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { CollateralUsageSection, ListedDependencyIdsContext, type PublishedCollateralUsageEntry } from "./collateral-usage-section";
import { buildDetailDependencyContext, hasDependencyContextRows } from "./dependency-context-model";
import { DependencySummary, OutsideGraphList, ScoredRoleList, UpstreamList } from "./dependency-context-details";
import { ModuleDisclosure } from "./module-disclosure";
import { StablecoinModuleTitle } from "@/components/stablecoin-detail/module-title";
import {
  DETAIL_MODULE_BODY_CLASS,
  DETAIL_MODULE_HEADER_CLASS,
  DETAIL_MODULE_SHELL_CLASS,
  DETAIL_MODULE_TITLE_CLASS,
} from "@/components/stablecoin-detail/section-title-class";
import { QueryStateNotice } from "@/components/query-state-notice";

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

const ContagionGraph = dynamic(() => import("@/components/contagion-graph/contagion-graph-root").then((mod) => mod.ContagionGraph), {
  ssr: false,
  loading: DependencyGraphPlaceholder,
});

export function ContagionSnapshot({
  stablecoinId,
  variantRelationshipCard,
}: ContagionSnapshotProps) {
  const reportCardsQuery = useReportCardsV9Detail(stablecoinId);
  const stablecoinsQuery = useStablecoins();
  const { data: rc } = reportCardsQuery;
  const { data: list } = stablecoinsQuery;
  const logos = logosById;
  const symbol = CLIENT_TRACKED_META_BY_ID.get(stablecoinId)?.symbol ?? stablecoinId;
  const cards = useMemo(
    () =>
      (rc?.neighborhood ?? []).map((card) => ({
        id: card.id,
        symbol: CLIENT_TRACKED_META_BY_ID.get(card.id)?.symbol ?? card.id,
        grade: card.grade,
        partialEvidence: card.partialEvidence,
        ratingStatus: card.ratingStatus,
        pillars: card.pillars,
        sharedBookId: card.sharedBookId,
      })),
    [rc?.neighborhood],
  );
  const gradeById = useMemo(() => new Map(cards.map((card) => [card.id, card.grade])), [cards]);
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
    () => buildDetailDependencyContext(stablecoinId, rc?.neighborhood ?? [], rc?.dependencyGraph.edges ?? [], mcapMap, marketCapAsOf),
    [stablecoinId, rc?.neighborhood, rc?.dependencyGraph.edges, mcapMap, marketCapAsOf],
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
        grade: gradeById.get(edge.to),
        variantKind: meta?.variantOf === stablecoinId ? meta.variantKind : undefined,
      };
    }),
    [edges, stablecoinId, mcapMap, gradeById],
  );
  const upstreams = useMemo(
    () => dependencyContext.upstreams.map((entry) => ({ ...entry, grade: gradeById.get(entry.coin.id) })),
    [dependencyContext.upstreams, gradeById],
  );
  // Every coin the ranked lists below show; the variant cards skip these rows.
  const listedIds = useMemo(
    () => new Set([...collateralUsageEntries, ...(detailCard ? upstreams : [])].map((entry) => entry.coin.id)),
    [collateralUsageEntries, detailCard, upstreams],
  );
  // The notice names the report-card read, which is the graph's source; a
  // supply-only failure leaves the graph drawn with "mcap n/a" instead.
  const sourceUnavailable = reportCardsQuery.error != null && rc === undefined;
  const roles = detailCard?.dependencies.roles ?? [];
  const coverage = detailCard?.dependencyCoverage ?? [];

  // List first: the ranked lists lead, the variant relationship sits beside
  // them, and the drawn graph waits behind a fold.
  const blocks = [
    collateralUsageEntries.length > 0 ? <CollateralUsageSection key="used-by" entries={collateralUsageEntries} symbol={symbol} /> : null,
    variantRelationshipCard ? <Fragment key="variants">{variantRelationshipCard}</Fragment> : null,
    detailCard && upstreams.length > 0 ? <UpstreamList key="upstreams" symbol={symbol} upstreams={upstreams} /> : null,
    roles.length > 0 ? <ScoredRoleList key="roles" roles={roles} gradeOf={(id) => gradeById.get(id)} /> : null,
    coverage.length > 0 ? <OutsideGraphList key="coverage" coverage={coverage} /> : null,
  ].filter((block) => block !== null);

  if (!detailCard && !hasContagion && blocks.length === 0 && !sourceUnavailable) {
    return null;
  }

  const [primary, ...rest] = blocks;

  return (
    <section className={DETAIL_MODULE_SHELL_CLASS}>
      <div className={DETAIL_MODULE_HEADER_CLASS}>
        <StablecoinModuleTitle className={DETAIL_MODULE_TITLE_CLASS}>Dependency context</StablecoinModuleTitle>
        <IntentLink
          href={`/dependency-map/?focus=${encodeURIComponent(stablecoinId)}`}
          className="pharos-focus-ring inline-flex min-h-11 items-center gap-1 rounded-sm text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
        >
          Open in Dependency Map
          <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </IntentLink>
      </div>
      <div className={`${DETAIL_MODULE_BODY_CLASS} space-y-5`}>
        {sourceUnavailable ? (
          <QueryStateNotice
            state="unavailable"
            label="Dependency graph data"
            onRetry={() => {
              void reportCardsQuery.refetch();
              void stablecoinsQuery.refetch();
            }}
          />
        ) : null}
        {detailCard ? (
          <DependencySummary
            symbol={symbol}
            context={dependencyContext}
            usage={collateralUsageEntries}
            marketCapAsOf={marketCapAsOf}
          />
        ) : null}
        {primary ? (
          // Flex, not a 3fr/2fr grid: when the variants card renders nothing
          // (every variant already ranks in Used by), the empty side column
          // drops out and the list takes the full width.
          <ListedDependencyIdsContext.Provider value={listedIds}>
            <div className="flex flex-col gap-x-10 gap-y-6 lg:flex-row">
              <div className="min-w-0 lg:flex-3">{primary}</div>
              {rest.length > 0 ? <div className="min-w-0 space-y-6 empty:hidden lg:flex-2">{rest}</div> : null}
            </div>
          </ListedDependencyIdsContext.Provider>
        ) : null}
        {/* The pan/zoom canvas fights page scroll on touch, so phones get the
            Dependency Map link in the header instead of an inline graph. */}
        {hasContagion ? (
          <div className="hidden border-t border-border/40 pt-1 sm:block">
            <ModuleDisclosure
              label="Dependency graph"
              count={edges.length}
              deferredChildren={
                <div className="min-w-0 pt-2">
                  <ContagionGraph
                    cards={cards}
                    dependencyEdges={rc?.dependencyGraph.edges ?? []}
                    mcapMap={mcapMap}
                    logos={logos}
                    focusCoinId={stablecoinId}
                    minimalChrome
                    maxNodes={DETAIL_NODE_LIMIT}
                  />
                </div>
              }
            >
              <p className="pb-2 text-xs text-muted-foreground">
                {symbol}&apos;s direct links, drawn with pan and zoom. The Dependency Map shows the wider network.
              </p>
            </ModuleDisclosure>
          </div>
        ) : null}
      </div>
    </section>
  );
}

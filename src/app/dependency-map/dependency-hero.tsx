"use client";

import { ContagionGraph } from "@/components/contagion-graph";
import { formatCurrency } from "@shared/lib/format";
import type { ContagionGraphCard } from "@/lib/contagion-layout";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";
import type { DependencyHubsModel } from "./dependency-hubs-model";

interface DependencyHeroProps {
  model: DependencyHubsModel;
  cards: readonly ContagionGraphCard[];
  dependencyEdges: readonly ReportCardsV9DependencyEdge[];
  mcapMap: Map<string, number>;
  logos?: Record<string, string>;
}

/**
 * Full-width dependency-map hero. The collateral graph is a tall/scenic metaphor,
 * so — per the redesign dead-space rule — it leads full-width beneath a compact
 * frost "One Beam" header strip rather than inside a split `FeatureHeroSplit`.
 *
 * One Beam = the modeled market cap of the distinct coins that route through at
 * least one shared collateral hub, deduped so a coin depending on several hubs is
 * counted once (`DependencyHubsModel.uniqueDependentMcapUsd`). It is a neutral $
 * magnitude, so it takes the frost recipe. The graph card renders as a sibling —
 * cards are never nested (DESIGN.md §5).
 */
export function DependencyHero({ model, cards, dependencyEdges, mcapMap, logos }: DependencyHeroProps) {
  const routedSupply = formatCurrency(model.uniqueDependentMcapUsd, 1);

  return (
    <div className="space-y-4">
      <section className="pharos-card-shell px-5 py-5 sm:px-6 sm:py-6" aria-label="Shared collateral exposure summary">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-2">
            <p className="pharos-kicker">Shared Collateral Exposure</p>
            <p
              className="pharos-numeric text-[2.1rem] font-semibold leading-none tracking-tight text-frost-blue sm:text-[2.45rem]"
              title="Modeled market cap of the distinct coins that route through at least one shared collateral hub, counted once even when a coin depends on multiple hubs."
            >
              {routedSupply}
            </p>
            <p className="pharos-meta">Supply routed through shared collateral</p>
          </div>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:flex sm:items-end sm:gap-8">
            <div className="space-y-1">
              <dt className="pharos-kicker">
                Upstream hubs
              </dt>
              <dd className="pharos-numeric text-lg font-semibold text-foreground">{model.upstreamHubCount}</dd>
            </div>
            <div className="space-y-1">
              <dt className="pharos-kicker">
                Direct dependents
              </dt>
              <dd className="pharos-numeric text-lg font-semibold text-foreground">
                {model.uniqueDirectDependentCount}
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <ContagionGraph cards={cards} dependencyEdges={dependencyEdges} mcapMap={mcapMap} logos={logos} />
    </div>
  );
}

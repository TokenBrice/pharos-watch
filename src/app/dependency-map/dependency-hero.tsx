"use client";

import { ContagionGraph } from "@/components/contagion-graph-root";
import { formatCurrency } from "@shared/lib/format";
import type { ContagionGraphCard } from "@/lib/contagion-layout";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";
import type { DependencyHubsModel } from "@/lib/dependency-hubs-model";

interface DependencyHeroProps {
  model: DependencyHubsModel;
  cards: readonly ContagionGraphCard[];
  dependencyEdges: readonly ReportCardsV9DependencyEdge[];
  mcapMap: Map<string, number | null>;
  logos?: Record<string, string>;
  methodologyVersion: string;
  publishedAt: number;
}

export function DependencyHero({ model, cards, dependencyEdges, mcapMap, logos, methodologyVersion, publishedAt }: DependencyHeroProps) {
  const supply = model.mappedSupply;
  const hasKnownSupply = model.uniqueDirectDependentCount > supply.excludedSupplyUnknownIds.length;
  return (
    <div className="space-y-4">
      <section className="pharos-card-shell px-5 py-5 sm:px-6 sm:py-6" aria-label="Mapped direct exposure summary">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-2">
            <p className="pharos-kicker">Mapped direct exposure</p>
            <p className="pharos-numeric text-[2.1rem] font-semibold leading-none tracking-tight text-frost-blue sm:text-[2.45rem]">
              {model.directEdgeCount === 0 ? "No mapped dependencies" : hasKnownSupply ? formatCurrency(supply.knownUsd, 2) : "Supply data unavailable"}
            </p>
            <p className="pharos-meta">Dependents&apos; supply mapped to tracked upstreams (gross)</p>
            {model.directEdgeCount > 0 && <p className="max-w-3xl text-sm text-muted-foreground">
              Includes {formatCurrency(supply.overlapUsd, 2)} counted in more than one layer. Wrapper claims {formatCurrency(supply.passThroughUsd, 2)}, vault claims {formatCurrency(supply.vaultClaimUsd, 2)}. Excludes {supply.excludedSupplyUnknownIds.length} coins without supply data.
            </p>}
            {supply.unknownShareEdgeCount > 0 && <p className="text-sm text-muted-foreground">Excludes {supply.unknownShareEdgeCount} links with unknown mapped shares.</p>}
            {supply.integrityFlag && <p role="alert" className="text-sm text-muted-foreground">Published basket shares exceed 100%. Exposure totals require review.</p>}
            <p className="text-xs text-muted-foreground">V9 {methodologyVersion} · published {new Date(publishedAt * 1000).toISOString()}</p>
            <p className="text-xs text-muted-foreground">market cap as of {model.marketCapAsOf === null ? "unknown" : new Date(model.marketCapAsOf * 1000).toISOString()}</p>
          </div>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:flex sm:items-end sm:gap-8">
            <div className="space-y-1"><dt className="pharos-kicker">Upstream hubs</dt><dd className="pharos-numeric text-lg font-semibold text-foreground">{model.upstreamHubCount}</dd></div>
            <div className="space-y-1"><dt className="pharos-kicker">Direct dependents</dt><dd className="pharos-numeric text-lg font-semibold text-foreground">{model.uniqueDirectDependentCount}</dd></div>
          </dl>
        </div>
      </section>
      <ContagionGraph cards={cards} dependencyEdges={dependencyEdges} mcapMap={mcapMap} logos={logos} syncUrlState />
    </div>
  );
}

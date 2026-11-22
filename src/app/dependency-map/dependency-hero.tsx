"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { DependencyWatershed } from "@/components/dependency-watershed/dependency-watershed";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { useMediaQuery } from "@/hooks/use-is-mobile";
import { trackEvent } from "@/lib/analytics";
import {
  readDependencyMapView,
  writeDependencyMapView,
  type DependencyMapView,
} from "@/lib/dependency-watershed/view-url";
import { formatCurrency } from "@shared/lib/format";
import { formatEventTimestamp } from "@/lib/depeg-event-display";
import type { ContagionGraphCard } from "@/lib/contagion-layout";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";
import type { DependencyHubsModel } from "@shared/lib/dependency-hubs-model";
import { DependencyExposureWorkspace, type DependencyExposureWorkspaceState } from "./dependency-exposure-workspace";
import { stablecoinLabel } from "@/lib/stablecoin-label";
import type { SharedFailureDomainGroups } from "@/lib/shared-failure-domains-model";
import { formatClaimSubtotal } from "@/lib/dependency-watershed/known";
import type { CoinState } from "@shared/lib/coin-state";
import { cn } from "@/lib/utils";

const ContagionGraph = dynamic(
  () => import("@/components/contagion-graph/contagion-graph-root").then((module) => module.ContagionGraph),
  {
    ssr: false,
    loading: () => (
      <div role="status" aria-label="Loading network layout">
        <ChartSkeleton className="min-h-[520px] rounded-xl" />
      </div>
    ),
  },
);

const QUICK_TRACE_HUB_LIMIT = 5;

interface DependencyHeroProps {
  model: DependencyHubsModel;
  cards: readonly ContagionGraphCard[];
  dependencyEdges: readonly ReportCardsV9DependencyEdge[];
  mcapMap: Map<string, number | null>;
  logos?: Record<string, string>;
  methodologyVersion: string;
  publishedAt: number;
  workspace: DependencyExposureWorkspaceState;
  commonModeGroups?: SharedFailureDomainGroups | null;
  /** The supply read is still in flight: missing figures are pending, not unavailable. */
  supplyPending?: boolean;
  /** Rendered under the summary on small screens (the basin list). */
  mobileSummary?: ReactNode;
  /** Live exceptional states, overlaid on Network nodes and the selection panel. */
  coinStates?: ReadonlyMap<string, readonly CoinState[]>;
}

const VIEW_OPTIONS: { value: DependencyMapView; label: string }[] = [
  { value: "watershed", label: "Watershed" },
  { value: "network", label: "Network" },
];

export function DependencyHero({ model, cards, dependencyEdges, mcapMap, logos, methodologyVersion, publishedAt, workspace, commonModeGroups, supplyPending = false, mobileSummary, coinStates }: DependencyHeroProps) {
  const [view, setView] = useState<DependencyMapView>("watershed");
  const desktop = useMediaQuery("(min-width: 768px)", true);
  useEffect(() => {
    const readUrl = () => setView(readDependencyMapView(window.location.search));
    readUrl();
    window.addEventListener("popstate", readUrl);
    return () => window.removeEventListener("popstate", readUrl);
  }, []);
  const switchView = (next: DependencyMapView) => {
    if (next === view) return;
    setView(next);
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${writeDependencyMapView(window.location.search, next)}${window.location.hash}`);
    trackEvent("dependency_map_action", { action: "view_switch", value: next });
  };
  const labels = useMemo(() => new Map(cards.map(card => [card.id, stablecoinLabel(card)])), [cards]);
  const labelOf = useMemo(() => (id: string) => labels.get(id) ?? id, [labels]);
  const quickTraceHubs = useMemo(
    () => model.hubs.slice(0, QUICK_TRACE_HUB_LIMIT).map((hub) => ({ id: hub.id, label: hub.label })),
    [model.hubs],
  );
  const activeRoots = useMemo(() => new Set(workspace.state.roots), [workspace.state.roots]);

  const viewControls = desktop && (
    <div className="pharos-segmented m-3" role="group" aria-label="Dependency map view">
      {VIEW_OPTIONS.map(option => (
        <button
          key={option.value}
          type="button"
          aria-pressed={view === option.value}
          className="pharos-focus-ring pharos-segmented-item text-sm"
          onClick={() => switchView(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
  const network = (
    <ContagionGraph
      cards={cards}
      dependencyEdges={dependencyEdges}
      mcapMap={mcapMap}
      logos={logos}
      syncUrlState
      modeControls={<div className="flex flex-wrap">{workspace.modeControls}{viewControls}</div>}
      exposureOverlay={workspace.overlay}
      onUseAsExposureRoot={workspace.addRoot}
      hubExposures={model.hubs}
      commonModeGroups={commonModeGroups}
      coinStates={coinStates}
    />
  );
  const publication = workspace.exposure.publication;
  const supply = model.mappedSupply;
  const hasKnownSupply = supply.known;
  const exposureOptions = useMemo(
    () => cards.map((card) => ({ id: card.id, label: labelOf(card.id), name: labelOf(card.id), symbol: card.symbol })),
    [cards, labelOf],
  );

  return (
    <div className="space-y-4">
      <section className="pharos-card-shell px-4 py-3.5 sm:px-5 sm:py-4" aria-label="Mapped direct exposure summary">
        <div className="space-y-2.5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="space-y-1">
              <p className="pharos-label">Mapped direct exposure</p>
              <p className="pharos-numeric text-[1.9rem] font-semibold leading-none tracking-tight text-foreground sm:text-[2.2rem]">
                {model.directEdgeCount === 0 ? "No mapped dependencies" : hasKnownSupply ? `${formatCurrency(supply.knownUsd, 2)}${supply.complete ? "" : " (known only)"}` : supplyPending ? "—" : supply.excludedSupplyUnknownIds.length === model.uniqueDirectDependentCount ? "Supply data unavailable" : "Exposure unavailable"}
              </p>
              <p className="pharos-meta">Dependents&apos; supply mapped to tracked upstreams (gross, market-cap proxy basis)</p>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                <span>Safety Score {methodologyVersion} · published {formatEventTimestamp(publishedAt, true)}</span>
                {!supplyPending ? (
                  <span>market cap as of {model.marketCapAsOf === null ? "unknown" : formatEventTimestamp(model.marketCapAsOf, true)}</span>
                ) : null}
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-x-8 gap-y-2 sm:flex sm:items-end sm:gap-8">
              <div className="space-y-0.5"><dt className="pharos-label">Upstream hubs</dt><dd className="pharos-numeric text-lg font-semibold text-foreground">{model.upstreamHubCount}</dd></div>
              <div className="space-y-0.5"><dt className="pharos-label">Direct dependents</dt><dd className="pharos-numeric text-lg font-semibold text-foreground">{model.uniqueDirectDependentCount}</dd></div>
            </dl>
          </div>
          {model.directEdgeCount > 0 && !supplyPending && <p className="text-xs leading-relaxed text-muted-foreground">
            {hasKnownSupply ? <>Includes {formatCurrency(supply.overlapUsd, 2)} counted in more than one layer. {supply.unknownFormCount > 0 && supply.passThroughCount + supply.vaultClaimCount === 0 ? "Wrapper/vault split unavailable." : <>Wrapper claims {supply.unknownFormCount > 0 && supply.passThroughCount === 0 ? "unavailable" : formatClaimSubtotal(supply.passThroughUsd, supply.claimAvailability["pass-through"])}, vault claims {supply.unknownFormCount > 0 && supply.vaultClaimCount === 0 ? "unavailable" : formatClaimSubtotal(supply.vaultClaimUsd, supply.claimAvailability["vault-claim"])}{supply.unknownFormCount > 0 ? " (classified claims only)" : ""}.</>} {supply.unknownFormCount > 0 && <>Wrapper/vault split unavailable{supply.unknownFormUsd === null ? "; supply unavailable" : ` for ${formatCurrency(supply.unknownFormUsd, 2)} of known serial exposure`}; {supply.unknownFormCount} claims have no published form.</>}</> : <>Layer overlap unavailable. Wrapper claims unavailable, vault claims unavailable.</>} {supply.excludedSupplyUnknownIds.length > 0 && <>Excludes {supply.excludedSupplyUnknownIds.length} coins without supply data.</>}
          </p>}
          {supply.unknownShareEdgeCount > 0 && <p className="text-xs text-muted-foreground">Excludes {supply.unknownShareEdgeCount} links with unknown mapped shares.</p>}
          {supply.integrityFlag && <p role="alert" className="text-xs text-muted-foreground">Published basket shares exceed 100%. Exposure totals require review.</p>}
          {quickTraceHubs.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 border-t border-border/50 pt-2.5" role="group" aria-label="Quick trace upstream">
              <span className="pharos-label mr-1">Quick trace upstream</span>
              {quickTraceHubs.map((hub) => {
                const isSelected = activeRoots.has(hub.id);
                return (
                  <button
                    key={hub.id}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => workspace.addRoot(hub.id)}
                    className={cn(
                      "pharos-focus-ring pharos-control-pill inline-flex min-h-9 items-center gap-1.5 px-2.5 py-1 text-xs font-medium sm:min-h-7",
                      isSelected && "pharos-control-pill-active",
                    )}
                  >
                    <StablecoinLogo src={logos?.[hub.id]} name={hub.label} size={16} />
                    <span>{hub.label}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      </section>
      {mobileSummary}
      <DependencyExposureWorkspace
        workspace={workspace}
        options={exposureOptions}
        quickTraceHubs={quickTraceHubs}
        logos={logos}
      >
        {desktop && view === "watershed" && publication
          ? <DependencyWatershed publication={publication} overlay={workspace.overlay} result={workspace.exposure.result} labelOf={labelOf} onAddRoot={workspace.addRoot} controls={<div className="flex flex-wrap">{workspace.modeControls}{viewControls}</div>} fallback={network} />
          : network}
      </DependencyExposureWorkspace>
    </div>
  );
}

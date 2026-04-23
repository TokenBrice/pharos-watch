"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import type { RedemptionBackstopEntry } from "@shared/types";
import { MethodologyCardActions, MethodologyLabel } from "@/components/methodology-hint";
import { buildRedemptionBackstopCardViewModel } from "./redemption-backstop-card-view-model";

export function RedemptionBackstopCard({
  entry,
}: {
  entry: RedemptionBackstopEntry;
}) {
  const viewModel = buildRedemptionBackstopCardViewModel(entry);

  return (
    <Card>
      <CardHeader className="pb-3">
        <DetailSectionTitle>
          <MethodologyLabel topic="redemptionBackstop">Redemption Backstop</MethodologyLabel>
        </DetailSectionTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* ── arrange: Hero score + Exit, separated from metadata ── */}
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <Badge variant="outline" className={cn("px-2.5 py-1 font-mono text-lg", viewModel.scoreToneClass)}>
            {viewModel.heroScoreLabel}
          </Badge>
          {viewModel.showExitScore && (
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <MethodologyLabel topic="effectiveExit">Exit</MethodologyLabel>
              <span className="font-mono text-foreground">{viewModel.exitScoreLabel}</span>
            </span>
          )}
        </div>

        {/* ── arrange: Classification + metadata badges (secondary) ── */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="border-border/60 bg-muted/30 text-xs">
            {viewModel.routeFamilyLabel}
          </Badge>
          <Badge variant="outline" className="border-border/60 bg-muted/30 text-xs">
            {viewModel.sourceModeLabel}
          </Badge>
          {viewModel.showResolutionStateBadge && (
            <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-xs text-amber-700 dark:text-amber-300">
              {viewModel.resolutionStateLabel}
            </Badge>
          )}
          {viewModel.showRouteStatusBadge && (
            <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-xs text-amber-700 dark:text-amber-300">
              {viewModel.routeStatusLabel}
            </Badge>
          )}
          <Badge variant="outline" className="border-border/60 bg-muted/30 text-xs">
            {viewModel.modelConfidenceLabel}
          </Badge>
        </div>

        {viewModel.resolutionSummary ? (
          <div className="rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-sm text-muted-foreground">
            {viewModel.resolutionSummary}
          </div>
        ) : null}

        {/* ── distill: Route properties as compact inline row ── */}
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <div>
            <span className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Access </span>
            <span className="font-medium">{viewModel.accessLabel}</span>
          </div>
          <div>
            <span className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Settlement </span>
            <span className="font-medium">{viewModel.settlementLabel}</span>
          </div>
          <div>
            <span className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Output </span>
            <span className="font-medium">{viewModel.outputAssetLabel}</span>
          </div>
        </div>

        {/* ── Capacity card (earns the card treatment — has detail) ── */}
        <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
          <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
            Immediate Capacity
          </p>
          <p className="mt-1 text-sm font-medium">{viewModel.capacitySummary.headline}</p>
          <p className="mt-1 text-xs text-muted-foreground">{viewModel.capacitySummary.detail}</p>
        </div>

        {/* ── Fee card (earns the card treatment — has detail) ── */}
        <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
          <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
            Redemption Fee
          </p>
          <p className="mt-1 text-sm font-medium">{viewModel.feeSummary.headline}</p>
          <p className="mt-1 text-xs text-muted-foreground">{viewModel.feeSummary.detail}</p>
        </div>

        {/* ── colorize + distill: Sub-scores collapsed with color ── */}
        <details className="group">
          <summary className="pharos-focus-ring inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-md text-sm text-muted-foreground [&::-webkit-details-marker]:hidden lg:min-h-9">
            <span className="underline decoration-dashed underline-offset-2">Scoring breakdown</span>
            <ChevronDown aria-hidden="true" className="h-3 w-3 transition-transform group-open:rotate-180" />
          </summary>
          <div className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
            <div className="rounded-lg border border-border/60 px-3 py-2">
              Access score <span className={cn("font-mono", viewModel.scoreBreakdown.access.textClass)}>{viewModel.scoreBreakdown.access.score ?? "—"}</span>
            </div>
            <div className="rounded-lg border border-border/60 px-3 py-2">
              Settlement <span className={cn("font-mono", viewModel.scoreBreakdown.settlement.textClass)}>{viewModel.scoreBreakdown.settlement.score ?? "—"}</span>
            </div>
            <div className="rounded-lg border border-border/60 px-3 py-2">
              Execution <span className={cn("font-mono", viewModel.scoreBreakdown.execution.textClass)}>{viewModel.scoreBreakdown.execution.score ?? "—"}</span>
            </div>
            <div className="rounded-lg border border-border/60 px-3 py-2">
              Capacity <span className={cn("font-mono", viewModel.scoreBreakdown.capacity.textClass)}>{viewModel.scoreBreakdown.capacity.score ?? "—"}</span>
            </div>
            <div className="rounded-lg border border-border/60 px-3 py-2">
              Output quality <span className={cn("font-mono", viewModel.scoreBreakdown.outputQuality.textClass)}>{viewModel.scoreBreakdown.outputQuality.score ?? "—"}</span>
            </div>
            <div className="rounded-lg border border-border/60 px-3 py-2">
              Cost <span className={cn("font-mono", viewModel.scoreBreakdown.cost.textClass)}>{viewModel.scoreBreakdown.cost.score ?? "—"}</span>
              {viewModel.scoreBreakdown.cost.suffix ?? ""}
            </div>
          </div>
        </details>

        {/* ── distill: Notes (filtered for redundancy with capacity) ── */}
        {viewModel.filteredNotes.length > 0 ? (
          <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
            {viewModel.filteredNotes.join(". ")}
          </div>
        ) : null}

        {viewModel.docSources.length > 0 ? (
          <div className="space-y-1">
            {viewModel.docSources.map((source) => {
              return (
                <div key={`${source.label}:${source.url}`} className="text-sm">
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex underline underline-offset-2 transition-colors hover:text-foreground"
                  >
                    {source.label}
                  </a>
                  {source.supports ? (
                    <span className="ml-2 text-xs text-muted-foreground">Supports {source.supports}</span>
                  ) : null}
                </div>
              );
            })}
            {viewModel.docsReviewedAt ? (
              <p className="text-xs text-muted-foreground">Reviewed {viewModel.docsReviewedAt}</p>
            ) : null}
            {viewModel.docsProvenanceLabel ? (
              <p className="text-xs text-muted-foreground">{viewModel.docsProvenanceLabel}</p>
            ) : null}
          </div>
        ) : null}

        <MethodologyCardActions topic="redemptionBackstop" />
      </CardContent>
    </Card>
  );
}

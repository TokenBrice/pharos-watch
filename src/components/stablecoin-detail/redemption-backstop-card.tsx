"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import {
  DETAIL_MODULE_BODY_CLASS,
  DETAIL_MODULE_HEADER_CLASS,
  DETAIL_MODULE_SHELL_CLASS,
  DETAIL_MODULE_TITLE_CLASS,
  SECTION_SCROLL_MT,
} from "@/components/stablecoin-detail/section-title-class";
import type { RedemptionBackstopEntry } from "@shared/types";
import { MethodologyLabel } from "@/components/methodology-hint";
import { ScoreBadgeWrapper } from "@/components/score-badge-wrapper";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { ScoringBreakdownDisclosure } from "@/components/stablecoin-detail/scoring-breakdown-disclosure";
import { ShowYourWorkPanel } from "@/components/show-your-work-panel";
import { FreshnessIndicator } from "@/components/status/freshness-indicator";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { buildRedemptionBackstopCardViewModel } from "./redemption-backstop-card-view-model";

const SCORE_BREAKDOWN_KEYS = ["access", "settlement", "execution", "capacity", "outputQuality", "cost"] as const;

function MetadataBadgeList({ items }: { items: readonly { label: string; value: string }[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {items.map((item) => (
        <Badge
          key={`${item.label}:${item.value}`}
          variant="outline"
          className="border-border/60 bg-background/60 text-[11px] font-normal text-muted-foreground"
        >
          {item.label}: {item.value}
        </Badge>
      ))}
    </div>
  );
}

export function RedemptionBackstopCard({ entry }: { entry: RedemptionBackstopEntry }) {
  const viewModel = buildRedemptionBackstopCardViewModel(entry);

  return (
    <Card id="redemption" className={cn(DETAIL_MODULE_SHELL_CLASS, SECTION_SCROLL_MT)}>
      <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <DetailSectionTitle className={DETAIL_MODULE_TITLE_CLASS}>
            <MethodologyLabel topic="redemptionBackstop">{viewModel.title}</MethodologyLabel>
          </DetailSectionTitle>
          <FreshnessIndicator
            compact
            updatedAtMs={entry.updatedAt * 1000}
            staleAfterMs={API_FRESHNESS_MAX_AGE_SEC.redemptionBackstops * 1000}
            labelPrefix="Updated"
          />
        </div>
      </CardHeader>
      <CardContent className={cn(DETAIL_MODULE_BODY_CLASS, "space-y-4")}>
        {/* ── arrange: standalone route score, separated from metadata ── */}
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <span className="text-sm text-muted-foreground">Standalone route score</span>
          <ScoreBadgeWrapper topic="redemptionBackstop" variant="tooltip-only">
            <Badge variant="outline" className={cn("px-2.5 py-1 pharos-numeric text-lg", viewModel.scoreToneClass)}>
              {viewModel.heroScoreLabel}
            </Badge>
          </ScoreBadgeWrapper>
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
            <Badge
              variant="outline"
              className="border-amber-500/30 bg-amber-500/10 text-xs text-amber-700 dark:text-amber-300"
            >
              {viewModel.resolutionStateLabel}
            </Badge>
          )}
          {viewModel.showRouteStatusBadge && (
            <Badge
              variant="outline"
              className="border-amber-500/30 bg-amber-500/10 text-xs text-amber-700 dark:text-amber-300"
            >
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

        {/* ── primary capacity column beside stacked secondary detail (balances the full width) ── */}
        <div className="grid items-start gap-3 xl:grid-cols-2">
          {/* ── Capacity card (earns the card treatment — has detail) ── */}
          <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
            <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
              {viewModel.capacitySummary.title}
            </p>
            <p className="mt-1 text-sm font-medium">{viewModel.capacitySummary.headline}</p>
            <p className="mt-1 text-xs text-muted-foreground">{viewModel.capacitySummary.detail}</p>
            {viewModel.routeExitCorrelationLabel ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Exit correlation: <span className="text-foreground">{viewModel.routeExitCorrelationLabel}</span>
              </p>
            ) : null}
            {viewModel.telemetryContext.length > 0 ? <MetadataBadgeList items={viewModel.telemetryContext} /> : null}
          </div>

          {/* ── stacked secondary detail: fee + confidence balance the capacity column's height ── */}
          <div className="grid gap-3 content-start">
            {/* ── Fee card (earns the card treatment — has detail) ── */}
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Redemption Fee</p>
              <p className="mt-1 text-sm font-medium">{viewModel.feeSummary.headline}</p>
              <p className="mt-1 text-xs text-muted-foreground">{viewModel.feeSummary.detail}</p>
              {viewModel.costScenarioContext.length > 0 ? (
                <MetadataBadgeList items={viewModel.costScenarioContext} />
              ) : null}
            </div>

            {viewModel.confidenceContext.length > 0 ? (
              <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Confidence Detail</p>
                <MetadataBadgeList items={viewModel.confidenceContext} />
                {viewModel.confidenceReasons.length > 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">{viewModel.confidenceReasons.join(". ")}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        {/* ── colorize + distill: Sub-scores collapsed with color ── */}
        <ScoringBreakdownDisclosure>
          <div className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
            {SCORE_BREAKDOWN_KEYS.map((key) => {
              const item = viewModel.scoreBreakdown[key];
              return (
                <div key={key} className="rounded-lg border border-border/60 px-3 py-2">
                  {item.label} <span className={cn("pharos-numeric", item.textClass)}>{item.score ?? "—"}</span>
                  {"suffix" in item ? item.suffix : ""}
                </div>
              );
            })}
          </div>
        </ScoringBreakdownDisclosure>

        {/* ── distill: Notes (filtered for redundancy with capacity) ── */}
        {viewModel.filteredNotes.length > 0 ? (
          <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
            {viewModel.filteredNotes.join(". ")}
          </div>
        ) : null}

        <ShowYourWorkPanel kind="redemption" entry={entry} stablecoinId={entry.stablecoinId} />

        <EvidenceFooter
          topic="redemptionBackstop"
          showWorkToggle
          sources={viewModel.docSources.map((source) => ({
            label: source.label,
            url: source.url,
            note: source.supports ? `Supports ${source.supports}` : undefined,
          }))}
          sourcesFootnote={
            viewModel.docsProvenanceLabel ? (
              <p className="text-xs text-muted-foreground">{viewModel.docsProvenanceLabel}</p>
            ) : null
          }
          trailing={viewModel.docsReviewedAt ? `Reviewed ${viewModel.docsReviewedAt}` : undefined}
        />
      </CardContent>
    </Card>
  );
}

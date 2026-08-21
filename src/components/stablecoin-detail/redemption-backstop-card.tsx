"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";
import { StablecoinModuleTitle } from "@/components/stablecoin-detail/module-title";
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
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { RedemptionRouteRail } from "@/components/stablecoin-detail/redemption-route-rail";
import { ScoreBandSpectrum, type SpectrumBand } from "@/components/stablecoin-detail/score-band-spectrum";
import { ScorePill } from "@/components/stablecoin-detail/score-pill";
import { ScoringBreakdownDisclosure } from "@/components/stablecoin-detail/scoring-breakdown-disclosure";
import { ShowYourWorkPanel } from "@/components/show-your-work-panel";
import { FreshnessIndicator } from "@/components/status/freshness-indicator";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { buildRedemptionBackstopCardViewModel } from "./redemption-backstop-card-view-model";

const SCORE_BREAKDOWN_KEYS = ["access", "settlement", "execution", "capacity", "outputQuality", "cost"] as const;

/** The view model's real tone cutoffs (80/65/50/35) as an unlabeled score
 *  track — these tiers have no published names, so the spectrum shows only
 *  position and tone, never invented vocabulary. Worst → best, left → right. */
const REDEMPTION_SCORE_BANDS: readonly SpectrumBand[] = [
  { key: "t0", label: "", fillClass: "bg-red-500/70", textClass: "text-red-700 dark:text-red-400" },
  { key: "t35", label: "", fillClass: "bg-orange-500/70", textClass: "text-orange-700 dark:text-orange-400" },
  { key: "t50", label: "", fillClass: "bg-amber-500/70", textClass: "text-amber-700 dark:text-amber-400" },
  { key: "t65", label: "", fillClass: "bg-blue-500/70", textClass: "text-blue-700 dark:text-blue-400" },
  { key: "t80", label: "", fillClass: "bg-emerald-500/70", textClass: "text-emerald-700 dark:text-emerald-400" },
];
const REDEMPTION_SCORE_CUTOFFS = [0, 35, 50, 65, 80] as const;

function redemptionScoreBandKey(score: number): string {
  if (score >= 80) return "t80";
  if (score >= 65) return "t65";
  if (score >= 50) return "t50";
  if (score >= 35) return "t35";
  return "t0";
}

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
          <StablecoinModuleTitle className={DETAIL_MODULE_TITLE_CLASS}>
            <MethodologyLabel topic="redemptionBackstop">{viewModel.title}</MethodologyLabel>
          </StablecoinModuleTitle>
          {/* Score in the header, not on its own body row: the header slot is
              where every other scored module states its band, and the label
              "Standalone route score" plus a lone pill cost a full row for one
              number. A low-confidence score keeps the broken outline so it does
              not read as firm as a well-evidenced one. */}
          <ScoreBadgeWrapper topic="redemptionBackstop" variant="tooltip-only">
            <ScorePill
              label={viewModel.heroScoreLabel}
              toneClass={viewModel.scoreToneClass}
              title="Standalone route score"
              className={viewModel.isLowConfidence ? "border-dashed" : undefined}
            />
          </ScoreBadgeWrapper>
        </div>
      </CardHeader>
      <CardContent className={cn(DETAIL_MODULE_BODY_CLASS, "space-y-4")}>
        {viewModel.score != null ? (
          <ScoreBandSpectrum
            mode="range"
            bands={REDEMPTION_SCORE_BANDS}
            cutoffs={REDEMPTION_SCORE_CUTOFFS}
            activeKey={redemptionScoreBandKey(viewModel.score)}
            score={viewModel.score}
            ariaLabel={`Route score ${viewModel.score} of 100 on the redemption score track.`}
            className="max-w-md"
          />
        ) : null}

        {/* ── arrange: metadata badges (route family lives on the rail's venue station) ── */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="border-border/60 bg-muted/30 text-xs">
            {viewModel.sourceModeLabel}
          </Badge>
          {viewModel.showResolutionStateBadge && (
            <Badge
              variant="outline"
              className={cn("text-xs", SEVERITY_TONE_CLASS.watch.pill)}
            >
              {viewModel.resolutionStateLabel}
            </Badge>
          )}
          {viewModel.showRouteStatusBadge && (
            <Badge
              variant="outline"
              className={cn("text-xs", SEVERITY_TONE_CLASS.watch.pill)}
            >
              {viewModel.routeStatusLabel}
            </Badge>
          )}
          <Badge variant="outline" className="border-border/60 bg-muted/30 text-xs">
            {viewModel.modelConfidenceLabel}
          </Badge>
        </div>

        {viewModel.resolutionSummary ? (
          <div className={cn("rounded-lg border px-3 py-2 text-sm text-muted-foreground", SEVERITY_TONE_CLASS.watch.banner)}>
            {viewModel.resolutionSummary}
          </div>
        ) : null}

        {/* ── the exit rail: holder → gate → venue → output; FactGrid below sm ── */}
        <RedemptionRouteRail
          accessModel={viewModel.accessModel}
          accessLabel={viewModel.accessLabel}
          settlementLabel={viewModel.settlementLabel}
          outputAssetLabel={viewModel.outputAssetLabel}
          routeFamilyLabel={viewModel.routeFamilyLabel}
        />

        {/* ── detail layer: capacity/fee/confidence fold behind the standard
               disclosure — the score, route chips, and access row above are
               the summary read ── */}
        <ModuleDisclosure label="Capacity, fees & confidence">
        <div className="mt-2 grid items-start gap-3 xl:grid-cols-2">
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

        {/* ── distill: Notes (filtered for redundancy with capacity) ── */}
        {viewModel.filteredNotes.length > 0 ? (
          <div className="mt-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
            {viewModel.filteredNotes.join(". ")}
          </div>
        ) : null}
        </ModuleDisclosure>

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
        >
          {/* Live-data freshness joins the footer's inline row rather than the
              header, which now carries status only. It is a different fact from
              the docs `Reviewed` stamp on the right, so the two coexist here. */}
          <FreshnessIndicator
            compact
            updatedAtMs={entry.updatedAt * 1000}
            staleAfterMs={API_FRESHNESS_MAX_AGE_SEC.redemptionBackstops * 1000}
            labelPrefix="Updated"
          />
        </EvidenceFooter>
      </CardContent>
    </Card>
  );
}

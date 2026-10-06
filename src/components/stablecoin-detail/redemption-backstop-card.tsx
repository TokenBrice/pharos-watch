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
import type { RedemptionBackstopEntry, SafetyScoreV9CurrentCard } from "@shared/types";
import {
  REVIEWED_REDEMPTION_COVERAGE_DISPOSITIONS,
  type RedemptionCoverageReasonCode,
} from "@shared/data/coverage-dispositions/redemption-coverage-dispositions";
import { describeExitRouteVenue } from "@/lib/safety-score-reason-labels";
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

/** The view model's tone cutoffs (80/65/50/35) as a range track. The tiers
 *  have no published names, so each band is labelled by its score range.
 *  Worst → best, left → right. */
const REDEMPTION_SCORE_BANDS: readonly SpectrumBand[] = [
  { key: "t0", label: "<35", fillClass: "bg-red-500/70", textClass: "text-red-700 dark:text-red-400" },
  { key: "t35", label: "35–49", fillClass: "bg-orange-500/70", textClass: "text-orange-700 dark:text-orange-400" },
  { key: "t50", label: "50–64", fillClass: "bg-amber-500/70", textClass: "text-amber-700 dark:text-amber-400" },
  { key: "t65", label: "65–79", fillClass: "bg-blue-500/70", textClass: "text-blue-700 dark:text-blue-400" },
  { key: "t80", label: "80+", fillClass: "bg-emerald-500/70", textClass: "text-emerald-700 dark:text-emerald-400" },
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

const NO_HOLDER_ROUTE_REASONS: Partial<Record<RedemptionCoverageReasonCode, string>> = {
  "pegkeeper-only": "Only PegKeeper contracts redeem; holders exit through markets.",
  "no-holder-route": "No issuer or protocol route lets ordinary holders redeem; holders exit through markets.",
  "borrower-repay-only": "Only borrowers repaying debt reclaim collateral; holders exit through markets.",
  "secondary-market-only": "Holders exit through secondary markets only.",
};

const NOT_RATED_REASONS: Record<RedemptionBackstopEntry["resolutionState"], string> = {
  resolved: "Not rated: the route score could not be resolved.",
  "missing-capacity": "Not rated: no executable redemption capacity could be measured.",
  "missing-cache": "Not rated: the asset was missing from the current supply snapshot.",
  impaired: "Not rated: current evidence contradicts par redemption on this route.",
  failed: "Not rated: the route score could not be resolved.",
};

/** "Exit pillar uses the best available route (Curve on Ethereum, 97); this route scores 63." */
function exitReconciliation(
  reportCard: SafetyScoreV9CurrentCard | null | undefined,
  entry: RedemptionBackstopEntry | null,
): string | null {
  const primaryRoute = reportCard?.breakdowns?.exit.primaryRoute ?? null;
  if (primaryRoute === null || primaryRoute.score === null) return null;
  const routeScore = Math.round(primaryRoute.score);
  const venue = describeExitRouteVenue(primaryRoute);
  if (entry === null) return `The Exit pillar relies on market routes instead (best: ${venue}, ${routeScore}).`;
  const scoresThisRoute = primaryRoute.key.startsWith("redemption:") && primaryRoute.key.includes(`:${entry.routeFamily}`);
  if (scoresThisRoute) return `The Exit pillar scores this route directly (${routeScore}).`;
  return `The Exit pillar uses the best available route (${venue}, ${routeScore}); ${
    entry.score == null ? "this route is not rated" : `this route scores ${entry.score}`
  }.`;
}

/**
 * Exit-evidence module: the scored redemption route, an explicit "No holder
 * redemption route" state from the reviewed coverage dispositions, or nothing.
 * Root keeps `id="redemption"` in every state (hero passport link target).
 */
export function RedemptionRouteSection({
  entry,
  reportCard,
  coinId,
}: {
  entry: RedemptionBackstopEntry | null | undefined;
  reportCard: SafetyScoreV9CurrentCard | null | undefined;
  coinId: string;
}) {
  if (entry) return <RedemptionBackstopCard entry={entry} reconciliation={exitReconciliation(reportCard, entry)} />;
  const disposition = REVIEWED_REDEMPTION_COVERAGE_DISPOSITIONS.find((row) => row.id === coinId);
  const verdict = disposition ? NO_HOLDER_ROUTE_REASONS[disposition.reasonCode] : undefined;
  if (!disposition || verdict === undefined) return null;
  const reconciliation = exitReconciliation(reportCard, null);
  return (
    <Card id="redemption" className={cn(DETAIL_MODULE_SHELL_CLASS, SECTION_SCROLL_MT)}>
      <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
        <StablecoinModuleTitle className={DETAIL_MODULE_TITLE_CLASS}>
          <MethodologyLabel topic="redemptionBackstop">Redemption route</MethodologyLabel>
        </StablecoinModuleTitle>
        <ScorePill label="No holder route" title="No holder redemption route exists, so none is scored" />
      </CardHeader>
      <CardContent className={cn(DETAIL_MODULE_BODY_CLASS, "space-y-3")}>
        <p className="text-sm font-medium text-foreground">No holder redemption route</p>
        <p className="text-sm text-muted-foreground">{verdict}</p>
        {reconciliation ? <p className="text-xs text-muted-foreground">{reconciliation}</p> : null}
        <ModuleDisclosure label="Review notes">
          <p className="pb-1 text-xs leading-relaxed text-muted-foreground">{disposition.blocker}</p>
        </ModuleDisclosure>
        <EvidenceFooter
          topic="redemptionBackstop"
          sources={disposition.evidenceUrls.map((url) => ({ label: new URL(url).hostname, url }))}
          trailing={`Reviewed ${disposition.reviewedDate}`}
        />
      </CardContent>
    </Card>
  );
}

function RedemptionBackstopCard({
  entry,
  reconciliation,
}: {
  entry: RedemptionBackstopEntry;
  reconciliation: string | null;
}) {
  const viewModel = buildRedemptionBackstopCardViewModel(entry);
  const verdict = viewModel.score == null
    ? NOT_RATED_REASONS[entry.resolutionState]
    : `${viewModel.accessLabel} access; ${viewModel.settlementLabel.toLowerCase()} settlement into ${viewModel.outputAssetLabel.toLowerCase()}.`;

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
              title="Standalone route score. Tone follows the 80/65/50/35 score cutoffs on the track below."
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
          <ModuleDisclosure label="Review notes">
            <p className="pb-1 text-xs leading-relaxed text-muted-foreground">{viewModel.resolutionSummary}</p>
          </ModuleDisclosure>
        ) : null}

        {/* ── the exit rail: holder → gate → venue → output; FactGrid below sm ── */}
        <RedemptionRouteRail
          accessModel={viewModel.accessModel}
          accessLabel={viewModel.accessLabel}
          settlementLabel={viewModel.settlementLabel}
          outputAssetLabel={viewModel.outputAssetLabel}
          routeFamilyLabel={viewModel.routeFamilyLabel}
        />
        <p className="text-sm text-foreground">{verdict}</p>
        {reconciliation ? <p className="text-xs text-muted-foreground">{reconciliation}</p> : null}

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

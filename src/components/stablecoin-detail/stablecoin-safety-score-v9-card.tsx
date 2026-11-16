"use client";

import { IntentLink } from "@/components/intent-link";
import { History, Table2 } from "lucide-react";
import type { SafetyScoreV9CurrentCard } from "@shared/types/safety-score-v9-public";
import type { V9QualityPillar } from "@shared/types/safety-score-v9";
import type { ReportCardsV9Response } from "@shared/types/report-cards-v9";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { ScoreConstructionPanel } from "@/components/stablecoin-detail/score-construction-panel";
import { StablecoinModuleTitle } from "@/components/stablecoin-detail/module-title";
import {
  DETAIL_MODULE_HEADER_CLASS,
  DETAIL_MODULE_SHELL_CLASS,
  DETAIL_MODULE_TITLE_CLASS,
} from "@/components/stablecoin-detail/section-title-class";
import { FreshnessIndicator } from "@/components/status/freshness-indicator";
import { MethodologyHint } from "@/components/methodology-hint";
import { ShowYourWorkPanel } from "@/components/show-your-work-panel";
import { ShowYourWorkToggle } from "@/components/show-your-work-toggle";
import { SafetyScoreReasonList } from "@/components/stablecoin-detail/safety-score-reason-list";
import {
  SafetyScoreV9PillarRow,
  type PillarEvidenceAnchors,
} from "@/components/stablecoin-detail/safety-score-v9-breakdown";
import { CapSection, ScoreAdjustment } from "@/components/stablecoin-detail/safety-score-v9-adjustments";
import { METHODOLOGY_CONTEXT } from "@/lib/methodology-context";
import { getSafetyGradeMetadata } from "@/lib/report-card-ui";
import { buildStablecoinSafetyScoreV9Presentation } from "@/lib/stablecoin-safety-score-v9-presentation";
import { cn } from "@/lib/utils";

const HEADER_ICON_BUTTON_CLASS =
  "pharos-focus-ring inline-flex !h-11 !min-h-11 !w-11 items-center justify-center rounded-md border border-border/60 bg-muted/50 text-muted-foreground transition-colors hover:border-border hover:bg-muted hover:text-foreground md:!h-5 md:!min-h-0 md:!w-5";

type StablecoinSafetyScoreV9DisplayCard = SafetyScoreV9CurrentCard;

function HeaderActions({ updatedAtMs }: { updatedAtMs: number | null }) {
  const methodology = METHODOLOGY_CONTEXT.safetyScore;
  return (
    <div className="flex shrink-0 items-center gap-2">
      {/* On a phone the title and its three 44px actions share one row; the
          freshness chip yields (the rail-less page dates the grade in the hero). */}
      {updatedAtMs !== null ? (
        <span className="hidden items-center gap-2 sm:inline-flex">
          <FreshnessIndicator
            compact
            updatedAtMs={updatedAtMs}
            staleAfterMs={API_FRESHNESS_MAX_AGE_SEC.reportCards * 1000}
            labelPrefix="Updated"
          />
          <span className="text-muted-foreground/50" aria-hidden="true">·</span>
        </span>
      ) : null}
      <MethodologyHint topic="safetyScore" buttonClassName={HEADER_ICON_BUTTON_CLASS} />
      {methodology.changelogPath ? (
        <IntentLink
          href={methodology.changelogPath}
          aria-label="Safety Score version history"
          className={HEADER_ICON_BUTTON_CLASS}
        >
          <History className="h-3 w-3" aria-hidden="true" />
        </IntentLink>
      ) : null}
      <ShowYourWorkToggle className={HEADER_ICON_BUTTON_CLASS}>
        <Table2 className="h-3 w-3" aria-hidden="true" />
        <span className="sr-only">Toggle score inputs</span>
      </ShowYourWorkToggle>
    </div>
  );
}

/** Composite modifiers inline beside the score, so a headline below every
 *  pillar (LUSD 78 under 79/84/90) reconciles at a glance. */
function ScoreModifiers({ card }: { card: StablecoinSafetyScoreV9DisplayCard }) {
  const { stages } = card.scoreTrace;
  const items: Array<{ key: string; label: string; title: string }> = [];
  if (stages.pegMultiplier !== null && Math.abs(stages.pegMultiplier - 1) >= 0.005) {
    items.push({ key: "peg", label: `Peg history ×${stages.pegMultiplier.toFixed(2)}`, title: "Measured peg history multiplies the pillar score" });
  }
  if (stages.deploymentAdjustmentPoints !== null && stages.deploymentAdjustmentPoints >= 0.05) {
    items.push({ key: "common-mode", label: `Shared exposure −${stages.deploymentAdjustmentPoints.toFixed(1)} pts`, title: "Deployments sharing a chain or bridge that can fail together" });
  }
  if (card.bindingCap) {
    items.push({ key: "cap", label: `Capped at ${card.bindingCap.limit.toFixed(0)}`, title: card.bindingCap.reason });
  }
  if (items.length === 0) return null;
  return (
    // Words, not a formula: each adjustment is a quiet chip with its why on hover.
    <span className="flex basis-full flex-wrap gap-1.5 pt-1 sm:basis-auto sm:pt-0" aria-label="Score adjustments">
      {items.map((item) => (
        <span
          key={item.key}
          title={item.title}
          className="inline-flex items-center rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-2xs font-medium text-muted-foreground"
        >
          {item.label}
        </span>
      ))}
    </span>
  );
}

export interface StablecoinSafetyScoreV9CardProps {
  card: StablecoinSafetyScoreV9DisplayCard;
  identity: ReportCardsV9Response["safetyScoreIdentity"];
  updatedAtMs: number | null;
  stablecoinName?: string;
  /** Which pillar evidence boards the page renders; omitted, every pillar row links to its board. */
  evidenceAnchors?: PillarEvidenceAnchors;
  /** Server-computed `openEvidence.byCard[].documentationOnlyLimited`; omitted renders plain limited. */
  documentationOnlyLimited?: readonly V9QualityPillar[];
}

export function StablecoinSafetyScoreV9Card({
  card,
  identity,
  updatedAtMs,
  stablecoinName,
  evidenceAnchors,
  documentationOnlyLimited,
}: StablecoinSafetyScoreV9CardProps) {
  const presentation = buildStablecoinSafetyScoreV9Presentation(card, documentationOnlyLimited);

  return (
    <Card className={DETAIL_MODULE_SHELL_CLASS} data-safety-model="v9">
      <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {/* No coin prefix: the dossier hero and rail already name the coin. */}
          <StablecoinModuleTitle className={DETAIL_MODULE_TITLE_CLASS}>Safety Score</StablecoinModuleTitle>

        </div>
        <HeaderActions updatedAtMs={updatedAtMs} />
      </CardHeader>
      {/* A flex column down to the folds: beside a taller Reserves card the
          stretched card pins its folds to the foot, never a blank band. */}
      <CardContent className="flex flex-1 flex-col px-0 py-0">
        <div className="flex flex-1 flex-col space-y-4 px-4 py-5 sm:px-5">
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 pt-1">
            <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
              <span
                className={cn(
                  "pharos-numeric text-4xl font-extrabold leading-none tracking-tight",
                  getSafetyGradeMetadata(card.grade).pulse.accentClassName,
                )}
              >
                {card.grade === null ? "Pipeline gap" : card.grade}
              </span>
              {card.score !== null ? (
                // The separating space sits inside the smaller span: at the
                // 4xl mono size it alone was a ~22 px hole before the slash.
                <span className="pharos-numeric text-4xl font-extrabold leading-none tracking-tight text-foreground">
                  {card.score.toFixed(0)}<span className="text-2xl font-bold text-muted-foreground"> / 100</span>
                </span>
              ) : (
                <span className="text-sm font-medium text-muted-foreground">{card.ratingStatus === "pipeline-gap" ? "No Safety Score published" : "Not rated"}</span>
              )}
              {card.provisional ? (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button type="button" className="pharos-focus-ring rounded-full" aria-label="Provisional Safety Score">
                        <Badge variant="outline" className="rounded-full border-border/60 bg-muted/40 text-2xs font-medium text-muted-foreground">
                          Provisional
                        </Badge>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs text-left">
                      {((card.unknownPricedWeightShare ?? 0) * 100).toFixed(1)}% of scoring weight is priced as unknown. This label does not change the score.
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : null}
              {card.gradeHold ? (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button type="button" className="pharos-focus-ring rounded-full" aria-label="Grade held">
                        <Badge variant="outline" className="rounded-full border-border/60 bg-muted/40 text-2xs font-medium text-muted-foreground">
                          Grade held
                        </Badge>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs text-left">
                      Published letter retained; this score&apos;s raw band is {card.gradeHold.rawGrade}.
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : null}
              <ScoreModifiers card={card} />
            </div>
            <p className="text-xs text-muted-foreground">{presentation.evidenceSummary}</p>
          </div>

          <div className="divide-y divide-border/40 border-y border-border/40">
            {presentation.pillars.map((pillar) => (
              <SafetyScoreV9PillarRow
                key={pillar.key}
                cardId={card.id}
                pillar={pillar}
                evidenceVisibility={evidenceAnchors?.[pillar.key]}
              />
            ))}
          </div>

          <ScoreAdjustment card={card} />
          <CapSection card={card} />
          {/* The folds close the card with no trailing divider; the score
              inputs panel renders nothing until the reader turns it on. */}
          <div className="mt-auto space-y-4">
            <ScoreConstructionPanel card={card} />
            {presentation.primaryReasons.length > 0 ? (
              <section aria-label="Rating notes">
                <ModuleDisclosure label="Rating notes" count={presentation.primaryReasons.length}>
                  <SafetyScoreReasonList messages={presentation.primaryReasons} className="mt-1 text-xs" />
                </ModuleDisclosure>
              </section>
            ) : null}
            <ShowYourWorkPanel
              kind="report-card-v9"
              card={card}
              methodologyVersion={identity.methodologyVersion}
              stablecoinId={card.id}
              stablecoinName={stablecoinName}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

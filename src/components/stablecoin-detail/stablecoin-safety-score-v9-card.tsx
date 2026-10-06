"use client";

import Link from "next/link";
import { History, Table2 } from "lucide-react";
import type { SafetyScoreV9CurrentCard } from "@shared/types";
import type { ReportCardsV9Response, V9PublicationHealth } from "@shared/types/report-cards-v9";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { OpsStatusChip, PartialEvidenceChip } from "@/components/stablecoin-detail/ops-status-chip";
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
import { SafetyScoreV9PillarRow } from "@/components/stablecoin-detail/safety-score-v9-breakdown";
import { CapSection, ScoreAdjustment } from "@/components/stablecoin-detail/safety-score-v9-adjustments";
import { describeDataCoverageHoldCauses } from "@/lib/safety-score-data-coverage";
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
      {updatedAtMs !== null ? (
        <FreshnessIndicator
          compact
          updatedAtMs={updatedAtMs}
          staleAfterMs={API_FRESHNESS_MAX_AGE_SEC.reportCards * 1000}
          labelPrefix="Updated"
        />
      ) : null}
      {updatedAtMs !== null ? <span className="text-muted-foreground/50" aria-hidden="true">·</span> : null}
      <MethodologyHint topic="safetyScore" buttonClassName={HEADER_ICON_BUTTON_CLASS} />
      {methodology.changelogPath ? (
        <Link
          href={methodology.changelogPath}
          aria-label="Safety Score version history"
          className={HEADER_ICON_BUTTON_CLASS}
        >
          <History className="h-3 w-3" aria-hidden="true" />
        </Link>
      ) : null}
      <ShowYourWorkToggle className={HEADER_ICON_BUTTON_CLASS}>
        <Table2 className="h-3 w-3" aria-hidden="true" />
        <span className="sr-only">Toggle score inputs</span>
      </ShowYourWorkToggle>
    </div>
  );
}

function formatRelativeTime(timestampMs: number): string {
  const ageSec = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (ageSec < 60) return "less than a minute ago";
  const ageMin = Math.floor(ageSec / 60);
  if (ageMin < 60) return `${ageMin}m ago`;
  const ageHours = Math.floor(ageMin / 60);
  if (ageHours < 24) return `${ageHours}h ago`;
  return `${Math.floor(ageHours / 24)}d ago`;
}

/** Held publication is pipeline state: an amber header chip, detail on tap (D6). */
function HeldPublicationChip({ health }: { health: V9PublicationHealth }) {
  if (health.status !== "held") return null;
  const heldSinceMs = health.heldSinceSec === null ? null : health.heldSinceSec * 1000;
  const causes = describeDataCoverageHoldCauses(health.reasons);
  return (
    <OpsStatusChip label="Ratings held" reasonCodes={health.reasons.map((reason) => reason.code)}>
      <p className="text-foreground">
        Ratings are held at the last verified snapshot
        {heldSinceMs !== null ? (
          <>
            {" "}since{" "}
            <time
              suppressHydrationWarning
              dateTime={new Date(heldSinceMs).toISOString()}
              title={new Date(heldSinceMs).toLocaleString(undefined, { timeZoneName: "long" })}
            >
              {formatRelativeTime(heldSinceMs)}
            </time>
          </>
        ) : null}
        .
      </p>
      {causes.length > 0 ? <p className="text-muted-foreground">{causes.join(" ")}</p> : null}
    </OpsStatusChip>
  );
}

/** Composite modifiers inline beside the score, so a headline below every
 *  pillar (LUSD 78 under 79/84/90) reconciles at a glance. */
function ScoreModifiers({ card }: { card: StablecoinSafetyScoreV9DisplayCard }) {
  const { stages } = card.scoreTrace;
  const items: Array<{ key: string; label: string; title: string }> = [];
  if (stages.pegMultiplier !== null && Math.abs(stages.pegMultiplier - 1) >= 0.005) {
    items.push({ key: "peg", label: `× peg ${stages.pegMultiplier.toFixed(2)}`, title: "Measured peg history multiplies the pillar score" });
  }
  if (stages.deploymentAdjustmentPoints !== null && stages.deploymentAdjustmentPoints >= 0.05) {
    items.push({ key: "common-mode", label: `−${stages.deploymentAdjustmentPoints.toFixed(1)} shared exposure`, title: "Deployments sharing a chain or bridge that can fail together" });
  }
  if (card.bindingCap) {
    items.push({ key: "cap", label: `capped at ${card.bindingCap.limit.toFixed(0)}`, title: card.bindingCap.reason });
  }
  if (items.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-xs text-muted-foreground">
      {items.map((item) => <span key={item.key} title={item.title}>{item.label}</span>)}
    </span>
  );
}

export interface StablecoinSafetyScoreV9CardProps {
  card: StablecoinSafetyScoreV9DisplayCard;
  identity: ReportCardsV9Response["safetyScoreIdentity"];
  publicationHealth: V9PublicationHealth;
  updatedAtMs: number | null;
  stablecoinName?: string;
  /** Ticker for the header lockup — this module is the site's most-screenshotted
   *  surface, so it names its subject instead of relying on page context. */
  stablecoinSymbol?: string;
  logoSrc?: string;
}

export function StablecoinSafetyScoreV9Card({
  card,
  identity,
  publicationHealth,
  updatedAtMs,
  stablecoinName,
  stablecoinSymbol,
  logoSrc,
}: StablecoinSafetyScoreV9CardProps) {
  const presentation = buildStablecoinSafetyScoreV9Presentation(card);

  return (
    <Card className={DETAIL_MODULE_SHELL_CLASS} data-safety-model="v9">
      <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <StablecoinModuleTitle
            className={DETAIL_MODULE_TITLE_CLASS}
            symbol={stablecoinSymbol}
            logoSrc={logoSrc}
          >
            Safety Score
          </StablecoinModuleTitle>
          <HeldPublicationChip health={publicationHealth} />
          {card.partialEvidence !== null ? <PartialEvidenceChip partialEvidence={card.partialEvidence} /> : null}
        </div>
        <HeaderActions updatedAtMs={updatedAtMs} />
      </CardHeader>
      <CardContent className="px-0 py-0">
        <div className="space-y-4 px-4 py-5 sm:px-5">
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
                <span className="pharos-numeric text-4xl font-extrabold leading-none tracking-tight text-foreground">
                  {card.score.toFixed(0)} <span className="text-2xl font-bold text-muted-foreground">/ 100</span>
                </span>
              ) : (
                <span className="text-sm font-medium text-muted-foreground">{card.ratingStatus === "pipeline-gap" ? "No Safety Score published" : "Not rated"}</span>
              )}
              <ScoreModifiers card={card} />
            </div>
            <p className="text-xs text-muted-foreground">{presentation.evidenceSummary}</p>
          </div>

          <div className="divide-y divide-border/40 border-y border-border/40">
            {presentation.pillars.map((pillar) => (
              <SafetyScoreV9PillarRow key={pillar.key} cardId={card.id} pillar={pillar} />
            ))}
          </div>

          <ScoreAdjustment card={card} />
          <CapSection card={card} />
          <ScoreConstructionPanel card={card} />
          {presentation.primaryReasons.length > 0 ? (
            <section className="border-b border-border/40 pb-3" aria-label="Rating notes">
              <ModuleDisclosure label="Rating notes" count={presentation.primaryReasons.length}>
                <SafetyScoreReasonList messages={presentation.primaryReasons} className="mt-1 text-xs" />
              </ModuleDisclosure>
            </section>
          ) : null}
          <EvidenceFooter topic="safetyScore" />
        </div>
        <div className="mx-4 mb-5 sm:mx-5">
          <ShowYourWorkPanel
            kind="report-card-v9"
            card={card}
            methodologyVersion={identity.methodologyVersion}
            stablecoinId={card.id}
            stablecoinName={stablecoinName}
          />
        </div>
      </CardContent>
    </Card>
  );
}

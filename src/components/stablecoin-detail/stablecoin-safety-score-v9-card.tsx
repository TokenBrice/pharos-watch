"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { History, Table2 } from "lucide-react";
import type { SafetyScoreV9CurrentCard } from "@shared/types";
import type { ReportCardsV9Response, V9PublicationHealth } from "@shared/types/report-cards-v9";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { AccessPosturePanel } from "@/components/stablecoin-detail/access-posture-panel";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
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
import { SafetyScoreV9PillarRow } from "@/components/stablecoin-detail/safety-score-v9-breakdown";
import { CapSection, ScoreAdjustment } from "@/components/stablecoin-detail/safety-score-v9-adjustments";
import { METHODOLOGY_CONTEXT } from "@/lib/methodology-context";
import { getSafetyGradeMetadata } from "@/lib/report-card-ui";
import { buildStablecoinSafetyScoreV9Presentation } from "@/lib/stablecoin-safety-score-v9-presentation";
import type { TransferReviewView } from "@/lib/transfer-review";
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
        <span className="sr-only">Show inputs</span>
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

function HeldPublicationNotice({ health }: { health: V9PublicationHealth }) {
  if (health.status !== "held") return null;
  const heldSinceMs = health.heldSinceSec === null ? null : health.heldSinceSec * 1000;
  return (
    <div
      className="mx-4 mt-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 sm:mx-5 dark:text-amber-300"
      role="status"
    >
      Ratings held at the last verified snapshot
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
    </div>
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
  rightColumn?: ReactNode;
  transferReview?: TransferReviewView | null;
}

export function StablecoinSafetyScoreV9Card({
  card,
  identity,
  publicationHealth,
  updatedAtMs,
  stablecoinName,
  stablecoinSymbol,
  logoSrc,
  rightColumn,
  transferReview = null,
}: StablecoinSafetyScoreV9CardProps) {
  const presentation = buildStablecoinSafetyScoreV9Presentation(card);
  const hasRightColumn = rightColumn !== null && rightColumn !== undefined;
  const scoreColumn = (
    <div className="space-y-4">
      <div className={cn("pt-1", !hasRightColumn && "text-center")}>
        <div className={cn("flex items-baseline gap-2.5", !hasRightColumn && "justify-center")}>
          <span
            className={cn(
              "pharos-numeric text-4xl font-extrabold leading-none tracking-tight",
              getSafetyGradeMetadata(card.grade).pulse.accentClassName,
            )}
          >
            {card.grade}
          </span>
          {card.score !== null ? (
            <span className="pharos-numeric text-4xl font-extrabold leading-none tracking-tight text-foreground">
              {card.score.toFixed(0)} <span className="text-2xl font-bold text-muted-foreground">/ 100</span>
            </span>
          ) : (
            <span className="text-sm font-medium text-muted-foreground">Not rated</span>
          )}
        </div>
        <p className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{presentation.evidenceSummary}</span>
        </p>
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
            <ul className="mt-1 space-y-1 text-xs leading-relaxed text-muted-foreground">
              {presentation.primaryReasons.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
          </ModuleDisclosure>
        </section>
      ) : null}
      <AccessPosturePanel rows={presentation.accessRows} review={transferReview} />
      <EvidenceFooter topic="safetyScore" />
    </div>
  );

  return (
    <Card className={DETAIL_MODULE_SHELL_CLASS} data-safety-model="v9">
      <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
        <StablecoinModuleTitle
          className={DETAIL_MODULE_TITLE_CLASS}
          symbol={stablecoinSymbol}
          logoSrc={logoSrc}
        >
          Safety Score
        </StablecoinModuleTitle>
        <HeaderActions updatedAtMs={updatedAtMs} />
      </CardHeader>
      <CardContent className="px-0 py-0">
        <HeldPublicationNotice health={publicationHealth} />
        {hasRightColumn ? (
          <div className="grid min-h-[560px] lg:grid-cols-2">
            <div className="min-w-0 px-4 py-5 sm:px-5">{scoreColumn}</div>
            <div
              className="contents lg:flex lg:min-h-0 lg:min-w-0 lg:border-l lg:border-border/40 lg:px-5 lg:py-5"
              style={{ contain: "size" }}
            >
              <div className="min-w-0 border-t border-border/40 px-4 py-5 sm:px-5 lg:flex lg:min-h-0 lg:flex-1 lg:border-t-0 lg:p-0">
                {rightColumn}
              </div>
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-2xl px-4 py-5 sm:px-5">{scoreColumn}</div>
        )}
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

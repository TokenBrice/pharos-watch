"use client";

import Link from "next/link";
import { memo } from "react";
import { LazySection } from "@/components/lazy-section";
import { Card, CardContent } from "@/components/ui/card";
import { CompareRadarV9 } from "@/components/compare/radar-chart-v9";
import { SafetyGradeBadge } from "@/components/safety-scores/safety-grade-badge";
import { SafetyScoreTopDriver, type SafetyScoreTopDriverProps } from "@/components/safety-scores/safety-score-top-driver";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { GRADE_RADAR_COLORS, PEG_METADATA } from "@shared/lib/classification";
import { formatCompactUsd } from "@shared/lib/format";
import { gradeRange } from "@shared/lib/report-card-core";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import type {
  SafetyScorePublicationIdentity,
} from "@shared/types/safety-score-publication";
import { hasPlottableV9RadarPillars, type V9TableConsumerCard as V9ConsumerCard } from "@/lib/safety-score-v9-consumers";
import { describePartialEvidence, formatPartialEvidenceHeadline } from "@/lib/safety-score-reason-labels";
import { cn } from "@/lib/utils";

const PILLAR_SR_LABELS = { backing: "Backing", exit: "Exit", control: "Economic Control" } as const;

const PILLAR_MICRO_ITEMS = [
  { key: "backing", short: "B", label: "Backing" },
  { key: "exit", short: "E", label: "Exit" },
  { key: "control", short: "C", label: "Economic Control" },
] as const;

type HighlightedMetric = "overall" | "backing" | "exit" | "control" | "mcap" | "coin";

function pillarMicroBarFillClass(score: number): string {
  if (score < 40) return "bg-[var(--severity-severe)]";
  if (score < 60) return "bg-[var(--severity-moderate)]";
  return "bg-meter-neutral";
}

// The table projection names a binding cap or a withheld score, but not the
// peg multiplier, so an uncapped card shows no driver rather than a weakest
// pillar that may not be what set its grade. It carries no evidence-freshness
// verdict either, so the chip names no evidence age (the dossier owns it).
function cardTopDriver(card: V9ConsumerCard): SafetyScoreTopDriverProps["driver"] {
  if (card.ratingStatus === "not-rated") {
    return { kind: "withheld", label: null, value: null, reason: card.nrReasons[0]?.message ?? "Required evidence is withheld." };
  }
  if (card.bindingCap !== null) {
    return { kind: "cap-bound", label: card.bindingCap.kind, value: card.bindingCap.limit, reason: card.bindingCap.reason };
  }
  return null;
}

export const ReportCardMiniV9 = memo(function ReportCardMiniV9({
  card,
  identity,
  logo,
  animIndex = 0,
  mcap,
  highlightedMetric = "overall",
}: {
  card: V9ConsumerCard;
  identity: SafetyScorePublicationIdentity;
  logo?: string;
  animIndex?: number;
  /** Null preserves unavailable supply as "—"; undefined omits the MCap row. */
  mcap?: number | null;
  highlightedMetric?: HighlightedMetric;
}) {
  const meta = CLIENT_TRACKED_META_BY_ID.get(card.id);
  const name = meta?.name ?? card.id;
  const symbol = meta?.symbol ?? card.id;
  const pegCurrency = meta?.flags.pegCurrency;
  const pegLabel = pegCurrency ? (PEG_METADATA[pegCurrency]?.filterLabel ?? pegCurrency) : null;
  const partial = describePartialEvidence(card);
  const showFooter = mcap !== undefined;

  return (
    <Link
      href={buildStablecoinUrl(card.id)}
      className="pharos-focus-ring block h-full rounded-xl transition-transform active:scale-[0.995]"
    >
      <Card className="pharos-card-shell pharos-interactive-card h-full cursor-pointer gap-0 py-0">
        <CardContent className="relative flex h-full flex-col items-center gap-2.5 px-2.5 pb-3 pt-3 sm:px-4">
          <div className="flex min-w-0 max-w-full items-center gap-2">
            <StablecoinLogo src={logo} name={name} size={24} />
            <span className="truncate text-sm font-medium">{name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{symbol}</span>
          </div>

          <SafetyGradeBadge
            grade={card.grade}
            score={card.score}
            showScore
            size="lg"
            animate
            animationDelayMs={animIndex * 40}
            versionTopic="safetyScore"
            versionVariant="tooltip-only"
            versionInteractive={false}
          />
          {partial !== null ? (
            // One headline keeps the grid's radars near one baseline; the
            // full gap list and the score's assumption live in the summary.
            <p role="status" className="text-center text-xs text-muted-foreground" title={partial.summary}>
              {formatPartialEvidenceHeadline(partial)}
              <span className="sr-only">. {partial.summary}</span>
            </p>
          ) : null}
          <SafetyScoreTopDriver driver={cardTopDriver(card)} coinId={card.id} subjectLabel={symbol} link={false} />

          {hasPlottableV9RadarPillars(card) ? (
            <div className="w-full max-w-[11rem]">
              <p className="sr-only">
                {(["backing", "exit", "control"] as const).map((key) => {
                  const score = card.pillars[key].score;
                  return `${PILLAR_SR_LABELS[key]} ${score === null ? "unknown, not plotted" : `${Math.round(score)}/100`}`;
                }).join("; ")}.
              </p>
              <LazySection minHeight={140} rootMargin="200px">
                <CompareRadarV9
                  series={[{ card, identity, color: GRADE_RADAR_COLORS[card.grade === null ? "NR" : gradeRange(card.grade)] }]}
                  cohortSeries={[]}
                  size={140}
                />
              </LazySection>
            </div>
          ) : (
            <p className="py-1 text-center text-xs text-muted-foreground">Pillar radar unavailable</p>
          )}

          {/* Visible B · E · C pillar micro-bars for quick scanning when sorted by pillar. */}
          <div
            className="mt-auto grid w-full grid-cols-3 gap-1.5 pt-1"
            aria-hidden="true"
            data-testid="grid-pillar-microbars"
          >
            {PILLAR_MICRO_ITEMS.map(({ key, short, label }) => {
              const rawScore = card.ratingStatus === "rated" ? card.pillars[key].score : null;
              const rounded = rawScore === null ? null : Math.round(rawScore);
              const bounded = rawScore === null ? null : Math.max(0, Math.min(100, rawScore));
              const isHighlighted = highlightedMetric === key;

              return (
                <div
                  key={key}
                  title={`${label}: ${rounded === null ? "Not scored" : `${rounded}/100`}`}
                  className={cn(
                    "flex flex-col gap-1 rounded-md px-1.5 py-1",
                    isHighlighted && "bg-muted/70 ring-1 ring-border",
                  )}
                >
                  <div className="flex items-baseline justify-between gap-1 text-2xs leading-none">
                    <span className={cn("font-semibold", isHighlighted ? "text-foreground" : "text-muted-foreground")}>
                      {short}
                    </span>
                    <span
                      className={cn(
                        "pharos-numeric",
                        rounded === null
                          ? "text-muted-foreground"
                          : isHighlighted
                            ? "font-bold text-foreground"
                            : "font-medium text-foreground/85",
                      )}
                    >
                      {rounded === null ? "—" : rounded}
                    </span>
                  </div>
                  <span
                    className={cn(
                      "block h-1 w-full",
                      bounded === null
                        ? "rounded-xs border border-dashed border-muted-foreground/50"
                        : "overflow-hidden rounded-xs border border-meter-track-border bg-meter-track",
                    )}
                  >
                    {bounded !== null ? (
                      <span
                        className={cn("block h-full", pillarMicroBarFillClass(bounded))}
                        style={{ width: `${bounded}%` }}
                      />
                    ) : null}
                  </span>
                </div>
              );
            })}
          </div>

          {showFooter ? (
            <div
              className={cn(
                "flex w-full items-center justify-between gap-2 border-t border-border/40 pt-2 text-2xs",
                highlightedMetric === "mcap" && "rounded-md bg-muted/60 px-1.5 py-1 border-t-0 ring-1 ring-border",
              )}
            >
              <span className="truncate text-muted-foreground">{pegLabel ?? "—"}</span>
              <span className="pharos-numeric shrink-0 text-muted-foreground">
                MCap{" "}
                <span className={cn(highlightedMetric === "mcap" ? "font-bold text-foreground" : "font-medium text-foreground/90")}>
                  {mcap === null ? "—" : formatCompactUsd(mcap)}
                </span>
              </span>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </Link>
  );
});

"use client";

import Link from "next/link";
import { memo } from "react";
import { LazySection } from "@/components/lazy-section";
import { Card, CardContent } from "@/components/ui/card";
import { CompareRadarV9 } from "@/components/radar-chart-v9";
import { SafetyGradeBadge } from "@/components/safety-grade-badge";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import type {
  SafetyScorePublicationIdentity,
} from "@shared/types";
import { hasCompleteV9RadarPillars, type V9TableConsumerCard as V9ConsumerCard } from "@/lib/safety-score-v9-consumers";

export const ReportCardMiniV9 = memo(function ReportCardMiniV9({
  card,
  identity,
  logo,
  animIndex = 0,
}: {
  card: V9ConsumerCard;
  identity: SafetyScorePublicationIdentity;
  logo?: string;
  animIndex?: number;
}) {
  const meta = CLIENT_TRACKED_META_BY_ID.get(card.id);
  const name = meta?.name ?? card.id;
  const symbol = meta?.symbol ?? card.id;

  return (
    <Link
      href={buildStablecoinUrl(card.id)}
      className="pharos-focus-ring block h-full rounded-xl transition-transform active:scale-[0.995]"
    >
      <Card className="pharos-card-shell pharos-interactive-card h-full cursor-pointer gap-0 py-0">
        <CardContent className="relative flex flex-col items-center gap-2.5 px-2 pb-3 pt-3 sm:px-4">
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
          {card.partialEvidence !== null ? (
            <p
              role="status"
              className="text-center text-xs text-muted-foreground"
              title={`${card.partialEvidence.causes.map((cause) =>
                cause === "A" ? "A — pipeline unavailable" : "B — public data awaiting curation").join(" · ")}${
                card.partialEvidence.excludedPillars.length > 0 ? ` · Excluded: ${card.partialEvidence.excludedPillars.join(", ")}` : ""}`}
            >
              Partial evidence · pipeline gap
            </p>
          ) : null}

          {hasCompleteV9RadarPillars(card) ? (
            <div className="w-full max-w-[11rem]">
              <p className="sr-only">
                Backing {card.pillars.backing.score}/100; Exit {card.pillars.exit.score}/100; Economic Control {card.pillars.control.score}/100.
              </p>
              <LazySection minHeight={140} rootMargin="200px">
                <CompareRadarV9
                  series={[{ card, identity, color: "#10b981" }]}
                  cohortSeries={[]}
                  size={140}
                />
              </LazySection>
            </div>
          ) : (
            <p className="py-1 text-center text-xs text-muted-foreground">Pillar radar unavailable</p>
          )}
        </CardContent>
      </Card>
    </Link>
  );
});

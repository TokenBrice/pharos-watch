"use client";

import Link from "next/link";
import { buildStablecoinUrl } from "@/lib/urls";
import { Card, CardContent } from "@/components/ui/card";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { SafetyGradeBadge } from "@/components/safety-grade-badge";
import type { ScoreBadgeWrapperVariant } from "@/components/score-badge-wrapper";
import type { ReportCard, ReportCardGrade } from "@shared/types";
import { getNetColor } from "@shared/lib/format";
import { ReportCardRadar } from "./radar-chart";
import { TrendingUp, TrendingDown } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ReportCardMiniProps {
  card: ReportCard;
  logo?: string; // logo URL
  isSimulated?: boolean; // this card was affected by simulation
  isSimulating?: boolean; // any simulation is active
  originalGrade?: ReportCardGrade;
  originalScore?: number | null;
  /** The asset qualifies as a very large, self-backed settlement rail. */
  coreSettlement?: boolean;
  /** Grid index used for staggered grade-pop animation delay */
  animIndex?: number;
  /** Trend direction based on score change from previous period */
  trend?: "up" | "down" | "stable" | null;
  /** Controls whether the inline methodology version suffix is shown on grade badges. */
  gradeVersionVariant?: ScoreBadgeWrapperVariant;
}

// ---------------------------------------------------------------------------
// Trend Indicator Component
// ---------------------------------------------------------------------------

function TrendIndicator({ trend, score }: { trend?: "up" | "down" | "stable" | null; score?: number | null }) {
  if (!trend || trend === "stable") {
    return null;
  }

  const isPositive = trend === "up";
  return (
    <span className={cn("flex items-center gap-0.5 text-[10px] font-medium", getNetColor(isPositive ? 1 : -1))}>
      {isPositive ? <TrendingUp className="h-3 w-3" aria-hidden="true" /> : <TrendingDown className="h-3 w-3" aria-hidden="true" />}
      {score != null && <span className="tabular-nums">{score}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ReportCardMini({
  card,
  logo,
  isSimulated,
  isSimulating,
  originalGrade,
  originalScore,
  coreSettlement,
  animIndex = 0,
  trend,
  gradeVersionVariant = "suffix",
}: ReportCardMiniProps) {
  const dimUnaffected = isSimulating && !isSimulated;
  const cardBody = (
    <Card
      className={cn(
        "pharos-card-shell pharos-interactive-card h-full cursor-pointer",
        isSimulated && "border-dashed border-amber-500/40",
        dimUnaffected && "opacity-60"
      )}
    >
      <CardContent className="relative flex flex-col items-center gap-2.5 pt-3 pb-3">
        {/* Simulated badge */}
        {isSimulated && (
          <span className="absolute top-2 right-2 text-[10px] font-semibold text-amber-700 dark:text-amber-400 bg-amber-500/15 rounded-full px-2 py-0.5 leading-none border border-amber-500/20">
            Simulated
          </span>
        )}
        {/* Header: logo + name + symbol */}
        <div className="flex items-center gap-2 min-w-0 max-w-full">
          <StablecoinLogo src={logo} name={card.name} size={24} />
          <span className="truncate text-sm font-medium">{card.name}</span>
          <span className="text-xs text-muted-foreground shrink-0">{card.symbol}</span>
        </div>
        {coreSettlement && (
          <span className="rounded-full border border-frost-blue/30 bg-frost-blue/10 px-2 py-0.5 text-[10px] font-semibold leading-none text-sky-800 dark:text-sky-300">
            Core rail
          </span>
        )}

        {/* Large grade badge — show before→after when simulated */}
        {isSimulated && originalGrade && originalGrade !== card.overallGrade ? (
          <div className="flex items-center gap-1.5">
            <SafetyGradeBadge
              grade={originalGrade}
              size="md"
              animate
              animationDelayMs={animIndex * 40}
              versionTopic="safetyScore"
              versionVariant="tooltip-only"
              versionInteractive={false}
            />
            <span className="text-muted-foreground text-sm">&rarr;</span>
            <SafetyGradeBadge
              grade={card.overallGrade}
              size="md"
              animate
              animationDelayMs={animIndex * 40 + 80}
              versionTopic="safetyScore"
              versionVariant="tooltip-only"
              versionInteractive={false}
            />
            {originalScore != null && card.overallScore != null && (
              <span className="text-xs font-medium text-red-700 dark:text-red-400">
                {"\u25BC"}
                {Math.abs(card.overallScore - originalScore)}
              </span>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <SafetyGradeBadge
              grade={card.overallGrade}
              size="lg"
              animate
              animationDelayMs={animIndex * 40}
              versionTopic="safetyScore"
              versionVariant={gradeVersionVariant}
              versionInteractive={false}
            />
            {/* Trend indicator */}
            <TrendIndicator trend={trend} score={card.overallScore ?? undefined} />
          </div>
        )}

        {/* Radar chart or Defunct label */}
        {card.isDefunct ? (
          <span className="text-sm text-muted-foreground italic py-6">Defunct</span>
        ) : (
          <div className="w-full max-w-[11rem]">
            <div className="aspect-[1/1.04]">
              <ReportCardRadar card={card} labels="short" />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );

  if (card.isDefunct) {
    return (
      <div className="block h-full rounded-xl">
        {cardBody}
      </div>
    );
  }

  return (
    <Link
      href={buildStablecoinUrl(card.id)}
      className="pharos-focus-ring block h-full active:scale-[0.995] transition-transform rounded-xl"
    >
      {cardBody}
    </Link>
  );
}

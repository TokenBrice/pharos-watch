"use client";

import Link from "next/link";
import { buildStablecoinUrl } from "@/lib/urls";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { ReportCard, ReportCardGrade } from "@shared/types";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/report-cards";
import { ReportCardRadar } from "./radar-chart";

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
  /** Grid index used for staggered grade-pop animation delay */
  animIndex?: number;
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
  animIndex = 0,
}: ReportCardMiniProps) {
  const dimUnaffected = isSimulating && !isSimulated;

  return (
    <Link href={buildStablecoinUrl(card.id)} className="block h-full active:scale-[0.995] transition-transform">
      <Card
        className={`hover:bg-accent/50 hover:shadow-md transition-all cursor-pointer h-full ${
          isSimulated
            ? "border-dashed border-amber-500/40"
            : ""
        } ${dimUnaffected ? "opacity-60" : ""}`}
      >
        <CardContent className="relative flex flex-col items-center gap-2.5 pt-2 pb-2">
          {/* Simulated badge */}
          {isSimulated && (
            <span className="absolute top-1 right-1 text-xs font-medium text-amber-700 dark:text-amber-400 bg-amber-500/10 rounded px-1 py-0.5 leading-none">
              Simulated
            </span>
          )}

          {/* Header: logo + name + symbol */}
          <div className="flex items-center gap-2 min-w-0 max-w-full">
            {logo && (
              <img
                src={logo}
                alt={`${card.name} logo`}
                width={24}
                height={24}
                className="w-6 h-6 rounded-full shrink-0"
                loading="lazy"
                decoding="async"
              />
            )}
            <span className="truncate text-sm font-medium">{card.name}</span>
            <span className="text-xs text-muted-foreground shrink-0">
              {card.symbol}
            </span>
          </div>

          {/* Large grade badge — show before→after when simulated */}
          {isSimulated && originalGrade && originalGrade !== card.overallGrade ? (
            <div className="flex items-center gap-1.5">
              <Badge
                variant="outline"
                className={`text-base font-bold font-mono px-2 py-0.5 pharos-grade-pop ${REPORT_CARD_GRADE_COLORS[originalGrade]}`}
                style={{ animationDelay: `${animIndex * 40}ms` }}
              >
                {originalGrade}
              </Badge>
              <span className="text-muted-foreground text-sm">&rarr;</span>
              <Badge
                variant="outline"
                className={`text-base font-bold font-mono px-2 py-0.5 pharos-grade-pop ${REPORT_CARD_GRADE_COLORS[card.overallGrade]}`}
                style={{ animationDelay: `${animIndex * 40 + 80}ms` }}
              >
                {card.overallGrade}
              </Badge>
              {originalScore != null && card.overallScore != null && (
                <span className="text-xs font-medium text-red-700 dark:text-red-400">
                  {"\u25BC"}
                  {Math.abs(card.overallScore - originalScore)}
                </span>
              )}
            </div>
          ) : (
            <Badge
              variant="outline"
              className={`text-xl font-bold font-mono px-3 py-1 pharos-grade-pop ${REPORT_CARD_GRADE_COLORS[card.overallGrade]}`}
              style={{ animationDelay: `${animIndex * 40}ms` }}
            >
              {card.overallGrade}
            </Badge>
          )}

          {/* Radar chart or Defunct label */}
          {card.isDefunct ? (
            <span className="text-sm text-muted-foreground italic py-6">
              Defunct
            </span>
          ) : (
            <div className="w-full max-w-[11rem]">
              <div className="aspect-[1/1.04]">
                <ReportCardRadar card={card} labels="short" />
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}

"use client";

import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { ReportCard, ReportCardGrade } from "@/lib/types";
import { REPORT_CARD_GRADE_COLORS } from "@/lib/report-cards";
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
}: ReportCardMiniProps) {
  const dimUnaffected = isSimulating && !isSimulated;

  return (
    <Link href={`/stablecoin/${card.id}`} className="block h-full">
      <Card
        className={`hover:bg-accent/50 transition-colors cursor-pointer h-full ${
          isSimulated
            ? "border-dashed border-amber-500/40"
            : ""
        } ${dimUnaffected ? "opacity-60" : ""}`}
      >
        <CardContent className="relative flex flex-col items-center gap-3 pt-2 pb-2">
          {/* Simulated badge */}
          {isSimulated && (
            <span className="absolute top-1 right-1 text-[10px] font-medium text-amber-500 bg-amber-500/10 rounded px-1 py-0.5 leading-none">
              Simulated
            </span>
          )}

          {/* Header: logo + name + symbol */}
          <div className="flex items-center gap-2 min-w-0 max-w-full">
            {logo && (
              <img
                src={logo}
                alt={`${card.name} logo`}
                className="w-6 h-6 rounded-full shrink-0"
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
                className={`text-base font-bold font-mono px-2 py-0.5 ${REPORT_CARD_GRADE_COLORS[originalGrade]}`}
              >
                {originalGrade}
              </Badge>
              <span className="text-muted-foreground text-sm">&rarr;</span>
              <Badge
                variant="outline"
                className={`text-base font-bold font-mono px-2 py-0.5 ${REPORT_CARD_GRADE_COLORS[card.overallGrade]}`}
              >
                {card.overallGrade}
              </Badge>
              {originalScore != null && card.overallScore != null && (
                <span className="text-xs font-medium text-red-500">
                  {"\u25BC"}
                  {Math.abs(card.overallScore - originalScore)}
                </span>
              )}
            </div>
          ) : (
            <Badge
              variant="outline"
              className={`text-xl font-bold font-mono px-3 py-1 ${REPORT_CARD_GRADE_COLORS[card.overallGrade]}`}
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
            <ReportCardRadar card={card} labels="short" size={250} />
          )}
        </CardContent>
      </Card>
    </Link>
  );
}

"use client";

import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { ReportCard } from "@/lib/types";
import { REPORT_CARD_GRADE_COLORS } from "@/lib/report-cards";
import { ReportCardRadar } from "./radar-chart";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ReportCardMiniProps {
  card: ReportCard;
  logo?: string; // logo URL
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ReportCardMini({ card, logo }: ReportCardMiniProps) {
  return (
    <Link href={`/stablecoin/${card.id}`} className="block h-full">
      <Card className="hover:bg-accent/50 transition-colors cursor-pointer h-full">
        <CardContent className="flex flex-col items-center gap-3 pt-2 pb-2">
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

          {/* Large grade badge */}
          <Badge
            variant="outline"
            className={`text-xl font-bold font-mono px-3 py-1 ${REPORT_CARD_GRADE_COLORS[card.overallGrade]}`}
          >
            {card.overallGrade}
          </Badge>

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

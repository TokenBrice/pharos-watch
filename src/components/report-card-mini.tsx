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
  mcap?: number | null; // circulating supply in USD
  logo?: string; // logo URL
}

// ---------------------------------------------------------------------------
// MCap formatting
// ---------------------------------------------------------------------------

function formatMcap(mcap: number): string {
  if (mcap >= 1e9) return `$${(mcap / 1e9).toFixed(1)}B`;
  if (mcap >= 1e6) return `$${(mcap / 1e6).toFixed(0)}M`;
  if (mcap >= 1e3) return `$${(mcap / 1e3).toFixed(0)}K`;
  return `$${mcap.toFixed(0)}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ReportCardMini({ card, mcap, logo }: ReportCardMiniProps) {
  return (
    <Link href={`/stablecoin/${card.id}`} className="block h-full">
      <Card className="hover:bg-accent/50 transition-colors cursor-pointer h-full">
        <CardContent className="flex flex-col items-center gap-3 pt-4 pb-4">
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
            <ReportCardRadar card={card} showLabels={false} size={140} />
          )}

          {/* Market cap */}
          {mcap != null && mcap > 0 && (
            <span className="text-xs text-muted-foreground">
              {formatMcap(mcap)}
            </span>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}

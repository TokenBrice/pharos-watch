"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { ReportCard as ReportCardType, DimensionKey } from "@/lib/types";
import {
  REPORT_CARD_GRADE_COLORS,
  DIMENSION_LABELS,
  DIMENSION_ORDER,
  METHODOLOGY_VERSION,
} from "@/lib/report-cards";
import { ReportCardRadar } from "./radar-chart";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import Link from "next/link";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ReportCardDetailProps {
  card: ReportCardType;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ReportCardDetail({ card }: ReportCardDetailProps) {
  // Defunct coins get a minimal card
  if (card.isDefunct) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Pharos Report Card</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <Badge
              variant="outline"
              className={`text-2xl px-4 py-2 font-bold ${REPORT_CARD_GRADE_COLORS.F}`}
            >
              F
            </Badge>
            <div>
              <p className="text-lg font-medium text-muted-foreground">Defunct</p>
              <p className="text-sm text-muted-foreground">
                This stablecoin is no longer active.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <div className="flex items-center justify-between">
            <span>Pharos Report Card</span>
            <span className="text-xs font-normal text-muted-foreground">
              v{METHODOLOGY_VERSION}
            </span>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Two-column layout: grade + radar | dimension breakdown */}
        <div className="grid gap-6 md:grid-cols-2">
          {/* Left column: Overall grade + radar chart */}
          <div className="flex flex-col items-center gap-4">
            <div className="flex items-center gap-3">
              <Badge
                variant="outline"
                className={`text-3xl px-5 py-2 font-bold ${REPORT_CARD_GRADE_COLORS[card.overallGrade]}`}
              >
                {card.overallGrade}
              </Badge>
              {card.overallScore !== null && (
                <span className="text-lg text-muted-foreground">
                  {card.overallScore}
                  <span className="text-sm">/100</span>
                </span>
              )}
            </div>
            <ReportCardRadar card={card} size={280} showLabels />
          </div>

          {/* Right column: Dimension breakdown */}
          <div className="space-y-2">
            {DIMENSION_ORDER.map((key) => {
              const dim = card.dimensions[key];
              return (
                <div
                  key={key}
                  className="flex items-center justify-between rounded-lg border px-3 py-2"
                >
                  <span className="text-sm font-medium">
                    {DIMENSION_LABELS[key]}
                  </span>
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className={`text-xs font-semibold ${REPORT_CARD_GRADE_COLORS[dim.grade]}`}
                    >
                      {dim.grade}
                    </Badge>
                    <span className="w-12 text-right text-sm tabular-nums text-muted-foreground">
                      {dim.score !== null ? (
                        <>
                          {dim.score}
                          <span className="text-xs">/100</span>
                        </>
                      ) : (
                        "\u2014"
                      )}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Dependency callout for CeFi-Dependent coins */}
        {card.dependencies && card.dependencies.length > 0 && (
          <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 px-4 py-3">
            <p className="mb-2 text-sm font-medium text-blue-500">
              CeFi-Dependent
            </p>
            <p className="text-sm text-muted-foreground">
              This stablecoin depends on{" "}
              {card.dependencies.map((depId, i) => {
                const depMeta = TRACKED_STABLECOINS.find(
                  (s) => s.id === depId,
                );
                const name = depMeta?.name ?? depId;
                return (
                  <span key={depId}>
                    {i > 0 && ", "}
                    <Link
                      href={`/stablecoin/${depId}`}
                      className="font-medium text-blue-500 underline underline-offset-2 hover:text-blue-400"
                    >
                      {name}
                    </Link>
                  </span>
                );
              })}
              . Its dependency risk score reflects the health of these upstream
              assets.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

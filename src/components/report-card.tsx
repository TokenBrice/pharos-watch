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
          <CardTitle>Safety Score</CardTitle>
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
            <span>Safety Score</span>
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
            <ReportCardRadar card={card} labels="full" className="flex-1 min-h-[260px]" />
          </div>

          {/* Right column: Dimension breakdown */}
          <div className="space-y-2">
            {DIMENSION_ORDER.map((key) => {
              const dim = card.dimensions[key];
              return (
                <div key={key}>
                  <div
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
                  {key === "resilience" && dim.score !== null && (
                    <div className="ml-4 mt-1 space-y-0.5">
                      {dim.detail.split(". ").map((part) => {
                        const match = part.match(/^(.+?):\s*(.+?)\s*\((\d+)\)$/);
                        if (!match) return null;
                        const [, label, desc, scoreStr] = match;
                        const subScore = parseInt(scoreStr, 10);
                        return (
                          <div
                            key={label}
                            className="flex items-center justify-between text-xs text-muted-foreground"
                          >
                            <span>
                              {label}: <span className="text-foreground/70">{desc}</span>
                            </span>
                            <span className="tabular-nums">{subScore}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
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
              This stablecoin has exposure to{" "}
              {card.dependencies.map((dep, i) => {
                const depMeta = TRACKED_STABLECOINS.find(
                  (s) => s.id === dep.id,
                );
                const name = depMeta?.name ?? dep.id;
                const typeLabel = dep.type === "wrapper" ? " (wrapper)"
                  : dep.type === "mechanism" ? " (mechanism-critical)"
                  : "";
                return (
                  <span key={dep.id}>
                    {i > 0 && ", "}
                    <Link
                      href={`/stablecoin/${dep.id}`}
                      className="font-medium text-blue-500 underline underline-offset-2 hover:text-blue-400 transition-colors"
                    >
                      {name}
                    </Link>
                    {typeLabel && (
                      <span className="text-xs text-blue-500/70">{typeLabel}</span>
                    )}
                  </span>
                );
              })}
              . Its dependency risk score reflects the health and stability of
              these assets.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

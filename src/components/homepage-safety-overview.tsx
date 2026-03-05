"use client";

import { useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { gradeRange, scoreToGrade } from "@shared/lib/report-cards";
import { formatCurrency } from "@shared/lib/format";
import { sumPegBuckets } from "@shared/lib/supply";
import type { ReportCard, StablecoinData } from "@shared/types";

interface HomepageSafetyOverviewProps {
  cards?: ReportCard[];
  peggedAssets?: StablecoinData[];
  className?: string;
}

const GRADE_RANGES = ["A", "B", "C", "D", "F", "NR"] as const;

const GRADE_BAR_COLORS: Record<(typeof GRADE_RANGES)[number], string> = {
  A: "bg-emerald-500",
  B: "bg-blue-500",
  C: "bg-amber-500",
  D: "bg-orange-500",
  F: "bg-red-500",
  NR: "bg-zinc-500",
};

const RANGE_PILL_CLASSES: Record<(typeof GRADE_RANGES)[number], string> = {
  A: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300",
  B: "border-blue-500/40 bg-blue-500/15 text-blue-300",
  C: "border-amber-500/40 bg-amber-500/15 text-amber-300",
  D: "border-orange-500/40 bg-orange-500/15 text-orange-300",
  F: "border-red-500/40 bg-red-500/15 text-red-300",
  NR: "border-zinc-500/40 bg-zinc-500/15 text-zinc-300",
};

const PULSE_THEME: Record<(typeof GRADE_RANGES)[number], {
  ring: string;
  bg: string;
  accent: string;
  tagline: string;
}> = {
  A: {
    ring: "border-emerald-500/35",
    bg: "bg-emerald-500/10",
    accent: "text-emerald-300",
    tagline: "High-grade assets dominate the market mix.",
  },
  B: {
    ring: "border-blue-500/35",
    bg: "bg-blue-500/10",
    accent: "text-blue-300",
    tagline: "Safety profile is balanced with moderate fragility.",
  },
  C: {
    ring: "border-amber-500/35",
    bg: "bg-amber-500/10",
    accent: "text-amber-300",
    tagline: "Quality mix is split; watch weaker structures.",
  },
  D: {
    ring: "border-orange-500/35",
    bg: "bg-orange-500/10",
    accent: "text-orange-300",
    tagline: "Risk pressure is elevated in lower-grade tiers.",
  },
  F: {
    ring: "border-red-500/35",
    bg: "bg-red-500/10",
    accent: "text-red-300",
    tagline: "Failure-prone segment is meaningfully outsized.",
  },
  NR: {
    ring: "border-zinc-500/35",
    bg: "bg-zinc-500/10",
    accent: "text-zinc-300",
    tagline: "Data coverage is incomplete for a full pulse read.",
  },
};

interface LargestCard {
  id: string;
  symbol: string;
  grade: ReportCard["overallGrade"];
  range: (typeof GRADE_RANGES)[number];
  score: number | null;
  mcapUsd: number;
}

export function HomepageSafetyOverview({ cards, peggedAssets, className }: HomepageSafetyOverviewProps) {
  const {
    activeCards,
    counts,
    ratedCount,
    avgScore,
    weightedScore,
    pulseGrade,
    pulseRange,
    strongCount,
    highRiskCount,
    largestByMcap,
  } = useMemo(() => {
    const active = (cards ?? []).filter((card) => !card.isDefunct);

    const rangeCounts: Record<(typeof GRADE_RANGES)[number], number> = {
      A: 0,
      B: 0,
      C: 0,
      D: 0,
      F: 0,
      NR: 0,
    };
    for (const card of active) {
      const range = gradeRange(card.overallGrade) as (typeof GRADE_RANGES)[number];
      rangeCounts[range] += 1;
    }

    const scored = active
      .map((card) => card.overallScore)
      .filter((score): score is number => score !== null);
    const average = scored.length > 0
      ? Math.round(scored.reduce((sum, score) => sum + score, 0) / scored.length)
      : null;

    const mcapById = new Map<string, number>();
    for (const asset of peggedAssets ?? []) {
      mcapById.set(asset.id, sumPegBuckets(asset.circulating));
    }

    let weightedNumerator = 0;
    let weightedDenominator = 0;
    for (const card of active) {
      if (card.overallScore === null) continue;
      const mcap = mcapById.get(card.id) ?? 0;
      if (mcap <= 0) continue;
      weightedNumerator += card.overallScore * mcap;
      weightedDenominator += mcap;
    }
    const weightedAverage = weightedDenominator > 0
      ? Math.round(weightedNumerator / weightedDenominator)
      : null;
    const marketPulse = weightedAverage ?? average;
    const marketGrade = scoreToGrade(marketPulse);
    const marketRange = gradeRange(marketGrade) as (typeof GRADE_RANGES)[number];

    const largest: LargestCard[] = active
      .map((card) => ({
        id: card.id,
        symbol: card.symbol,
        grade: card.overallGrade,
        range: gradeRange(card.overallGrade) as (typeof GRADE_RANGES)[number],
        score: card.overallScore,
        mcapUsd: mcapById.get(card.id) ?? 0,
      }))
      .filter((card) => card.mcapUsd > 0)
      .sort((a, b) => b.mcapUsd - a.mcapUsd)
      .slice(0, 3);

    return {
      activeCards: active,
      counts: rangeCounts,
      ratedCount: scored.length,
      avgScore: average,
      weightedScore: weightedAverage,
      pulseGrade: marketGrade,
      pulseRange: marketRange,
      strongCount: rangeCounts.A + rangeCounts.B,
      highRiskCount: rangeCounts.D + rangeCounts.F,
      largestByMcap: largest,
    };
  }, [cards, peggedAssets]);

  if (activeCards.length === 0) {
    return (
      <Card className={cn("min-h-[340px] rounded-xl animate-in fade-in duration-300 sm:min-h-[390px]", className)}>
        <CardContent className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
          Safety score data is loading.
        </CardContent>
      </Card>
    );
  }

  const pulse = PULSE_THEME[pulseRange];
  const strongPct = Math.round((strongCount / activeCards.length) * 100);
  const highRiskPct = Math.round((highRiskCount / activeCards.length) * 100);
  const ratedPct = Math.round((ratedCount / activeCards.length) * 100);

  return (
    <Card className={cn("min-h-[340px] overflow-hidden rounded-xl animate-in fade-in duration-300 sm:min-h-[390px]", className)}>
      <CardContent className="flex h-full flex-col justify-between gap-4 p-4">
        <div className={cn("overflow-hidden rounded-xl border px-3 py-2", pulse.ring, pulse.bg)}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Market Safety Pulse</p>
              <div className="mt-1 flex items-end gap-2">
                <p className={cn("text-3xl font-black leading-none tracking-tight sm:text-4xl", pulse.accent)}>
                  {pulseGrade}
                </p>
                <p className="font-mono text-xl font-bold leading-none tabular-nums sm:text-2xl">
                  {weightedScore ?? avgScore ?? "NR"}
                </p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">MCap-weighted</p>
              <p className="mt-1 font-mono text-lg font-semibold tabular-nums">Avg {avgScore ?? "NR"}</p>
            </div>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{pulse.tagline}</p>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg border border-border/60 bg-background/35 px-2.5 py-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">A/B share</p>
            <p className="mt-1 font-mono text-lg font-bold text-emerald-300">{strongPct}%</p>
          </div>
          <div className="rounded-lg border border-border/60 bg-background/35 px-2.5 py-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">D/F pressure</p>
            <p className="mt-1 font-mono text-lg font-bold text-red-300">{highRiskPct}%</p>
          </div>
          <div className="rounded-lg border border-border/60 bg-background/35 px-2.5 py-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Coverage</p>
            <p className="mt-1 font-mono text-lg font-bold">{ratedPct}%</p>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px] uppercase tracking-wide text-muted-foreground">
            <span>Grade Mix</span>
            <span className="font-mono normal-case">{activeCards.length} coins</span>
          </div>
          <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted/30">
            {GRADE_RANGES.map((range) => {
              const count = counts[range];
              if (count === 0) return null;
              return (
                <div
                  key={range}
                  className={GRADE_BAR_COLORS[range]}
                  style={{ width: `${(count / activeCards.length) * 100}%` }}
                  title={`${range}: ${count}`}
                />
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            {GRADE_RANGES.map((range) => (
              <span key={range} className="font-mono">{range}:{counts[range]}</span>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Systemically Important</p>
          {largestByMcap.length > 0 ? (
            <div className="grid grid-cols-3 gap-2">
              {largestByMcap.map((card) => (
                <div key={card.id} className="rounded-lg border border-border/60 bg-background/35 px-2 py-2">
                  <div className="flex items-center justify-between gap-1.5">
                    <span className="font-mono text-[11px] font-semibold">{card.symbol}</span>
                    <span className={cn("rounded border px-1.5 py-0.5 text-[10px] font-semibold leading-none", RANGE_PILL_CLASSES[card.range])}>
                      {card.grade}
                    </span>
                  </div>
                  <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                    {formatCurrency(card.mcapUsd)}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Market-cap context unavailable.</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

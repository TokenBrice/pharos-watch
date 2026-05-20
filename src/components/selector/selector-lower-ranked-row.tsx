"use client";

import type { SelectorInput, SelectorLowerRanked } from "@shared/lib/selector";
import { PEG_METADATA } from "@shared/lib/classification";

interface SelectorLowerRankedRowProps {
  entry: SelectorLowerRanked;
  pegCurrency: SelectorInput["pegCurrency"];
  /**
   * Pre-rendered prose. The engine's `what-to-watch-templates.ts` is expected
   * to emit the bold verdict + muted teaching line keyed off `reasonKey`.
   */
  verdictText?: string;
  teachingText?: string;
}

export function SelectorLowerRankedRow({
  entry,
  pegCurrency,
  verdictText,
  teachingText,
}: SelectorLowerRankedRowProps) {
  const entryWithProse = entry as SelectorLowerRanked & {
    verdictText?: string;
    teachingText?: string;
  };
  const verdict = verdictText ?? entryWithProse.verdictText ?? `${entry.symbol} needs review`;
  const teaching =
    teachingText
    ?? entryWithProse.teachingText
    ?? (entry.failedComponent
      ? `Lower-ranked for this profile because its ${readableComponent(entry.failedComponent)} reading did not clear the selected profile threshold.`
      : "Lower-ranked for this profile after the same filters and weights were applied.");
  const pegLabel = PEG_METADATA[pegCurrency]?.filterLabel ?? pegCurrency;

  return (
    <li className="flex flex-col gap-1 rounded-xl border border-dashed border-border/55 bg-muted/[0.06] px-3.5 py-3 focus-within:border-foreground/45 focus-within:ring-2 focus-within:ring-ring/30 sm:flex-row sm:items-baseline sm:gap-3">
      <p className="min-w-0 break-words text-sm font-semibold tracking-tight text-foreground sm:min-w-fit">
        {verdict} <span className="text-xs font-medium text-muted-foreground">({pegLabel} peg)</span>
      </p>
      <p className="min-w-0 break-words text-sm leading-relaxed text-muted-foreground">{teaching}</p>
    </li>
  );
}

function readableComponent(key: string): string {
  const labels: Record<string, string> = {
    safetyOverall: "Safety Score",
    resilience: "resilience",
    dependencyRisk: "dependency risk",
    pegStabilityHistory: "peg history",
    pegStabilityLive: "live peg stability",
    pegScoreNow: "current peg score",
    decentralization: "decentralization",
    dewsInverted: "DEWS stress",
    bluechip: "blue-chip alignment",
    supplyLog: "market depth",
    pharosYieldScore: "Pharos Yield Score",
    excessApy: "net yield",
    yieldVariance: "yield variance",
    sourceRiskInverted: "source risk",
    effectiveExit: "effective exit",
    liquidity: "liquidity",
    liquidityDiversification: "liquidity diversification",
  };
  return labels[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

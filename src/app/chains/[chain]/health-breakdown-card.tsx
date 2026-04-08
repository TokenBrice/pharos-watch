"use client";

import { AlertCircle, AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import {
  BACKING_DIVERSITY_WEIGHT,
  CHAIN_ENVIRONMENT_WEIGHT,
  CONCENTRATION_WEIGHT,
  PEG_STABILITY_WEIGHT,
  QUALITY_WEIGHT,
  getHealthBand,
} from "@shared/lib/chain-health";
import { formatElapsedSeconds } from "@shared/lib/format";
import type { ChainSummary, HealthBand } from "@shared/types/chains";
import type { ApiMeta } from "@/lib/api";
import { MethodologyCardActions, MethodologyHint, MethodologyLabel } from "@/components/methodology-hint";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { HEALTH_BADGE_CLASSES, HEALTH_FILL_CLASSES, HEALTH_TEXT_CLASSES } from "@/lib/chain-ui";
import { cn } from "@/lib/utils";

function resolveScoreBand(score: number): HealthBand {
  return getHealthBand(score) ?? "concentrated";
}

function ScoreIcon({ band }: { band: HealthBand }) {
  if (band === "robust") {
    return <><CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" /><span className="sr-only">Robust</span></>;
  }
  if (band === "healthy") {
    return <><AlertCircle className="h-3.5 w-3.5 text-sky-500" aria-hidden="true" /><span className="sr-only">Healthy</span></>;
  }
  if (band === "mixed") {
    return <><AlertTriangle className="h-3.5 w-3.5 text-amber-500" aria-hidden="true" /><span className="sr-only">Mixed</span></>;
  }
  if (band === "fragile") {
    return <><AlertTriangle className="h-3.5 w-3.5 text-orange-500" aria-hidden="true" /><span className="sr-only">Fragile</span></>;
  }
  return <><XCircle className="h-3.5 w-3.5 text-red-500" aria-hidden="true" /><span className="sr-only">Concentrated</span></>;
}

function FactorGauge({
  label,
  score,
  methodologyKey,
}: {
  label: string;
  score: number | null;
  methodologyKey?: "chainHealthQuality" | "chainHealthEnvironment" | "chainHealthConcentration" | "chainHealthPegStability" | "chainHealthBackingDiversity";
}) {
  const hasScore = score != null;
  const scoreBand = hasScore ? resolveScoreBand(score) : null;
  const colorClass = scoreBand ? HEALTH_FILL_CLASSES[scoreBand] : "bg-muted-foreground/30";
  const textClass = scoreBand ? HEALTH_TEXT_CLASSES[scoreBand] : "text-muted-foreground";

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-1.5">
          {scoreBand && <ScoreIcon band={scoreBand} />}
          {methodologyKey ? (
            <MethodologyLabel topic={methodologyKey} className="text-xs">
              <span className="pharos-kicker cursor-help">{label}</span>
            </MethodologyLabel>
          ) : (
            <span className="pharos-kicker">{label}</span>
          )}
        </div>
        <span className={cn("font-mono font-medium", textClass)}>{hasScore ? score : "--"}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        {hasScore && (
          <div
            className={cn("h-full rounded-full transition-all duration-500", colorClass)}
            style={{ width: `${score}%` }}
          />
        )}
      </div>
    </div>
  );
}

function buildHealthUnavailableMessage(meta: ApiMeta | null): string {
  const reportCards = meta?.dependencies?.reportCards;
  if (!reportCards || reportCards.status === "fresh") {
    return "Insufficient safety score coverage for a composite health score. Sub-factors are shown below.";
  }

  if (reportCards.status === "stale") {
    const ageText = reportCards.ageSeconds != null
      ? ` (${formatElapsedSeconds(reportCards.ageSeconds)} old)`
      : "";
    return `Chain Health is temporarily unavailable because report-card inputs are stale${ageText}. Sub-factors are still shown below.`;
  }

  return "Chain Health is temporarily unavailable because report-card inputs are unavailable. Sub-factors are still shown below.";
}

export function HealthBreakdownCard({
  chain,
  meta,
}: {
  chain: ChainSummary;
  meta: ApiMeta | null;
}) {
  const { healthFactors, healthScore } = chain;
  const healthBand = chain.healthBand;
  const hasScore = healthScore != null && healthBand != null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="pharos-kicker">Chain Health Score</CardTitle>
          <MethodologyHint topic="chainHealth" />
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {hasScore ? (
          <div className="flex items-center gap-4">
            <div
              className={cn(
                "flex h-20 w-20 items-center justify-center rounded-2xl text-3xl font-bold shadow-sm",
                HEALTH_BADGE_CLASSES[healthBand],
              )}
            >
              {healthScore}
            </div>
            <div className="space-y-1">
              <p className={cn("text-lg font-semibold capitalize", HEALTH_TEXT_CLASSES[healthBand])}>{healthBand}</p>
              <p className="max-w-[280px] text-sm text-muted-foreground">
                Composite health across quality, environment, concentration, peg stability, and backing diversity.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-3 rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="text-sm text-amber-800 dark:text-amber-200">
              {buildHealthUnavailableMessage(meta)}
            </p>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <FactorGauge
            label={`Quality (${Math.round(QUALITY_WEIGHT * 100)}%)`}
            score={healthFactors.quality}
            methodologyKey="chainHealthQuality"
          />
          <FactorGauge
            label={`Environment (${Math.round(CHAIN_ENVIRONMENT_WEIGHT * 100)}%)`}
            score={healthFactors.chainEnvironment}
            methodologyKey="chainHealthEnvironment"
          />
          <FactorGauge
            label={`Concentration (${Math.round(CONCENTRATION_WEIGHT * 100)}%)`}
            score={healthFactors.concentration}
            methodologyKey="chainHealthConcentration"
          />
          <FactorGauge
            label={`Peg Stability (${Math.round(PEG_STABILITY_WEIGHT * 100)}%)`}
            score={healthFactors.pegStability}
            methodologyKey="chainHealthPegStability"
          />
          <FactorGauge
            label={`Backing Diversity (${Math.round(BACKING_DIVERSITY_WEIGHT * 100)}%)`}
            score={healthFactors.backingDiversity}
            methodologyKey="chainHealthBackingDiversity"
          />
        </div>

        <MethodologyCardActions topic="chainHealth" />
      </CardContent>
    </Card>
  );
}

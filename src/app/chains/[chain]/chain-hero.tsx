"use client";

import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight, Minus, TrendingDown, TrendingUp } from "lucide-react";
import type { ChainMeta } from "@shared/lib/chains";
import {
  BACKING_DIVERSITY_WEIGHT,
  CHAIN_ENVIRONMENT_WEIGHT,
  CONCENTRATION_WEIGHT,
  PEG_STABILITY_WEIGHT,
  QUALITY_WEIGHT,
  getHealthBand,
} from "@shared/lib/chains/health";
import { formatCompactUsd, formatElapsedSeconds, formatSignedPercent } from "@shared/lib/format";
import type { ChainEnvironmentEvidence, ChainSummary, HealthBand } from "@shared/types/chains";
import type { ApiMeta } from "@/lib/api";
import { ChainTypeBadge } from "@/components/chain-type-badge";
import { MethodologyCardActions, MethodologyHint, MethodologyLabel } from "@/components/methodology-hint";
import { ScoreBadgeWrapper } from "@/components/score-badge-wrapper";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  HEALTH_BADGE_CLASSES,
  HEALTH_FILL_CLASSES,
  HEALTH_TEXT_CLASSES,
  trendColor,
} from "@/lib/chain-ui";
import { cn } from "@/lib/utils";

type TrendKey = "change24hPct" | "change7dPct" | "change30dPct";

const TREND_WINDOWS: { key: TrendKey; label: string }[] = [
  { key: "change24hPct", label: "24h" },
  { key: "change7dPct", label: "7d" },
  { key: "change30dPct", label: "30d" },
];

const FACTOR_DEFS = [
  {
    key: "quality" as const,
    label: "Quality",
    weight: QUALITY_WEIGHT,
    methodology: "chainHealthQuality" as const,
  },
  {
    key: "chainEnvironment" as const,
    label: "Environment",
    weight: CHAIN_ENVIRONMENT_WEIGHT,
    methodology: "chainHealthEnvironment" as const,
  },
  {
    key: "concentration" as const,
    label: "Concentration",
    weight: CONCENTRATION_WEIGHT,
    methodology: "chainHealthConcentration" as const,
  },
  {
    key: "pegStability" as const,
    label: "Peg Stability",
    weight: PEG_STABILITY_WEIGHT,
    methodology: "chainHealthPegStability" as const,
  },
  {
    key: "backingDiversity" as const,
    label: "Backing Diversity",
    weight: BACKING_DIVERSITY_WEIGHT,
    methodology: "chainHealthBackingDiversity" as const,
  },
];

function resolveScoreBand(score: number): HealthBand {
  return getHealthBand(score) ?? "concentrated";
}

function buildHealthUnavailableMessage(meta: ApiMeta | null): string {
  const reportCards = meta?.dependencies?.reportCards;
  if (!reportCards || reportCards.status === "fresh") {
    return "Insufficient safety score coverage for a composite Chain Health score. Sub-factors are shown below.";
  }
  if (reportCards.status === "stale") {
    const ageText = reportCards.ageSeconds != null
      ? ` (${formatElapsedSeconds(reportCards.ageSeconds)} old)`
      : "";
    return `Chain Health is temporarily unavailable because report-card inputs are stale${ageText}. Sub-factors are still shown below.`;
  }
  return "Chain Health is temporarily unavailable because report-card inputs are unavailable. Sub-factors are still shown below.";
}

function TrendValue({ value }: { value: number }) {
  const Icon = value > 0.001 ? TrendingUp : value < -0.001 ? TrendingDown : Minus;
  return (
    <span className={cn("inline-flex items-center gap-1 font-mono text-sm font-semibold tabular-nums", trendColor(value))}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {formatSignedPercent(value * 100, 2)}
    </span>
  );
}

function FactorRow({
  label,
  weight,
  score,
  methodology,
  context,
}: {
  label: string;
  weight: number;
  score: number | null;
  methodology: "chainHealthQuality" | "chainHealthEnvironment" | "chainHealthConcentration" | "chainHealthPegStability" | "chainHealthBackingDiversity";
  context?: string | null;
}) {
  const hasScore = score != null;
  const band = hasScore ? resolveScoreBand(score) : null;
  const fillClass = band ? HEALTH_FILL_CLASSES[band] : "bg-muted-foreground/30";
  const textClass = band ? HEALTH_TEXT_CLASSES[band] : "text-muted-foreground";

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <MethodologyLabel topic={methodology} className="text-xs">
          <span className="pharos-kicker cursor-help">
            {label} <span className="font-mono normal-case tracking-normal text-muted-foreground/80">({Math.round(weight * 100)}%)</span>
          </span>
        </MethodologyLabel>
        <span className={cn("font-mono text-sm font-semibold tabular-nums", textClass)}>
          {hasScore ? score : "—"}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        {hasScore && (
          <div
            className={cn("h-full rounded-full transition-[width] duration-500", fillClass)}
            style={{ width: `${score}%` }}
          />
        )}
      </div>
      {context ? (
        <p className="text-[11px] leading-snug text-muted-foreground">{context}</p>
      ) : null}
    </div>
  );
}

function formatChainEnvironmentContext(evidence: ChainEnvironmentEvidence | undefined): string | null {
  if (!evidence) return null;
  if (evidence.source === "l2beat") {
    const review = evidence.isUnderReview ? " under review" : "";
    return `L2BEAT ${evidence.stage}${review}; risk ${evidence.riskScore}/100; snapshot ${evidence.snapshot.fetchedAt}.`;
  }
  return `Pharos resilience tier ${evidence.resilienceTier} fallback.`;
}

function IdentityRow({ meta, chainName }: { meta: ChainMeta; chainName: string }) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-4">
        <div className="shrink-0 rounded-xl border border-border/60 bg-background/80 p-2.5">
          <Image
            src={meta.logoPath}
            alt=""
            width={48}
            height={48}
            className={cn("h-12 w-12 rounded-full", meta.darkInvert && "dark:invert")}
          />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h2 className="text-lg font-semibold leading-none tracking-tight">{chainName}</h2>
            <ChainTypeBadge type={meta.type} />
            {meta.evmChainId != null && (
              <span className="rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 font-mono text-xs tabular-nums text-muted-foreground">
                Chain ID {meta.evmChainId}
              </span>
            )}
            {meta.explorerUrl && (
              <a
                href={meta.explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                Explorer
                <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
              </a>
            )}
          </div>
        </div>
      </div>
      <Link
        href="/chains/"
        className="pharos-focus-ring inline-flex h-9 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/70 px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        All chains
      </Link>
    </div>
  );
}

function MarketMetrics({ chain }: { chain: ChainSummary | null }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-5">
      <div>
        <p className="pharos-kicker">Total Supply</p>
        <div className="pharos-numeric mt-1 text-2xl font-bold leading-none text-frost-blue">
          {chain ? formatCompactUsd(chain.totalUsd) : <Skeleton className="h-7 w-24" />}
        </div>
      </div>
      <div>
        <p className="pharos-kicker">Global Share</p>
        <div className="mt-1 font-mono text-2xl font-bold leading-none tabular-nums">
          {chain ? `${(chain.dominanceShare * 100).toFixed(1)}%` : <Skeleton className="h-7 w-16" />}
        </div>
      </div>
      {TREND_WINDOWS.map(({ key, label }) => (
        <div key={key}>
          <p className="pharos-kicker">{label}</p>
          <div className="mt-1 leading-none">
            {chain ? <TrendValue value={chain[key]} /> : <Skeleton className="h-5 w-16" />}
          </div>
        </div>
      ))}
    </div>
  );
}

function HealthZone({
  chain,
  apiMeta,
}: {
  chain: ChainSummary | null;
  apiMeta: ApiMeta | null;
}) {
  const healthBand = chain?.healthBand ?? null;
  const healthScore = chain?.healthScore ?? null;
  const hasComposite = healthBand != null && healthScore != null;

  return (
    <section className="space-y-5" aria-label="Chain Health">
      <div className="flex items-start justify-between gap-3">
        <p className="pharos-kicker">Chain Health Score</p>
        <MethodologyHint topic="chainHealth" />
      </div>

      {chain == null ? (
        <div className="flex items-center gap-4">
          <Skeleton className="h-16 w-16 rounded-xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-48" />
          </div>
        </div>
      ) : hasComposite ? (
        <div className="flex items-center gap-4">
          <ScoreBadgeWrapper topic="chainHealth" variant="tooltip-only">
            <span
              className={cn(
                "flex h-16 w-16 items-center justify-center rounded-xl font-mono text-2xl font-bold tabular-nums",
                HEALTH_BADGE_CLASSES[healthBand],
              )}
            >
              {healthScore}
            </span>
          </ScoreBadgeWrapper>
          <div className="min-w-0 space-y-0.5">
            <p className={cn("text-base font-semibold capitalize leading-tight", HEALTH_TEXT_CLASSES[healthBand])}>
              {healthBand}
            </p>
            <p className="text-xs text-muted-foreground">
              Composite across quality, environment, concentration, peg stability, and backing diversity.
            </p>
          </div>
        </div>
      ) : (
        <p className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          {buildHealthUnavailableMessage(apiMeta)}
        </p>
      )}

      <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
        {FACTOR_DEFS.map((def) => (
          <FactorRow
            key={def.key}
            label={def.label}
            weight={def.weight}
            score={chain?.healthFactors[def.key] ?? null}
            methodology={def.methodology}
            context={
              def.key === "chainEnvironment"
                ? formatChainEnvironmentContext(chain?.chainEnvironmentEvidence)
                : null
            }
          />
        ))}
      </div>

      <MethodologyCardActions topic="chainHealth" showWorkToggle />
    </section>
  );
}

export function ChainHero({
  meta,
  chain,
  apiMeta,
}: {
  meta: ChainMeta;
  chain: ChainSummary | null;
  apiMeta: ApiMeta | null;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="space-y-6 px-5 py-6 sm:px-6">
        <IdentityRow meta={meta} chainName={chain?.name ?? meta.name} />

        <div className="h-px w-full bg-border/60" />

        <MarketMetrics chain={chain} />

        <div className="h-px w-full bg-border/60" />

        <HealthZone chain={chain} apiMeta={apiMeta} />
      </div>
    </Card>
  );
}

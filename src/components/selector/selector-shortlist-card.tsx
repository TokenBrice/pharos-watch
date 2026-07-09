"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ArrowUpRight, Clock, ShieldAlert } from "lucide-react";
import { SafetyGradeBadge } from "@/components/safety-grade-badge";
import { TableSourceLink } from "@/components/table/client";
import { RowSparkline } from "@/components/row-sparkline";
import { useSupplyHistory } from "@/hooks/use-stablecoins";
import { cn } from "@/lib/utils";
import { GRADE_RADAR_COLORS, gradeRange } from "@shared/lib/report-cards";
import type { SelectorComponent, SelectorProfile, SelectorRecommendation } from "@shared/lib/selector";
import {
  selectorComponentLowestSubDimensionLabel,
  selectorComponentScoreLabel,
  selectorProfileLabel,
} from "@shared/lib/selector/selector-labels";

interface SelectorShortlistCardProps {
  rank: 1 | 2 | 3;
  recommendation: SelectorRecommendation;
  profile: SelectorProfile;
  isMobile: boolean;
  /** Logo URL keyed by coin id. Optional. */
  logoUrl?: string;
  whyText?: string;
  watchText?: string;
  /**
   * When true (single-result shortlist), promote the per-card Open detail link
   * to a filled primary button. With multiple results, Compare these is the
   * strongest forward action; with a single result, Open detail is.
   */
  prominentOpenDetail?: boolean;
  /** External URL for the recommended yield source, when available. */
  yieldSourceUrl?: string | null;
  /** Internal Yield Intelligence detail URL for this recommendation. */
  yieldInspectionHref?: string | null;
}

/** Discrete staleness label used on mobile (R2 Mobile concern #4). */
function discreteStalenessLabel(seconds: number): string {
  if (seconds <= 60) return "Fresh";
  if (seconds <= 120) return "1m";
  if (seconds <= 360) return "5m";
  return "Stale";
}

function preciseStaleness(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h`;
}

interface TextChip {
  label: string;
  value: string;
  ariaLabel?: string;
  tone?: "default" | "watch";
}

function buildEvidenceChips(rec: SelectorRecommendation, isMobile: boolean): TextChip[] {
  const chips: TextChip[] = [];

  switch (rec.profile) {
    case "treasury": {
      const safety = rec.safetyGrade;
      if (safety) {
        chips.push({ label: "Safety", value: safety, ariaLabel: `Safety grade ${safety}` });
      }
      const resilience = rec.components.find((c) => c.key === "resilience");
      if (resilience?.rawValue != null) {
        chips.push({
          label: "Resilience",
          value: String(Math.round(resilience.rawValue)),
          ariaLabel: `Resilience score ${Math.round(resilience.rawValue)} of 100`,
        });
      }
      const dependency = rec.components.find((c) => c.key === "dependencyRisk");
      if (dependency?.rawValue != null) {
        chips.push({
          label: "Dependency Risk",
          value: String(Math.round(dependency.rawValue)),
          ariaLabel: `Dependency risk score ${Math.round(dependency.rawValue)} of 100`,
        });
      }
      break;
    }
    case "yield": {
      const pys = rec.components.find((c) => c.key === "pharosYieldScore");
      if (pys?.rawValue != null) {
        chips.push({
          label: "PYS",
          value: String(Math.round(pys.rawValue)),
          ariaLabel: `Pharos Yield Score ${Math.round(pys.rawValue)} of 100`,
        });
      }
      if (rec.recommendedSource) {
        chips.push({
          label: "APY",
          value: `${rec.recommendedSource.apy30d.toFixed(1)}%`,
          ariaLabel: `Trailing 30-day APY ${rec.recommendedSource.apy30d.toFixed(1)} percent`,
        });
      }
      const safety = rec.safetyGrade;
      if (safety) {
        chips.push({ label: "Safety", value: safety, ariaLabel: `Safety grade ${safety}` });
      }
      break;
    }
    case "trading": {
      const peg = rec.components.find((c) => c.key === "pegScoreNow");
      const liquidity = rec.components.find((c) => c.key === "liquidity");
      const dews = rec.components.find((c) => c.key === "dewsInverted");

      // Trading: per-input staleness chip replaces one evidence chip when triggered.
      // We surface PegScore + Liquidity + Staleness as the 3-chip set.
      if (peg?.rawValue != null) {
        chips.push({
          label: "Peg",
          value: String(Math.round(peg.rawValue)),
          ariaLabel: `Peg score ${Math.round(peg.rawValue)} of 100`,
        });
      }
      if (liquidity?.rawValue != null) {
        chips.push({
          label: "Liquidity",
          value: String(Math.round(liquidity.rawValue)),
          ariaLabel: `Liquidity score ${Math.round(liquidity.rawValue)} of 100`,
        });
      }
      // Pick the worst staleness across the per-input map.
      const ages = Object.values(rec.perInputStaleness ?? {});
      if (ages.length > 0) {
        const worst = Math.max(...ages);
        chips.push({
          label: "Freshness",
          value: isMobile ? discreteStalenessLabel(worst) : `${preciseStaleness(worst)} old`,
          ariaLabel: `Data freshness watch: ${discreteStalenessLabel(worst).toLowerCase()}`,
          tone: "watch",
        });
      } else if (dews?.rawValue != null) {
        chips.push({
          label: "DEWS",
          value: String(Math.round(dews.rawValue)),
          ariaLabel: `DEWS stress score ${Math.round(dews.rawValue)} of 100. Lower is better.`,
        });
      }
      break;
    }
  }

  return chips.slice(0, 3);
}

export function SelectorShortlistCard(props: SelectorShortlistCardProps) {
  const {
    rank,
    recommendation: rec,
    profile,
    isMobile,
    logoUrl,
    whyText,
    watchText,
    prominentOpenDetail = false,
    yieldSourceUrl,
    yieldInspectionHref,
  } = props;
  const chips = buildEvidenceChips(rec, isMobile);
  const resolvedWhyText = whyText ?? rec.whyText;
  const resolvedWatchText = watchText ?? rec.watchText;

  const detailHref = `/stablecoin/${rec.id}/`;
  const profileLabel = selectorProfileLabel(profile);
  const headlineId = `selector-shortlist-${rec.id}`;

  return (
    <li className="pharos-card-shell pharos-interactive-card relative overflow-hidden p-4 focus-within:border-foreground/55 focus-within:ring-2 focus-within:ring-ring/35 sm:p-5">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="pharos-numeric mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background/65 text-xs font-semibold text-foreground"
        >
          {rank}
        </span>
        <span className="sr-only">{`Rank ${rank}, ${profileLabel} profile.`}</span>
        {logoUrl ? (
          <img
            src={logoUrl}
            alt=""
            className="mt-0.5 h-9 w-9 shrink-0 rounded-full border border-border/55 bg-background/60 object-cover"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <span
            aria-hidden="true"
            className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border/55 bg-background/60 text-xs font-bold text-foreground"
          >
            {rec.symbol.slice(0, 2)}
          </span>
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <h3 id={headlineId} className="text-base font-semibold tracking-tight text-foreground sm:text-lg">
            <span className="font-bold">{rec.symbol}</span>
            <span className="break-words text-muted-foreground"> — {rec.name}</span>
          </h3>
          <div className="flex flex-wrap items-center gap-1.5">
            <SafetyGradeBadge grade={rec.safetyGrade} size="xs" />
          </div>
        </div>
      </div>

      <CardTrendStrips coinId={rec.id} symbol={rec.symbol} safetyGrade={rec.safetyGrade} isMobile={isMobile} />

      <div className="mt-3 space-y-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Evidence checked</p>
        <ul className="flex flex-wrap gap-1.5" aria-label="Profile-conditioned evidence">
          {chips.map((chip) => (
            <li key={`${chip.label}:${chip.value}`}>
              <span
                className={cn(
                  "inline-flex items-baseline gap-1 rounded-full border px-2 py-0.5 text-[11px]",
                  chip.tone === "watch"
                    ? "border-amber-500/40 bg-amber-500/[0.07] text-amber-800 dark:text-amber-200"
                    : "border-border/60 bg-background/55 text-foreground",
                )}
              >
                <span aria-hidden={chip.ariaLabel ? "true" : undefined} className="text-muted-foreground">
                  {chip.label}
                </span>
                <span aria-hidden={chip.ariaLabel ? "true" : undefined} className="pharos-numeric font-semibold">
                  {chip.value}
                </span>
                {chip.ariaLabel ? <span className="sr-only">{chip.ariaLabel}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <ScoreBreakdown components={rec.components} />

      <div className="mt-3 space-y-2 text-sm leading-relaxed text-foreground">
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Why it ranked here
          </p>
          {resolvedWhyText && resolvedWhyText.length > 0 ? (
            <p className="break-words">{resolvedWhyText}</p>
          ) : (
            <p className="break-words">
              This entry passed the selected profile filters and ranked highest under the current evidence weights.
              Review the score details before acting.
            </p>
          )}
        </div>
        <div className="space-y-1 text-muted-foreground">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">What to watch</p>
          {resolvedWatchText && resolvedWatchText.length > 0 ? (
            <p className="break-words">{resolvedWatchText}</p>
          ) : (
            <p>
              {readableLowestSubDimension(rec.lowestSubDimension.key)} scores{" "}
              <span className="pharos-numeric">{Math.round(rec.lowestSubDimension.score)}</span> under this profile.
            </p>
          )}
        </div>
      </div>

      {rec.profile === "yield" && rec.recommendedSource ? (
        <div className="mt-3 rounded-lg border border-border/50 bg-background/35 px-3 py-2 text-xs text-muted-foreground">
          <p className="flex flex-wrap items-baseline gap-1.5">
            <span className="font-semibold text-foreground">Yield rail:</span>
            <span className="break-words">
              {rec.recommendedSource.protocol} on {rec.recommendedSource.chain} at{" "}
              {rec.recommendedSource.apy30d.toFixed(1)}%
              {rec.recommendedSource.pharosYieldScore != null ? ` (PYS ${rec.recommendedSource.pharosYieldScore})` : ""}
            </span>
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-1.5">
            <ShieldAlert className="h-3 w-3" aria-hidden="true" />
            <span>
              Source risk: {rec.recommendedSource.sourceRiskTier}. Data freshness:{" "}
              {preciseStaleness(rec.recommendedSource.freshness.ageSeconds)} old.
            </span>
          </p>
          {yieldSourceUrl || yieldInspectionHref ? (
            <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              {yieldInspectionHref ? (
                <Link href={yieldInspectionHref} className="text-xs font-medium text-foreground">
                  Inspect on Yield Intelligence
                </Link>
              ) : null}
              {yieldSourceUrl ? (
                <TableSourceLink href={yieldSourceUrl} className="text-xs font-medium text-foreground">
                  Open yield source
                </TableSourceLink>
              ) : null}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 flex items-center justify-between gap-2 pt-1 text-sm">
        <Link
          href={detailHref}
          className={cn(
            "pharos-focus-ring inline-flex items-center gap-1.5",
            prominentOpenDetail
              ? "min-h-10 rounded-full border border-foreground/60 bg-foreground px-3.5 font-medium text-background hover:bg-foreground/90"
              : "rounded-sm font-medium text-foreground underline underline-offset-4 hover:text-foreground",
          )}
          aria-labelledby={`${headlineId} open-detail-label-${rec.id}`}
        >
          <span id={`open-detail-label-${rec.id}`}>Open detail</span>
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
        {rec.confidence != null && rec.confidence < 60 ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/[0.07] px-2 py-0.5 text-xs font-medium text-amber-800 dark:text-amber-200">
            <Clock className="h-3 w-3" aria-hidden="true" />
            Lower confidence — limited data
          </span>
        ) : rec.confidence != null && rec.confidence < 80 ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-border/55 bg-background/65 px-2 py-0.5 text-xs text-muted-foreground">
            Limited data
          </span>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Cohort-tinted sparklines (D13). Renders a 7d peg-deviation strip (signed,
 * baselined at the rec's most-recent price) and a 30d supply strip beneath
 * the identity row. Mobile gates to peg-deviation only to avoid crowding.
 */
function CardTrendStrips({
  coinId,
  symbol,
  safetyGrade,
  isMobile,
}: {
  coinId: string;
  symbol: string;
  safetyGrade: SelectorRecommendation["safetyGrade"];
  isMobile: boolean;
}) {
  const { data: history, isLoading } = useSupplyHistory(coinId, 30);
  const tint = GRADE_RADAR_COLORS[gradeRange(safetyGrade)] ?? GRADE_RADAR_COLORS.NR;

  const { pegSeries, supplySeries, pegBaseline } = useMemo(() => {
    if (!history || history.length === 0) {
      return { pegSeries: [], supplySeries: [], pegBaseline: null as number | null };
    }
    const sorted = [...history].sort((a, b) => a.date - b.date);
    const cutoff7d = sorted.length > 0 ? sorted[sorted.length - 1].date - 7 * 86_400 : 0;
    const recent7d = sorted.filter((p) => p.date >= cutoff7d);
    const recentSupply = sorted.slice(-30).map((p) => p.circulatingUsd);
    // Baseline = the most recent finite price; the strip renders price minus
    // baseline so the line diverges around a flat 0 reference.
    const finitePrices = recent7d.map((p) => p.price).filter((p): p is number => p != null && Number.isFinite(p));
    const baseline = finitePrices.length > 0 ? finitePrices[finitePrices.length - 1] : null;
    return {
      pegSeries: recent7d.map((p) => (p.price == null || !Number.isFinite(p.price) ? null : p.price)),
      supplySeries: recentSupply.map((s) => (Number.isFinite(s) ? s : null)),
      pegBaseline: baseline,
    };
  }, [history]);

  if (isLoading) {
    return (
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <div aria-hidden="true" className="h-4 w-full rounded bg-muted/15" />
        {!isMobile ? <div aria-hidden="true" className="h-4 w-full rounded bg-muted/15" /> : null}
      </div>
    );
  }

  const pegAvailable = pegSeries.filter((v) => v != null).length >= 2 && pegBaseline != null;
  const supplyAvailable = supplySeries.filter((v) => v != null).length >= 2;

  if (!pegAvailable && !supplyAvailable) return null;

  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      {pegAvailable ? (
        <div className="flex flex-col gap-0.5">
          <p className="text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground">7d peg</p>
          <RowSparkline
            data={pegSeries}
            signed
            referenceValue={pegBaseline ?? 1}
            positiveColor={tint}
            negativeColor={tint}
            ariaLabel={`${symbol} 7-day price trajectory relative to its current peg level`}
            srSummary="Cohort-tinted strip; colour reflects this asset's safety grade."
            className="w-full"
            height={16}
          />
        </div>
      ) : null}
      {!isMobile && supplyAvailable ? (
        <div className="flex flex-col gap-0.5">
          <p className="text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground">30d supply</p>
          <RowSparkline
            data={supplySeries}
            positiveColor={tint}
            ariaLabel={`${symbol} 30-day circulating supply trend`}
            srSummary="Cohort-tinted strip; colour reflects this asset's safety grade."
            className="w-full"
            height={16}
          />
        </div>
      ) : null}
    </div>
  );
}

function ScoreBreakdown({ components }: { components: readonly SelectorComponent[] }) {
  if (components.length === 0) return null;
  const sorted = [...components].sort((a, b) => b.contribution - a.contribution);
  return (
    <details className="mt-3 rounded-lg border border-border/50 bg-background/35 px-3 py-2 text-xs">
      <summary className="cursor-pointer font-medium text-foreground">Score breakdown</summary>
      <p className="mt-2 leading-relaxed text-muted-foreground">
        Weights shown are effective per-coin weights after missing-data redistribution.
      </p>
      <dl className="mt-2 grid gap-2">
        {sorted.map((component) => (
          <div
            key={component.key}
            className="grid gap-1 rounded-md border border-border/45 bg-card/45 px-2.5 py-2 sm:grid-cols-[minmax(9rem,1fr)_auto]"
          >
            <dt className="font-medium text-foreground">{readableComponentKey(component.key)}</dt>
            <dd className="flex flex-wrap gap-x-2 gap-y-1 text-muted-foreground sm:justify-end">
              <span>
                Weight <span className="pharos-numeric">{formatComponentNumber(component.weight)}</span>%
              </span>
              <span>
                Normalized{" "}
                <span className="pharos-numeric">{formatNullableComponentNumber(component.normalizedValue)}</span>
              </span>
              <span className="font-medium text-foreground">
                <span className="pharos-numeric">{formatContribution(component.contribution)}</span> pts
              </span>
              {component.rawValue == null || component.redistributed ? (
                <span className="rounded-full border border-border/50 bg-muted/15 px-1.5 text-muted-foreground">
                  {component.redistributed ? "Redistributed" : "Missing signal"}
                </span>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function formatNullableComponentNumber(value: number | null): string {
  return value == null ? "n/a" : formatComponentNumber(value);
}

function formatComponentNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatContribution(value: number): string {
  const formatted = formatComponentNumber(value);
  return value > 0 ? `+${formatted}` : formatted;
}

function readableComponentKey(key: string): string {
  return selectorComponentScoreLabel(key) ?? "Profile score input";
}

function readableLowestSubDimension(key: string): string {
  return selectorComponentLowestSubDimensionLabel(key) ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

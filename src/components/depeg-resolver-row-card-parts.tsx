"use client";

import Link from "next/link";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatBps, formatPrice, pegCurrencySymbol } from "@shared/lib/format";
import type { DdrFactor } from "@shared/types/depeg-resolver";
import {
  formatDurationSec,
  getCurrentDeviationBps,
  getDuration,
  getPeakDeviationBps,
  getPredictionState,
  getRelatedContext,
  getResolution,
  SEVERITY_LABEL,
  SEVERITY_WEIGHT,
  SUPPRESSED_REASON_LABELS,
  TIER_META,
  type DdrDisplayRow,
} from "@/components/depeg-resolver-row-card-model";
import { CoinLockup, LiveFacts, LockMetadataStrip, StageLabel } from "@/components/depeg-resolver-row-card-shared";
import { StateOnlyCard } from "@/components/depeg-resolver-row-card-state";
import { ForecastTimeline } from "@/components/depeg-resolver-row-card-timeline";

export interface DepegResolverRowCardProps {
  row: DdrDisplayRow;
  logos?: Record<string, string>;
}

function SeverityPips({ kind, weight }: { kind: "kill" | "anchor"; weight: number }) {
  const filled = kind === "kill" ? "bg-red-500" : "bg-emerald-500";
  const empty = kind === "kill" ? "bg-red-500/25" : "bg-emerald-500/25";
  return (
    <span className="mt-[3px] inline-flex shrink-0 gap-0.5" aria-hidden="true">
      <span className={cn("h-1.5 w-1.5 rounded-full", weight >= 1 ? filled : empty)} />
      <span className={cn("h-1.5 w-1.5 rounded-full", weight >= 2 ? filled : empty)} />
    </span>
  );
}

function FactorList({ kind, factors }: { kind: "kill" | "anchor"; factors: DdrFactor[] }) {
  const heading = kind === "kill" ? "Toward terminal" : "Toward repeg";
  const headTone = kind === "kill" ? "text-red-700 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400";

  return (
    <div className="min-w-0 space-y-1.5">
      <p className={cn("text-[10px] font-semibold uppercase tracking-[0.12em]", headTone)}>{heading}</p>
      {factors.length === 0 ? (
        <p className="text-xs italic text-muted-foreground/70">none fired</p>
      ) : (
        <ul className="space-y-1.5">
          {factors.map((factor) => (
            <li key={factor.code} className="flex items-start gap-2 text-xs">
              <SeverityPips kind={kind} weight={SEVERITY_WEIGHT[factor.severity]} />
              <span className="min-w-0 break-words leading-snug text-foreground/90">{factor.label}</span>
              <span className="ml-auto shrink-0 pl-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                {SEVERITY_LABEL[factor.severity]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SignalPull({ killWeight, anchorWeight }: { killWeight: number; anchorWeight: number }) {
  const max = Math.max(killWeight, anchorWeight, 1);
  const leftPct = (killWeight / max) * 100;
  const rightPct = (anchorWeight / max) * 100;
  const label = `Signal pull: kill signals weight ${killWeight}, recovery anchors weight ${anchorWeight}.`;

  return (
    <div className="flex items-center gap-1.5" role="img" aria-label={label}>
      <div className="flex flex-1 justify-end">
        <div
          className="h-2 rounded-full bg-red-500/70"
          style={{ width: `${leftPct}%`, minWidth: killWeight > 0 ? "0.5rem" : 0 }}
        />
      </div>
      <span className="h-3.5 w-px shrink-0 bg-border" aria-hidden="true" />
      <div className="flex flex-1 justify-start">
        <div
          className="h-2 rounded-full bg-emerald-500/70"
          style={{ width: `${rightPct}%`, minWidth: anchorWeight > 0 ? "0.5rem" : 0 }}
        />
      </div>
    </div>
  );
}

export function DepegResolverRowCard({ row, logos }: DepegResolverRowCardProps) {
  const predictionState = getPredictionState(row);
  if (predictionState && predictionState !== "frozen") {
    return <StateOnlyCard row={row} state={predictionState} logos={logos} />;
  }

  const resolution = getResolution(row);
  const duration = getDuration(row);
  const tier = resolution.tier;
  const meta = TIER_META[tier];
  const factors = resolution.factors;
  const kills = factors.filter((f) => f.kind === "kill");
  const anchors = factors.filter((f) => f.kind === "anchor");
  const killWeight = kills.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);
  const anchorWeight = anchors.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);

  const showTension = factors.length > 0 && tier !== "insufficient_signal";
  const chronic = duration.ageStatus === "chronic_tail";
  const dirGlyph = row.direction === "below" ? "▼" : "▲";
  const durationAnchorLabel = predictionState === "frozen" ? "from lock" : "~resolve";
  const currentDeviationBps = getCurrentDeviationBps(row);
  const priceLabel =
    currentDeviationBps != null
      ? formatPrice(1 + currentDeviationBps / 10_000, pegCurrencySymbol(row.pegCurrency))
      : null;

  return (
    <Card className="gap-0 overflow-hidden p-4 sm:p-5">
      <div className="space-y-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <CoinLockup row={row} logos={logos} />
            {priceLabel ? (
              <span className="shrink-0 font-mono text-sm font-semibold tabular-nums text-foreground">
                {priceLabel}
              </span>
            ) : null}
          </div>
          <span className="shrink-0 rounded-full border border-border/70 bg-background/60 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            {dirGlyph} {row.direction} {row.pegCurrency}
          </span>
        </div>

        <div className={cn("rounded-lg border px-3 py-2.5", meta.band)}>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[0.95rem] font-bold uppercase tracking-wide leading-none">{meta.label}</p>
            {predictionState === "frozen" ? (
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
                Prediction frozen
              </span>
            ) : null}
          </div>
          <p className="mt-1.5 text-xs leading-snug opacity-80">{meta.blurb}</p>
        </div>

        {predictionState === "frozen" ? <LockMetadataStrip row={row} showAnchoredDuration /> : null}

        <ForecastTimeline row={row} />

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs tabular-nums text-muted-foreground">
          <span>
            peak <span className="text-foreground">{formatBps(getPeakDeviationBps(row))}</span>
          </span>
          {currentDeviationBps != null ? (
            <span>
              {predictionState === "frozen" ? "live now" : "now"}{" "}
              <span className="text-foreground">{formatBps(currentDeviationBps)}</span>
            </span>
          ) : null}
          {duration.medianSec != null && !duration.suppressed && tier !== "recovery_unlikely" ? (
            <span>
              {durationAnchorLabel} <span className="text-foreground">{formatDurationSec(duration.medianSec)}</span>
              {duration.iqrSec ? (
                <span className="text-muted-foreground">
                  {" "}
                  ({formatDurationSec(duration.iqrSec[0])}–{formatDurationSec(duration.iqrSec[1])})
                </span>
              ) : null}
            </span>
          ) : null}
          {duration.stratum && !duration.suppressed && tier !== "recovery_unlikely" ? (
            <span className="truncate text-muted-foreground/80" title={duration.stratum}>
              {duration.stratum}
            </span>
          ) : null}
        </div>

        {chronic ? (
          <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
            Unusually prolonged — already past comparable incidents&apos; P99.
          </p>
        ) : null}

        {tier === "recovery_unlikely" ? (
          <div className="rounded-lg border border-red-500/25 bg-red-500/[0.06] px-3 py-2.5">
            <p className="text-sm font-medium text-foreground">DDR does not expect this depeg to recover.</p>
            <p className="mt-1 text-xs leading-snug text-muted-foreground">
              Comparable structural failures did not return to peg, so no duration estimate is shown.
            </p>
            <Link
              href="/cemetery"
              className="pharos-focus-ring mt-1.5 inline-block rounded-sm text-xs font-medium text-red-700 hover:underline dark:text-red-400"
            >
              See the Stablecoin Cemetery →
            </Link>
          </div>
        ) : tier === "insufficient_signal" ? (
          <div className="space-y-1.5">
            <StageLabel>Why no verdict</StageLabel>
            {resolution.insufficientReasons?.length ? (
              <ul className="space-y-1 text-xs text-muted-foreground">
                {resolution.insufficientReasons.map((reason) => (
                  <li key={reason} className="flex gap-2">
                    <span aria-hidden="true" className="text-muted-foreground/50">
                      —
                    </span>
                    <span className="min-w-0">{reason}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">Key inputs are missing for this event.</p>
            )}
          </div>
        ) : duration.suppressed && duration.suppressedReason ? (
          <p className="text-xs leading-snug text-muted-foreground">
            {SUPPRESSED_REASON_LABELS[duration.suppressedReason] ?? "Duration estimate is not available."}
          </p>
        ) : null}

        {predictionState === "frozen" ? <LiveFacts row={row} /> : null}

        {showTension ? (
          <div className="space-y-2.5 border-t border-border/50 pt-3">
            <div className="flex items-center justify-between gap-2">
              <StageLabel>Will it recover?</StageLabel>
              <span className="font-mono text-[10px] text-muted-foreground">
                {kills.length} kill · {anchors.length} anchor
              </span>
            </div>
            <SignalPull killWeight={killWeight} anchorWeight={anchorWeight} />
            <div className="grid grid-cols-1 gap-x-5 gap-y-3 sm:grid-cols-2">
              <FactorList kind="kill" factors={kills} />
              <FactorList kind="anchor" factors={anchors} />
            </div>
          </div>
        ) : null}

        <RelatedContextDetails row={row} />
      </div>
    </Card>
  );
}

function RelatedContextDetails({ row }: { row: DdrDisplayRow }) {
  const c = getRelatedContext(row);
  const items: Array<{ label: string; value: string }> = [];
  if (c.dewsBand) {
    items.push({
      label: "DEWS",
      value: c.dewsScore != null ? `${c.dewsBand} · ${Math.round(c.dewsScore)}` : c.dewsBand,
    });
  }
  if (c.liquidityScore != null) {
    items.push({ label: "Liquidity", value: `${Math.round(c.liquidityScore)}` });
  }
  if (c.safetyGrade) {
    items.push({
      label: "Safety",
      value: c.safetyScore != null ? `${c.safetyGrade} · ${Math.round(c.safetyScore)}` : c.safetyGrade,
    });
  }
  if (c.supplyChange7dPct != null) {
    items.push({
      label: "Supply 7d",
      value: `${c.supplyChange7dPct > 0 ? "+" : ""}${c.supplyChange7dPct.toFixed(1)}%`,
    });
  }
  if (c.mintSurge != null) {
    items.push({ label: "Mint surge", value: c.mintSurge ? "yes" : "no" });
  }

  if (items.length === 0) return null;

  return (
    <details className="group border-t border-border/50 pt-2.5">
      <summary className="pharos-focus-ring inline-flex min-h-11 cursor-pointer list-none items-center rounded-md text-xs text-muted-foreground hover:text-foreground sm:min-h-0">
        Related context
        <span aria-hidden="true" className="ml-1 inline-block transition-transform group-open:rotate-90">
          ›
        </span>
      </summary>
      <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
        {items.map((item) => (
          <div key={item.label} className="flex items-center gap-1.5">
            <dt className="text-muted-foreground">{item.label}</dt>
            <dd className="font-mono tabular-nums text-foreground">{item.value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

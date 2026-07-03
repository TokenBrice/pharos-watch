"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { formatPrice, pegCurrencySymbol } from "@shared/lib/format";
import type { DdrFactor } from "@shared/types/depeg-resolver";
import {
  formatDurationSec,
  getDuration,
  getLiveCurrentDeviationBps,
  getPredictionState,
  getRelatedContext,
  getResolution,
  NOW_DOT_TONE,
  SEVERITY_LABEL,
  SEVERITY_WEIGHT,
  SUPPRESSED_REASON_LABELS,
  TIER_META,
  type DdrDisplayRow,
} from "@/components/depeg-resolver-row-card-model";
import { CoinLockup, LiveFacts, LockMetadataStrip, StageLabel } from "@/components/depeg-resolver-row-card-shared";
import { MethodologyHint } from "@/components/methodology-hint";
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

const DISCLOSURE_SUMMARY =
  "pharos-focus-ring -mx-1 flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md px-1 text-muted-foreground hover:text-foreground sm:min-h-0 sm:py-1";

function DisclosureChevron() {
  return (
    <span aria-hidden="true" className="ml-auto inline-block text-muted-foreground/60 transition-transform group-open:rotate-90">
      ›
    </span>
  );
}

export function DepegResolverRowCard({ row, logos }: DepegResolverRowCardProps) {
  const predictionState = getPredictionState(row);
  if (predictionState && predictionState !== "frozen") {
    return <StateOnlyCard row={row} state={predictionState} logos={logos} />;
  }

  const frozen = predictionState === "frozen";
  const resolution = getResolution(row);
  const duration = getDuration(row);
  const tier = resolution.tier;
  const meta = TIER_META[tier];
  const factors = resolution.factors;
  const kills = factors.filter((f) => f.kind === "kill");
  const anchors = factors.filter((f) => f.kind === "anchor");
  const killWeight = kills.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);
  const anchorWeight = anchors.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);

  const terminal = tier === "recovery_unlikely";
  const insufficient = tier === "insufficient_signal";
  const showTension = factors.length > 0 && !insufficient;
  const chronic = duration.ageStatus === "chronic_tail";
  const dirGlyph = row.direction === "below" ? "▼" : "▲";
  const currentDeviationBps = getLiveCurrentDeviationBps(row);
  const priceLabel =
    currentDeviationBps != null
      ? formatPrice(1 + currentDeviationBps / 10_000, pegCurrencySymbol(row.pegCurrency))
      : null;

  const showBand = !duration.suppressed && !terminal && !insufficient && (Boolean(duration.iqrSec) || Boolean(duration.stratum));

  return (
    <div className="pharos-card-shell @container/ddr gap-0 overflow-hidden p-4 sm:p-5">
      <div className="space-y-3">
        {/* Identity + verdict + direction — one inline row, direction aligned right */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <CoinLockup row={row} logos={logos} logoSize={52} />
          {priceLabel ? (
            <span className="pharos-numeric shrink-0 text-sm font-semibold text-foreground">{priceLabel}</span>
          ) : null}
          <span className="inline-flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn("h-2 w-2 shrink-0 rounded-full", NOW_DOT_TONE[tier])} aria-hidden="true" />
            <span className={cn("text-sm font-bold uppercase tracking-wide leading-none", meta.accent)}>{meta.label}</span>
            {frozen ? (
              /* The chip itself opens the contextual-methodology popover —
                 "frozen" reads as "stale/broken" without an explainer. */
              <MethodologyHint topic="ddrPredictionFrozen" asChild>
                <button
                  type="button"
                  className="pharos-focus-ring inline-flex min-h-6 items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-emerald-700 underline decoration-dotted decoration-emerald-700/50 underline-offset-2 transition-colors hover:bg-emerald-500/20 dark:text-emerald-400 dark:decoration-emerald-400/50"
                >
                  Prediction frozen
                </button>
              </MethodologyHint>
            ) : null}
          </span>
          <span className="ml-auto shrink-0 rounded-full border border-border/70 bg-background/60 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            {dirGlyph} {row.direction} {row.pegCurrency}
          </span>
        </div>

        {/* Hero: the drawn forecast */}
        <ForecastTimeline row={row} />

        {/* Prediction facts (band + comparison stratum) — quiet caption under the hero */}
        {showBand ? (
          <p className="pharos-numeric flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            {duration.iqrSec ? (
              <span>
                band{" "}
                <span className="text-foreground/80">
                  {formatDurationSec(duration.iqrSec[0])}–{formatDurationSec(duration.iqrSec[1])}
                </span>
              </span>
            ) : null}
            {duration.iqrSec && duration.stratum ? (
              <span className="text-muted-foreground/40" aria-hidden="true">
                ·
              </span>
            ) : null}
            {duration.stratum ? <span className="text-muted-foreground/80">{duration.stratum}</span> : null}
          </p>
        ) : null}

        {chronic ? (
          <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
            Unusually prolonged — already past comparable incidents&apos; P99.
          </p>
        ) : null}

        {/* Suppressed-duration reasons (terminal / insufficient / no-support) */}
        {terminal ? (
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
        ) : insufficient ? (
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

        {/* Causes — collapsed by default, at-a-glance pull stays in the summary */}
        {showTension ? (
          <details className="group border-t border-border/50 pt-3">
            <summary className={DISCLOSURE_SUMMARY}>
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground group-hover:text-foreground">
                Will it recover?
              </span>
              <span className="pharos-numeric text-[10px] text-muted-foreground/80">
                {kills.length} kill · {anchors.length} anchor
              </span>
              <span className="ml-auto hidden w-24 shrink-0 sm:block">
                <SignalPull killWeight={killWeight} anchorWeight={anchorWeight} />
              </span>
              <DisclosureChevron />
            </summary>
            <div className="mt-3 space-y-3">
              <div className="sm:hidden">
                <SignalPull killWeight={killWeight} anchorWeight={anchorWeight} />
              </div>
              <div className="grid grid-cols-1 gap-x-5 gap-y-3 @[26rem]/ddr:grid-cols-2">
                <FactorList kind="kill" factors={kills} />
                <FactorList kind="anchor" factors={anchors} />
              </div>
            </div>
          </details>
        ) : null}

        <PredictionDetails row={row} frozen={frozen} />

        {/* Footer: live reality, kept distinct from the frozen forecast above */}
        <div className="-mx-4 -mb-4 border-t border-border/50 bg-muted/25 px-4 py-2.5 sm:-mx-5 sm:-mb-5 sm:px-5">
          <LiveFacts row={row} />
        </div>
      </div>
    </div>
  );
}

function PredictionDetails({ row, frozen }: { row: DdrDisplayRow; frozen: boolean }) {
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

  if (!frozen && items.length === 0) return null;

  return (
    <details className="group border-t border-border/50 pt-2.5">
      <summary className={DISCLOSURE_SUMMARY}>
        <span className="text-xs">{frozen ? "Prediction details" : "Related context"}</span>
        <DisclosureChevron />
      </summary>
      <div className="mt-2.5 space-y-2.5">
        {frozen ? <LockMetadataStrip row={row} showAnchoredDuration /> : null}
        {items.length ? (
          <dl className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
            {items.map((item) => (
              <div key={item.label} className="flex items-center gap-1.5">
                <dt className="text-muted-foreground">{item.label}</dt>
                <dd className="pharos-numeric text-foreground">{item.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </details>
  );
}

interface StablecoinDepegResolverRowsProps {
  stablecoinId: string;
  data:
    | {
        _meta?: {
          degraded: boolean;
          degradedReason?: string | null;
        };
        rows: DdrDisplayRow[];
      }
    | undefined;
  logoSrc?: string;
}

export function StablecoinDepegResolverRows({ stablecoinId, data, logoSrc }: StablecoinDepegResolverRowsProps) {
  const rows = data?.rows.filter((row) => row.stablecoinId === stablecoinId) ?? [];
  const degraded = data?._meta?.degraded === true;
  const showStaleRows = degraded && data?._meta?.degradedReason === "stale-cache" && rows.length > 0;

  if (!data || (degraded && !showStaleRows) || rows.length === 0) {
    return null;
  }

  const logos = logoSrc ? { [stablecoinId]: logoSrc } : undefined;

  return (
    <section aria-label={`Depeg Duration Resolver for ${rows[0]?.symbol ?? stablecoinId}`} className="space-y-4">
      {showStaleRows ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          Resolver snapshot is stale; duration estimates are suppressed until the next refresh.
        </p>
      ) : null}
      <div className="space-y-4">
        {rows.map((row) => (
          <DepegResolverRowCard key={`${row.stablecoinId}:${row.eventId}`} row={row} logos={logos} />
        ))}
      </div>
    </section>
  );
}

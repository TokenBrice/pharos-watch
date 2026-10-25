"use client";

import Link from "next/link";
import { LockKeyhole } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import type { DdrDuration, DdrFactor, DdrV2ResponseRow } from "@shared/types/depeg-resolver";
import {
  formatCoarseDurationSec,
  formatDdrDirection,
  formatDurationSec,
  formatUnresolvedShare,
  getDuration,
  getLiveCurrentDeviationBps,
  getPredictionState,
  getRelatedContext,
  getResolution,
  getTierMeta,
  getTierVocabulary,
  isCumulativeIncidence,
  NOT_INFORMATIVE_CELL_LABEL,
  NOW_DOT_TONE,
  SEVERITY_LABEL,
  SEVERITY_WEIGHT,
  SUPPRESSED_REASON_LABELS,
} from "@/components/depeg-resolver-row-card-model";
import { CoinLockup, LiveFacts, LockMetadataStrip, StageLabel } from "@/components/depeg-resolver-row-card-shared";
import { MethodologyHint } from "@/components/methodology-hint";
import { StateOnlyCard } from "@/components/depeg-resolver-row-card-state";
import { ForecastTimeline } from "@/components/depeg-resolver-row-card-timeline";
import { DDR_KILL_SAVE_CLASSES } from "@shared/lib/classification";

export interface DepegResolverRowCardProps {
  row: DdrV2ResponseRow;
  logos?: Record<string, string>;
}

function SeverityPips({ kind, weight }: { kind: "kill" | "anchor"; weight: number }) {
  const { filled, empty } = DDR_KILL_SAVE_CLASSES[kind === "kill" ? "kill" : "save"];
  return (
    <span className="mt-1 inline-flex shrink-0 gap-0.5" aria-hidden="true">
      <span className={cn("h-1.5 w-1.5 rounded-full", weight >= 1 ? filled : empty)} />
      <span className={cn("h-1.5 w-1.5 rounded-full", weight >= 2 ? filled : empty)} />
    </span>
  );
}

function FactorList({ kind, factors }: { kind: "kill" | "anchor"; factors: DdrFactor[] }) {
  const heading = kind === "kill" ? "Toward terminal" : "Toward repeg";
  const headTone = DDR_KILL_SAVE_CLASSES[kind === "kill" ? "kill" : "save"].head;

  return (
    <div className="min-w-0 space-y-1.5">
      <p className={cn("pharos-label", headTone)}>{heading}</p>
      {factors.length === 0 ? (
        <p className="text-xs italic text-muted-foreground">none fired</p>
      ) : (
        <ul className="space-y-1.5">
          {factors.map((factor) => (
            <li key={factor.code} className="flex items-start gap-2 text-xs">
              <SeverityPips kind={kind} weight={SEVERITY_WEIGHT[factor.severity]} />
              <span className="min-w-0 break-words leading-snug text-foreground/90">{factor.label}</span>
              <span className="pharos-meta ml-auto shrink-0 pl-1">
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
          className={cn("h-2 rounded-full", DDR_KILL_SAVE_CLASSES.kill.bar)}
          style={{ width: `${leftPct}%`, minWidth: killWeight > 0 ? "0.5rem" : 0 }}
        />
      </div>
      <span className="h-3.5 w-px shrink-0 bg-border" aria-hidden="true" />
      <div className="flex flex-1 justify-start">
        <div
          className={cn("h-2 rounded-full", DDR_KILL_SAVE_CLASSES.save.bar)}
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
  if (predictionState !== "frozen") {
    return <StateOnlyCard row={row} state={predictionState} logos={logos} />;
  }

  const frozen = predictionState === "frozen";
  const resolution = getResolution(row);
  const duration = getDuration(row);
  const tier = resolution.tier;
  const vocabulary = getTierVocabulary(row);
  const meta = getTierMeta(tier, vocabulary);
  const factors = resolution.factors;
  const kills = factors.filter((f) => f.kind === "kill");
  const anchors = factors.filter((f) => f.kind === "anchor");
  const killWeight = kills.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);
  const anchorWeight = anchors.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);

  const terminal = tier === "recovery_unlikely";
  const insufficient = tier === "insufficient_signal";
  const showTension = factors.length > 0 && !insufficient;
  const chronic = duration.ageStatus === "chronic_tail";
  const currentDeviationBps = getLiveCurrentDeviationBps(row);
  const pegRatioLabel =
    currentDeviationBps != null
      ? `${((1 + currentDeviationBps / 10_000) * 100).toFixed(2)}% of peg`
      : null;

  const cumulative = isCumulativeIncidence(duration);
  const unresolvedShare = cumulative ? (duration.unresolvedShare30d ?? null) : null;
  const showBand =
    !duration.suppressed &&
    !terminal &&
    !insufficient &&
    (Boolean(duration.iqrSec) ||
      Boolean(duration.stratum) ||
      (cumulative &&
        (duration.medianSec != null ||
          unresolvedShare != null ||
          duration.horizons.some((cell) => cell.state === "not_informative"))));
  // Evidence classes lead with the base rate; terminal and no-verdict cards carry their own copy below.
  const showClassBlurb = vocabulary === "evidence_class" && !terminal && !insufficient;

  return (
    <div className="pharos-card-shell @container/ddr gap-0 overflow-hidden p-4 sm:p-5">
      <div className="space-y-3">
        {/* Identity + direction share a row; verdict facts sit on a second row so
            the direction chip never wraps differently between sibling cards. */}
        <div className="flex items-center justify-between gap-x-3">
          <CoinLockup row={row} logos={logos} logoSize={52} />
          <span className="shrink-0 whitespace-nowrap rounded-full border border-border/70 bg-background/60 px-2 py-0.5 text-xs text-muted-foreground">
            {formatDdrDirection(row)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {pegRatioLabel ? (
            <span className="pharos-numeric shrink-0 text-sm font-semibold text-foreground">{pegRatioLabel}</span>
          ) : null}
          <span className="inline-flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn("h-2 w-2 shrink-0 rounded-full", NOW_DOT_TONE[tier])} aria-hidden="true" />
            <span className={cn("text-sm font-bold leading-none", meta.accent)}>{meta.label}</span>
            {frozen ? (
              /* The chip itself opens the contextual-methodology popover —
                 "frozen" reads as "stale/broken" without an explainer. */
              <MethodologyHint topic="ddrPredictionFrozen" asChild>
                <button
                  type="button"
                  className="pharos-focus-ring inline-flex min-h-6 items-center gap-1 rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground underline decoration-dotted decoration-muted-foreground/60 underline-offset-2 transition-colors hover:bg-muted/70 hover:text-foreground"
                >
                  <LockKeyhole className="h-3 w-3 shrink-0" aria-hidden="true" />
                  Prediction frozen
                </button>
              </MethodologyHint>
            ) : null}
          </span>
        </div>

        {showClassBlurb ? <p className="text-xs leading-snug text-muted-foreground">{meta.blurb}</p> : null}

        {/* Hero: the drawn forecast */}
        <ForecastTimeline row={row} />

        {/* Prediction facts (band + comparison stratum) — quiet caption under the hero */}
        {showBand && cumulative ? (
          <CumulativeDurationFacts duration={duration} unresolvedShare={unresolvedShare} />
        ) : showBand ? (
          <p className="pharos-meta flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {duration.iqrSec ? (
              <span>
                Typical range{" "}
                <span className="pharos-numeric text-foreground/80">
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
          <p className="text-xs font-medium text-state-warn">
            Unusually prolonged — already past comparable incidents&apos; P99.
          </p>
        ) : null}

        {/* Suppressed-duration reasons (terminal / insufficient / no-support) */}
        {terminal ? (
          <div className="rounded-lg border border-state-danger-solid/25 bg-state-danger-solid/[0.06] px-3 py-2.5">
            {vocabulary === "evidence_class" ? (
              <>
                <p className="text-sm font-medium text-foreground">Terminal evidence fired for this break.</p>
                <p className="mt-1 text-xs leading-snug text-muted-foreground">
                  {meta.blurb} No duration estimate is shown.
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-foreground">DDR does not expect this depeg to recover.</p>
                <p className="mt-1 text-xs leading-snug text-muted-foreground">
                  Comparable structural failures did not return to peg, so no duration estimate is shown.
                </p>
              </>
            )}
            <Link
              href="/cemetery"
              className="pharos-focus-ring mt-1.5 inline-block rounded-sm text-xs font-medium text-state-danger hover:underline"
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
              <span className="pharos-label group-hover:text-foreground">
                Will it recover?
              </span>
              <span className="pharos-meta">
                <span className="pharos-numeric">{kills.length}</span> kill {kills.length === 1 ? "signal" : "signals"} ·{" "}
                <span className="pharos-numeric">{anchors.length}</span> {anchors.length === 1 ? "anchor" : "anchors"}
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

/**
 * DDRv5 duration caption: the horizon odds above lead, so the quantiles here are
 * secondary and coarse. A quantile the recovery curve never reached stays absent.
 */
function CumulativeDurationFacts({
  duration,
  unresolvedShare,
}: {
  duration: DdrDuration;
  unresolvedShare: number | null;
}) {
  const parts: ReactNode[] = [];
  const notInformative = duration.horizons
    .filter((cell) => cell.state === "not_informative")
    .map((cell) => cell.horizon);
  if (notInformative.length) {
    parts.push(
      <span key="not-informative">
        {notInformative.join(" · ")} odds: {NOT_INFORMATIVE_CELL_LABEL}
      </span>,
    );
  }
  if (duration.medianSec != null) {
    parts.push(
      <span key="median">
        Half of comparable incidents recovered within{" "}
        <span className="pharos-numeric text-foreground/80">~{formatCoarseDurationSec(duration.medianSec)}</span>
      </span>,
    );
  }
  if (duration.iqrSec) {
    parts.push(
      <span key="range">
        typical range{" "}
        <span className="pharos-numeric text-foreground/80">
          {formatCoarseDurationSec(duration.iqrSec[0])}–{formatCoarseDurationSec(duration.iqrSec[1])}
        </span>
      </span>,
    );
  }
  if (unresolvedShare != null) {
    parts.push(
      <span key="unresolved">
        <span className="pharos-numeric text-foreground/80">{formatUnresolvedShare(unresolvedShare)}</span> may not
        resolve within 30 days
      </span>,
    );
  }
  if (duration.stratum) {
    parts.push(
      <span key="stratum" className="text-muted-foreground/80">
        {duration.stratum}
      </span>,
    );
  }
  return (
    <p className="pharos-meta flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      {parts.flatMap((part, index) =>
        index === 0
          ? [part]
          : [
              <span key={`sep-${index}`} className="text-muted-foreground/40" aria-hidden="true">
                ·
              </span>,
              part,
            ],
      )}
    </p>
  );
}

function PredictionDetails({ row, frozen }: { row: DdrV2ResponseRow; frozen: boolean }) {
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
        rows: DdrV2ResponseRow[];
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
        <p className="rounded-lg border border-state-warn bg-state-warn-subtle px-3 py-2 text-xs text-state-warn-strong">
          Resolver live overlay is stale; frozen forecasts, including anchored duration estimates, remain unchanged.
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

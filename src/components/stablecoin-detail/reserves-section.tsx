"use client";

import { useMemo, type ReactNode } from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import {
  formatReserveRiskTier,
  formatReserveSharePct,
  isWholeReserveShare,
  ReserveRiskSwatch,
} from "@/components/reserves/reserve-risk-swatch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { EvidenceFooter, FooterStamp, type EvidenceFooterSource } from "@/components/stablecoin-detail/evidence-footer";
import { EvidenceModule, type EvidenceModuleVariant } from "@/components/stablecoin-detail/evidence-module";
import { FactGrid, type FactGridItem } from "@/components/stablecoin-detail/fact-grid";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import {
  buildReserveCompositionNote,
  buildReserveFeedStatus,
  buildReserveFootnoteModel,
  buildReserveSourceChip,
  compactReserveStamp,
  liveCompositionDiffers,
  compositionSlices,
  lookThroughCompositionSlices,
  reserveSliceLabel,
  reviewedCompositionSlices,
  splitReserveCompositionRows,
  type ReserveCompositionSlice,
  type ReserveFeedStatusModel,
} from "@/components/stablecoin-detail/reserve-presentation";
import { SECTION_SCROLL_MT } from "@/components/stablecoin-detail/section-title-class";
import { deriveVerdictLine } from "@/components/stablecoin-detail/verdict-line";
import { revealAnchorId } from "@/lib/anchor-reveal";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import {
  formatReserveQualityPct,
  LIQUID_WITHIN_ONE_DAY_WATCH_BELOW_PCT,
  type ReserveQualityClientSummary,
  type ReserveQualityLadderClientRow,
} from "@/lib/stablecoin-detail-reserve-quality-client";
import type { ReserveLookThroughClientSummary } from "@/lib/stablecoin-detail-reserve-look-through-client";
import { cn } from "@/lib/utils";
import { RESERVE_RISK_PRESENTATION } from "@shared/lib/classification/reserve-risk";
import type { ReserveResult } from "@shared/lib/reserve-templates";

import { findSummaryBudgetViolations } from "@shared/lib/summary-budget";
import { buildStablecoinUrl } from "@shared/lib/urls";
import type { ReserveLiquidityHorizon } from "@shared/types/reserves";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";

export interface ReservesSectionProps {
  coin: StablecoinMeta;
  reserves: ReserveResult | null;
  reserveFetchError: unknown | null;
  onRetry?: () => Promise<unknown> | void;
  isFetching?: boolean;
  isLoading?: boolean;
  qualitySummary?: ReserveQualityClientSummary | null;
  /**
   * The wrapped parent's reviewed slices, drawn in place of a wrapper's single
   * reviewed slice. Used only when the reviewed basis is exactly one slice.
   */
  lookThrough?: ReserveLookThroughClientSummary | null;
  /** Layout chosen by the page: `module` (default) or `tile` beside the Safety Score. */
  variant?: EvidenceModuleVariant;
  stripForm?: boolean;
  /**
   * Set when the published Safety Score admitted no reserve composition
   * (`describeReserveScoreAdmission`): why the reviewed slices are not its basis.
   */
  scoreAdmissionNote?: string | null;
}

const FEED_STATUS_ANCHOR_ID = "reserve-feed-status";
const AMBER_VALUE_CLASS = "text-state-warn";
const CHIP_CLASS = "text-2xs font-medium";
const SLICE_LINE_CLASS = "text-xs leading-relaxed text-muted-foreground";

/**
 * The ladder is a composition of the basket by exit horizon, not a risk level:
 * the same-day-or-next-day horizons the "Liquid ≤ 1 day" fact adds up are blue,
 * every slower horizon (and the undisclosed share) is neutral. No red: a T-bill
 * that settles in eight days is not an alarm.
 */
const LADDER_BAR_CLASS: Record<ReserveLiquidityHorizon, string> = {
  immediate: SEVERITY_TONE_CLASS.info.bar,
  "one-day": SEVERITY_TONE_CLASS.info.bar,
  "seven-days": SEVERITY_TONE_CLASS.neutral.bar,
  "over-seven-days": SEVERITY_TONE_CLASS.neutral.bar,
  unknown: SEVERITY_TONE_CLASS.neutral.bar,
};

function LadderRow({ row }: { row: ReserveQualityLadderClientRow }) {
  return (
    <li className="flex items-center gap-3">
      <span className="pharos-label w-20 shrink-0 leading-tight">
        {row.label}
      </span>
      {/* `minWidth` keeps a fractional share (0.1%) visible instead of collapsing to an empty track. */}
      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div
          className={cn("h-full rounded-full", LADDER_BAR_CLASS[row.key])}
          style={{ width: `${Math.max(0, Math.min(100, row.pct))}%`, minWidth: "3px" }}
        />
      </div>
      <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-foreground">
        {formatReserveQualityPct(row.pct)}
      </span>
    </li>
  );
}

/** A chip that explains itself on hover/focus; tap-only readers get the same sentence in the merged sources fold. */
function ExplainedChip({ label, tooltip, className }: { label: string; tooltip: string | null; className: string }) {
  if (!tooltip) {
    return <Badge variant="outline" className={className}>{label}</Badge>;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="pharos-focus-ring rounded-full">
          <Badge variant="outline" className={className}>{label}</Badge>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs text-left">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/** Ops state as a header chip; activating it opens the Feed status disclosure that holds the detail. */
function FeedStatusChip({ status }: { status: ReserveFeedStatusModel }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => {
            revealAnchorId(FEED_STATUS_ANCHOR_ID)?.scrollIntoView({ block: "nearest" });
          }}
          className="pharos-focus-ring max-w-full rounded-full text-left"
        >
          <Badge
            variant="outline"
            className={cn(CHIP_CLASS, "max-w-full whitespace-normal", SEVERITY_TONE_CLASS[status.tone].pill)}
          >
            {status.label}
          </Badge>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs text-left">
        {status.summary} Reason: {status.reason}.
      </TooltipContent>
    </Tooltip>
  );
}

function RetryButton({ onRetry, isFetching }: { onRetry: () => Promise<unknown> | void; isFetching: boolean }) {
  return (
    <button
      type="button"
      onClick={() => { void onRetry(); }}
      disabled={isFetching}
      aria-busy={isFetching || undefined}
      className="pharos-focus-ring inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-70"
    >
      <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} aria-hidden="true" />
      {isFetching ? "Retrying" : "Retry"}
    </button>
  );
}

/**
 * The whole-basket figures the verdict does not already state, in reading
 * order: how fast the basket exits, then how much of it the review left
 * unresolved. The verdict is the reserve lede, whose first sentence always
 * states the one-day convertibility and whose full text adds any unresolved
 * exposure, so a fact never repeats it. Its largest position is the list's
 * first row and its date is the footer's, so neither is a fact; a figure the
 * issuer does not publish is left out, never "Not published".
 */
function buildFacts(
  summary: ReserveQualityClientSummary | null,
  { verdictStatesLiquidity, verdictStatesExposure }: { verdictStatesLiquidity: boolean; verdictStatesExposure: boolean },
): FactGridItem[] {
  const facts: FactGridItem[] = [];

  if (summary?.liquidWithinOneDayPct != null && summary.unknownHorizonPct != null) {
    const { liquidWithinOneDayPct: liquid, unknownHorizonPct: unknown } = summary;
    // Amber only on a breach no undisclosed slice could cure: below the
    // watch line even if every slice with no published exit timeline converted
    // within the day. A disclosure gap alone is the "Opaque exit" chip's job.
    const isBreach = liquid < LIQUID_WITHIN_ONE_DAY_WATCH_BELOW_PCT
      && liquid + unknown < LIQUID_WITHIN_ONE_DAY_WATCH_BELOW_PCT;
    if (!verdictStatesLiquidity && unknown < 100) {
      facts.push({
        key: "liquid-one-day",
        label: "Liquid ≤ 1 day",
        value: `${unknown > 0 ? "≥ " : ""}${formatReserveQualityPct(liquid)}`,
        ...(isBreach ? { valueClassName: AMBER_VALUE_CLASS } : {}),
        title: unknown > 0
          ? `${formatReserveQualityPct(unknown)} of the basket has no published exit timeline`
          : "Share of the basket convertible to cash within one day",
      });
    }

    if (!verdictStatesExposure && summary.unidentifiedObligorsPct != null) {
      facts.push({
        key: "unresolved-exposure",
        label: "Unresolved exposure",
        value: formatReserveQualityPct(summary.unidentifiedObligorsPct),
        ...(summary.unidentifiedObligorsPct > 0 ? { valueClassName: AMBER_VALUE_CLASS } : {}),
        title: "Share of reserve dispositions the review left unresolved; it does not measure individually identified obligors",
      });
    }
  }

  return facts;
}

/**
 * Source labels can carry reviewer page notes after the first ";", a
 * parenthetical and an "as of …" clause: only the report name belongs in the
 * summary layer, beside the date it already shows; the full label stays in the title.
 */
function reportName(label: string): string {
  const name = label.split(";")[0]!.trim();
  return name.replace(/\s*\(.*$/, "").replace(/\s+as of\s.*$/i, "").trim() || name;
}

/** Slice data only: reviewer narrative folds with the sources, confidence sits in the chip row. */
function SliceDetail({ summary }: { summary: ReserveQualityClientSummary }) {
  const slices = [...summary.slices].sort((a, b) => b.pct - a.pct);
  return (
    <ModuleDisclosure label="Slice detail & risk factors">
      <div className="mt-3 space-y-3">
        {summary.unidentifiedObligorsPct != null ? (
          <p className={SLICE_LINE_CLASS}>
            {`Unresolved exposure: ${formatReserveQualityPct(summary.unidentifiedObligorsPct)} of reserve dispositions the review left unresolved.`}
          </p>
        ) : null}
        {summary.selfExposurePct != null ? (
          <p className={SLICE_LINE_CLASS}>
            {`Issuer self-exposure: ${formatReserveQualityPct(summary.selfExposurePct)} of the basket is the issuer's own assets rather than independent collateral.`}
          </p>
        ) : null}
        <ul aria-label="Reserve slices" className="space-y-2.5">
          {slices.map((slice) => {
            const label = reserveSliceLabel(slice.name, slice.obligor);
            return (
              <li key={slice.key} className="space-y-0.5">
                <p className={SLICE_LINE_CLASS}>
                  <span className="font-medium text-foreground">{label}</span>
                  {` · ${formatReserveQualityPct(slice.pct)}`}
                  {slice.assetClassLabel ? ` · ${slice.assetClassLabel}` : ""}
                  {slice.horizonLabel ? ` · ${slice.horizonLabel}` : ""}
                  {` · ${slice.riskLabel} risk`}
                </p>
                {slice.obligor && slice.obligor !== label ? (
                  <p className={SLICE_LINE_CLASS}>{`Obligor: ${slice.obligor}`}</p>
                ) : null}
                {slice.riskFactorLabels.length > 0 ? (
                  <p className={SLICE_LINE_CLASS}>{`Risk factors: ${slice.riskFactorLabels.join(" · ")}`}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </ModuleDisclosure>
  );
}

/**
 * A listed share at a fixed one decimal so the column aligns; positive dust
 * stays "<0.1%", a near-whole share never rounds up to the whole, and a whole
 * basket that float sums leave a few ULPs short still reads 100%.
 */
function formatListedSharePct(pct: number): string {
  if (isWholeReserveShare(pct)) return "100%";
  if (pct > 0 && pct < 0.1) return "<0.1%";
  return pct.toFixed(1) === "100.0" ? ">99.9%" : `${pct.toFixed(1)}%`;
}

function CompositionRow({
  swatch, name, context, pct, title, concentrated = false,
}: { swatch: ReactNode; name: string; context: string; pct: number; title?: string; concentrated?: boolean }) {
  return (
    <li className="flex items-start gap-2.5 py-2" title={title}>
      <span className="flex h-5 shrink-0 items-center">{swatch}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm leading-5 text-foreground">{name}</span>
        <span className="block text-xs leading-4 text-muted-foreground">{context}</span>
      </span>
      <span className={cn("pharos-numeric shrink-0 text-sm leading-5", concentrated ? AMBER_VALUE_CLASS : "text-foreground")}>
        {formatListedSharePct(pct)}
        {concentrated ? <span className="sr-only"> (concentration finding)</span> : null}
      </span>
    </li>
  );
}

/**
 * The risk tier is spelled out on every row, so the swatch is never the only
 * channel. Obligor prose stays a hover title, as on the old tiles; the slice
 * detail fold carries it in full.
 */
function SliceRow({ slice, concentrated }: { slice: ReserveCompositionSlice; concentrated?: boolean }) {
  return (
    <CompositionRow
      swatch={<ReserveRiskSwatch risk={slice.risk} />}
      name={slice.label}
      context={slice.role ? `${formatReserveRiskTier(slice.risk)} · ${slice.role}` : formatReserveRiskTier(slice.risk)}
      pct={slice.pct}
      title={slice.detail ?? undefined}
      concentrated={concentrated}
    />
  );
}

/**
 * The module's reserve visual: one 100% stacked bar toned by reserve risk tier
 * over a ranked list (swatch, full name, risk tier and asset class, share).
 * Up to eight rows list; the rest fold with their count and share but keep
 * their full weight and tier in the bar. A share short of the whole leaves a
 * dashed unreviewed remainder, never a filled tier. The bar's accessible name
 * carries every slice, folded ones included. The review's concentration
 * finding (a large medium-or-worse top slice) tints that first row's share.
 */
function ReserveComposition({
  slices,
  subject,
  topConcentrated = false,
}: {
  slices: readonly ReserveCompositionSlice[];
  subject: string;
  topConcentrated?: boolean;
}) {
  const { shown, rest, restPct, segments } = splitReserveCompositionRows(slices);
  if (shown.length === 0) return null;
  const totalPct = slices.reduce((sum, slice) => sum + slice.pct, 0);
  const unreviewedPct = isWholeReserveShare(totalPct) ? 0 : Math.max(0, 100 - totalPct);
  const ariaLabel = `${subject}: ${slices
    .map((slice) => `${slice.label} ${formatReserveSharePct(slice.pct)} (${formatReserveRiskTier(slice.risk).toLowerCase()})`)
    .join(", ")}${unreviewedPct > 0 ? `, Unreviewed remainder ${formatReserveSharePct(unreviewedPct)}` : ""}`;
  return (
    <div className="min-w-0">
      <div role="figure" aria-label={ariaLabel} className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full">
        {segments.map((segment) => (
          <span
            key={segment.key}
            className="h-full min-w-0.5"
            style={{ flex: `${segment.pct} 1 0%`, backgroundColor: RESERVE_RISK_PRESENTATION[segment.risk].accentColor }}
          />
        ))}
        {unreviewedPct > 0 ? (
          <span
            className="h-full min-w-0.5 rounded-r-full border border-dashed border-muted-foreground/60"
            style={{ flex: `${unreviewedPct} 1 0%` }}
          />
        ) : null}
      </div>
      <ol aria-label="Reserve composition, largest first" className="mt-2 divide-y divide-border/40">
        {shown.map((slice, index) => (
          <SliceRow key={slice.key} slice={slice} concentrated={topConcentrated && index === 0} />
        ))}
        {unreviewedPct > 0 ? (
          <CompositionRow
            swatch={<span className="size-2.5 rounded-xs border border-dashed border-muted-foreground/60" />}
            name="Unreviewed remainder"
            context="Not covered by the reviewed composition"
            pct={unreviewedPct}
          />
        ) : null}
      </ol>
      {rest.length > 0 ? (
        <ModuleDisclosure label={`${rest.length} more ${rest.length === 1 ? "slice" : "slices"} · ${formatListedSharePct(restPct)}`}>
          <ol aria-label="Remaining reserve slices" className="divide-y divide-border/40">
            {rest.map((slice) => <SliceRow key={slice.key} slice={slice} />)}
          </ol>
        </ModuleDisclosure>
      ) : null}
    </div>
  );
}

function LiveFeedDetail({
  slices,
  datedLabel,
  note,
  relation,
  reviewedDrivesScore,
}: {
  slices: readonly ReserveCompositionSlice[];
  datedLabel: string | null;
  note: string | null;
  relation: "differs" | "matches" | "unreviewed";
  reviewedDrivesScore: boolean;
}) {
  const reviewedRole = reviewedDrivesScore ? "which drive the Safety Score basis" : "which the Safety Score does not use";
  const relationText = {
    differs: `This composition can differ from the reviewed slices above, ${reviewedRole}.`,
    matches: `This composition matches the reviewed slices above, ${reviewedRole}.`,
    unreviewed: "No reviewed reserve composition exists yet, so these figures do not drive the Safety Score basis.",
  }[relation];
  return (
    <ModuleDisclosure label="Live reserve feed">
      <div className="mt-3 space-y-2">
        <p className={SLICE_LINE_CLASS}>
          {datedLabel ?? "Live attestation or proof composition"}. {relationText}
        </p>
        {note ? <p className={SLICE_LINE_CLASS}>{note}</p> : null}
        <ul aria-label="Live reserve feed composition" className="space-y-1">
          {slices.map((slice) => (
            <li key={slice.key} className={SLICE_LINE_CLASS}>
              <span className="font-medium text-foreground">{slice.label}</span>
              {` · ${formatReserveQualityPct(slice.pct)}`}
            </li>
          ))}
        </ul>
      </div>
    </ModuleDisclosure>
  );
}

function FeedStatusDetail({
  status,
  onRetry,
  isFetching,
}: {
  status: ReserveFeedStatusModel;
  onRetry?: () => Promise<unknown> | void;
  isFetching: boolean;
}) {
  return (
    <ModuleDisclosure label="Feed status" id={FEED_STATUS_ANCHOR_ID}>
      <div role="status" aria-live="polite" className="mt-3 space-y-1">
        {status.rows.map((row) => (
          <p key={row} className={SLICE_LINE_CLASS}>{row}</p>
        ))}
        {status.retryable && onRetry ? (
          <div className="pt-1">
            <RetryButton onRetry={onRetry} isFetching={isFetching} />
          </div>
        ) : null}
      </div>
    </ModuleDisclosure>
  );
}

/**
 * A wrapper whose whole reviewed basis is one claim on its parent draws the
 * parent's reviewed basket instead. This line names the wrapper slice it stands
 * for and labels the basket "via <parent>". The parent's review date folds into
 * the provenance, so the footer's review stamp stays the one visible date.
 */
function LookThroughCaption({
  wrapper,
  lookThrough,
}: {
  wrapper: ReserveCompositionSlice;
  lookThrough: ReserveLookThroughClientSummary;
}) {
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <ReserveRiskSwatch risk={wrapper.risk} />
      <span className="font-medium text-foreground">{wrapper.label}</span>
      <span className="font-mono tabular-nums text-foreground">{formatReserveQualityPct(wrapper.pct)}</span>
      <span className="font-medium">{formatReserveRiskTier(wrapper.risk)}</span>
      <span aria-hidden="true">→</span>
      <span>
        via{" "}
        <Link
          href={buildStablecoinUrl(lookThrough.parentId, "#reserves")}
          className="pharos-focus-ring rounded-sm font-mono font-semibold text-foreground underline decoration-dotted underline-offset-4 transition-colors hover:decoration-solid motion-reduce:transition-none"
        >
          {lookThrough.parentSymbol}
        </Link>
        {" reserves"}
      </span>
    </p>
  );
}

/**
 * The verdict is the generated lede when it fits the summary budget, else its
 * first sentence (slice count and convertibility); the trailing exposure
 * sentences restate figures the facts and slice detail already carry.
 */
function buildVerdict(summary: ReserveQualityClientSummary | null): string | null {
  if (!summary?.lede) return null;
  return findSummaryBudgetViolations(summary.lede).length === 0 ? summary.lede : deriveVerdictLine(summary.lede);
}

/**
 * A look-through verdict counts the slices actually drawn (the parent's), not
 * the wrapper's single claim the lede counts, and names the largest one: the
 * caption above already says which wrapper slice the basket stands for.
 */
function buildLookThroughVerdict(parentSymbol: string, slices: readonly ReserveCompositionSlice[]): string | null {
  const top = slices[0];
  if (!top) return null;
  return slices.length === 1
    ? `Via ${parentSymbol}: 1 reviewed slice, ${top.label}.`
    : `Via ${parentSymbol}: ${slices.length} reviewed slices, led by ${top.label} at ${formatReserveQualityPct(top.pct)}.`;
}

/**
 * The one Reserves module (plan §8a): the risk-toned composition bar and
 * ranked list of the *reviewed* slices (the Safety Score basis), the lede as verdict, a chip row
 * (confidence · source type), the figures the verdict does not state, then the folded ladder, slice
 * detail, dated live attestation/proof feed and feed status, and last the
 * merged review notes & sources fold above one footer line. The header carries
 * one status chip (liquidity) and, when the feed is unhealthy, the ops chip.
 *
 * The summary is always the reviewed slices, or an explicit "no reviewed
 * composition" state: live figures never reach it. A wrapper whose one
 * reviewed slice is its parent draws the parent's reviewed slices instead,
 * labelled "via <parent>"; a one-slice basket is the bar and one row. A live feed is always exposed in the dated "Live reserve feed" fold,
 * worded by whether it differs from the reviewed slices. Also owns the
 * `#reserve-quality` alias the hero and FAQ link to, pinned to the module top.
 *
 * Pillar-primary: it never folds, at any breakpoint, and it carries no
 * stretch filler, so its natural height sits beside the Safety Score.
 */
export function ReservesSection({
  coin,
  reserves,
  reserveFetchError,
  onRetry,
  isFetching = false,
  isLoading = false,
  qualitySummary = null,
  lookThrough = null,
  variant = "module",
  stripForm,
  scoreAdmissionNote = null,
}: ReservesSectionProps) {
  // The reviewed basis is the curated `coin.reserves`. The quality summary is
  // derived from it but only exists when slices carry both asset class and
  // liquidity horizon, so partially annotated baskets (USDe) still draw here.
  // A provenance-only summary projects the review's chip/footer evidence
  // without quality slices, so the visual falls back to the curated basket.
  const reviewedSlices = useMemo(
    () => (qualitySummary && qualitySummary.evidenceBasis !== "provenance-only"
      ? reviewedCompositionSlices(qualitySummary)
      : compositionSlices(coin.reserves ?? [])),
    [qualitySummary, coin.reserves],
  );
  const liveSlices = useMemo(
    () => (reserves ? compositionSlices(reserves.reserves) : []),
    [reserves],
  );
  const lookThroughSlices = useMemo(
    () => (lookThrough ? lookThroughCompositionSlices(lookThrough) : []),
    [lookThrough],
  );

  if (!reserves && !reserveFetchError && !qualitySummary && !coin.reserves?.length) {
    if (!isLoading) return null;
    return (
      <section id="reserves" aria-label="Reserve composition" aria-busy="true" className="min-w-0">
        <div className="mb-4 flex items-center gap-2">
          <Skeleton className="h-4 w-36 rounded-sm" />
          <Skeleton className="h-5 w-10 rounded-full" />
        </div>
        <Skeleton className="h-3 rounded-full" />
        <Skeleton className="mt-3 h-40 rounded-md" />
        <span className="sr-only">Loading reserve composition</span>
      </section>
    );
  }

  const hasReviewedBasis = reviewedSlices.length > 0;
  // A look-through stands in only for a wrapper's single reviewed slice.
  const wrapperSlice = reviewedSlices.length === 1 && lookThroughSlices.length > 0 ? reviewedSlices[0]! : null;
  const lookThroughView = lookThrough && wrapperSlice ? { parent: lookThrough, wrapper: wrapperSlice } : null;
  // A look-through draws the parent's basket. The wrapper's one-slice quality
  // summary describes a different population, so its header chip, whole-basket
  // facts and liquidity ladder never label the parent's slices (R7/ADR-34).
  const populationId = lookThroughView?.parent.parentId ?? coin.id;
  const wholeBasketSummary = qualitySummary?.populationId === populationId ? qualitySummary : null;
  const feedStatus = buildReserveFeedStatus(reserves, reserveFetchError);
  const sourceChip = buildReserveSourceChip(reserves);
  const liveMatchesReviewed = hasReviewedBasis && liveSlices.length > 0 && !liveCompositionDiffers(liveSlices, reviewedSlices);
  // A live feed replaying the reviewed basket shares its composition date, so
  // the feed's stamp never says "date unavailable" beside a dated basket.
  const footnote = reserves
    ? buildReserveFootnoteModel(
        reserves,
        !!coin.liveReservesConfig,
        coin.flags.backing.replace("-", " "),
        liveMatchesReviewed ? (qualitySummary?.asOf ?? null) : null,
      )
    : null;
  const isLiveFeed = reserves?.mode === "live" || reserves?.mode === "live-stale";
  // A live feed is always exposed in its dated disclosure, never promoted into the summary.
  const showLiveFeed = isLiveFeed && liveSlices.length > 0;
  const verdict = lookThroughView
    ? buildLookThroughVerdict(lookThroughView.parent.parentSymbol, lookThroughSlices)
    : buildVerdict(qualitySummary);
  const ledeVerdict = lookThroughView == null && verdict != null;
  const facts = buildFacts(wholeBasketSummary, {
    verdictStatesLiquidity: ledeVerdict,
    verdictStatesExposure: ledeVerdict && verdict === qualitySummary?.lede,
  });
  const reviewedAt = qualitySummary?.reviewedAt ?? undefined;
  // A look-through stacks three more dates on one card (the parent's review,
  // the wrapper basis's as-of, the live check), so it keeps one visible date,
  // the footer's review stamp, and folds the rest into the provenance.
  const keepsOneDate = lookThroughView != null && reviewedAt != null;
  // One provenance line: the reviewed composition's date beside its review
  // date, on the right. The live feed's dates open its "Live reserve feed"
  // fold, so they reach the line (left) only when that fold is absent. A
  // fallback note ("showing curated reserve baseline") takes the right slot
  // only when there is no other stamp there, else it folds with the sources.
  const compositionAsOf = lookThroughView == null ? (wholeBasketSummary?.asOf ?? null) : null;
  const asOfStamp = compositionAsOf && compositionAsOf !== reviewedAt ? `Reserves as of ${compositionAsOf}` : null;
  const liveStamp = isLiveFeed && !keepsOneDate && !showLiveFeed && footnote?.text ? compactReserveStamp(footnote.text) : null;
  const baselineNote = isLiveFeed ? null : (footnote?.text ?? null);

  const sources: EvidenceFooterSource[] = [];
  for (const source of [
    ...(qualitySummary?.sources ?? []),
    ...(lookThroughView?.parent.parentSources ?? []),
    ...(footnote?.references ?? []),
  ]) {
    if (!sources.some((existing) => existing.url === source.url)) sources.push({ label: source.label, url: source.url });
  }
  const basisSource = qualitySummary?.sources[0];
  // The "Live reserve feed" fold already opens on the dated stamp; it is
  // repeated here only when that fold is absent.
  const foldedLiveStamp = keepsOneDate && isLiveFeed && !showLiveFeed ? (footnote?.text ?? null) : null;
  const parent = lookThroughView?.parent ?? null;
  const parentBasisDate = parent?.parentCompositionAsOf && parent.parentCompositionAsOf !== parent.parentReviewedAt
    ? `as of ${parent.parentCompositionAsOf}${parent.parentReviewedAt ? `, reviewed ${parent.parentReviewedAt}` : ""}`
    : parent?.parentReviewedAt
      ? `reviewed ${parent.parentReviewedAt}`
      : null;
  const lookThroughDates = parent
    ? [
        parentBasisDate
          ? `${parent.parentSymbol} reserves ${parentBasisDate}${
            reviewedAt ? `; the review date below covers ${coin.symbol}'s own basis` : ""
          }.`
          : null,
        qualitySummary?.asOf
          ? `${coin.symbol} basis as of ${qualitySummary.asOf}${basisSource ? `, per ${reportName(basisSource.label)}` : ""}.`
          : null,
        foldedLiveStamp ? `Live feed: ${foldedLiveStamp}.` : null,
      ].filter((line): line is string => line != null)
    : [];
  // Folded provenance lines ride under the source list; with no sources they
  // become review notes so the merged fold still carries them.
  const datesInFootnote = sources.length > 0 ? lookThroughDates : [];
  const provenanceSentence = sourceChip?.tooltip ?? null;
  const foldedBaselineNote = reviewedAt || asOfStamp ? baselineNote : null;
  const sourcesFootnote = provenanceSentence || foldedBaselineNote || datesInFootnote.length > 0
    ? (
        <>
          {datesInFootnote.map((line) => <span key={line} className="block">{line}</span>)}
          {provenanceSentence ? <span className="block">{provenanceSentence}</span> : null}
          {foldedBaselineNote ? <span className="block">{foldedBaselineNote}</span> : null}
        </>
      )
    : undefined;
  const reviewNotes = [
    qualitySummary?.compositionBasis,
    qualitySummary?.knownUnknownExposureNote,
    ...(sources.length > 0 ? [] : lookThroughDates),
  ].filter((note): note is string => Boolean(note));

  const headerRight = wholeBasketSummary || feedStatus ? (
    <>
      {wholeBasketSummary?.chipLabel ? (
        // The module's verdict chip ("Opaque exit") never truncates: `shrink-0!`
        // beats the header slot's shrink-and-truncate rule; the title wraps instead.
        <Badge variant="outline" className={cn(CHIP_CLASS, "shrink-0!", wholeBasketSummary.chipToneClass)}>
          {wholeBasketSummary.chipLabel}
        </Badge>
      ) : null}
      {feedStatus ? <FeedStatusChip status={feedStatus} /> : null}
    </>
  ) : undefined;

  const chipRow = qualitySummary?.confidenceLabel || sourceChip ? (
    <>
      {qualitySummary?.confidenceLabel ? (
        <Badge variant="outline" className={cn(CHIP_CLASS, SEVERITY_TONE_CLASS.neutral.pill)}>
          {`Confidence: ${qualitySummary.confidenceLabel}`}
        </Badge>
      ) : null}
      {sourceChip ? (
        <ExplainedChip
          label={sourceChip.label}
          tooltip={sourceChip.tooltip}
          className={cn(CHIP_CLASS, SEVERITY_TONE_CLASS.neutral.pill)}
        />
      ) : null}
    </>
  ) : undefined;

  const visual = (
    <>
      {/* Zero-size alias pinned to the module top (the shell is `relative`), so
          `#reserve-quality` lands on the header without adding layout. */}
      <span id="reserve-quality" aria-hidden="true" className={cn("absolute inset-x-0 top-0 h-0", SECTION_SCROLL_MT)} />
      {lookThroughView ? (
        <div className="space-y-3">
          <LookThroughCaption wrapper={lookThroughView.wrapper} lookThrough={lookThroughView.parent} />
          <ReserveComposition
            slices={lookThroughSlices}
            subject={`${lookThroughView.parent.parentSymbol} reviewed reserve slices, held via ${lookThroughView.wrapper.label}`}
          />
        </div>
      ) : hasReviewedBasis ? (
        <ReserveComposition
          slices={reviewedSlices}
          subject={qualitySummary?.evidenceBasis === "contextual" ? "Contextual reserve slices, not whole-token composition" : "Reviewed reserve slices"}
          topConcentrated={wholeBasketSummary?.topPositionName != null && reviewedSlices.length > 1}
        />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {!reserves && reserveFetchError
              ? "Reserve composition could not be loaded."
              : "No reviewed reserve composition yet."}
          </p>
          {!reserves && onRetry ? <RetryButton onRetry={onRetry} isFetching={isFetching} /> : null}
        </div>
      )}
    </>
  );

  return (
    <TooltipProvider>
      <EvidenceModule
        id="reserves"
        title="Reserves"
        variant={variant}
        stripForm={stripForm}
        collapsibleOnMobile={false}
        className="relative"
        headerRight={headerRight}
        visual={visual}
        verdict={verdict}
        chipRow={chipRow}
        // The domain folds in fixed order; the shell closes the module with the
        // provenance fold and footer line.
        folds={
          <>
            {wholeBasketSummary && wholeBasketSummary.ladder.length > 0 ? (
              <ModuleDisclosure label="Liquidity ladder">
                <ul aria-label="Liquidity horizon ladder" className="mt-3 space-y-1.5">
                  {wholeBasketSummary.ladder.map((row) => (
                    <LadderRow key={row.key} row={row} />
                  ))}
                </ul>
              </ModuleDisclosure>
            ) : null}
            {qualitySummary && qualitySummary.evidenceBasis !== "provenance-only" ? <SliceDetail summary={qualitySummary} /> : null}
            {showLiveFeed ? (
              <LiveFeedDetail
                slices={liveSlices}
                datedLabel={footnote?.text ?? null}
                note={buildReserveCompositionNote(reserves)}
                relation={!hasReviewedBasis ? "unreviewed" : liveMatchesReviewed ? "matches" : "differs"}
                reviewedDrivesScore={scoreAdmissionNote == null}
              />
            ) : null}
            {feedStatus ? <FeedStatusDetail status={feedStatus} onRetry={onRetry} isFetching={isFetching} /> : null}
          </>
        }
        footer={
          <EvidenceFooter
            sources={sources}
            sourcesFootnote={sourcesFootnote}
            notes={reviewNotes.length > 0 ? reviewNotes.map((note) => <p key={note}>{note}</p>) : undefined}
            notesCount={reviewNotes.length}
            reviewed={reviewedAt}
            trailing={asOfStamp ? (
              <span className="whitespace-nowrap">{asOfStamp}</span>
            ) : reviewedAt ? undefined : (baselineNote ?? undefined)}
          >
            {liveStamp ? <FooterStamp text={liveStamp} /> : null}
          </EvidenceFooter>
        }
      >
        {hasReviewedBasis && scoreAdmissionNote ? (
          <p className={SLICE_LINE_CLASS}>
            <span className="font-medium text-foreground">Not used by the Safety Score.</span> {scoreAdmissionNote}
          </p>
        ) : null}
        <FactGrid aria-label="Reserve facts" items={facts} />
      </EvidenceModule>
    </TooltipProvider>
  );
}

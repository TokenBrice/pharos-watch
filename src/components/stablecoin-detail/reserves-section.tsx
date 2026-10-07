"use client";

import { useMemo } from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { formatReserveRiskTier, ReserveRiskSwatch, ReserveTreemap } from "@/components/reserve-treemap";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { EvidenceFooter, type EvidenceFooterSource } from "@/components/stablecoin-detail/evidence-footer";
import { EvidenceModule, type EvidenceModuleVariant } from "@/components/stablecoin-detail/evidence-module";
import { FactGrid, type FactGridItem } from "@/components/stablecoin-detail/fact-grid";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import {
  buildReserveCompositionNote,
  buildReserveFeedStatus,
  buildReserveFootnoteModel,
  buildReserveSourceChip,
  liveCompositionDiffers,
  compositionSlices,
  lookThroughCompositionSlices,
  reserveSliceLabel,
  reviewedCompositionSlices,
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
import type { ReserveResult } from "@shared/lib/reserve-templates";
import { findSummaryBudgetViolations } from "@shared/lib/summary-budget";
import { buildStablecoinUrl } from "@shared/lib/urls";
import type { ReserveLiquidityHorizon, StablecoinMeta } from "@shared/types";

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
}

const FEED_STATUS_ANCHOR_ID = "reserve-feed-status";
const AMBER_VALUE_CLASS = "text-amber-600 dark:text-amber-400";
const CHIP_CLASS = "text-[11px] font-medium";
const SUB_LINE_CLASS = "block font-sans text-[11px] font-normal normal-case tracking-normal text-muted-foreground";
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
      <span className="w-20 shrink-0 text-[10px] font-medium uppercase leading-tight tracking-[0.14em] text-muted-foreground">
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
 * At most four facts, in reading order: how fast the basket exits, how much of
 * it has no identified obligor, its largest position, and the review's date.
 * A look-through drops the date fact: the module keeps one visible date (the
 * footer's review stamp) and folds the others into its provenance.
 */
function buildFacts(
  summary: ReserveQualityClientSummary | null,
  slices: readonly ReserveCompositionSlice[],
  { includeAsOf }: { includeAsOf: boolean },
): FactGridItem[] {
  const facts: FactGridItem[] = [];

  if (summary) {
    const { liquidWithinOneDayPct: liquid, unknownHorizonPct: unknown } = summary;
    // Amber only on a breach no undisclosed slice could cure: below the
    // watch line even if every slice with no published exit timeline converted
    // within the day. A disclosure gap alone is the "Opaque exit" chip's job.
    const isBreach = liquid < LIQUID_WITHIN_ONE_DAY_WATCH_BELOW_PCT
      && liquid + unknown < LIQUID_WITHIN_ONE_DAY_WATCH_BELOW_PCT;
    facts.push({
      key: "liquid-one-day",
      label: "Liquid ≤ 1 day",
      value: unknown >= 100
        ? "Not published"
        : `${unknown > 0 ? "≥ " : ""}${formatReserveQualityPct(liquid)}`,
      ...(isBreach ? { valueClassName: AMBER_VALUE_CLASS } : {}),
      title: unknown > 0
        ? `${formatReserveQualityPct(unknown)} of the basket has no published exit timeline`
        : "Share of the basket convertible to cash within one day",
    });

    if (summary.unidentifiedObligorsPct != null) {
      facts.push({
        key: "unresolved-exposure",
        label: "Unresolved reserve exposure",
        value: formatReserveQualityPct(summary.unidentifiedObligorsPct),
        ...(summary.unidentifiedObligorsPct > 0 ? { valueClassName: AMBER_VALUE_CLASS } : {}),
        title: "Share of reserve dispositions the review left unresolved; it does not measure individually identified obligors",
      });
    }
  }

  const top = slices[0];
  if (top && slices.length > 1) {
    facts.push({
      key: "top-position",
      label: "Top position",
      value: (
        <>
          {formatReserveQualityPct(top.pct)}
          <span className={SUB_LINE_CLASS}>{top.label}</span>
        </>
      ),
      // The review flags a concentration finding only for a large medium-or-worse slice.
      ...(summary?.topPositionName != null ? { valueClassName: AMBER_VALUE_CLASS } : {}),
      title: top.detail ?? top.label,
    });
  }

  if (includeAsOf && summary?.asOf) {
    const source = summary.sources[0];
    const sourceName = source ? reportName(source.label) : null;
    facts.push({
      key: "as-of",
      label: "As of",
      value: source ? (
        <>
          {summary.asOf}
          <span className={SUB_LINE_CLASS}>{sourceName}</span>
        </>
      ) : summary.asOf,
      ...(source ? { href: source.url, title: source.label } : {}),
    });
  }

  return facts;
}

/**
 * Source labels can carry reviewer page notes after the first ";": only the
 * report name belongs in the summary layer; the full label stays in the title.
 */
function reportName(label: string): string {
  return label.split(";")[0]!.trim();
}

/** Slice data only: reviewer narrative folds with the sources, confidence sits in the chip row. */
function SliceDetail({ summary }: { summary: ReserveQualityClientSummary }) {
  const slices = [...summary.slices].sort((a, b) => b.pct - a.pct);
  return (
    <ModuleDisclosure label="Slice detail & risk factors">
      <div className="mt-3 space-y-3">
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

function LiveFeedDetail({
  slices,
  datedLabel,
  note,
  relation,
}: {
  slices: readonly ReserveCompositionSlice[];
  datedLabel: string | null;
  note: string | null;
  relation: "differs" | "matches" | "unreviewed";
}) {
  const relationText = {
    differs: "This composition can differ from the reviewed slices above, which drive the Safety Score basis.",
    matches: "This composition matches the reviewed slices above, which drive the Safety Score basis.",
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
  if (!summary) return null;
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
 * The one Reserves module (plan §8a): the risk-toned treemap of the *reviewed*
 * slices (the Safety Score basis), the lede as verdict, a chip row
 * (confidence · source type), up to four facts, then the folded ladder, slice
 * detail, dated live attestation/proof feed and feed status, and last the
 * merged review notes & sources fold above one footer line. The header carries
 * one status chip (liquidity) and, when the feed is unhealthy, the ops chip.
 *
 * The summary is always the reviewed slices, or an explicit "no reviewed
 * composition" state: live figures never reach it. A wrapper whose one
 * reviewed slice is its parent draws the parent's reviewed slices instead,
 * labelled "via <parent>"; any other one-slice basket is a compact composition
 * bar. A live feed is always exposed in the dated "Live reserve feed" fold,
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
}: ReservesSectionProps) {
  // The reviewed basis is the curated `coin.reserves`. The quality summary is
  // derived from it but only exists when slices carry both asset class and
  // liquidity horizon, so partially annotated baskets (USDe) still draw here.
  const reviewedSlices = useMemo(
    () => (qualitySummary ? reviewedCompositionSlices(qualitySummary) : compositionSlices(coin.reserves ?? [])),
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
        <Skeleton className="h-64 rounded-md sm:h-72" />
        <span className="sr-only">Loading reserve composition</span>
      </section>
    );
  }

  const hasReviewedBasis = reviewedSlices.length > 0;
  // A look-through stands in only for a wrapper's single reviewed slice.
  const wrapperSlice = reviewedSlices.length === 1 && lookThroughSlices.length > 0 ? reviewedSlices[0]! : null;
  const lookThroughView = lookThrough && wrapperSlice ? { parent: lookThrough, wrapper: wrapperSlice } : null;
  const feedStatus = buildReserveFeedStatus(reserves, reserveFetchError);
  const sourceChip = buildReserveSourceChip(reserves);
  const footnote = reserves
    ? buildReserveFootnoteModel(reserves, !!coin.liveReservesConfig, coin.flags.backing.replace("-", " "))
    : null;
  const isLiveFeed = reserves?.mode === "live" || reserves?.mode === "live-stale";
  // A live feed is always exposed in its dated disclosure, never promoted into the summary.
  const showLiveFeed = isLiveFeed && liveSlices.length > 0;
  const facts = buildFacts(qualitySummary, reviewedSlices, { includeAsOf: lookThroughView == null });
  const verdict = lookThroughView
    ? buildLookThroughVerdict(lookThroughView.parent.parentSymbol, lookThroughSlices)
    : buildVerdict(qualitySummary);
  const reviewedAt = qualitySummary?.reviewedAt ?? undefined;
  // A look-through stacks three more dates on one card (the parent's review,
  // the wrapper basis's as-of, the live check), so it keeps one visible date,
  // the footer's review stamp, and folds the rest into the provenance.
  const keepsOneDate = lookThroughView != null && reviewedAt != null;
  // Footer line: the live feed's dated stamp on the left, the review date on
  // the right. A fallback note ("showing curated reserve baseline") takes the
  // right slot only when there is no review date, else it folds with the sources.
  const liveStamp = isLiveFeed && !keepsOneDate ? (footnote?.text ?? null) : null;
  const baselineNote = isLiveFeed ? null : (footnote?.text ?? null);

  const sources: EvidenceFooterSource[] = [];
  for (const source of [...(qualitySummary?.sources ?? []), ...(footnote?.references ?? [])]) {
    if (!sources.some((existing) => existing.url === source.url)) sources.push({ label: source.label, url: source.url });
  }
  const basisSource = qualitySummary?.sources[0];
  // The "Live reserve feed" fold already opens on the dated stamp; it is
  // repeated here only when that fold is absent.
  const foldedLiveStamp = keepsOneDate && isLiveFeed && !showLiveFeed ? (footnote?.text ?? null) : null;
  const lookThroughDates = lookThroughView
    ? [
        lookThroughView.parent.parentReviewedAt
          ? `${lookThroughView.parent.parentSymbol} reserves reviewed ${lookThroughView.parent.parentReviewedAt}${
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
  const foldedBaselineNote = reviewedAt ? baselineNote : null;
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

  const headerRight = qualitySummary || feedStatus ? (
    <>
      {qualitySummary ? (
        // The module's verdict chip ("Opaque exit") never truncates: `shrink-0!`
        // beats the header slot's shrink-and-truncate rule; the title wraps instead.
        <Badge variant="outline" className={cn(CHIP_CLASS, "shrink-0!", qualitySummary.chipToneClass)}>
          {qualitySummary.chipLabel}
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
          <ReserveTreemap
            slices={lookThroughSlices}
            subject={`${lookThroughView.parent.parentSymbol} reviewed reserve slices, held via ${lookThroughView.wrapper.label}`}
          />
        </div>
      ) : hasReviewedBasis ? (
        <ReserveTreemap slices={reviewedSlices} subject="Reviewed reserve slices" />
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
            {qualitySummary && qualitySummary.ladder.length > 0 ? (
              <ModuleDisclosure label="Liquidity ladder">
                <ul aria-label="Liquidity horizon ladder" className="mt-3 space-y-1.5">
                  {qualitySummary.ladder.map((row) => (
                    <LadderRow key={row.key} row={row} />
                  ))}
                </ul>
              </ModuleDisclosure>
            ) : null}
            {qualitySummary ? <SliceDetail summary={qualitySummary} /> : null}
            {showLiveFeed ? (
              <LiveFeedDetail
                slices={liveSlices}
                datedLabel={footnote?.text ?? null}
                note={buildReserveCompositionNote(reserves)}
                relation={!hasReviewedBasis ? "unreviewed" : liveCompositionDiffers(liveSlices, reviewedSlices) ? "differs" : "matches"}
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
            trailing={reviewedAt ? undefined : (baselineNote ?? undefined)}
          >
            {liveStamp ? <span>{liveStamp}</span> : null}
          </EvidenceFooter>
        }
      >
        <FactGrid aria-label="Reserve facts" items={facts} />
      </EvidenceModule>
    </TooltipProvider>
  );
}

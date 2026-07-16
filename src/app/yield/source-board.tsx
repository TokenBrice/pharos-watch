"use client";

import { useId, useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { buildStablecoinUrl } from "@/lib/urls";
import { formatYieldWarningSignal } from "@/lib/yield-constants";
import {
  YIELD_SOURCE_CONFIDENCE_DEFINITIONS,
  YIELD_SOURCE_CONFIDENCE_ORDER,
  YIELD_SOURCE_CONFIDENCE_STYLES,
  YIELD_SOURCE_DEPTH_DEFINITIONS,
  YIELD_SOURCE_POSTURE_DEFINITIONS,
  YIELD_SOURCE_POSTURE_ORDER,
  formatYieldSourcePosture,
  type YieldSourceConfidenceTier,
  type YieldSourceDepthLens,
  type YieldSourcePosture,
} from "@/lib/yield-source-risk";
import { YIELD_TYPE_STYLES } from "@shared/lib/classification";
import type {
  YieldSourceBoardAnomalyDetail,
  YieldSourceBoardGroup,
  YieldSourceBoardModel,
  YieldSourceBoardRiskDriverCount,
  YieldSourceBoardRowDetail,
  YieldSourceBoardSourceSwitchDetail,
} from "@/app/yield/source-board-model";

interface YieldSourceBoardProps {
  model: YieldSourceBoardModel;
  activeFilters?: {
    depth?: string;
    sourceConfidence?: string;
    sourcePosture?: string;
  };
  onFilterChange?: (key: string, value: string) => void;
}

const LANE_DIGEST_COUNT = 5;

type DisclosureKey = "switches" | "anomalies";

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

const DEPTH_ORDER: readonly YieldSourceDepthLens[] = ["deep", "moderate", "thin", "unknown"];

const DEPTH_SEGMENT_BG: Record<YieldSourceDepthLens, string> = {
  deep: "bg-emerald-500/40",
  moderate: "bg-sky-500/40",
  thin: "bg-amber-500/40",
  unknown: "bg-muted/40",
};

const CONFIDENCE_SEGMENT_BG: Record<YieldSourceConfidenceTier, string> = {
  deterministic: "bg-emerald-500/40",
  curated: "bg-sky-500/40",
  discovered: "bg-amber-500/40",
  fallback: "bg-slate-500/40",
};

const POSTURE_SEGMENT_BG: Record<YieldSourcePosture, string> = {
  clean: "bg-emerald-500/40",
  watch: "bg-amber-500/40",
  speculative: "bg-red-500/40",
};

function nonZeroCountParts<T extends string>(
  keys: readonly T[],
  counts: Record<T, number>,
  format: (key: T, count: number) => string,
): string[] {
  return keys
    .filter((tier) => counts[tier] > 0)
    .map((tier) => format(tier, counts[tier]));
}

function formatConfidenceSummary(
  counts: Record<YieldSourceConfidenceTier, number>,
  unknownCount: number,
): string {
  const parts = nonZeroCountParts(YIELD_SOURCE_CONFIDENCE_ORDER, counts, (tier, count) => `${count} ${tier}`);
  const base = parts.join(" · ");
  return unknownCount > 0 ? `${base} (+${unknownCount} unknown)` : base;
}

function formatDepthSummary(counts: Record<YieldSourceDepthLens, number>): string {
  return nonZeroCountParts(DEPTH_ORDER, counts, (lens, count) => `${count} ${lens}`).join(" · ");
}

function formatPostureSummary(counts: Record<YieldSourcePosture, number>): string {
  return nonZeroCountParts(
    YIELD_SOURCE_POSTURE_ORDER,
    counts,
    (posture, count) => `${count} ${formatYieldSourcePosture(posture).toLowerCase()}`,
  ).join(" · ");
}

function buildConfidenceAriaLabel(
  counts: Record<YieldSourceConfidenceTier, number>,
  unknownCount: number,
): string {
  const parts = nonZeroCountParts(YIELD_SOURCE_CONFIDENCE_ORDER, counts, (tier, count) => `${count} ${tier}`);
  const base = parts.join(", ");
  const suffix = unknownCount > 0 ? `, ${unknownCount} unknown` : "";
  return `Confidence tier mix: ${base}${suffix}`;
}

function buildDepthAriaLabel(counts: Record<YieldSourceDepthLens, number>): string {
  const parts = nonZeroCountParts(DEPTH_ORDER, counts, (lens, count) => `${count} ${lens}`);
  return `Depth mix: ${parts.join(", ")}`;
}

function buildPostureAriaLabel(counts: Record<YieldSourcePosture, number>): string {
  const parts = nonZeroCountParts(
    YIELD_SOURCE_POSTURE_ORDER,
    counts,
    (posture, count) => `${count} ${formatYieldSourcePosture(posture)}`,
  );
  return `Source posture mix: ${parts.join(", ")}`;
}

type StackBarFilterTarget = {
  key: "depth" | "sourceConfidence" | "sourcePosture";
  value: string;
};

function StackBar({
  segments,
  ariaLabel,
  onSegmentSelect,
}: {
  segments: ReadonlyArray<{
    key: string;
    bg: string;
    count: number;
    description: string;
    label: string;
    target?: StackBarFilterTarget;
    active?: boolean;
  }>;
  ariaLabel: string;
  onSegmentSelect?: (target: StackBarFilterTarget, active: boolean) => void;
}) {
  const total = segments.reduce((sum, seg) => sum + seg.count, 0);
  if (total === 0) return null;
  const visibleSegments = segments.filter((seg) => seg.count > 0);

  return (
    <div
      // group, not img: the segments are focusable tooltip triggers, and
      // role="img" treats children as presentational (axe nested-interactive
      // / aria-prohibited-attr on the labelled segments).
      role="group"
      aria-label={ariaLabel}
      className="relative flex h-6 w-full"
    >
      {/* Keep the 8px visual bar centered inside 24px targets. */}
      <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-2 h-2 rounded-full bg-muted/30" />
      {visibleSegments.map((seg, index) => {
          const percentage = (seg.count / total) * 100;
          const isInteractive = seg.target != null && onSegmentSelect != null;
          const isTooNarrowForFocus = percentage < 14 && !isInteractive;
          const isFocusable = isInteractive || !isTooNarrowForFocus;
          const triggerLabel = `${seg.label}: ${seg.count}. ${seg.description}`;
          const triggerClassName = cn(
            "relative block h-6",
            isFocusable && "pharos-focus-ring min-w-6",
            isInteractive
              ? "cursor-pointer border-0 p-0"
              : isTooNarrowForFocus
                ? "pointer-events-none"
                : "cursor-help",
            seg.active && "ring-2 ring-inset ring-foreground/70",
          );
          const visualClassName = cn(
            "pointer-events-none absolute inset-x-0 top-2 h-2",
            index === 0 && "rounded-l-full",
            index === visibleSegments.length - 1 && "rounded-r-full",
            seg.bg,
          );

          return (
            <Tooltip key={seg.key}>
              <TooltipTrigger asChild>
                {isInteractive ? (
                  <button
                    type="button"
                    aria-label={`${triggerLabel} ${seg.active ? "Clear filter." : "Filter rows."}`}
                    aria-pressed={seg.active}
                    className={triggerClassName}
                    style={{ width: `${percentage}%` }}
                    onClick={() => onSegmentSelect(seg.target!, seg.active === true)}
                  >
                    <span aria-hidden="true" className={visualClassName} />
                  </button>
                ) : (
                  <span
                    // aria-label is prohibited on role=generic; the focusable
                    // trigger needs a real role (same pattern as the yield
                    // rows' benchmark-mismatch dot).
                    role={isTooNarrowForFocus ? undefined : "button"}
                    tabIndex={isTooNarrowForFocus ? undefined : 0}
                    aria-label={isTooNarrowForFocus ? undefined : triggerLabel}
                    className={triggerClassName}
                    style={{ width: `${percentage}%` }}
                  >
                    <span aria-hidden="true" className={visualClassName} />
                  </span>
                )}
              </TooltipTrigger>
              <TooltipContent className="max-w-[260px] text-xs">
                <span className="font-medium">
                  {seg.label} ({seg.count})
                </span>
                <span className="block text-background/75">{seg.description}</span>
              </TooltipContent>
            </Tooltip>
          );
        })}
    </div>
  );
}

function SourceQualityBars({
  model,
  activeFilters,
  onFilterChange,
}: {
  model: YieldSourceBoardModel;
  activeFilters?: YieldSourceBoardProps["activeFilters"];
  onFilterChange?: YieldSourceBoardProps["onFilterChange"];
}) {
  const confidenceTotal =
    YIELD_SOURCE_CONFIDENCE_ORDER.reduce(
      (sum, tier) => sum + model.selectedConfidenceCounts[tier],
      0,
    ) + model.selectedConfidenceUnknownCount;
  const depthTotal = DEPTH_ORDER.reduce((sum, lens) => sum + model.depthCounts[lens], 0);
  const postureTotal = YIELD_SOURCE_POSTURE_ORDER.reduce((sum, posture) => sum + model.postureCounts[posture], 0);

  if (confidenceTotal === 0 && depthTotal === 0 && postureTotal === 0) return null;

  const confidenceSegments = [
    ...YIELD_SOURCE_CONFIDENCE_ORDER.map((tier) => ({
      key: tier,
      bg: CONFIDENCE_SEGMENT_BG[tier],
      count: model.selectedConfidenceCounts[tier],
      description: YIELD_SOURCE_CONFIDENCE_DEFINITIONS[tier].description,
      label: YIELD_SOURCE_CONFIDENCE_DEFINITIONS[tier].label,
      target: { key: "sourceConfidence" as const, value: tier },
      active: activeFilters?.sourceConfidence === tier,
    })),
    {
      key: "unknown",
      bg: "bg-muted/40",
      count: model.selectedConfidenceUnknownCount,
      description: "Chosen sources without a published confidence tier.",
      label: "Unknown",
    },
  ];

  const depthSegments = DEPTH_ORDER.map((lens) => ({
    key: lens,
    bg: DEPTH_SEGMENT_BG[lens],
    count: model.depthCounts[lens],
    description: YIELD_SOURCE_DEPTH_DEFINITIONS[lens].description,
    label: YIELD_SOURCE_DEPTH_DEFINITIONS[lens].label,
    target: { key: "depth" as const, value: lens },
    active: activeFilters?.depth === lens,
  }));

  const postureSegments = YIELD_SOURCE_POSTURE_ORDER.map((posture) => ({
    key: posture,
    bg: POSTURE_SEGMENT_BG[posture],
    count: model.postureCounts[posture],
    description: YIELD_SOURCE_POSTURE_DEFINITIONS[posture].description,
    label: formatYieldSourcePosture(posture),
    target: {
      key: "sourcePosture" as const,
      value: posture === "watch" ? "watch-only" : posture,
    },
    active: activeFilters?.sourcePosture === (posture === "watch" ? "watch-only" : posture),
  }));

  const handleSegmentSelect = onFilterChange
    ? (target: StackBarFilterTarget, active: boolean) => onFilterChange(target.key, active ? "all" : target.value)
    : undefined;

  return (
    <div className="space-y-3 rounded-md border border-border/60 bg-muted/10 p-3">
      {postureTotal > 0 ? (
        <div className="space-y-1.5">
          <div className="flex items-baseline gap-3">
            <span className="w-20 shrink-0 text-xs font-medium text-foreground">Posture</span>
            <StackBar
              segments={postureSegments}
              ariaLabel={buildPostureAriaLabel(model.postureCounts)}
              onSegmentSelect={handleSegmentSelect}
            />
          </div>
          <p className="pl-[5.75rem] text-xs text-muted-foreground">
            {formatPostureSummary(model.postureCounts)}
          </p>
        </div>
      ) : null}
      {confidenceTotal > 0 ? (
        <div className="space-y-1.5">
          <div className="flex items-baseline gap-3">
            <span className="w-20 shrink-0 text-xs font-medium text-foreground">Confidence</span>
            <StackBar
              segments={confidenceSegments}
              ariaLabel={buildConfidenceAriaLabel(
                model.selectedConfidenceCounts,
                model.selectedConfidenceUnknownCount,
              )}
              onSegmentSelect={handleSegmentSelect}
            />
          </div>
          <p className="pl-[5.75rem] text-xs text-muted-foreground">
            {formatConfidenceSummary(
              model.selectedConfidenceCounts,
              model.selectedConfidenceUnknownCount,
            )}
          </p>
        </div>
      ) : null}
      {depthTotal > 0 ? (
        <div className="space-y-1.5">
          <div className="flex items-baseline gap-3">
            <span className="w-20 shrink-0 text-xs font-medium text-foreground">Depth</span>
            <StackBar
              segments={depthSegments}
              ariaLabel={buildDepthAriaLabel(model.depthCounts)}
              onSegmentSelect={handleSegmentSelect}
            />
          </div>
          <p className="pl-[5.75rem] text-xs text-muted-foreground">
            {formatDepthSummary(model.depthCounts)}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function SourceRiskDriverChips({ drivers }: { drivers: readonly YieldSourceBoardRiskDriverCount[] }) {
  if (drivers.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No populated source-risk drivers in the visible rows.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap gap-2" aria-label="Top source-risk drivers">
      {drivers.map((driver) => (
        <Tooltip key={driver.key}>
          <TooltipTrigger asChild>
            <span
              role="button"
              tabIndex={0}
              aria-label={`${driver.label}: ${pluralize(driver.count, "row")}`}
              className="pharos-focus-ring inline-flex cursor-help items-center gap-1 rounded-full border border-amber-500/25 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-800 dark:text-amber-200"
            >
              <span>{driver.label}</span>
              <span className="pharos-numeric text-[10px] opacity-75">{driver.count}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-[260px] text-xs">
            <span className="font-medium">{pluralize(driver.count, "visible row")}</span>
            <span className="block text-background/75">{driver.description}</span>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

function SourceLaneRow({ group }: { group: YieldSourceBoardGroup }) {
  const visibleSources = group.sourceLabels.slice(0, 3);
  const hiddenSourceCount = group.sourceLabels.slice(3).reduce((sum, source) => sum + source.count, 0);
  const tier = group.laneConfidenceTier;

  return (
    <li className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-baseline sm:gap-4 sm:px-5">
      <div className="flex shrink-0 items-center gap-2">
        <Badge
          variant="outline"
          className={cn("text-[11px]", YIELD_TYPE_STYLES[group.yieldType]?.badge ?? "")}
        >
          {group.yieldTypeLabel}
        </Badge>
        {tier ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                role="button"
                tabIndex={0}
                aria-label={`${YIELD_SOURCE_CONFIDENCE_DEFINITIONS[tier].label} confidence`}
                className="pharos-focus-ring inline-flex min-h-6 min-w-6 cursor-help items-center justify-center rounded-full"
              >
                <span aria-hidden="true" className={YIELD_SOURCE_CONFIDENCE_STYLES[tier].dot} />
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-[260px] text-xs">
              <span className="font-medium">{YIELD_SOURCE_CONFIDENCE_DEFINITIONS[tier].label}</span>
              <span className="block text-background/75">
                {YIELD_SOURCE_CONFIDENCE_DEFINITIONS[tier].description}
              </span>
            </TooltipContent>
          </Tooltip>
        ) : null}
        <span className="text-sm font-medium text-foreground">{group.dataSourceLabel}</span>
        <span className="pharos-numeric text-xs text-muted-foreground">
          {pluralize(group.representedSourceCount, "observation")}
        </span>
      </div>
      {visibleSources.length > 0 ? (
        <p className="min-w-0 text-xs leading-relaxed text-muted-foreground">
          {visibleSources.map((source) => `${source.label}${source.count > 1 ? ` x${source.count}` : ""}`).join(", ")}
          {hiddenSourceCount > 0 ? `, +${hiddenSourceCount} more` : ""}
        </p>
      ) : null}
    </li>
  );
}

function DisclosureRowFrame({
  detail,
  children,
}: {
  detail: YieldSourceBoardRowDetail;
  children: ReactNode;
}) {
  return (
    <li className="flex flex-col gap-1 py-2 sm:flex-row sm:items-baseline sm:gap-3">
      <div className="flex shrink-0 items-center gap-2 sm:w-56">
        <Badge
          variant="outline"
          className={cn("text-[11px]", YIELD_TYPE_STYLES[detail.yieldType]?.badge ?? "")}
        >
          {detail.yieldTypeLabel}
        </Badge>
        <Link
          href={`${buildStablecoinUrl(detail.id)}yield/`}
          className="pharos-focus-ring rounded-sm text-sm font-medium text-foreground underline-offset-4 hover:underline"
        >
          {detail.symbol}
        </Link>
        <span className="text-xs text-muted-foreground">{detail.dataSourceLabel}</span>
      </div>
      <p className="min-w-0 text-xs leading-relaxed text-muted-foreground">{children}</p>
    </li>
  );
}

function SourceSwitchDisclosure({ details }: { details: YieldSourceBoardSourceSwitchDetail[] }) {
  if (details.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">No source-switch detail captured for this view.</p>
    );
  }
  return (
    <ul className="divide-y divide-border/40">
      {details.map((detail) => (
        <DisclosureRowFrame key={`switch-${detail.id}`} detail={detail}>
          {detail.previousSourceKey
            ? <>was <span className="font-mono">{detail.previousSourceKey}</span> · now <span className="font-mono">{detail.currentYieldSource}</span></>
            : <>now <span className="font-mono">{detail.currentYieldSource}</span></>}
        </DisclosureRowFrame>
      ))}
    </ul>
  );
}

function AnomalyDisclosure({ details }: { details: YieldSourceBoardAnomalyDetail[] }) {
  if (details.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">No anomaly detail captured for this view.</p>
    );
  }
  return (
    <ul className="divide-y divide-border/40">
      {details.map((detail) => (
        <DisclosureRowFrame key={`anomaly-${detail.id}`} detail={detail}>
          {detail.anomalies.map(formatYieldWarningSignal).join(" · ")}
        </DisclosureRowFrame>
      ))}
    </ul>
  );
}

function DisclosureToggle({
  label,
  description,
  open,
  controls,
  toneClass,
  onClick,
}: {
  label: string;
  description: string;
  open: boolean;
  controls: string;
  toneClass: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      aria-controls={controls}
      title={description}
      className={cn(
        "pharos-focus-ring inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
        toneClass,
      )}
    >
      <span>{label}</span>
      <ChevronDown
        aria-hidden="true"
        className={cn("h-3 w-3 transition-transform", open ? "rotate-180" : "rotate-0")}
      />
    </button>
  );
}

export function YieldSourceBoard({ model, activeFilters, onFilterChange }: YieldSourceBoardProps) {
  const disclosureId = useId();
  const ledgerId = useId();
  const [openDisclosure, setOpenDisclosure] = useState<DisclosureKey | null>(null);
  const [showAllLanes, setShowAllLanes] = useState(false);

  if (model.representedSourceCount === 0) return null;

  const topLanes = model.groups.slice(0, LANE_DIGEST_COUNT);
  const extraLanes = model.groups.slice(LANE_DIGEST_COUNT);
  const extraLaneCount = extraLanes.length;
  const hasDisclosureBadges = model.sourceSwitchCount > 0 || model.anomalyCount > 0;

  function toggleDisclosure(key: DisclosureKey) {
    setOpenDisclosure((current) => (current === key ? null : key));
  }

  return (
    <TooltipProvider>
      <section
        aria-labelledby="yield-source-board-heading"
        className="pharos-card-shell overflow-hidden"
      >
        <div className="pharos-panel-header space-y-5">
          <div className="space-y-1">
            <p className="pharos-kicker">Yield Sources</p>
            <h2
              id="yield-source-board-heading"
              className="text-lg font-semibold tracking-tight text-foreground"
            >
              Source mix in the current view
            </h2>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Data families behind the visible rows. Counts every chosen source plus retained alternates.
            </p>
          </div>

          <SourceQualityBars
            model={model}
            activeFilters={activeFilters}
            onFilterChange={onFilterChange}
          />

          <div className="border-t border-border/50 pt-5">
            <SourceRiskDriverChips drivers={model.topSourceRiskDrivers} />
          </div>

          {hasDisclosureBadges ? (
            <div className="space-y-3 border-t border-border/50 pt-5">
              <div className="flex flex-wrap gap-2">
                {model.sourceSwitchCount > 0 ? (
                  <DisclosureToggle
                    label={pluralize(model.sourceSwitchCount, "source changed", "sources changed")}
                    description="A source changed when the selected source differs from the prior published snapshot. Click for the audit list."
                    open={openDisclosure === "switches"}
                    controls={disclosureId}
                    toneClass="border-sky-500/25 bg-sky-500/10 text-sky-700 hover:bg-sky-500/15 dark:text-sky-300"
                    onClick={() => toggleDisclosure("switches")}
                  />
                ) : null}
                {model.anomalyCount > 0 ? (
                  <DisclosureToggle
                    label={`${pluralize(model.anomalyCount, "chosen source")} with anomalies`}
                    description="Anomalies flag source-observation quality issues such as low venue TVL or APY that diverges from recent history. Click for the audit list."
                    open={openDisclosure === "anomalies"}
                    controls={disclosureId}
                    toneClass="border-amber-500/25 bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 dark:text-amber-300"
                    onClick={() => toggleDisclosure("anomalies")}
                  />
                ) : null}
              </div>

              <div
                id={disclosureId}
                aria-hidden={openDisclosure === null}
                inert={openDisclosure === null}
                className={cn(
                  "grid transition-[grid-template-rows,opacity] duration-[220ms] ease-[var(--motion-ease-standard)] motion-reduce:transition-none",
                  openDisclosure ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
                )}
              >
                <div className="overflow-hidden">
                  <div className="rounded-md border border-border/60 bg-muted/10 px-3 py-2">
                    {openDisclosure === "switches" ? (
                      <SourceSwitchDisclosure details={model.sourceSwitchDetails} />
                    ) : null}
                    {openDisclosure === "anomalies" ? (
                      <AnomalyDisclosure details={model.anomalyDetails} />
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <ul className="divide-y divide-border/60" aria-label="Yield source lanes">
          {topLanes.map((group) => (
            <SourceLaneRow key={group.key} group={group} />
          ))}
        </ul>

        {extraLaneCount > 0 ? (
          <>
            <div
              id={ledgerId}
              aria-hidden={!showAllLanes}
              inert={!showAllLanes}
              className={cn(
                "grid transition-[grid-template-rows] duration-[220ms] ease-[var(--motion-ease-standard)] motion-reduce:transition-none",
                showAllLanes ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
              )}
            >
              <div className="overflow-hidden">
                <ul className="divide-y divide-border/60 border-t border-border/60" aria-label="Additional yield source lanes">
                  {extraLanes.map((group) => (
                    <SourceLaneRow key={group.key} group={group} />
                  ))}
                </ul>
              </div>
            </div>
            <div className="border-t border-border/60 px-4 py-3 sm:px-5">
              <button
                type="button"
                onClick={() => setShowAllLanes((value) => !value)}
                aria-expanded={showAllLanes}
                aria-controls={ledgerId}
                className="pharos-focus-ring inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/60 px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              >
                <span>
                  {showAllLanes
                    ? "Collapse ledger"
                    : `Show full ledger (${extraLaneCount} more ${extraLaneCount === 1 ? "lane" : "lanes"})`}
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className={cn("h-3.5 w-3.5 transition-transform", showAllLanes ? "rotate-180" : "rotate-0")}
                />
              </button>
            </div>
          </>
        ) : null}
      </section>
    </TooltipProvider>
  );
}

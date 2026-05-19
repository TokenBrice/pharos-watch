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
  type YieldSourceConfidenceTier,
  type YieldSourceDepthLens,
} from "@/lib/yield-source-risk";
import { YIELD_TYPE_STYLES } from "@shared/lib/classification";
import type {
  YieldSourceBoardAnomalyDetail,
  YieldSourceBoardGroup,
  YieldSourceBoardModel,
  YieldSourceBoardRowDetail,
  YieldSourceBoardSourceSwitchDetail,
} from "@/app/yield/source-board-model";

interface YieldSourceBoardProps {
  model: YieldSourceBoardModel;
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

function formatConfidenceSummary(
  counts: Record<YieldSourceConfidenceTier, number>,
  unknownCount: number,
): string {
  const parts = YIELD_SOURCE_CONFIDENCE_ORDER
    .filter((tier) => counts[tier] > 0)
    .map((tier) => `${counts[tier]} ${tier}`);
  const base = parts.join(" · ");
  return unknownCount > 0 ? `${base} (+${unknownCount} unknown)` : base;
}

function formatDepthSummary(counts: Record<YieldSourceDepthLens, number>): string {
  return DEPTH_ORDER
    .filter((lens) => counts[lens] > 0)
    .map((lens) => `${counts[lens]} ${lens}`)
    .join(" · ");
}

function buildConfidenceAriaLabel(
  counts: Record<YieldSourceConfidenceTier, number>,
  unknownCount: number,
): string {
  const parts = YIELD_SOURCE_CONFIDENCE_ORDER
    .filter((tier) => counts[tier] > 0)
    .map((tier) => `${counts[tier]} ${tier}`);
  const base = parts.join(", ");
  const suffix = unknownCount > 0 ? `, ${unknownCount} unknown` : "";
  return `Confidence tier mix: ${base}${suffix}`;
}

function buildDepthAriaLabel(counts: Record<YieldSourceDepthLens, number>): string {
  const parts = DEPTH_ORDER
    .filter((lens) => counts[lens] > 0)
    .map((lens) => `${counts[lens]} ${lens}`);
  return `Depth mix: ${parts.join(", ")}`;
}

function StackBar({
  segments,
  ariaLabel,
}: {
  segments: ReadonlyArray<{ key: string; bg: string; count: number; description: string; label: string }>;
  ariaLabel: string;
}) {
  const total = segments.reduce((sum, seg) => sum + seg.count, 0);
  if (total === 0) return null;

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className="flex h-2 w-full overflow-hidden rounded-full bg-muted/30"
    >
      {segments
        .filter((seg) => seg.count > 0)
        .map((seg) => {
          const percentage = (seg.count / total) * 100;
          return (
            <Tooltip key={seg.key}>
              <TooltipTrigger asChild>
                <span
                  tabIndex={0}
                  className={cn("pharos-focus-ring block h-full cursor-help", seg.bg)}
                  style={{ width: `${percentage}%` }}
                />
              </TooltipTrigger>
              <TooltipContent className="max-w-[260px] text-xs">
                <span className="font-medium">
                  {seg.label} ({seg.count})
                </span>
                <span className="block text-muted-foreground">{seg.description}</span>
              </TooltipContent>
            </Tooltip>
          );
        })}
    </div>
  );
}

function SourceQualityBars({ model }: { model: YieldSourceBoardModel }) {
  const confidenceTotal =
    YIELD_SOURCE_CONFIDENCE_ORDER.reduce(
      (sum, tier) => sum + model.selectedConfidenceCounts[tier],
      0,
    ) + model.selectedConfidenceUnknownCount;
  const depthTotal = DEPTH_ORDER.reduce((sum, lens) => sum + model.depthCounts[lens], 0);

  if (confidenceTotal === 0 && depthTotal === 0) return null;

  const confidenceSegments = [
    ...YIELD_SOURCE_CONFIDENCE_ORDER.map((tier) => ({
      key: tier,
      bg: CONFIDENCE_SEGMENT_BG[tier],
      count: model.selectedConfidenceCounts[tier],
      description: YIELD_SOURCE_CONFIDENCE_DEFINITIONS[tier].description,
      label: YIELD_SOURCE_CONFIDENCE_DEFINITIONS[tier].label,
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
  }));

  return (
    <div className="space-y-3 rounded-md border border-border/60 bg-muted/10 p-3">
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
            <StackBar segments={depthSegments} ariaLabel={buildDepthAriaLabel(model.depthCounts)} />
          </div>
          <p className="pl-[5.75rem] text-xs text-muted-foreground">
            {formatDepthSummary(model.depthCounts)}
          </p>
        </div>
      ) : null}
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
                tabIndex={0}
                aria-label={`${YIELD_SOURCE_CONFIDENCE_DEFINITIONS[tier].label} confidence`}
                className={cn("pharos-focus-ring cursor-help", YIELD_SOURCE_CONFIDENCE_STYLES[tier].dot)}
              />
            </TooltipTrigger>
            <TooltipContent className="max-w-[260px] text-xs">
              <span className="font-medium">{YIELD_SOURCE_CONFIDENCE_DEFINITIONS[tier].label}</span>
              <span className="block text-muted-foreground">
                {YIELD_SOURCE_CONFIDENCE_DEFINITIONS[tier].description}
              </span>
            </TooltipContent>
          </Tooltip>
        ) : null}
        <span className="text-sm font-medium text-foreground">{group.dataSourceLabel}</span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
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

export function YieldSourceBoard({ model }: YieldSourceBoardProps) {
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
        <div className="pharos-panel-header space-y-3">
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

          <SourceQualityBars model={model} />

          {hasDisclosureBadges ? (
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
          ) : null}

          <div
            id={disclosureId}
            aria-hidden={openDisclosure === null}
            className={cn(
              "grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none",
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
              className={cn(
                "grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none",
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

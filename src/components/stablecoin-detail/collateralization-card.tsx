"use client";

import { RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";
import { timeAgo } from "@shared/lib/format";
import { RailCard, RailStamp, ReviewedStamp } from "@/components/stablecoin-detail/rail-card";
import type { MechanismCollateralizationView } from "@/lib/mechanism-collateralization";

interface CollateralizationCardProps {
  reviewed: MechanismCollateralizationView | null;
  /** Live feed ratio from the reserve snapshot metadata, when the adapter emits one. */
  liveRatio?: number | null;
  /** Live committed liquidation capital as a share of supply, when measured. */
  liveLiquidationCapacityRatio?: number | null;
  liveAtSec?: number | null;
}

function formatRatioPct(ratio: number): string {
  const pct = ratio * 100;
  return `${pct >= 1000 ? Math.round(pct).toLocaleString("en-US") : pct.toFixed(1)}%`;
}

function coverageLabel(ratio: number): { label: string; tone: "over" | "par" | "under" } {
  if (ratio >= 1.005) return { label: "Overcollateralized", tone: "over" };
  if (ratio >= 0.995) return { label: "Fully collateralized", tone: "par" };
  return { label: "Undercollateralized", tone: "under" };
}

const TONE_BADGE_CLASSES: Record<"over" | "par" | "under", string> = {
  over: SEVERITY_TONE_CLASS.ok.pill,
  par: SEVERITY_TONE_CLASS.ok.pill,
  // Rose, not the token's red `alert` — the detail rail's undercollateralized
  // treatment is a separate hue and is not re-coloured here.
  under: "border-rose-500/25 bg-rose-500/12 text-rose-700 dark:text-rose-400",
};

/**
 * Right-rail collateralization module (issue #682). Headline prefers the live
 * reserve-feed ratio when the adapter emits one; otherwise it shows the dated
 * reviewed ratio from the V9 mechanism review. A reviewed structural
 * not-applicable ruling renders honestly instead of a number.
 */
export function CollateralizationCard({
  reviewed,
  liveRatio = null,
  liveLiquidationCapacityRatio = null,
  liveAtSec = null,
}: CollateralizationCardProps) {
  const live = typeof liveRatio === "number" && Number.isFinite(liveRatio) && liveRatio >= 0 ? liveRatio : null;
  const liveBackstop =
    typeof liveLiquidationCapacityRatio === "number"
    && Number.isFinite(liveLiquidationCapacityRatio)
    && liveLiquidationCapacityRatio >= 0
      ? liveLiquidationCapacityRatio
      : null;
  if (live == null && liveBackstop == null && reviewed == null) return null;

  const headlineRatio = live ?? reviewed?.ratio ?? null;
  const liquidationCapacityRatio = liveBackstop ?? reviewed?.liquidationCapacityRatio ?? null;
  const hasLiveMetrics = live != null || liveBackstop != null;
  const coverage = headlineRatio != null ? coverageLabel(headlineRatio) : null;

  return (
    <RailCard
      title="Collateralization"
      ariaLabel="Collateralization"
      trailing={
        hasLiveMetrics ? (
          <RailStamp className="gap-1.5">
            <RefreshCw className="h-3 w-3" aria-hidden="true" />
            {liveAtSec != null ? `Live · ${timeAgo(liveAtSec)}` : "Live"}
          </RailStamp>
        ) : reviewed != null ? (
          <ReviewedStamp date={reviewed.reviewedAt} />
        ) : null
      }
    >
      <div className="px-4 pb-4">
        {headlineRatio != null && coverage != null ? (
          <>
            <p className="font-mono text-[2rem] font-semibold leading-none tracking-normal tabular-nums text-foreground">
              {formatRatioPct(headlineRatio)}
            </p>
            <p className="mt-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
              <Badge
                variant="outline"
                className={cn("h-5 rounded-full px-2 text-[11px] font-medium normal-case tracking-normal", TONE_BADGE_CLASSES[coverage.tone])}
              >
                {coverage.label}
              </Badge>
            </p>
          </>
        ) : (
          <>
            <p className="text-sm font-medium text-foreground">Not applicable</p>
            {reviewed?.notApplicableRationale ? (
              <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">{reviewed.notApplicableRationale}</p>
            ) : null}
          </>
        )}
      </div>

      {liquidationCapacityRatio != null ? (
        <div className="border-t border-border/50 px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-muted-foreground">Liquidation backstop</p>
            <p className="font-mono text-sm font-semibold tabular-nums text-foreground">
              {formatRatioPct(liquidationCapacityRatio)}
            </p>
          </div>
          <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
            Capital committed to absorb liquidations, as a share of supply.
          </p>
        </div>
      ) : null}

      {reviewed != null ? (
        <div className="border-t border-border/50 px-4 py-3">
          <a
            href={reviewed.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="pharos-focus-ring rounded-sm text-[11px] text-frost-blue underline-offset-2 hover:underline"
          >
            {reviewed.sourceLabel}
          </a>
        </div>
      ) : null}
    </RailCard>
  );
}

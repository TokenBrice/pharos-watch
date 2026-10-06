"use client";

import { Link2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { RailCard, RailCount } from "@/components/stablecoin-detail/rail-card";
import type { FailureDomainRow, FailureDomainsView } from "@/lib/failure-domains";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";

/** Rows beyond this many fold into the disclosure; wrappers can carry 25+ routes. */
const VISIBLE_ROW_LIMIT = 5;

function shareLabel(row: FailureDomainRow): string {
  if (row.exposureShare === null) return "Unquantified";
  const pct = row.exposureShare * 100;
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

function DomainRow({ row }: { row: FailureDomainRow }) {
  return (
    <li>
      <div className="flex items-baseline justify-between gap-2">
        <p className="min-w-0 truncate text-xs font-medium text-foreground">{row.label}</p>
        <div className="flex shrink-0 items-center gap-1.5">
          {row.adjustmentPoints > 0 ? (
            <Badge
              variant="outline"
              // A point cost is a quantity, not a risk band: a tenth of a point
              // in the alarm ramp reads far louder than it measures.
              className={cn("h-5 rounded-full px-2 text-[10px] font-medium", SEVERITY_TONE_CLASS.neutral.pill)}
            >
              −{row.adjustmentPoints.toFixed(1)}
            </Badge>
          ) : null}
          <span className="font-mono text-xs tabular-nums text-muted-foreground">{shareLabel(row)}</span>
        </div>
      </div>
    </li>
  );
}

/**
 * Right-rail common-mode exposure module. Sits beside `ContractDeployments`
 * because it answers the question that card raises: those deployments look
 * independent, but how many of them fail together?
 *
 * A zero-point row is kept rather than filtered — an identified shared domain
 * that did not cost the score is still the fact a holder wants, and dropping it
 * would misread "no penalty" as "no exposure". Per-row measurement reasons and
 * the capped modelling contribution sit behind "Review notes".
 */
export function FailureDomainsCard({
  view,
  frameless,
}: {
  view: FailureDomainsView | null;
  /** Body-only render inside a `RailCopyFold` band (see `RailCard`). */
  frameless?: boolean;
}) {
  if (view === null) return null;

  const visibleRows = view.rows.slice(0, VISIBLE_ROW_LIMIT);
  const overflowRows = view.rows.slice(VISIBLE_ROW_LIMIT);

  return (
    <RailCard
      frameless={frameless}
      title="Shared failure domains"
      titleAdornment={<RailCount>{view.rows.length}</RailCount>}
      ariaLabel="Shared failure domains"
      icon={Link2}
    >
      <div className="px-4 pb-4">
        <p className="text-[11px] leading-snug text-muted-foreground">
          Chains and bridges that more than one of this token&apos;s deployments depend on, so they can fail together.
        </p>
        <ul className="mt-3 space-y-2.5">
          {visibleRows.map((row) => <DomainRow key={row.key} row={row} />)}
        </ul>
        {overflowRows.length > 0 ? (
          <ModuleDisclosure label="All domains" count={view.rows.length}>
            <ul className="space-y-2.5 pb-1 pt-1">
              {overflowRows.map((row) => <DomainRow key={row.key} row={row} />)}
            </ul>
          </ModuleDisclosure>
        ) : null}
        <ModuleDisclosure label="Review notes">
          <ul className="space-y-2 pb-1 pt-1">
            {view.rows.map((row) => (
              <li key={row.key} className="text-[11px] leading-snug text-muted-foreground">
                <span className="font-medium text-foreground">{row.label}</span>: {row.reason}
                {row.modeledExposureShare != null && row.modeledExposureShare !== row.exposureShare
                  ? ` Modeled contribution (capped): ${Math.round(row.modeledExposureShare * 100)}%.`
                  : ""}
              </li>
            ))}
          </ul>
        </ModuleDisclosure>
      </div>

      {view.totalAdjustmentPoints > 0 ? (
        <div className="border-t border-border/50 px-4 py-3">
          <p className="text-[11px] leading-snug text-muted-foreground">
            Common-mode exposure costs this asset{" "}
            <span className="font-mono font-semibold text-foreground">
              {view.totalAdjustmentPoints.toFixed(1)}
            </span>{" "}
            points of its Safety Score.
          </p>
        </div>
      ) : null}
    </RailCard>
  );
}

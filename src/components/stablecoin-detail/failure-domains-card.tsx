"use client";

import { useState } from "react";
import { Link2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { InlineDisclosureToggle } from "@/components/stablecoin-detail/disclosure-toggles";
import { RailCard, RailCount } from "@/components/stablecoin-detail/rail-card";
import type { FailureDomainRow, FailureDomainsView } from "@/lib/failure-domains";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";

function shareLabel(row: FailureDomainRow): string {
  if (row.exposureShare === null) return "Unquantified";
  const pct = row.exposureShare * 100;
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

function DomainRow({ row, open }: { row: FailureDomainRow; open: boolean }) {
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
      {open ? <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{row.reason}</p> : null}
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
 * would misread "no penalty" as "no exposure".
 */
export function FailureDomainsCard({ view }: { view: FailureDomainsView | null }) {
  const [open, setOpen] = useState(false);
  if (view === null) return null;

  return (
    <RailCard
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
          {view.rows.map((row) => <DomainRow key={row.key} row={row} open={open} />)}
        </ul>
        <InlineDisclosureToggle
          open={open}
          onToggle={() => setOpen((value) => !value)}
          collapsedLabel="How each was measured"
          className="mt-2.5"
        />
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

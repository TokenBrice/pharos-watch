"use client";

import { useState } from "react";
import { ChevronDown, Link2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { FailureDomainRow, FailureDomainsView } from "@/lib/failure-domains";

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
              className="h-5 rounded-full border-rose-500/25 bg-rose-500/12 px-2 text-[10px] font-medium text-rose-700 dark:text-rose-400"
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
    <section className="pharos-card-shell overflow-hidden" aria-label="Shared failure domains">
      <div className="flex items-center justify-between gap-3 px-4 py-3.5">
        <div className="flex min-w-0 items-center gap-2">
          <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-sm font-medium text-muted-foreground">Shared failure domains</h2>
        </div>
        <span className="inline-flex h-6 shrink-0 items-center rounded-full bg-muted/70 px-2 font-mono text-xs font-medium text-muted-foreground">
          {view.rows.length}
        </span>
      </div>

      <div className="px-4 pb-4">
        <p className="text-[11px] leading-snug text-muted-foreground">
          Chains and bridges that more than one of this token&apos;s deployments depend on, so they can fail together.
        </p>
        <ul className="mt-3 space-y-2.5">
          {view.rows.map((row) => <DomainRow key={row.key} row={row} open={open} />)}
        </ul>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="pharos-focus-ring mt-2.5 inline-flex min-h-7 items-center gap-1 rounded-sm text-[11px] font-medium text-frost-blue"
        >
          {open ? "Show less" : "How each was measured"}
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} aria-hidden="true" />
        </button>
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
    </section>
  );
}

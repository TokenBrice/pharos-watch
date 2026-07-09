"use client";

import { XIcon } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useYieldCompareSelection } from "@/hooks/use-yield-compare-selection";
import { formatCurrency, formatPercent, formatScore } from "@shared/lib/format";
import {
  YIELD_SOURCE_DEPTH_DEFINITIONS,
  YIELD_SOURCE_POSTURE_DEFINITIONS,
  formatYieldSourceRiskSummary,
} from "@/lib/yield-source-risk";
import { formatYieldWarningSignal } from "@/lib/yield-constants";
import { formatYieldDecisionReasonLine } from "@/lib/yield-decision-ledger";
import { getLogoSrc, type LogoMap } from "@/lib/logos";
import type { YieldViewModelRow } from "@/lib/yield-view-model";

interface YieldCompareDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: readonly YieldViewModelRow[];
  logos: LogoMap;
}

interface CompareColumn {
  id: string;
  row: YieldViewModelRow | null;
}

interface CompareRowDescriptor {
  key: string;
  label: string;
  align: "left" | "right";
  render: (row: YieldViewModelRow) => string;
}

function formatSourcePosture(row: YieldViewModelRow): string {
  return row.sourcePosture ? (YIELD_SOURCE_POSTURE_DEFINITIONS[row.sourcePosture]?.label ?? row.sourcePosture) : "—";
}

function formatMaterialSourceRisk(row: YieldViewModelRow): string {
  const summary = formatYieldSourceRiskSummary(row.sourceRisk);
  return summary ? summary.replace(/^Source risk\s+/u, "") : "—";
}

function formatVenueTier(row: YieldViewModelRow): string {
  const tier = row.sourceRisk?.venueRiskTier ?? null;
  if (!tier) return "—";
  const label = tier.charAt(0).toUpperCase() + tier.slice(1);
  const weighted = row.sourceRisk?.venueRiskWeighted;
  const weightedLabel = typeof weighted === "number" && Number.isFinite(weighted) ? ` (${weighted.toFixed(1)}/5)` : "";
  const confidence = row.sourceRisk?.venueRiskConfidence;
  const confidenceLabel = confidence && confidence !== "verified" ? `, ${confidence} confidence` : "";
  return `${label}${weightedLabel}${confidenceLabel}`;
}

const COMPARE_ROW_DESCRIPTORS: readonly CompareRowDescriptor[] = [
  {
    key: "apy30d",
    label: "APY (30d)",
    align: "right",
    render: (row) => formatPercent(row.apy30d),
  },
  {
    key: "pys",
    label: "PYS",
    align: "right",
    render: (row) => (row.pharosYieldScore !== null ? formatScore(row.pharosYieldScore) : "—"),
  },
  {
    key: "safety",
    label: "Safety",
    align: "right",
    render: (row) =>
      row.safetyGrade && row.safetyGrade !== "NR"
        ? row.safetyGrade
        : row.safetyScore !== null
          ? `${Math.round(row.safetyScore)}/100`
          : "—",
  },
  {
    key: "source",
    label: "Source",
    align: "left",
    render: (row) => row.yieldSource,
  },
  {
    key: "sourcePosture",
    label: "Source posture",
    align: "left",
    render: formatSourcePosture,
  },
  {
    key: "sourceRisk",
    label: "Source risk",
    align: "right",
    render: formatMaterialSourceRisk,
  },
  {
    key: "venueTier",
    label: "Venue tier",
    align: "left",
    render: formatVenueTier,
  },
  {
    key: "decisionReason",
    label: "Decision reason",
    align: "left",
    render: (row) => formatYieldDecisionReasonLine(row.decisionLedger) ?? "—",
  },
  {
    key: "depth",
    label: "Depth",
    align: "left",
    render: (row) => YIELD_SOURCE_DEPTH_DEFINITIONS[row.sourceDepthLens]?.label ?? "—",
  },
  {
    key: "stability",
    label: "Stability",
    align: "right",
    render: (row) => (row.yieldStability !== null ? `${Math.round(row.yieldStability * 100)}%` : "—"),
  },
  {
    key: "warnings",
    label: "Warnings",
    align: "left",
    render: (row) =>
      row.warningSignals.length === 0
        ? "None"
        : row.warningSignals.map((signal) => formatYieldWarningSignal(signal)).join(", "),
  },
  {
    key: "benchmark",
    label: "Benchmark",
    align: "left",
    render: (row) => row.benchmarkLabel ?? "—",
  },
];

const PLACEHOLDER = "Coin not in current view";

export function YieldCompareDrawer({ open, onOpenChange, rows, logos }: YieldCompareDrawerProps) {
  const { ids, toggle } = useYieldCompareSelection();
  const rowsById = useMemo(() => new Map(rows.map((row) => [row.id, row] as const)), [rows]);
  const columns: CompareColumn[] = useMemo(
    () => ids.map((id) => ({ id, row: rowsById.get(id) ?? null })),
    [ids, rowsById],
  );
  const shareHref = useMemo(
    () => (ids.length > 0 ? `/yield/?compare=${encodeURIComponent(ids.join(","))}` : "/yield/"),
    [ids],
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Compare yield sources</SheetTitle>
          <SheetDescription>Side-by-side metrics for the {ids.length} coins you selected.</SheetDescription>
        </SheetHeader>

        <TableFrame
          tableId="yield-compare-drawer"
          testId="yield-compare-drawer-table"
          chrome="bare"
          density="compact"
          className="px-4 pb-2"
          tableClassName="min-w-[360px] sm:min-w-[480px] border-collapse text-sm"
          tableProps={{ "aria-label": "Yield source comparison" }}
          viewportProps={{ mobileScrollHint: false, compactBottomPadding: false }}
        >
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead
                scope="col"
                className="h-auto border-b border-border/60 px-0 py-2 pr-3 text-left text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground"
              >
                Metric
              </TableHead>
              {columns.map((column) => {
                const row = column.row;
                const symbol = row?.symbol ?? column.id;
                const name = row?.name ?? column.id;
                return (
                  <TableHead
                    key={column.id}
                    scope="col"
                    className="h-auto border-b border-border/60 px-2 py-2 text-left align-bottom"
                  >
                    <div className="flex items-center gap-2">
                      <StablecoinLogo src={getLogoSrc(logos, column.id)} name={name} size={20} />
                      <span className="font-medium text-foreground">{symbol}</span>
                      <button
                        type="button"
                        onClick={() => toggle(column.id)}
                        className="pharos-focus-ring ml-auto inline-flex items-center justify-center rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        aria-label={`Remove ${symbol} from compare`}
                      >
                        <XIcon className="h-3 w-3" aria-hidden="true" />
                      </button>
                    </div>
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {COMPARE_ROW_DESCRIPTORS.map((descriptor) => (
              <TableRow key={descriptor.key} className="border-b border-border/30 last:border-b-0">
                <TableHead
                  scope="row"
                  className="h-auto px-0 py-2 pr-3 text-left text-xs font-medium text-muted-foreground"
                >
                  {descriptor.label}
                </TableHead>
                {columns.map((column) => {
                  if (!column.row) {
                    return (
                      <TableCell key={column.id} className="px-2 py-2 text-left text-xs italic text-muted-foreground">
                        {PLACEHOLDER}
                      </TableCell>
                    );
                  }
                  const value = descriptor.render(column.row);
                  const cellClass =
                    descriptor.align === "right"
                      ? "px-2 py-2 text-right font-mono tabular-nums text-foreground"
                      : "px-2 py-2 text-left text-foreground";
                  return (
                    <TableCell key={column.id} className={cellClass}>
                      {value}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
            <TableRow className="hover:bg-transparent">
              <TableHead
                scope="row"
                className="h-auto px-0 py-2 pr-3 text-left text-xs font-medium text-muted-foreground"
              >
                TVL
              </TableHead>
              {columns.map((column) => (
                <TableCell key={column.id} className="px-2 py-2 text-right font-mono tabular-nums text-foreground">
                  {column.row && column.row.sourceTvlUsd !== null
                    ? formatCurrency(column.row.sourceTvlUsd)
                    : column.row
                      ? "—"
                      : ""}
                </TableCell>
              ))}
            </TableRow>
          </TableBody>
        </TableFrame>

        <SheetFooter>
          <Link
            href={shareHref}
            className="pharos-focus-ring text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Share this comparison &rarr;
          </Link>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

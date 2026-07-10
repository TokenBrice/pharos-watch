"use client";

import { CheckIcon, DownloadIcon, Share2Icon, XIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
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
import { getYieldDecisionReasonLine } from "@/lib/yield-workbench-row";
import { trackEvent } from "@/lib/analytics";
import { downloadCsvWithPreamble, type CsvColumn } from "@/lib/exports/csv";
import { getLogoSrc, type LogoMap } from "@/lib/logos";
import type { YieldViewModelRow } from "@/lib/yield-view-model";

interface YieldCompareDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: readonly YieldViewModelRow[];
  logos: LogoMap;
  updatedAt?: number;
  methodologyLabel?: string;
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
    render: (row) => getYieldDecisionReasonLine(row) ?? "—",
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

const COMPARE_EXPORT_COLUMNS: CsvColumn<YieldViewModelRow>[] = [
  { header: "ID", accessor: (row) => row.id },
  { header: "Symbol", accessor: (row) => row.symbol },
  { header: "Name", accessor: (row) => row.name },
  { header: "APY 30d (%)", accessor: (row) => row.apy30d },
  { header: "PYS", accessor: (row) => row.pharosYieldScore ?? "NR" },
  { header: "Safety grade", accessor: (row) => row.safetyGrade ?? "NR" },
  { header: "Safety score", accessor: (row) => row.safetyScore ?? "NR" },
  { header: "Source", accessor: (row) => row.yieldSource },
  { header: "Source posture", accessor: (row) => row.sourcePosture ?? "unknown" },
  { header: "Source risk score", accessor: (row) => row.sourceRisk?.sourceRiskScore ?? "unknown" },
  { header: "Venue risk tier", accessor: (row) => row.sourceRisk?.venueRiskTier ?? "unknown" },
  { header: "Depth", accessor: (row) => row.sourceDepthLens },
  { header: "Stability", accessor: (row) => row.yieldStability ?? "unknown" },
  { header: "Benchmark", accessor: (row) => row.benchmarkLabel ?? "unknown" },
  { header: "TVL USD", accessor: (row) => row.sourceTvlUsd ?? "unknown" },
  { header: "Warnings", accessor: (row) => row.warningSignals.join(" | ") },
  { header: "Provider URL", accessor: (row) => row.yieldSourceUrl ?? "" },
];

export function YieldCompareDrawer({
  open,
  onOpenChange,
  rows,
  logos,
  updatedAt = Math.floor(Date.now() / 1000),
  methodologyLabel = "Pharos Yield Score current",
}: YieldCompareDrawerProps) {
  const { ids, toggle } = useYieldCompareSelection();
  const [shareStatus, setShareStatus] = useState<"shared" | "copied" | "failed" | null>(null);
  const rowsById = useMemo(() => new Map(rows.map((row) => [row.id, row] as const)), [rows]);
  const columns: CompareColumn[] = useMemo(
    () => ids.map((id) => ({ id, row: rowsById.get(id) ?? null })),
    [ids, rowsById],
  );
  const shareHref = useMemo(
    () => (ids.length > 0 ? `/yield/?compare=${encodeURIComponent(ids.join(","))}` : "/yield/"),
    [ids],
  );
  const handleShare = useCallback(async () => {
    const url = new URL(shareHref, window.location.origin).href;
    const payload = {
      title: "Pharos Yield comparison",
      text: `Compare ${ids.length} stablecoin yield opportunities on Pharos.`,
      url,
    };

    if (typeof navigator.share === "function") {
      try {
        await navigator.share(payload);
        setShareStatus("shared");
        trackEvent("yield_comparison_shared", {
          method: "web_share",
          coin_count: ids.length,
          success: true,
        });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          trackEvent("yield_comparison_shared", {
            method: "web_share",
            coin_count: ids.length,
            success: false,
          });
          return;
        }
      }
    }

    try {
      await navigator.clipboard.writeText(url);
      setShareStatus("copied");
      trackEvent("yield_comparison_shared", {
        method: "clipboard",
        coin_count: ids.length,
        success: true,
      });
    } catch {
      setShareStatus("failed");
      trackEvent("yield_comparison_shared", {
        method: "clipboard",
        coin_count: ids.length,
        success: false,
      });
    }
  }, [ids.length, shareHref]);
  const handleExport = useCallback(() => {
    const selectedRows = columns.flatMap((column) => (column.row ? [column.row] : []));
    if (selectedRows.length === 0) return;
    downloadCsvWithPreamble(selectedRows, COMPARE_EXPORT_COLUMNS, "pharos-yield-comparison", {
      endpoint: "yield-rankings comparison",
      asOfISO: new Date(updatedAt * 1000).toISOString(),
      sourceUrl: new URL(shareHref, window.location.origin).href,
      methodologyLabel,
    });
    trackEvent("yield_exported", { scope: "comparison", row_count: selectedRows.length });
  }, [columns, methodologyLabel, shareHref, updatedAt]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Compare yield sources</SheetTitle>
          <SheetDescription>Side-by-side metrics for the {ids.length} coins you selected.</SheetDescription>
        </SheetHeader>

        <div className="space-y-3 px-4 pb-2 sm:hidden" data-testid="yield-compare-mobile-list">
          {columns.map((column) => {
            const row = column.row;
            const symbol = row?.symbol ?? column.id;
            const name = row?.name ?? column.id;
            return (
              <article key={column.id} className="rounded-lg border border-border/70 bg-background/45 p-3">
                <header className="flex items-center gap-2 border-b border-border/60 pb-2">
                  <StablecoinLogo src={getLogoSrc(logos, column.id)} name={name} size={24} />
                  <span className="min-w-0">
                    <span className="block font-semibold text-foreground">{symbol}</span>
                    <span className="block truncate text-xs text-muted-foreground">{name}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => toggle(column.id)}
                    className="pharos-focus-ring ml-auto inline-flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    aria-label={`Remove ${symbol} from compare`}
                  >
                    <XIcon className="h-4 w-4" aria-hidden="true" />
                  </button>
                </header>
                {row ? (
                  <dl className="divide-y divide-border/40">
                    {COMPARE_ROW_DESCRIPTORS.map((descriptor) => (
                      <div
                        key={descriptor.key}
                        className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-3 py-2 text-xs"
                      >
                        <dt className="text-muted-foreground">{descriptor.label}</dt>
                        <dd
                          className={
                            descriptor.align === "right"
                              ? "break-words text-right font-mono tabular-nums text-foreground"
                              : "break-words text-right text-foreground"
                          }
                        >
                          {descriptor.render(row)}
                        </dd>
                      </div>
                    ))}
                    <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-3 py-2 text-xs">
                      <dt className="text-muted-foreground">TVL</dt>
                      <dd className="text-right font-mono tabular-nums text-foreground">
                        {row.sourceTvlUsd !== null ? formatCurrency(row.sourceTvlUsd) : "—"}
                      </dd>
                    </div>
                  </dl>
                ) : (
                  <p className="py-4 text-xs italic text-muted-foreground">{PLACEHOLDER}</p>
                )}
              </article>
            );
          })}
        </div>

        <TableFrame
          tableId="yield-compare-drawer"
          testId="yield-compare-drawer-table"
          chrome="bare"
          density="compact"
          className="hidden px-4 pb-2 sm:block"
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
                        className="pharos-focus-ring ml-auto inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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

        <SheetFooter className="items-center gap-2">
          <button
            type="button"
            onClick={handleExport}
            disabled={columns.every((column) => column.row === null)}
            className="pharos-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full border border-border/70 bg-background px-4 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <DownloadIcon className="h-4 w-4" aria-hidden="true" />
            <span>Export CSV</span>
          </button>
          <button
            type="button"
            onClick={() => void handleShare()}
            disabled={ids.length === 0}
            className="pharos-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full border border-border/70 bg-background px-4 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {shareStatus === "shared" || shareStatus === "copied" ? (
              <CheckIcon className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            ) : (
              <Share2Icon className="h-4 w-4" aria-hidden="true" />
            )}
            <span>
              {shareStatus === "shared" ? "Shared" : shareStatus === "copied" ? "Link copied" : "Share comparison"}
            </span>
          </button>
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {shareStatus === "failed" ? "Sharing failed. Check browser permissions and try again." : ""}
          </span>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

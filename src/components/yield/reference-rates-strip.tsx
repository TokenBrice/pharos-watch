"use client";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import {
  getYieldBenchmarkDisplayHealthInput,
  getYieldBenchmarkDisplayLabel,
  resolveYieldBenchmarkDisplayHealth,
} from "@/lib/yield-benchmark";
import { deriveDataHealth, isPublicWarning } from "@/lib/data-health";
import { useFreshnessBoundary } from "@/hooks/use-freshness-boundary";
import { cn } from "@/lib/utils";
import { formatPercent } from "@shared/lib/format";
import { CRON_SCHEDULE_CADENCES } from "@shared/lib/cron-cadences";
import { PEG_CURRENCY_SYMBOLS } from "@shared/lib/peg-taxonomy";
import { CurrencyFlag } from "@/components/yield/currency-flag";
import type {
  YieldBenchmarkMeta,
  YieldBenchmarkRegistry,
  YieldSafetySnapshotMeta,
  YieldSourceInputMeta,
} from "@shared/types";

interface ReferenceRatesStripProps {
  benchmarks?: YieldBenchmarkRegistry | null;
  fallbackBenchmark?: YieldBenchmarkMeta | null;
  poolInputMeta?: YieldSourceInputMeta | null;
  safetySnapshot?: YieldSafetySnapshotMeta | null;
  /** Count of tracked /yield rows per currency, keyed by 3-char ISO code. */
  currencyCounts?: Record<string, number> | null;
}

interface BenchmarkRow {
  key: string;
  currency: string;
  currencySymbol: string | null;
  benchmarkLabel: string;
  rate: number;
  recordDate: string | null;
  meta: YieldBenchmarkMeta;
}

// Preserve strip-specific forms while sharing the canonical currency glyphs.
const CURRENCY_SYMBOL_OVERRIDES: Record<string, string> = {
  CHF: "Fr",
  MXN: "Mex$",
};

function getBenchmarkEntries(
  benchmarks: YieldBenchmarkRegistry | null | undefined,
  fallbackBenchmark: YieldBenchmarkMeta | null | undefined,
): YieldBenchmarkMeta[] {
  const entries = benchmarks ? Object.values(benchmarks) : fallbackBenchmark ? [fallbackBenchmark] : [];
  return entries.filter((b): b is YieldBenchmarkMeta => b != null);
}

function getBenchmarkRows(entries: YieldBenchmarkMeta[]): BenchmarkRow[] {
  return entries
    .map((b) => {
      const fullLabel = getYieldBenchmarkDisplayLabel(b);
      const currency = b.currency ?? b.key ?? "USD";
      // Strip the leading currency token from the display label so the
      // table's currency column carries that identification, not the
      // benchmark-name column.
      const benchmarkLabel = fullLabel.startsWith(`${currency} `) ? fullLabel.slice(currency.length + 1) : fullLabel;
      return {
        key: b.key ?? fullLabel ?? currency,
        currency,
        currencySymbol: CURRENCY_SYMBOL_OVERRIDES[currency] ?? PEG_CURRENCY_SYMBOLS[currency as keyof typeof PEG_CURRENCY_SYMBOLS] ?? null,
        benchmarkLabel,
        rate: b.rate,
        recordDate: b.recordDate,
        meta: b,
      };
    });
}

function formatSpread(deltaBps: number): string {
  // ASCII hyphen is replaced by a typographic minus for negative spreads so
  // the column reads cleanly in tabular mono alongside the "+" prefix.
  if (deltaBps === 0) return "0 bps";
  if (deltaBps > 0) return `+${Math.round(deltaBps)} bps`;
  return `−${Math.round(Math.abs(deltaBps))} bps`;
}

function formatPoolInputAge(meta: YieldSourceInputMeta): string {
  if (meta.ageSeconds != null) return `Pool input age ${Math.round(meta.ageSeconds / 60)}m`;
  if (meta.fallbackMode) return `Pool input: ${meta.fallbackMode}`;
  return "Pool input age unavailable";
}

function formatPoolInputMode(meta: YieldSourceInputMeta): string {
  if (meta.mode === "dex-cache") return "DEX-sync cached DeFiLlama pools.";
  if (meta.mode === "direct-fetch") return "Direct DeFiLlama pool fetch.";
  return "DeFiLlama pool input unavailable.";
}

export function ReferenceRatesStrip({
  benchmarks,
  fallbackBenchmark,
  poolInputMeta,
  safetySnapshot,
  currencyCounts,
}: ReferenceRatesStripProps) {
  const entries = getBenchmarkEntries(benchmarks, fallbackBenchmark);
  // Pool input ages from its original clock against the producer cadence; a null clock stays unavailable (ADR-42).
  const poolHealthInput = poolInputMeta?.updatedAt != null && poolInputMeta.updatedAt > 0 ? {
    label: "Pool input",
    dataUpdatedAt: poolInputMeta.updatedAt * 1000,
    staleTime: CRON_SCHEDULE_CADENCES.halfHourlyOffset.intervalSec * 1000,
    hasData: true,
  } : null;
  const nowMs = useFreshnessBoundary([
    ...(poolHealthInput ? [poolHealthInput] : []),
    ...entries.map(getYieldBenchmarkDisplayHealthInput),
  ]);
  const rows = getBenchmarkRows(entries);
  if (rows.length === 0 && !poolInputMeta && !safetySnapshot) return null;

  const safetyPct = safetySnapshot?.coverageRatio != null ? Math.round(safetySnapshot.coverageRatio * 100) : null;
  const poolIsStale = poolHealthInput != null && isPublicWarning(deriveDataHealth(poolHealthInput, nowMs));
  const hasFreshnessRow = !!poolInputMeta || !!safetySnapshot;
  // USD is the implicit baseline: every other currency's risk-free rate is
  // compared against it. If USD isn't in the registry, the spread column
  // shows em-dash for every row.
  const usdRow = rows.find((r) => r.currency === "USD") ?? null;
  const showCountColumn = !!currencyCounts;

  return (
    <TooltipProvider>
      <section aria-labelledby="yield-reference-rates-heading" className="pharos-card-shell overflow-hidden">
        <div className="space-y-4 px-4 py-4 sm:px-5">
          <div className="space-y-1">
            <p className="pharos-label">Reference rates</p>
            <h2 id="yield-reference-rates-heading" className="text-lg font-semibold tracking-tight text-foreground">
              Risk-free benchmark per currency
            </h2>
            <p className="text-sm text-muted-foreground">
              Each yield in the leaderboard is graded against the local risk-free benchmark. Excess yield is the spread
              above this rate.
            </p>
          </div>

          {rows.length > 0 ? (
            <TableFrame
              tableId="yield-reference-rates"
              testId="yield-reference-rates-table"
              chrome="content"
              density="compact"
              className="bg-card/20"
              tableClassName="min-w-[640px] border-collapse text-sm"
              tableProps={{ "aria-label": "Per-currency reference rates" }}
              viewportClassName="-mx-1 px-1"
              viewportProps={{ compactBottomPadding: false, mobileScrollHint: false }}
            >
              <TableHeader>
                <TableRow className="border-b border-border/40 text-left pharos-label hover:bg-transparent">
                  <TableHead scope="col" colSpan={2} className="py-2 pl-5 pr-3 font-medium">
                    Currency
                  </TableHead>
                  {showCountColumn ? (
                    <TableHead scope="col" className="px-3 py-2 text-right font-medium">
                      Tracked
                    </TableHead>
                  ) : null}
                  <TableHead scope="col" className="px-3 py-2 text-right font-medium">
                    Rate
                  </TableHead>
                  <TableHead scope="col" className="px-3 py-2 text-right font-medium">
                    vs USD
                  </TableHead>
                  <TableHead scope="col" className="px-3 py-2 font-medium">
                    Benchmark
                  </TableHead>
                  <TableHead scope="col" className="py-2 pl-3 text-right font-medium">
                    As of
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="divide-y divide-border/40">
                {rows.map((row) => {
                  const isUsd = row.currency === "USD";
                  const spreadBps = usdRow ? (row.rate - usdRow.rate) * 100 : null;
                  const dateIsStale = resolveYieldBenchmarkDisplayHealth(row.meta, nowMs).warning;
                  return (
                    <TableRow key={row.key} className="transition-colors hover:bg-muted/20">
                      <TableCell className="py-2 pr-2">
                        <CurrencyFlag currency={row.currency} />
                      </TableCell>
                      <TableCell className="py-2 pr-3 pharos-numeric text-xs text-foreground">
                        <span className="inline-flex items-baseline gap-2">
                          <span>{row.currency}</span>
                          {row.currencySymbol ? (
                            <span aria-hidden="true" className="text-muted-foreground/70">
                              {row.currencySymbol}
                            </span>
                          ) : null}
                        </span>
                      </TableCell>
                      {showCountColumn ? (
                        <TableCell className="px-3 py-2 text-right pharos-numeric text-xs text-muted-foreground">
                          {currencyCounts[row.currency] ?? 0}
                        </TableCell>
                      ) : null}
                      <TableCell className="px-3 py-2 text-right pharos-numeric text-base font-semibold text-foreground">
                        {formatPercent(row.rate)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "px-3 py-2 text-right pharos-numeric text-xs",
                          isUsd || spreadBps === null ? "text-muted-foreground/70" : "text-muted-foreground",
                        )}
                      >
                        {isUsd || spreadBps === null ? "—" : formatSpread(spreadBps)}
                      </TableCell>
                      <TableCell className="px-3 py-2 text-xs text-muted-foreground">{row.benchmarkLabel}</TableCell>
                      <TableCell
                        className={cn(
                          "py-2 pl-3 text-right pharos-numeric text-xs",
                          dateIsStale ? "text-state-warn-bright" : "text-muted-foreground/80",
                        )}
                      >
                        {row.recordDate ?? "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </TableFrame>
          ) : null}
        </div>

        {hasFreshnessRow ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/60 px-4 py-2 text-2xs text-muted-foreground sm:px-5">
            <span className="pharos-label">Data freshness</span>
            {poolInputMeta ? (
              <>
                <span aria-hidden="true" className="text-muted-foreground/40">
                  ·
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      tabIndex={0}
                      className={cn(
                        "pharos-focus-ring inline-flex min-h-6 items-center cursor-help rounded-sm",
                        poolIsStale ? "text-state-warn-bright" : undefined,
                      )}
                    >
                      {formatPoolInputAge(poolInputMeta)}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[260px] text-xs">
                    {formatPoolInputMode(poolInputMeta)}
                  </TooltipContent>
                </Tooltip>
              </>
            ) : null}
            {safetySnapshot ? (
              <>
                <span aria-hidden="true" className="text-muted-foreground/40">
                  ·
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      tabIndex={0}
                      className="pharos-focus-ring inline-flex min-h-6 items-center cursor-help rounded-sm"
                    >
                      {safetyPct === null ? (
                        "Safety coverage unavailable"
                      ) : (
                        <>
                          <span className="pharos-numeric text-foreground">{safetyPct}%</span> scored
                        </>
                      )}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[260px] text-xs">
                    {/* Retained measured coverage reads as neutral provenance; held/degraded reasons stay in the API and /status. */}
                    {safetyPct === null
                      ? (safetySnapshot.reason ?? "Safety coverage unavailable.")
                      : "Confidence-weighted source arbitration coverage across tracked rows."}
                  </TooltipContent>
                </Tooltip>
              </>
            ) : null}
          </div>
        ) : null}
      </section>
    </TooltipProvider>
  );
}

"use client";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { getYieldBenchmarkDisplayLabel } from "@/lib/yield-benchmark";
import { cn } from "@/lib/utils";
import { formatPercent } from "@shared/lib/format";
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
}

// Pool input is considered stale once it exceeds 2x the producer cron interval
// (DEX liquidity sync runs every 30 minutes per Pharos hook timing rule).
const POOL_STALE_THRESHOLD_SECONDS = 60 * 60;

// Currency glyph rendered alongside the ISO code. Where a currency shares the
// "$" mark with USD (AUD, CAD, SGD, BRL, MXN), the prefixed form disambiguates
// at a glance without relying on the ISO column alone.
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CHF: "Fr",
  AUD: "A$",
  CAD: "C$",
  BRL: "R$",
  MXN: "Mex$",
  ZAR: "R",
  CNY: "¥",
  CNH: "¥",
  TRY: "₺",
  IDR: "Rp",
  SGD: "S$",
  PHP: "₱",
};

function getBenchmarkRows(
  benchmarks: YieldBenchmarkRegistry | null | undefined,
  fallbackBenchmark: YieldBenchmarkMeta | null | undefined,
): BenchmarkRow[] {
  const entries = benchmarks ? Object.values(benchmarks) : fallbackBenchmark ? [fallbackBenchmark] : [];
  return entries
    .filter((b): b is YieldBenchmarkMeta => b != null)
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
        currencySymbol: CURRENCY_SYMBOLS[currency] ?? null,
        benchmarkLabel,
        rate: b.rate,
        recordDate: b.recordDate,
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
  const rows = getBenchmarkRows(benchmarks, fallbackBenchmark);
  if (rows.length === 0 && !poolInputMeta && !safetySnapshot) return null;

  const safetyPct = safetySnapshot ? Math.round(safetySnapshot.coverageRatio * 100) : null;
  const poolIsStale = poolInputMeta?.ageSeconds != null && poolInputMeta.ageSeconds > POOL_STALE_THRESHOLD_SECONDS;
  const hasFreshnessRow = !!poolInputMeta || (safetySnapshot && safetyPct !== null);
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
            <p className="pharos-kicker">Reference rates</p>
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
                <TableRow className="border-b border-border/40 text-left text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70 hover:bg-transparent">
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
                  return (
                    <TableRow key={row.key} className="transition-colors hover:bg-muted/20">
                      <TableCell className="py-2 pr-2">
                        <CurrencyFlag currency={row.currency} />
                      </TableCell>
                      <TableCell className="py-2 pr-3 font-mono text-xs tracking-[0.08em] text-foreground">
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
                      <TableCell className="py-2 pl-3 text-right pharos-numeric text-xs text-muted-foreground/80">
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
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/60 px-4 py-2 text-[11px] text-muted-foreground sm:px-5">
            <span className="font-medium uppercase tracking-[0.12em] text-muted-foreground/80">Data freshness</span>
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
                        poolIsStale ? "text-amber-700 dark:text-amber-300" : undefined,
                      )}
                    >
                      {formatPoolInputAge(poolInputMeta)}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[260px] text-xs">
                    {formatPoolInputMode(poolInputMeta)}
                    {poolIsStale ? " Older than the 30-minute liquidity cron — treat numbers as lagging." : ""}
                  </TooltipContent>
                </Tooltip>
              </>
            ) : null}
            {safetySnapshot && safetyPct !== null ? (
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
                      <span className="pharos-numeric text-foreground">{safetyPct}%</span> scored
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[260px] text-xs">
                    {safetySnapshot.kind === "ok"
                      ? "Confidence-weighted source arbitration coverage across tracked rows."
                      : (safetySnapshot.reason ?? "Safety snapshot degraded.")}
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

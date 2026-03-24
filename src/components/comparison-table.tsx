"use client";

import Link from "next/link";
import { useMemo } from "react";
import type { StablecoinData, StablecoinMeta, ReportCardGrade } from "@shared/types";
import { getCirculatingRaw, getPrevWeekRaw } from "@shared/lib/supply";
import { formatCurrency, formatNativePrice, formatScore, getNetColor, getNetPrefix } from "@shared/lib/format";
import { getPegReference } from "@shared/lib/peg-rates";
import { GOVERNANCE_LABELS_SHORT, BACKING_LABELS_SHORT } from "@shared/lib/classification";

const SAFETY_GRADE_ORDER: Record<ReportCardGrade, number> = {
  "A+": 12, A: 11, "A-": 10,
  "B+": 9,  B: 8,  "B-": 7,
  "C+": 6,  C: 5,  "C-": 4,
  D: 3, F: 2, NR: 1,
};
import { StablecoinLogo } from "@/components/stablecoin-logo";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { MethodologyLabel } from "@/components/methodology-hint";
import { buildStablecoinUrl } from "@/lib/urls";

interface ComparisonCoin {
  id: string;
  symbol: string;
  name: string;
  data: StablecoinData;
  meta: StablecoinMeta;
  pegScore: number | null;
  liquidityScore: number | null;
  safetyGrade: ReportCardGrade | null;
  netFlow30d: number | null;
}

interface ComparisonTableProps {
  coins: ComparisonCoin[];
  pegRates: Record<string, number>;
  logos?: Record<string, string>;
  detailErrors?: Record<string, boolean>;
}

// --- Best-value detection helpers ---

/** Find index of coin closest to its peg reference (smallest absolute deviation). */
function bestPriceIndex(
  coins: ComparisonCoin[],
  pegRates: Record<string, number>,
): number | null {
  let bestIdx: number | null = null;
  let bestDev = Infinity;
  for (let i = 0; i < coins.length; i++) {
    const { data, meta } = coins[i];
    if (data.price == null || typeof data.price !== "number" || isNaN(data.price)) continue;
    const ref = getPegReference(data.pegType, pegRates, meta.commodityOunces);
    if (ref <= 0) continue;
    const dev = Math.abs(data.price / ref - 1);
    if (dev < bestDev) {
      bestDev = dev;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Find index of coin with highest non-null numeric value. */
function bestHighestIndex(values: (number | null)[]): number | null {
  let bestIdx: number | null = null;
  let bestVal = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v != null && v > bestVal) {
      bestVal = v;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Find index of coin with best safety grade (highest SAFETY_GRADE_ORDER value). */
function bestGradeIndex(grades: (ReportCardGrade | null)[]): number | null {
  let bestIdx: number | null = null;
  let bestOrder = -1;
  for (let i = 0; i < grades.length; i++) {
    const g = grades[i];
    if (g == null) continue;
    const order = SAFETY_GRADE_ORDER[g] ?? 0;
    if (order > bestOrder) {
      bestOrder = order;
      bestIdx = i;
    }
  }
  return bestIdx;
}

const BEST_CLASS = "text-green-600 dark:text-green-400 font-semibold";

export function ComparisonTable({ coins, pegRates, logos, detailErrors }: ComparisonTableProps) {
  // Pre-compute row data
  const rowData = useMemo(() => {
    const prices = coins.map(({ data, meta }) => {
      const ref = getPegReference(data.pegType, pegRates, meta.commodityOunces);
      return formatNativePrice(data.price, meta.flags.pegCurrency, ref);
    });

    const pegScores = coins.map((c) => c.pegScore);

    const marketCaps = coins.map(({ data }) => getCirculatingRaw(data));

    const weeklyChanges = coins.map(({ data }) => {
      const current = getCirculatingRaw(data);
      const prev = getPrevWeekRaw(data);
      if (prev === 0) return null;
      return ((current - prev) / prev) * 100;
    });

    const liquidityScores = coins.map((c) => c.liquidityScore);

    const governanceLabels = coins.map(({ meta }) =>
      GOVERNANCE_LABELS_SHORT[meta.flags.governance] ?? meta.flags.governance,
    );

    const backingLabels = coins.map(({ meta }) =>
      BACKING_LABELS_SHORT[meta.flags.backing] ?? meta.flags.backing,
    );

    const pegCurrencies = coins.map(({ meta }) => meta.flags.pegCurrency);

    const safetyGrades = coins.map((c) => c.safetyGrade);

    const netFlow30dValues = coins.map((c) => c.netFlow30d);

    // Best indices
    const bestPrice = bestPriceIndex(coins, pegRates);
    const bestPegScore = bestHighestIndex(pegScores);

    const bestLiquidity = bestHighestIndex(liquidityScores);
    const bestGrade = bestGradeIndex(safetyGrades);
    const bestNetFlow30d = bestHighestIndex(netFlow30dValues);

    return {
      prices,
      pegScores,
      marketCaps,
      weeklyChanges,
      liquidityScores,
      governanceLabels,
      backingLabels,
      pegCurrencies,
      safetyGrades,
      netFlow30dValues,
      bestPrice,
      bestPegScore,

      bestLiquidity,
      bestGrade,
      bestNetFlow30d,
    };
  }, [coins, pegRates]);

  if (coins.length === 0) {
    return (
      <div className="pharos-empty-note py-8 text-center">
        Select stablecoins above to compare them side-by-side.
      </div>
    );
  }

  return (
    <>
      <div className="pharos-subtle-band">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <p className="pharos-kicker">At A Glance</p>
          <p className="pharos-meta">Green highlights mark the strongest relative read inside this selected set, not an absolute endorsement.</p>
        </div>
      </div>

      {/* Mobile: stacked cards per coin */}
      <div className="sm:hidden space-y-4">
        {coins.map((coin, i) => (
          <div key={coin.id} className="pharos-card-shell space-y-3 p-4">
            <div className="flex items-center gap-2">
              <StablecoinLogo src={logos?.[coin.id]} name={coin.name} size={28} />
              <div className="min-w-0">
                <span className="block text-sm font-semibold">{coin.symbol}</span>
                <span className="block truncate text-xs text-muted-foreground">{coin.name}</span>
              </div>
              {detailErrors?.[coin.id] && (
                <span className="text-xs text-destructive ml-auto">Chart unavailable</span>
              )}
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Price</dt>
              <dd className={`text-right font-mono tabular-nums ${i === rowData.bestPrice ? BEST_CLASS : ""}`}>{rowData.prices[i]}</dd>
              <dt className="text-muted-foreground"><MethodologyLabel topic="pegScore">Peg Score</MethodologyLabel></dt>
              <dd className={`text-right font-mono tabular-nums ${i === rowData.bestPegScore ? BEST_CLASS : ""}`}>
                {rowData.pegScores[i] != null ? formatScore(rowData.pegScores[i]) : "—"}
              </dd>
              <dt className="text-muted-foreground">Market Cap</dt>
              <dd className="text-right font-mono tabular-nums">{formatCurrency(rowData.marketCaps[i])}</dd>
              <dt className="text-muted-foreground">7d Change</dt>
              <dd className="text-right font-mono tabular-nums">
                {rowData.weeklyChanges[i] != null
                  ? `${rowData.weeklyChanges[i]! >= 0 ? "+" : ""}${rowData.weeklyChanges[i]!.toFixed(2)}%`
                  : "—"}
              </dd>
              <dt className="text-muted-foreground"><MethodologyLabel topic="liquidityScore">Liquidity</MethodologyLabel></dt>
              <dd className={`text-right font-mono tabular-nums ${i === rowData.bestLiquidity ? BEST_CLASS : ""}`}>
                {rowData.liquidityScores[i] != null ? formatScore(rowData.liquidityScores[i]) : "—"}
              </dd>
              <dt className="text-muted-foreground">Governance</dt>
              <dd className="text-right">{rowData.governanceLabels[i]}</dd>
              <dt className="text-muted-foreground">Backing</dt>
              <dd className="text-right">{rowData.backingLabels[i]}</dd>
              <dt className="text-muted-foreground">Peg</dt>
              <dd className="text-right">{rowData.pegCurrencies[i]}</dd>
              <dt className="text-muted-foreground"><MethodologyLabel topic="safetyScore">Safety Rating</MethodologyLabel></dt>
              <dd className={`text-right ${i === rowData.bestGrade ? BEST_CLASS : ""}`}>
                {rowData.safetyGrades[i] ?? "—"}
              </dd>
              <dt className="text-muted-foreground">Net Flow 30D</dt>
              <dd className={`text-right font-mono tabular-nums ${i === rowData.bestNetFlow30d ? BEST_CLASS : rowData.netFlow30dValues[i] != null ? getNetColor(rowData.netFlow30dValues[i]!) : ""}`}>
                {rowData.netFlow30dValues[i] != null
                  ? `${getNetPrefix(rowData.netFlow30dValues[i]!)}${formatCurrency(rowData.netFlow30dValues[i]!)}`
                  : "—"}
              </dd>
            </dl>
          </div>
        ))}
      </div>

      {/* Desktop: side-by-side table */}
      <div className="hidden sm:block">
        <div className="pharos-table-shell overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col" className="pharos-table-sticky-metric min-w-[110px]">Metric</TableHead>
                {coins.map((coin) => (
                <TableHead scope="col" key={coin.id} className="text-center min-w-[120px]">
                    <Link href={buildStablecoinUrl(coin.id)} className="pharos-focus-ring inline-flex w-full flex-col items-center gap-1 rounded-xl px-2 py-2">
                      <StablecoinLogo
                        src={logos?.[coin.id]}
                        name={coin.name}
                        size={28}
                      />
                      <span className="text-xs font-semibold">{coin.symbol}</span>
                      <span className="text-xs text-muted-foreground font-normal">{coin.name}</span>
                      {detailErrors?.[coin.id] && (
                        <span className="text-xs text-destructive">Chart data unavailable</span>
                      )}
                    </Link>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {/* Price */}
              <TableRow>
                <TableCell className="pharos-table-sticky-metric font-medium">Price</TableCell>
                {coins.map((coin, i) => (
                  <TableCell
                    key={coin.id}
                    className={`text-center font-mono tabular-nums ${i === rowData.bestPrice ? BEST_CLASS : ""}`}
                  >
                    {rowData.prices[i]}
                  </TableCell>
                ))}
              </TableRow>

              {/* Peg Score */}
              <TableRow>
                <TableCell className="pharos-table-sticky-metric font-medium"><MethodologyLabel topic="pegScore">Peg Score</MethodologyLabel></TableCell>
                {coins.map((coin, i) => (
                  <TableCell
                    key={coin.id}
                    className={`text-center font-mono tabular-nums ${i === rowData.bestPegScore ? BEST_CLASS : ""}`}
                  >
                    {rowData.pegScores[i] != null
                      ? formatScore(rowData.pegScores[i])
                      : "—"}
                  </TableCell>
                ))}
              </TableRow>

            {/* Market Cap */}
            <TableRow>
              <TableCell className="pharos-table-sticky-metric font-medium">Market Cap</TableCell>
              {coins.map((coin, i) => (
                <TableCell
                  key={coin.id}
                  className="text-center font-mono tabular-nums"
                >
                  {formatCurrency(rowData.marketCaps[i])}
                </TableCell>
              ))}
            </TableRow>

            {/* 7d Change */}
            <TableRow>
              <TableCell className="pharos-table-sticky-metric font-medium">7d Change</TableCell>
              {coins.map((coin, i) => {
                const change = rowData.weeklyChanges[i];
                const sign = change != null && change >= 0 ? "+" : "";
                return (
                  <TableCell
                    key={coin.id}
                    className="text-center font-mono tabular-nums"
                  >
                    {change != null ? `${sign}${change.toFixed(2)}%` : "—"}
                  </TableCell>
                );
              })}
            </TableRow>

            {/* Liquidity Score */}
            <TableRow>
              <TableCell className="pharos-table-sticky-metric font-medium"><MethodologyLabel topic="liquidityScore">Liquidity Score</MethodologyLabel></TableCell>
              {coins.map((coin, i) => (
                <TableCell
                  key={coin.id}
                  className={`text-center font-mono tabular-nums ${i === rowData.bestLiquidity ? BEST_CLASS : ""}`}
                >
                  {rowData.liquidityScores[i] != null
                    ? formatScore(rowData.liquidityScores[i])
                    : "—"}
                </TableCell>
              ))}
            </TableRow>

            {/* Governance */}
            <TableRow>
              <TableCell className="pharos-table-sticky-metric font-medium">Governance</TableCell>
              {coins.map((coin, i) => (
                <TableCell key={coin.id} className="text-center">
                  {rowData.governanceLabels[i]}
                </TableCell>
              ))}
            </TableRow>

            {/* Backing */}
            <TableRow>
              <TableCell className="pharos-table-sticky-metric font-medium">Backing</TableCell>
              {coins.map((coin, i) => (
                <TableCell key={coin.id} className="text-center">
                  {rowData.backingLabels[i]}
                </TableCell>
              ))}
            </TableRow>

            {/* Peg Currency */}
            <TableRow>
              <TableCell className="pharos-table-sticky-metric font-medium">Peg Currency</TableCell>
              {coins.map((coin, i) => (
                <TableCell key={coin.id} className="text-center">
                  {rowData.pegCurrencies[i]}
                </TableCell>
              ))}
            </TableRow>

            {/* Safety Rating */}
            <TableRow>
              <TableCell className="pharos-table-sticky-metric font-medium"><MethodologyLabel topic="safetyScore">Safety Rating</MethodologyLabel></TableCell>
              {coins.map((coin, i) => (
                <TableCell
                  key={coin.id}
                  className={`text-center ${i === rowData.bestGrade ? BEST_CLASS : ""}`}
                >
                  {rowData.safetyGrades[i] ?? "—"}
                </TableCell>
              ))}
            </TableRow>

            {/* Net Flow 30D */}
            <TableRow>
              <TableCell className="pharos-table-sticky-metric font-medium">Net Flow 30D</TableCell>
              {coins.map((coin, i) => {
                const val = rowData.netFlow30dValues[i];
                return (
                  <TableCell
                    key={coin.id}
                    className={`text-center font-mono tabular-nums ${i === rowData.bestNetFlow30d ? BEST_CLASS : val != null ? getNetColor(val) : ""}`}
                  >
                    {val != null ? `${getNetPrefix(val)}${formatCurrency(val)}` : "—"}
                  </TableCell>
                );
              })}
            </TableRow>
          </TableBody>
        </Table>
        </div>
      </div>
    </>
  );
}

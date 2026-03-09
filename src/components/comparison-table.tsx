"use client";

import { useMemo } from "react";
import type { StablecoinData, StablecoinMeta, ReportCardGrade } from "@shared/types";
import { getCirculatingRaw, getPrevWeekRaw } from "@shared/lib/supply";
import { formatCurrency, formatNativePrice, formatScore } from "@shared/lib/format";
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

interface ComparisonCoin {
  id: string;
  symbol: string;
  name: string;
  data: StablecoinData;
  meta: StablecoinMeta;
  pegScore: number | null;
  liquidityScore: number | null;
  safetyGrade: ReportCardGrade | null;
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

    // Best indices
    const bestPrice = bestPriceIndex(coins, pegRates);
    const bestPegScore = bestHighestIndex(pegScores);

    const bestLiquidity = bestHighestIndex(liquidityScores);
    const bestGrade = bestGradeIndex(safetyGrades);

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
      bestPrice,
      bestPegScore,

      bestLiquidity,
      bestGrade,
    };
  }, [coins, pegRates]);

  if (coins.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        Select stablecoins above to compare them side-by-side.
      </p>
    );
  }

  return (
    <>
      {/* Mobile: stacked cards per coin */}
      <div className="sm:hidden space-y-4">
        {coins.map((coin, i) => (
          <div key={coin.id} className="rounded-lg border p-4 space-y-3">
            <div className="flex items-center gap-2">
              <StablecoinLogo src={logos?.[coin.id]} name={coin.name} size={28} />
              <div>
                <span className="font-semibold text-sm">{coin.symbol}</span>
                <span className="text-xs text-muted-foreground ml-1.5">{coin.name}</span>
              </div>
              {detailErrors?.[coin.id] && (
                <span className="text-xs text-destructive ml-auto">Chart unavailable</span>
              )}
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Price</dt>
              <dd className={`text-right font-mono tabular-nums ${i === rowData.bestPrice ? BEST_CLASS : ""}`}>{rowData.prices[i]}</dd>
              <dt className="text-muted-foreground">Peg Score</dt>
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
              <dt className="text-muted-foreground">Liquidity</dt>
              <dd className={`text-right font-mono tabular-nums ${i === rowData.bestLiquidity ? BEST_CLASS : ""}`}>
                {rowData.liquidityScores[i] != null ? formatScore(rowData.liquidityScores[i]) : "—"}
              </dd>
              <dt className="text-muted-foreground">Governance</dt>
              <dd className="text-right">{rowData.governanceLabels[i]}</dd>
              <dt className="text-muted-foreground">Backing</dt>
              <dd className="text-right">{rowData.backingLabels[i]}</dd>
              <dt className="text-muted-foreground">Peg</dt>
              <dd className="text-right">{rowData.pegCurrencies[i]}</dd>
              <dt className="text-muted-foreground">Safety Rating</dt>
              <dd className={`text-right ${i === rowData.bestGrade ? BEST_CLASS : ""}`}>
                {rowData.safetyGrades[i] ?? "—"}
              </dd>
            </dl>
          </div>
        ))}
      </div>

      {/* Desktop: side-by-side table */}
      <div className="hidden sm:block">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col" className="min-w-[80px]">Metric</TableHead>
                {coins.map((coin) => (
                <TableHead scope="col" key={coin.id} className="text-center min-w-[120px]">
                    <div className="flex flex-col items-center gap-1">
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
                    </div>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {/* Price */}
              <TableRow>
                <TableCell className="font-medium">Price</TableCell>
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
                <TableCell className="font-medium">Peg Score</TableCell>
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
              <TableCell className="font-medium">Market Cap</TableCell>
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
              <TableCell className="font-medium">7d Change</TableCell>
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
              <TableCell className="font-medium">Liquidity Score</TableCell>
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
              <TableCell className="font-medium">Governance</TableCell>
              {coins.map((coin, i) => (
                <TableCell key={coin.id} className="text-center">
                  {rowData.governanceLabels[i]}
                </TableCell>
              ))}
            </TableRow>

            {/* Backing */}
            <TableRow>
              <TableCell className="font-medium">Backing</TableCell>
              {coins.map((coin, i) => (
                <TableCell key={coin.id} className="text-center">
                  {rowData.backingLabels[i]}
                </TableCell>
              ))}
            </TableRow>

            {/* Peg Currency */}
            <TableRow>
              <TableCell className="font-medium">Peg Currency</TableCell>
              {coins.map((coin, i) => (
                <TableCell key={coin.id} className="text-center">
                  {rowData.pegCurrencies[i]}
                </TableCell>
              ))}
            </TableRow>

            {/* Safety Rating */}
            <TableRow>
              <TableCell className="font-medium">Safety Rating</TableCell>
              {coins.map((coin, i) => (
                <TableCell
                  key={coin.id}
                  className={`text-center ${i === rowData.bestGrade ? BEST_CLASS : ""}`}
                >
                  {rowData.safetyGrades[i] ?? "—"}
                </TableCell>
              ))}
            </TableRow>
          </TableBody>
        </Table>
        </div>
      </div>
    </>
  );
}

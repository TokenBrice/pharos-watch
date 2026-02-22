"use client";

import { useMemo } from "react";
import type { StablecoinData, StablecoinMeta, BluechipGrade } from "@/lib/types";
import { getCirculatingRaw, getPrevWeekRaw } from "@/lib/supply";
import { formatCurrency, formatNativePrice } from "@/lib/format";
import { getPegReference } from "@/lib/peg-rates";
import { GRADE_ORDER } from "@/lib/bluechip";
import { GOVERNANCE_LABELS_SHORT, BACKING_LABELS_SHORT } from "@/lib/classification";
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
  bluechipGrade: BluechipGrade | null;
}

interface ComparisonTableProps {
  coins: ComparisonCoin[];
  pegRates: Record<string, number>;
  logos?: Record<string, string>;
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

/** Find index of coin with best bluechip grade (highest GRADE_ORDER value). */
function bestGradeIndex(grades: (BluechipGrade | null)[]): number | null {
  let bestIdx: number | null = null;
  let bestOrder = -1;
  for (let i = 0; i < grades.length; i++) {
    const g = grades[i];
    if (g == null) continue;
    const order = GRADE_ORDER[g] ?? 0;
    if (order > bestOrder) {
      bestOrder = order;
      bestIdx = i;
    }
  }
  return bestIdx;
}

const BEST_CLASS = "text-green-600 dark:text-green-400 font-semibold";

export function ComparisonTable({ coins, pegRates, logos }: ComparisonTableProps) {
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

    const bluechipGrades = coins.map((c) => c.bluechipGrade);

    // Best indices
    const bestPrice = bestPriceIndex(coins, pegRates);
    const bestPegScore = bestHighestIndex(pegScores);
    const bestMarketCap = bestHighestIndex(marketCaps);
    const bestLiquidity = bestHighestIndex(liquidityScores);
    const bestGrade = bestGradeIndex(bluechipGrades);

    return {
      prices,
      pegScores,
      marketCaps,
      weeklyChanges,
      liquidityScores,
      governanceLabels,
      backingLabels,
      pegCurrencies,
      bluechipGrades,
      bestPrice,
      bestPegScore,
      bestMarketCap,
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
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="min-w-[80px]">Metric</TableHead>
          {coins.map((coin) => (
            <TableHead key={coin.id} className="text-center min-w-[120px]">
              <div className="flex flex-col items-center gap-1">
                <StablecoinLogo
                  src={logos?.[coin.id]}
                  name={coin.name}
                  size={28}
                />
                <span className="text-xs font-semibold">{coin.symbol}</span>
                <span className="text-xs text-muted-foreground font-normal">{coin.name}</span>
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
                ? `${rowData.pegScores[i]!.toFixed(1)}/10`
                : "N/A"}
            </TableCell>
          ))}
        </TableRow>

        {/* Market Cap */}
        <TableRow>
          <TableCell className="font-medium">Market Cap</TableCell>
          {coins.map((coin, i) => (
            <TableCell
              key={coin.id}
              className={`text-center font-mono tabular-nums ${i === rowData.bestMarketCap ? BEST_CLASS : ""}`}
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
                {change != null ? `${sign}${change.toFixed(2)}%` : "N/A"}
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
                ? `${rowData.liquidityScores[i]!.toFixed(1)}/10`
                : "N/A"}
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

        {/* Bluechip Rating */}
        <TableRow>
          <TableCell className="font-medium">Bluechip Rating</TableCell>
          {coins.map((coin, i) => (
            <TableCell
              key={coin.id}
              className={`text-center ${i === rowData.bestGrade ? BEST_CLASS : ""}`}
            >
              {rowData.bluechipGrades[i] ?? "N/A"}
            </TableCell>
          ))}
        </TableRow>
      </TableBody>
    </Table>
  );
}

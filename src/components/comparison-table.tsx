"use client";

import Link from "next/link";
import { Fragment, memo, useMemo, type ReactNode } from "react";
import type { StablecoinData, ReportCardGrade } from "@shared/types";
import { getCirculatingRaw, getPrevWeekRaw } from "@shared/lib/supply";
import { formatCurrency, formatNativePrice, formatScore, formatSignedCurrency, getNetColor } from "@shared/lib/format";
import { getPegReference } from "@shared/lib/peg-rates";
import { GOVERNANCE_LABELS_SHORT, BACKING_LABELS_SHORT } from "@shared/lib/classification";
import {
  getReportCardGradeRank,
  UNKNOWN_REPORT_CARD_GRADE_RANK,
} from "@shared/lib/report-card-core";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import {
  MatrixTable,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/table";
import { MethodologyLabel } from "@/components/methodology-hint";
import { buildStablecoinUrl } from "@/lib/urls";
import type { ComparisonMeta } from "@/lib/compare-derive";

interface ComparisonCoin {
  id: string;
  symbol: string;
  name: string;
  data: StablecoinData;
  meta: ComparisonMeta;
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

/** Find index of coin with best safety grade; unknown-like values sort below NR. */
function bestGradeIndex(grades: (ReportCardGrade | null)[]): number | null {
  let bestIdx: number | null = null;
  let bestOrder = UNKNOWN_REPORT_CARD_GRADE_RANK;
  for (let i = 0; i < grades.length; i++) {
    const g = grades[i];
    if (g == null) continue;
    const order = getReportCardGradeRank(g, UNKNOWN_REPORT_CARD_GRADE_RANK) ?? UNKNOWN_REPORT_CARD_GRADE_RANK;
    if (order > bestOrder) {
      bestOrder = order;
      bestIdx = i;
    }
  }
  return bestIdx;
}

const BEST_CLASS = "text-green-600 dark:text-green-400 font-semibold";
const FROZEN_NULL_TITLE = "No live data — coin is frozen";

function NullCell({ frozen }: { frozen: boolean }) {
  return frozen ? <span title={FROZEN_NULL_TITLE}>—</span> : <>—</>;
}

function FrozenBadge({ frozenAt }: { frozenAt?: string }) {
  return (
    <span
      className="ml-1 rounded border border-zinc-500/30 px-1 text-[9px] uppercase tracking-wide text-zinc-500"
      title={frozenAt ? `Frozen on ${frozenAt}` : "Frozen"}
    >
      Frozen
    </span>
  );
}

interface ComparisonMetric {
  key: string;
  mobileLabel: ReactNode;
  desktopLabel: ReactNode;
  renderValue: (coin: ComparisonCoin, index: number) => ReactNode;
  valueClassName: (coin: ComparisonCoin, index: number, isDesktop: boolean) => string;
}

export const ComparisonTable = memo(function ComparisonTable({ coins, pegRates, logos, detailErrors }: ComparisonTableProps) {
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

  const comparisonMetrics = useMemo<ComparisonMetric[]>(
    () => [
      {
        key: "price",
        mobileLabel: "Price",
        desktopLabel: "Price",
        renderValue: (_coin, i) => rowData.prices[i],
        valueClassName: (_coin, i, isDesktop) =>
          `${isDesktop ? "text-center" : "text-right"} pharos-numeric ${i === rowData.bestPrice ? BEST_CLASS : ""}`,
      },
      {
        key: "peg-score",
        mobileLabel: <MethodologyLabel topic="pegScore">Peg Score</MethodologyLabel>,
        desktopLabel: <MethodologyLabel topic="pegScore">Peg Score</MethodologyLabel>,
        renderValue: (coin, i) =>
          rowData.pegScores[i] != null
            ? formatScore(rowData.pegScores[i])
            : <NullCell frozen={coin.meta.status === "frozen"} />,
        valueClassName: (_coin, i, isDesktop) =>
          `${isDesktop ? "text-center" : "text-right"} pharos-numeric ${i === rowData.bestPegScore ? BEST_CLASS : ""}`,
      },
      {
        key: "market-cap",
        mobileLabel: "Market Cap",
        desktopLabel: "Market Cap",
        renderValue: (_coin, i) => formatCurrency(rowData.marketCaps[i]),
        valueClassName: (_coin, _i, isDesktop) =>
          `${isDesktop ? "text-center" : "text-right"} pharos-numeric`,
      },
      {
        key: "weekly-change",
        mobileLabel: "7d Change",
        desktopLabel: "7d Change",
        renderValue: (coin, i) => {
          const change = rowData.weeklyChanges[i];
          const sign = change != null && change >= 0 ? "+" : "";
          return change != null ? `${sign}${change.toFixed(2)}%` : <NullCell frozen={coin.meta.status === "frozen"} />;
        },
        valueClassName: (_coin, _i, isDesktop) =>
          `${isDesktop ? "text-center" : "text-right"} pharos-numeric`,
      },
      {
        key: "liquidity-score",
        mobileLabel: <MethodologyLabel topic="liquidityScore">Liquidity</MethodologyLabel>,
        desktopLabel: <MethodologyLabel topic="liquidityScore">Liquidity Score</MethodologyLabel>,
        renderValue: (coin, i) =>
          rowData.liquidityScores[i] != null
            ? formatScore(rowData.liquidityScores[i])
            : <NullCell frozen={coin.meta.status === "frozen"} />,
        valueClassName: (_coin, i, isDesktop) =>
          `${isDesktop ? "text-center" : "text-right"} pharos-numeric ${i === rowData.bestLiquidity ? BEST_CLASS : ""}`,
      },
      {
        key: "governance",
        mobileLabel: "Governance",
        desktopLabel: "Governance",
        renderValue: (_coin, i) => rowData.governanceLabels[i],
        valueClassName: (_coin, _i, isDesktop) => (isDesktop ? "text-center" : "text-right"),
      },
      {
        key: "backing",
        mobileLabel: "Backing",
        desktopLabel: "Backing",
        renderValue: (_coin, i) => rowData.backingLabels[i],
        valueClassName: (_coin, _i, isDesktop) => (isDesktop ? "text-center" : "text-right"),
      },
      {
        key: "peg-currency",
        mobileLabel: "Peg",
        desktopLabel: "Peg Currency",
        renderValue: (_coin, i) => rowData.pegCurrencies[i],
        valueClassName: (_coin, _i, isDesktop) => (isDesktop ? "text-center" : "text-right"),
      },
      {
        key: "safety-rating",
        mobileLabel: <MethodologyLabel topic="safetyScore">Safety Rating</MethodologyLabel>,
        desktopLabel: <MethodologyLabel topic="safetyScore">Safety Rating</MethodologyLabel>,
        renderValue: (coin, i) => rowData.safetyGrades[i] ?? <NullCell frozen={coin.meta.status === "frozen"} />,
        valueClassName: (_coin, i, isDesktop) =>
          `${isDesktop ? "text-center" : "text-right"} ${i === rowData.bestGrade ? BEST_CLASS : ""}`,
      },
      {
        key: "net-flow-30d",
        mobileLabel: "Net Flow 30D",
        desktopLabel: "Net Flow 30D",
        renderValue: (coin, i) =>
          rowData.netFlow30dValues[i] != null
            ? formatSignedCurrency(rowData.netFlow30dValues[i]!)
            : <NullCell frozen={coin.meta.status === "frozen"} />,
        valueClassName: (_coin, i, isDesktop) => {
          const value = rowData.netFlow30dValues[i];
          return `${isDesktop ? "text-center" : "text-right"} pharos-numeric ${
            i === rowData.bestNetFlow30d ? BEST_CLASS : value != null ? getNetColor(value) : ""
          }`;
        },
      },
    ],
    [rowData],
  );

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
                <h3 className="text-sm font-semibold">
                  {coin.symbol}
                  {coin.meta.status === "frozen" ? <FrozenBadge frozenAt={coin.meta.frozenAt} /> : null}
                </h3>
                <p className="truncate text-xs text-muted-foreground">{coin.name}</p>
              </div>
              {detailErrors?.[coin.id] && (
                <span className="text-xs text-destructive ml-auto">Chart unavailable</span>
              )}
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              {comparisonMetrics.map((metric) => (
                <Fragment key={metric.key}>
                  <dt className="text-muted-foreground">{metric.mobileLabel}</dt>
                  <dd className={metric.valueClassName(coin, i, false)}>{metric.renderValue(coin, i)}</dd>
                </Fragment>
              ))}
            </dl>
          </div>
        ))}
      </div>

      {/* Desktop: side-by-side table */}
      <div className="hidden sm:block">
        <MatrixTable
          tableId="live-comparison-matrix"
          testId="live-comparison-matrix-table"
          role="region"
          aria-label="Comparison table"
          tabIndex={0}
          tableAriaLabel="Comparison table"
          viewportProps={{ mobileScrollHint: false }}
        >
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
                    <span className="text-xs font-semibold">
                      {coin.symbol}
                      {coin.meta.status === "frozen" ? <FrozenBadge frozenAt={coin.meta.frozenAt} /> : null}
                    </span>
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
            {comparisonMetrics.map((metric) => (
              <TableRow key={metric.key}>
                <TableHead scope="row" className="pharos-table-sticky-metric font-medium text-foreground">
                  {metric.desktopLabel}
                </TableHead>
                {coins.map((coin, i) => (
                  <TableCell key={coin.id} className={metric.valueClassName(coin, i, true)}>
                    {metric.renderValue(coin, i)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </MatrixTable>
      </div>
    </>
  );
});

"use client";

import Link from "next/link";
import { Star } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { TableCell, TableRow } from "@/components/ui/table";
import {
  BACKING_COLORS,
  GOVERNANCE_COLORS,
  BACKING_LABELS_SHORT,
  GOVERNANCE_LABELS_SHORT,
} from "@shared/lib/classification";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/report-cards";
import { formatCurrency, formatNativePrice, formatPegDeviation, formatPercentChange } from "@shared/lib/format";
import { getPegReference } from "@shared/lib/peg-rates";
import { getCirculatingRaw, getPrevDayRaw, getPrevWeekRaw } from "@shared/lib/supply";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { DexLiquidityMap, PegSummaryCoin, ReportCard, StablecoinData } from "@shared/types";
import type { ColumnId } from "@/hooks/use-preferences";
import { getResolvedBlacklistStatus } from "@/lib/blacklist-status";
import { confidenceClass } from "@/lib/confidence";
import { deviationColorClass, getScoreColor, pegScoreColor } from "@/lib/severity-colors";
import { buildStablecoinUrl } from "@/lib/urls";
import { getStablecoinTableRowRiskLevel } from "@/components/stablecoin-table-logic";
import { DeviationIcon } from "@/components/severity-icon";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { getVariantAccessibleLabel, getVariantDisplay } from "@/lib/variant-display";
import type { TableDensity } from "@/hooks/use-table-density";

interface StablecoinVirtualRowProps {
  coin: StablecoinData;
  rank: number;
  isStriped: boolean;
  densityConfig: {
    rowHeight: number;
    iconSize: number;
  };
  density: TableDensity;
  isVisible: (id: ColumnId) => boolean;
  logos?: Record<string, string>;
  pegRates: Record<string, number>;
  pegScores?: Map<string, PegSummaryCoin>;
  dexLiquidity?: DexLiquidityMap;
  reportCards?: Record<string, ReportCard>;
  showPinnedControl?: boolean;
  isPinned?: boolean;
  onTogglePinned?: (coinId: string) => void;
  onNavigate: (coinId: string) => void;
  onPrefetch: (coinId: string) => void;
}

function MiniSparkline({ values }: { values: number[] }) {
  if (values.length < 2 || values.every((v) => v === 0)) return null;
  const min = values.reduce((m, v) => Math.min(m, v), Infinity);
  const max = values.reduce((m, v) => Math.max(m, v), -Infinity);
  const range = max - min || 1;
  const h = 16;
  const w = 40;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - min) / range) * h;
      return `${x},${y}`;
    })
    .join(" ");
  const trending = values[values.length - 1] >= values[0];
  return (
    <svg width={w} height={h} viewBox="0 0 40 16" className="inline-block align-middle mr-1" aria-hidden="true">
      <polyline
        points={points}
        fill="none"
        stroke={trending ? "var(--color-green-500, #22c55e)" : "var(--color-red-500, #ef4444)"}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function StablecoinVirtualRow({
  coin,
  rank,
  isStriped,
  densityConfig,
  density,
  isVisible,
  logos,
  pegRates,
  pegScores,
  dexLiquidity,
  reportCards,
  showPinnedControl = false,
  isPinned = false,
  onTogglePinned,
  onNavigate,
  onPrefetch,
}: StablecoinVirtualRowProps) {
  const circulating = getCirculatingRaw(coin);
  const prevDay = getPrevDayRaw(coin);
  const prevWeek = getPrevWeekRaw(coin);
  const meta = TRACKED_META_BY_ID.get(coin.id);
  const variantDisplay = meta?.variantKind ? getVariantDisplay(meta.variantKind) : null;
  const variantContext = meta?.variantKind ? getVariantAccessibleLabel(meta.variantKind) : null;
  const blacklistStatus = getResolvedBlacklistStatus(coin.id, reportCards?.[coin.id]);
  const change24h = prevDay > 0 ? ((circulating - prevDay) / prevDay) * 100 : 0;
  const change7d = prevWeek > 0 ? ((circulating - prevWeek) / prevWeek) * 100 : 0;

  const riskLevel = getStablecoinTableRowRiskLevel(coin, pegScores, reportCards);
  const riskClass = riskLevel === "depeg" ? "pharos-row-risk-depeg" :
    riskLevel === "poor" ? "pharos-row-risk-poor" :
    riskLevel === "warning" ? "pharos-row-risk-warning" : "";
  const isCompactDensity = density === "list" || density === "compact";

  function isNestedInteractiveTarget(
    target: EventTarget | null,
    currentTarget: EventTarget | null,
  ): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const interactiveAncestor = target.closest("a,button,input,select,textarea,[role=\"button\"],[role=\"link\"]");
    return interactiveAncestor != null && interactiveAncestor !== currentTarget;
  }

  return (
    <TableRow
      key={coin.id}
      className={`group cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none ${riskClass}`}
      style={{ height: densityConfig.rowHeight }}
      data-row-striped={isStriped ? "true" : undefined}
      onClick={(event) => {
        if (isNestedInteractiveTarget(event.target, event.currentTarget)) return;
        onNavigate(coin.id);
      }}
      onMouseEnter={() => onPrefetch(coin.id)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || isNestedInteractiveTarget(e.target, e.currentTarget)) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onNavigate(coin.id);
        }
      }}
      role="link"
      aria-label={`View ${coin.name} (${coin.symbol}) details${variantContext ? `, ${variantContext}` : ""}`}
      tabIndex={0}
    >
      {showPinnedControl && (
        <TableCell className="text-center">
          {onTogglePinned && (
            <button
              type="button"
              aria-label={`${isPinned ? "Unstar" : "Star"} ${coin.symbol}`}
              aria-pressed={isPinned}
              title={`${isPinned ? "Unstar" : "Star"} ${coin.symbol}`}
              className={`pharos-focus-ring inline-flex size-6 items-center justify-center rounded-md transition-colors ${
                isPinned
                  ? "bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 dark:text-amber-300"
                  : "text-muted-foreground opacity-80 hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
              }`}
              onClick={(e) => {
                e.stopPropagation();
                onTogglePinned(coin.id);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
              }}
            >
              <Star className={`h-3.5 w-3.5 ${isPinned ? "fill-current" : ""}`} aria-hidden />
            </button>
          )}
        </TableCell>
      )}
      {isVisible("rank") && (
        <TableCell className="text-right text-muted-foreground text-xs font-mono tabular-nums">
          {rank}
        </TableCell>
      )}
      {isVisible("name") && (
        <TableCell>
          <div className="flex items-center">
            <Link
              href={buildStablecoinUrl(coin.id)}
              className={`pharos-focus-ring flex min-w-0 flex-1 items-center rounded-md px-1 py-1 font-medium hover:bg-muted/35 ${
                density === "list" ? "gap-1.5" : "gap-2"
              }`}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              onMouseEnter={() => onPrefetch(coin.id)}
              aria-label={`View ${coin.name} (${coin.symbol}) details${variantContext ? `, ${variantContext}` : ""}`}
            >
              <StablecoinLogo src={logos?.[coin.id]} name={coin.name} size={densityConfig.iconSize} />
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-1.5 font-medium text-foreground">
                  <span>{coin.symbol}</span>
                  {variantDisplay ? (
                    <span
                      className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${variantDisplay.badgeClass}${isCompactDensity ? "" : " leading-none"}`}
                      aria-label={variantContext ?? undefined}
                    >
                      {variantDisplay.shortLabel}
                    </span>
                  ) : null}
                </span>
                <span
                  className={`max-w-[180px] truncate text-xs text-muted-foreground ${
                    density === "list" ? "hidden" : "hidden xl:block"
                  }`}
                >
                  {coin.name}
                </span>
              </span>
            </Link>
          </div>
        </TableCell>
      )}
      {isVisible("price") && (
        <TableCell className="text-right font-mono tabular-nums">
          <span className={confidenceClass(coin.priceConfidence)}>
            {(() => {
              const ref = getPegReference(coin.pegType, pegRates, meta?.commodityOunces);
              return formatNativePrice(coin.price, meta?.flags.pegCurrency ?? "USD", ref);
            })()}
          </span>
        </TableCell>
      )}
      {isVisible("peg") && (
        <TableCell className="text-right font-mono tabular-nums">
          {meta?.flags.navToken ? (
            <span
              className="text-muted-foreground"
              title={
                meta.flags.pegCurrency === "VAR"
                  ? "CPI-indexed, price tracks inflation"
                  : "NAV token, price appreciates with yield"
              }
            >
              {meta.flags.pegCurrency === "VAR" ? "CPI" : "NAV"}
            </span>
          ) : (
            (() => {
              const ref = getPegReference(coin.pegType, pegRates, meta?.commodityOunces);
              const price = coin.price;
              const absBps =
                price != null && typeof price === "number" && ref > 0
                  ? Math.abs(price / ref - 1) * 10_000
                  : null;
              const colorClass = absBps === null ? "text-muted-foreground" : deviationColorClass(absBps);
              return (
                <span className={`inline-flex items-center gap-0.5 ${colorClass}`}>
                  {absBps !== null && <DeviationIcon absBps={absBps} />}
                  {formatPegDeviation(price, ref)}
                </span>
              );
            })()
          )}
        </TableCell>
      )}
      {isVisible("mcap") && (
        <TableCell className="text-right font-mono tabular-nums">{formatCurrency(circulating)}</TableCell>
      )}
      {isVisible("change24h") && (
        <TableCell className="text-right font-mono tabular-nums text-sm">
          <span className={change24h >= 0 ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}>
            {prevDay > 0 ? (
              <>
                {change24h >= 0 ? "↑" : "↓"} {formatPercentChange(circulating, prevDay)}
              </>
            ) : (
              "—"
            )}
          </span>
        </TableCell>
      )}
      {isVisible("change7d") && (
        <TableCell className="text-right font-mono tabular-nums text-sm">
          <span className={change7d >= 0 ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}>
            {prevWeek > 0 ? (
              <>
                <span className="hidden sm:inline">
                  <MiniSparkline values={[getPrevWeekRaw(coin), getPrevDayRaw(coin), getCirculatingRaw(coin)]} />
                </span>
                {change7d >= 0 ? "↑" : "↓"} {formatPercentChange(circulating, prevWeek)}
              </>
            ) : (
              "—"
            )}
          </span>
        </TableCell>
      )}
      {isVisible("grade") && (
        <TableCell className="px-3 py-2 text-center">
          {reportCards?.[coin.id] && (
            <Badge
              variant="outline"
              className={`text-xs font-mono px-1.5 py-0.5 transition-all duration-200 ${
                REPORT_CARD_GRADE_COLORS[reportCards[coin.id].overallGrade]
              } ${
                ["D", "F"].includes(reportCards[coin.id].overallGrade)
                  ? "animate-risk-pulse border-red-500/60 bg-red-500/5"
                  : ""
              }`}
              title={`Pharos grade: ${reportCards[coin.id].overallGrade}${reportCards[coin.id].overallScore ? ` (${reportCards[coin.id].overallScore}/100)` : ""}`}
            >
              {reportCards[coin.id].overallGrade}
            </Badge>
          )}
        </TableCell>
      )}
      {isVisible("stability") && (
        <TableCell className="text-right font-mono tabular-nums text-sm">
          {(() => {
            if (meta?.flags.navToken) {
              return <span className="text-muted-foreground">—</span>;
            }
            const pegCoin = pegScores?.get(coin.id);
            if (!pegCoin || pegCoin.pegScore === null) {
              return <span className="text-muted-foreground">—</span>;
            }
            const score = pegCoin.pegScore;
            return <span className={pegScoreColor(score)}>{score}</span>;
          })()}
        </TableCell>
      )}
      {isVisible("liquidity") && (
        <TableCell className="text-right font-mono tabular-nums text-sm">
          {(() => {
            const liq = dexLiquidity?.[coin.id];
            if (!liq || liq.liquidityScore === null || liq.liquidityScore === 0) {
              return <span className="text-muted-foreground">—</span>;
            }
            const score = liq.liquidityScore;
            return <span className={getScoreColor(score)}>{score}</span>;
          })()}
        </TableCell>
      )}
      {isVisible("blacklistable") && (
        <TableCell className="text-center font-mono tabular-nums text-sm">
          {blacklistStatus === true ? (
            <span className="text-red-700 dark:text-red-400">Yes</span>
          ) : blacklistStatus === false ? (
            <span className="text-green-700 dark:text-green-400">No</span>
          ) : blacklistStatus === "possible" ? (
            <span className="text-amber-700 dark:text-amber-400">Possible</span>
          ) : blacklistStatus === "inherited" ? (
            <span className="text-amber-700 dark:text-amber-400">Upstream</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </TableCell>
      )}
      {isVisible("backing") && (
        <TableCell className="text-center">
          {meta && (
            <Badge variant="outline" className={`text-xs ${BACKING_COLORS[meta.flags.backing] ?? ""}`}>
              {BACKING_LABELS_SHORT[meta.flags.backing]}
            </Badge>
          )}
        </TableCell>
      )}
      {isVisible("type") && (
        <TableCell className="text-center">
          {meta && (
            <Badge variant="outline" className={`text-xs ${GOVERNANCE_COLORS[meta.flags.governance] ?? ""}`}>
              {GOVERNANCE_LABELS_SHORT[meta.flags.governance]}
            </Badge>
          )}
        </TableCell>
      )}
      {isVisible("flags") && (
        <TableCell className="">
          <div className="flex flex-wrap gap-1 justify-center">
            {meta?.flags.pegCurrency !== "USD" && (
              <Badge variant="secondary" className="text-xs">
                {meta?.flags.pegCurrency}
              </Badge>
            )}
          </div>
        </TableCell>
      )}
    </TableRow>
  );
}

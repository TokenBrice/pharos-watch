"use client";

import { memo } from "react";
import Link from "next/link";
import { Star } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { TableCell, TableRow } from "@/components/table";
import {
  BACKING_BADGE_STYLES,
  GOVERNANCE_BADGE_STYLES,
  BACKING_LABELS_SHORT,
  GOVERNANCE_LABELS_SHORT,
} from "@shared/lib/classification";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/report-cards";
import { formatCurrency, formatNativePrice, formatPegDeviation, formatPercentChange, getNetColor } from "@shared/lib/format";
import { getPegReference } from "@shared/lib/peg-rates";
import { getCirculatingRaw, getPrevDayRaw, getPrevWeekRaw } from "@shared/lib/supply";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import type { DexLiquidityMap, PegSummaryCoin, ReportCard, StablecoinData } from "@shared/types";
import type { ColumnId } from "@/hooks/use-preferences";
import { getResolvedBlacklistStatus } from "@/lib/blacklist-status";
import { confidenceClass } from "@/lib/confidence";
import { resolveMintAuthorityScoreDisplay, resolveMintAuthorityStatus } from "@/lib/mint-authority-display";
import { deviationColorClass, getScoreColor, pegScoreColor } from "@/lib/severity-colors";
import { buildStablecoinUrl } from "@/lib/urls";
import { getStablecoinTableRowRiskLevel } from "@/components/stablecoin-table-logic";
import { DeviationIcon } from "@/components/severity-icon";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { getVariantAccessibleLabel, getVariantDisplay } from "@shared/lib/variant-display";
import type { TableDensity } from "@/hooks/use-table-density";
import type { UseRowCursorResult } from "@/hooks/use-row-cursor";

interface StablecoinVirtualRowProps {
  coin: StablecoinData;
  rank: number;
  virtualIndex?: number;
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
  rowProps?: ReturnType<UseRowCursorResult["getRowProps"]>;
  measureElement?: (element: HTMLTableRowElement | null) => void;
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

function isNestedInteractiveTarget(
  target: EventTarget | null,
  currentTarget: EventTarget | null,
): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const interactiveAncestor = target.closest("a,button,input,select,textarea,[role=\"button\"],[role=\"link\"]");
  return interactiveAncestor != null && interactiveAncestor !== currentTarget;
}

function StablecoinVirtualRowBase({
  coin,
  rank,
  virtualIndex,
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
  rowProps,
  measureElement,
}: StablecoinVirtualRowProps) {
  const circulating = getCirculatingRaw(coin);
  const prevDay = getPrevDayRaw(coin);
  const prevWeek = getPrevWeekRaw(coin);
  const meta = TRACKED_META_BY_ID.get(coin.id);
  const reportCard = reportCards?.[coin.id];
  const pegScore = pegScores?.get(coin.id)?.pegScore ?? null;
  const liquidityScore = dexLiquidity?.[coin.id]?.liquidityScore ?? null;
  const variantDisplay = meta?.variantKind ? getVariantDisplay(meta.variantKind) : null;
  const variantContext = meta?.variantKind ? getVariantAccessibleLabel(meta.variantKind) : null;
  const blacklistStatus = getResolvedBlacklistStatus(coin.id, reportCards?.[coin.id]);
  const mintAuthorityStatus = resolveMintAuthorityStatus(meta?.mintAuthoritySummary);
  const mintAuthorityScore = resolveMintAuthorityScoreDisplay(meta?.id, meta?.mintAuthoritySummary);
  const change24h = prevDay > 0 ? ((circulating - prevDay) / prevDay) * 100 : 0;
  const change7d = prevWeek > 0 ? ((circulating - prevWeek) / prevWeek) * 100 : 0;
  const supplySparklineValues = [prevWeek, prevDay, circulating];

  const riskLevel = getStablecoinTableRowRiskLevel(coin, pegScores, reportCards);
  const riskClass = riskLevel === "depeg" ? "pharos-row-risk-depeg" :
    riskLevel === "poor" ? "pharos-row-risk-poor" :
    riskLevel === "warning" ? "pharos-row-risk-warning" : "";
  const isCompactDensity = density === "list" || density === "compact";

  const pegRef = getPegReference(coin.pegType, pegRates, meta?.commodityOunces);
  const priceCell = formatNativePrice(coin.price, meta?.flags.pegCurrency ?? "USD", pegRef);

  const pegDeviationCell = (() => {
    const price = coin.price;
    const absBps =
      price != null && typeof price === "number" && pegRef > 0
        ? Math.abs(price / pegRef - 1) * 10_000
        : null;
    const colorClass = absBps === null ? "text-muted-foreground" : deviationColorClass(absBps);
    return (
      <span className={`inline-flex items-center gap-0.5 ${colorClass}`}>
        {absBps !== null && <DeviationIcon absBps={absBps} />}
        {formatPegDeviation(price, pegRef)}
      </span>
    );
  })();

  const stabilityCell = (() => {
    if (meta?.flags.navToken) {
      return <span className="text-muted-foreground">—</span>;
    }
    if (pegScore === null) {
      return <span className="text-muted-foreground">—</span>;
    }
    return <span className={pegScoreColor(pegScore)}>{pegScore}</span>;
  })();

  const liquidityCell = (() => {
    if (liquidityScore === null || liquidityScore === 0) {
      return <span className="text-muted-foreground">—</span>;
    }
    return <span className={getScoreColor(liquidityScore)}>{liquidityScore}</span>;
  })();

  return (
    <TableRow
      {...rowProps}
      ref={measureElement}
      key={coin.id}
      className={`group cursor-pointer data-[cursor=true]:bg-muted/40 data-[cursor=true]:shadow-[inset_3px_0_0_0_var(--brand-accent)] ${riskClass}`}
      style={{ height: densityConfig.rowHeight }}
      data-index={virtualIndex}
      data-row-striped={isStriped ? "true" : undefined}
      onClick={(event) => {
        if (isNestedInteractiveTarget(event.target, event.currentTarget)) return;
        onNavigate(coin.id);
      }}
      onMouseEnter={() => {
        rowProps?.onMouseEnter?.();
        onPrefetch(coin.id);
      }}
    >
      {showPinnedControl && (
        <TableCell key="pin" className="text-center">
          {onTogglePinned && (
            <button
              type="button"
              aria-label={`${isPinned ? "Unstar" : "Star"} ${coin.symbol}`}
              aria-pressed={isPinned}
              title={`${isPinned ? "Unstar" : "Star"} ${coin.symbol}`}
              className={`pharos-focus-ring inline-flex size-11 items-center justify-center rounded-md transition-colors xl:size-6 ${
                isPinned
                  ? "bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 dark:text-amber-300"
                  : "text-muted-foreground opacity-80 hover:text-foreground xl:opacity-0 xl:group-hover:opacity-100 xl:focus-visible:opacity-100"
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
        <TableCell key="rank" className="text-right text-muted-foreground text-xs font-mono tabular-nums">
          {rank}
        </TableCell>
      )}
      {isVisible("name") && (
        <TableCell key="name">
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
              data-stablecoin-detail-link="true"
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
                  className={`max-w-[140px] truncate text-xs text-muted-foreground ${
                    density === "list" ? "hidden" : "hidden xl:block"
                  }`}
                >
                  {coin.name}
                </span>
                <span className="mt-1 flex min-w-0 items-center gap-1 xl:hidden" aria-label="Mobile risk summary">
                  {reportCard ? (
                    <span
                      className={`inline-flex h-5 min-w-5 items-center justify-center rounded border px-1 text-[10px] font-mono font-semibold leading-none ${REPORT_CARD_GRADE_COLORS[reportCard.overallGrade]}`}
                      title={`Safety grade ${reportCard.overallGrade}`}
                    >
                      {reportCard.overallGrade}
                    </span>
                  ) : (
                    <span className="inline-flex h-5 items-center rounded border border-border/60 px-1 text-[10px] text-muted-foreground">
                      NR
                    </span>
                  )}
                  <span className="inline-flex h-5 items-center rounded border border-border/60 bg-background/60 px-1.5 text-[10px] text-muted-foreground">
                    Peg{" "}
                    <span className={`ml-1 font-mono tabular-nums ${pegScore !== null ? pegScoreColor(pegScore) : "text-muted-foreground"}`}>
                      {pegScore !== null ? pegScore : "—"}
                    </span>
                  </span>
                  <span className="inline-flex h-5 items-center rounded border border-border/60 bg-background/60 px-1.5 text-[10px] text-muted-foreground">
                    Liq{" "}
                    <span className={`ml-1 font-mono tabular-nums ${liquidityScore ? getScoreColor(liquidityScore) : "text-muted-foreground"}`}>
                      {liquidityScore ? liquidityScore : "—"}
                    </span>
                  </span>
                </span>
              </span>
            </Link>
          </div>
        </TableCell>
      )}
      {isVisible("price") && (
        <TableCell key="price" className="text-right font-mono tabular-nums">
          <span className={confidenceClass(coin.priceConfidence)}>
            {priceCell}
          </span>
        </TableCell>
      )}
      {isVisible("peg") && (
        <TableCell key="peg" className="text-right font-mono tabular-nums">
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
            pegDeviationCell
          )}
        </TableCell>
      )}
      {isVisible("mcap") && (
        <TableCell key="mcap" className="text-right font-mono tabular-nums">{formatCurrency(circulating)}</TableCell>
      )}
      {isVisible("change24h") && (
        <TableCell key="change24h" className="text-right font-mono tabular-nums text-sm">
          <span className={getNetColor(change24h, { positiveClass: "text-green-700 dark:text-green-400", negativeClass: "text-red-700 dark:text-red-400", positiveInclusiveZero: true })}>
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
        <TableCell key="change7d" className="text-right font-mono tabular-nums text-sm">
          <span className={getNetColor(change7d, { positiveClass: "text-green-700 dark:text-green-400", negativeClass: "text-red-700 dark:text-red-400", positiveInclusiveZero: true })}>
            {prevWeek > 0 ? (
              <>
                {/* 2xl gate: below ~1536px the fixed-layout columns are too
                    narrow for sparkline + delta; the svg painted over Grade. */}
                <span className="hidden 2xl:inline">
                  <MiniSparkline values={supplySparklineValues} />
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
        <TableCell key="grade" className="px-3 py-2 text-center">
          {reportCard && (
            <Badge
              variant="outline"
              className={`text-xs font-mono px-1.5 py-0.5 transition-all duration-200 ${
                REPORT_CARD_GRADE_COLORS[reportCard.overallGrade]
              } ${
                ["D", "F"].includes(reportCard.overallGrade)
                  ? "animate-risk-pulse border-red-500/60 bg-red-500/5"
                  : ""
              }`}
              title={`Pharos grade: ${reportCard.overallGrade}${reportCard.overallScore ? ` (${reportCard.overallScore}/100)` : ""}`}
            >
              {reportCard.overallGrade}
            </Badge>
          )}
        </TableCell>
      )}
      {isVisible("stability") && (
        <TableCell key="stability" className="text-right font-mono tabular-nums text-sm">
          {stabilityCell}
        </TableCell>
      )}
      {isVisible("liquidity") && (
        <TableCell key="liquidity" className="text-right font-mono tabular-nums text-sm">
          {liquidityCell}
        </TableCell>
      )}
      {isVisible("blacklistable") && (
        <TableCell key="blacklistable" className="text-center font-mono tabular-nums text-sm">
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
      {isVisible("mintAuthority") && (
        <TableCell key="mintAuthority" className="text-center">
          <Badge
            variant="outline"
            className={`px-2 py-0.5 pharos-numeric text-xs ${mintAuthorityScore.badgeClassName}`}
            title={`${mintAuthorityScore.detail} Review bucket: ${mintAuthorityStatus.spokenLabel}.`}
          >
            {mintAuthorityScore.scoreLabel}
          </Badge>
        </TableCell>
      )}
      {isVisible("backing") && (
        <TableCell key="backing" className="text-center">
          {meta && (
            <Badge variant="outline" className={`text-xs ${BACKING_BADGE_STYLES[meta.flags.backing]?.cls ?? ""}`}>
              {BACKING_LABELS_SHORT[meta.flags.backing]}
            </Badge>
          )}
        </TableCell>
      )}
      {isVisible("type") && (
        <TableCell key="type" className="text-center">
          {meta && (
            <Badge variant="outline" className={`text-xs ${GOVERNANCE_BADGE_STYLES[meta.flags.governance]?.cls ?? ""}`}>
              {GOVERNANCE_LABELS_SHORT[meta.flags.governance]}
            </Badge>
          )}
        </TableCell>
      )}
      {isVisible("flags") && (
        <TableCell key="flags" className="">
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

export const StablecoinVirtualRow = memo(StablecoinVirtualRowBase);
StablecoinVirtualRow.displayName = "StablecoinVirtualRow";

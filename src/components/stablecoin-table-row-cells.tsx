"use client";

import Link from "next/link";
import { Star } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { TableCell } from "@/components/table";
import { DeviationIcon } from "@/components/severity-icon";
import { MintAuthorityScoreBadge } from "@/components/mint-authority-score-badge";
import { RowSparkline } from "@/components/row-sparkline";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import type { StablecoinTableRowModel } from "@/components/stablecoin-table-row-model";
import type { StablecoinTableRowCellProps } from "@/components/stablecoin-table-row-types";
import { confidenceClass } from "@/lib/confidence";
import { getScoreColor, pegScoreColor } from "@/lib/severity-colors";
import { buildStablecoinUrl } from "@shared/lib/urls";
import {
  BACKING_BADGE_STYLES,
  BACKING_LABELS_SHORT,
  GOVERNANCE_BADGE_STYLES,
  GOVERNANCE_LABELS_SHORT,
} from "@shared/lib/classification";
import { formatCurrency, formatPegDeviation, formatPercentChange, getNetColor } from "@shared/lib/format";
import { REPORT_CARD_GRADE_COLORS } from "@shared/lib/classification";

interface RowCellsProps {
  row: StablecoinTableRowCellProps;
  model: StablecoinTableRowModel;
}

function MiniSparkline({ values }: { values: number[] }) {
  if (values.every((value) => value === 0)) return null;
  const trending = values[values.length - 1] >= values[0];

  return <RowSparkline
    data={values}
    width={40}
    height={16}
    inset={{ top: 0, right: 0, bottom: 0, left: 0 }}
    strokeWidth={1.5}
    yRangeMode="flat-unit"
    pointPrecision={null}
    nonScalingStroke={false}
    minPoints={2}
    fill={false}
    decorative
    positiveColor={trending ? "var(--p-green-500, #22c55e)" : "var(--p-red-500, #ef4444)"}
    ariaLabel="7-day circulating supply trend"
    className="mr-1"
    emptyContent={null}
  />;
}

function PinnedCell({ row, model }: RowCellsProps) {
  if (!row.showPinnedControl) return null;
  return (
    <TableCell className="text-center">
      {row.onTogglePinned ? (
        <button
          type="button"
          aria-label={`${row.isPinned ? "Unstar" : "Star"} ${row.coin.symbol}`}
          aria-pressed={row.isPinned}
          title={`${row.isPinned ? "Unstar" : "Star"} ${row.coin.symbol}`}
          className={`pharos-focus-ring inline-flex items-center justify-center rounded-md transition-colors ${
            row.isPinned
              ? "bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 dark:text-amber-300"
              : "text-muted-foreground opacity-80 hover:text-foreground lg:pointer-fine:opacity-0 lg:group-hover:opacity-100 lg:focus-visible:opacity-100"
          } ${model.isOverview ? "size-5 opacity-100 group-hover:opacity-100 focus-visible:opacity-100" : "size-11 lg:size-6"}`}
          onClick={(event) => {
            event.stopPropagation();
            row.onTogglePinned?.(row.coin.id);
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Star
            className={`${model.isOverview ? "h-3 w-3" : "h-3.5 w-3.5"} ${row.isPinned ? "fill-current" : ""}`}
            aria-hidden
          />
        </button>
      ) : null}
    </TableCell>
  );
}

function MobileRiskSummary({ model }: { model: StablecoinTableRowModel }) {
  return (
    <span
      className={`mt-1 min-w-0 items-center gap-1 ${model.isOverview ? "hidden" : "flex lg:hidden"}`}
      aria-label="Mobile risk summary"
    >
      {model.reportCard ? (
        <span
          className={`inline-flex h-5 min-w-5 items-center justify-center rounded border px-1 pharos-numeric text-[10px] font-semibold leading-none ${REPORT_CARD_GRADE_COLORS[model.reportCard.grade]}`}
          title={`Safety grade ${model.reportCard.grade}`}
        >
          {model.reportCard.grade}
        </span>
      ) : (
        <span className="inline-flex h-5 items-center rounded border border-border/60 px-1 text-[10px] text-muted-foreground">
          NR
        </span>
      )}
      <span className="inline-flex h-5 items-center rounded border border-border/60 bg-background/60 px-1.5 text-[10px] text-muted-foreground">
        Peg{" "}
        <span className={`ml-1 pharos-numeric ${model.pegScore !== null ? pegScoreColor(model.pegScore) : "text-muted-foreground"}`}>
          {model.pegScore !== null ? model.pegScore : "—"}
        </span>
      </span>
      <span className="inline-flex h-5 items-center rounded border border-border/60 bg-background/60 px-1.5 text-[10px] text-muted-foreground">
        Liq{" "}
        <span className={`ml-1 pharos-numeric ${model.liquidityScore ? getScoreColor(model.liquidityScore) : "text-muted-foreground"}`}>
          {model.liquidityScore ? model.liquidityScore : "—"}
        </span>
      </span>
      <span
        className="inline-flex h-5 items-center rounded border border-border/60 bg-background/60 px-1.5 text-[10px] text-muted-foreground"
        title={model.mintAuthorityScore.detail}
      >
        Mint{" "}
        <span className={`ml-1 pharos-numeric ${model.mintAuthorityScore.textClassName}`}>
          {model.mintAuthorityScore.score != null ? model.mintAuthorityScore.score : "NR"}
        </span>
      </span>
    </span>
  );
}

function IdentityCells({ row, model }: RowCellsProps) {
  return (
    <>
      {row.isVisible("rank") ? (
        <TableCell className="text-right text-muted-foreground text-xs pharos-numeric">{row.rank}</TableCell>
      ) : null}
      {row.isVisible("name") ? (
        <TableCell>
          <div className="flex items-center">
            <Link
              href={buildStablecoinUrl(row.coin.id)}
              className={`pharos-focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-md font-medium ${model.isOverview ? "px-0 py-0" : "px-1 py-1 hover:bg-muted/35"}`}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              onMouseEnter={() => row.onPrefetch(row.coin.id)}
              aria-label={`View ${row.coin.name} (${row.coin.symbol}) details${model.variantContext ? `, ${model.variantContext}` : ""}`}
              data-stablecoin-detail-link="true"
            >
              <StablecoinLogo src={row.logos?.[row.coin.id]} name={row.coin.name} size={row.densityConfig.iconSize} />
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-1.5 font-medium text-foreground">
                  <span>{row.coin.symbol}</span>
                  {model.variantDisplay ? (
                    <span
                      className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${model.variantDisplay.badgeClass}${model.isCompactDensity ? "" : " leading-none"}`}
                      aria-label={model.variantContext ?? undefined}
                    >
                      {model.variantDisplay.shortLabel}
                    </span>
                  ) : null}
                </span>
                <span className={`max-w-[140px] truncate text-xs text-muted-foreground ${model.isOverview ? "block" : "hidden lg:block"}`}>
                  {row.coin.name}
                </span>
                <MobileRiskSummary model={model} />
              </span>
            </Link>
          </div>
        </TableCell>
      ) : null}
    </>
  );
}

function MarketCells({ row, model }: RowCellsProps) {
  return (
    <>
      {row.isVisible("price") ? (
        <TableCell className="text-right pharos-numeric">
          <span className={confidenceClass(row.coin.priceConfidence)}>{model.priceCell}</span>
        </TableCell>
      ) : null}
      {row.isVisible("peg") ? (
        <TableCell className="text-right pharos-numeric">
          {model.meta?.flags.navToken ? (
            <span
              className="text-muted-foreground"
              title={model.meta.flags.pegCurrency === "VAR" ? "CPI-indexed, price tracks inflation" : "NAV token, price appreciates with yield"}
            >
              {model.meta.flags.pegCurrency === "VAR" ? "CPI" : "NAV"}
            </span>
          ) : (
            <span className={`inline-flex items-center gap-0.5 ${model.pegDeviationColorClass}`}>
              {model.absPegDeviationBps !== null ? <DeviationIcon absBps={model.absPegDeviationBps} /> : null}
              {formatPegDeviation(row.coin.price, model.pegRef)}
            </span>
          )}
        </TableCell>
      ) : null}
      {row.isVisible("mcap") ? (
        <TableCell className="text-right pharos-numeric">{formatCurrency(model.circulating)}</TableCell>
      ) : null}
      {row.isVisible("change24h") ? (
        <TableCell className="text-right pharos-numeric text-sm">
          <span className={getNetColor(model.change24h, {
            positiveClass: "text-green-700 dark:text-green-400",
            negativeClass: "text-red-700 dark:text-red-400",
            positiveInclusiveZero: true,
          })}>
            {model.prevDay > 0 ? (
              <>{model.change24h >= 0 ? "↑" : "↓"} {formatPercentChange(model.circulating, model.prevDay)}</>
            ) : "—"}
          </span>
        </TableCell>
      ) : null}
      {row.isVisible("change7d") ? (
        <TableCell className="text-right pharos-numeric text-sm">
          <span className={getNetColor(model.change7d, {
            positiveClass: "text-green-700 dark:text-green-400",
            negativeClass: "text-red-700 dark:text-red-400",
            positiveInclusiveZero: true,
          })}>
            {model.prevWeek > 0 ? (
              <>
                <span className="hidden lg:inline"><MiniSparkline values={model.supplySparklineValues} /></span>
                {model.change7d >= 0 ? "↑" : "↓"} {formatPercentChange(model.circulating, model.prevWeek)}
              </>
            ) : "—"}
          </span>
        </TableCell>
      ) : null}
    </>
  );
}

function RiskCells({ row, model }: RowCellsProps) {
  const stabilityCell = model.meta?.flags.navToken || model.pegScore === null
    ? <span className="text-muted-foreground">—</span>
    : <span className={pegScoreColor(model.pegScore)}>{model.pegScore}</span>;
  const liquidityCell = model.liquidityScore === null || model.liquidityScore === 0
    ? <span className="text-muted-foreground">—</span>
    : <span className={getScoreColor(model.liquidityScore)}>{model.liquidityScore}</span>;

  return (
    <>
      {row.isVisible("grade") ? (
        <TableCell className="px-3 py-2 text-center">
          {model.reportCard ? (
            <Badge
              variant="outline"
              className={`rounded-full px-2 py-0.5 pharos-numeric text-xs font-semibold transition-all duration-200 ${REPORT_CARD_GRADE_COLORS[model.reportCard.grade]} ${["D", "F"].includes(model.reportCard.grade) ? "animate-risk-pulse border-red-500/60 bg-red-500/5" : ""}`}
              title={`Pharos grade: ${model.reportCard.grade}${model.reportCard.score ? ` (${model.reportCard.score}/100)` : ""}`}
            >
              {model.reportCard.grade}
            </Badge>
          ) : null}
        </TableCell>
      ) : null}
      {row.isVisible("stability") ? <TableCell className="text-right pharos-numeric text-sm">{stabilityCell}</TableCell> : null}
      {row.isVisible("liquidity") ? <TableCell className="text-right pharos-numeric text-sm">{liquidityCell}</TableCell> : null}
      {row.isVisible("blacklistable") ? (
        <TableCell className="text-center pharos-numeric text-sm">
          {model.blacklistStatus === true ? (
            <span className="text-red-700 dark:text-red-400">Yes</span>
          ) : model.blacklistStatus === false ? (
            <span className="text-green-700 dark:text-green-400">No</span>
          ) : model.blacklistStatus === "possible" ? (
            <span className="text-amber-700 dark:text-amber-400">Possible</span>
          ) : model.blacklistStatus === "inherited" ? (
            <span className="text-amber-700 dark:text-amber-400">Upstream</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </TableCell>
      ) : null}
      {row.isVisible("mintAuthority") ? (
        <TableCell className="text-center">
          <MintAuthorityScoreBadge
            scoreLabel={model.mintAuthorityScore.scoreLabel}
            detail={model.mintAuthorityScore.detail}
            reviewBucketLabel={model.mintAuthorityStatus.spokenLabel}
            badgeClassName={model.mintAuthorityScore.badgeClassName}
          />
        </TableCell>
      ) : null}
      {row.isVisible("backing") ? (
        <TableCell className="text-center">
          {model.meta ? (
            <Badge variant="outline" className={`text-xs ${BACKING_BADGE_STYLES[model.meta.flags.backing]?.cls ?? ""}`}>
              {BACKING_LABELS_SHORT[model.meta.flags.backing]}
            </Badge>
          ) : null}
        </TableCell>
      ) : null}
      {row.isVisible("type") ? (
        <TableCell className="text-center">
          {model.meta ? (
            <Badge
              variant="outline"
              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${GOVERNANCE_BADGE_STYLES[model.meta.flags.governance]?.cls ?? ""}`}
            >
              {GOVERNANCE_LABELS_SHORT[model.meta.flags.governance]}
            </Badge>
          ) : null}
        </TableCell>
      ) : null}
      {row.isVisible("flags") ? (
        <TableCell>
          <div className="flex flex-wrap gap-1 justify-center">
            {model.meta?.flags.pegCurrency !== "USD" ? (
              <Badge variant="secondary" className="text-xs">{model.meta?.flags.pegCurrency}</Badge>
            ) : null}
          </div>
        </TableCell>
      ) : null}
    </>
  );
}

export function StablecoinTableRowCells({ row, model }: RowCellsProps) {
  return (
    <>
      <PinnedCell row={row} model={model} />
      <IdentityCells row={row} model={model} />
      <MarketCells row={row} model={model} />
      <RiskCells row={row} model={model} />
    </>
  );
}

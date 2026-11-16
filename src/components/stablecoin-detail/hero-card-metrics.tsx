"use client";

import { FigureLeadText } from "./figure-lead-text";
import {
  formatBps,
  formatCurrency,
  formatPercentChange,
  formatSupply,
} from "@shared/lib/format";
import { formatNativePrice, pegCurrencySymbol } from "@shared/lib/peg-format";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import type { DetailQuote } from "@/lib/stablecoin-detail-view-model-types";
import { hasObservedDisplayPrice } from "@/lib/current-peg";
import type { HeroCardViewModel } from "@/lib/stablecoin-detail-view-model";
import { confidenceClass } from "@/lib/confidence";
import { deviationColorClass } from "@/lib/severity-colors";
import { cn } from "@/lib/utils";

/** Label class shared by every hero metric cell — one casing across breakpoints. */
const HERO_METRIC_LABEL_CLASS = "text-sm font-medium text-muted-foreground";

/** A four-figure price (gold) reads as money: thousands separator and cents ("$3,834.22"). */
function groupFourFigurePrice(formatted: string): string {
  let start = 0;
  while (start < formatted.length && (formatted[start]! < "0" || formatted[start]! > "9")) start += 1;
  const value = Number(formatted.slice(start));
  if (start >= formatted.length || !Number.isFinite(value) || Math.abs(value) < 1000) return formatted;
  return `${formatted.slice(0, start)}${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Hero price string. Several peg symbols have no glyph in the mono face — CHF's
 * `₣` renders as a broken box — so any non-dollar peg carries its ISO code as a
 * prefix instead of its symbol. Dollar-denominated pegs keep `$`.
 */
export function formatHeroNativePrice(
  usdPrice: number | null | undefined,
  pegCurrency: string,
  pegRef: number | null,
  decimals?: number,
): string {
  const formatted = groupFourFigurePrice(formatNativePrice(usdPrice, pegCurrency, pegRef, decimals));
  const symbol = pegCurrencySymbol(pegCurrency);
  if (symbol === "$" || !formatted.startsWith(symbol)) return formatted;
  return `${pegCurrency} ${formatted.slice(symbol.length)}`;
}

export interface HeroTertiaryMetricConfig {
  key: string;
  label: React.ReactNode;
  mobileLabel?: React.ReactNode;
  value: React.ReactNode;
  subValue?: string;
  colorClass?: string;
}

export interface HeroSignalRailItem {
  key: string;
  label: string;
  primary: string;
  secondary: string | null;
  /** The release date of a saved value ("as of 2026-10-22"). */
  note?: string;
  href: string;
  colorClass: string;
  /** The live read is still in its first fetch: a neutral placeholder. */
  pending?: true;
}
export type HeroSupplyFields = Pick<HeroCardViewModel["market"], "supply" | "supplyTrend">;

type HeroMetricVariant = "cell" | "card";

function formatTrendPercent(current: number | null, previous: number | null): string {
  return current == null || previous == null ? "—" : formatPercentChange(current, previous);
}

function formatSupplyRestoredAsOf(coinData?: Pick<DetailQuote, "supplyRestored" | "supplyObservedAt">): string | null {
  return coinData?.supplyRestored === true && coinData.supplyObservedAt != null
    ? new Date(coinData.supplyObservedAt * 1000).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      })
    : null;
}

function SupplyRestoredNotice({ coinData, className }: { coinData?: Pick<DetailQuote, "supplyRestored" | "supplyObservedAt" | "supplyExcludedChains">; className: string }) {
  if (coinData?.supplyRestored !== true) {
    const excluded = coinData?.supplyExcludedChains;
    return excluded?.length ? <p className={className}>Partial supply · excludes {excluded.join(", ")}</p> : null;
  }
  // Neutral provenance: the page health banner owns material supply staleness (ADR-42).
  const supplyRestoredAsOf = formatSupplyRestoredAsOf(coinData);
  return <p className={cn(className, "text-muted-foreground")}>{supplyRestoredAsOf ? `Supply as of ${supplyRestoredAsOf}` : "Supply date unavailable"}</p>;
}

/**
 * One desktop figure cell. The label line has a fixed height (a help glyph
 * never pushes its figure down) and caveat notes follow the sub-line, so every
 * cell's figure and delta sit on the same lines.
 */
function CompactMetricCell({
  label,
  children,
  subline,
  note,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  subline?: React.ReactNode;
  note?: React.ReactNode;
}) {
  return (
    <div className="min-h-[8.25rem] border-b border-border/40 px-5 py-5 last:border-b-0 sm:px-6 lg:border-b-0 lg:border-r lg:last:border-r-0">
      <p className={cn(HERO_METRIC_LABEL_CLASS, "flex h-5 items-center")}>{label}</p>
      <div className="mt-3">{children}</div>
      {subline ? <div className="pharos-label mt-2">{subline}</div> : null}
      {note}
    </div>
  );
}

function formatPriceReferenceLine({
  deviationBps,
  pegReferenceUnavailable,
  referenceMarketClosed,
  isNavToken,
}: {
  deviationBps: number | null;
  pegReferenceUnavailable: boolean;
  referenceMarketClosed: boolean;
  isNavToken: boolean;
}): string {
  // A peg with no fixture, or no usable reference, has a real state of its own; only a
  // published deviation actually read against a closed market is held.
  if (pegReferenceUnavailable) return "Peg reference unavailable";
  if (isNavToken) return "NAV token — no fixed peg";
  if (referenceMarketClosed) return "Reference market closed";
  return deviationBps == null ? "N/A" : formatBps(deviationBps);
}

export function HeroPriceMetric({
  variant,
  coin,
  coinData,
  price: { pegRef, deviationBps, pegReferenceUnavailable, referenceMarketClosed, isNavToken, limitedDepegCoverageNote },
}: HeroPriceMetricProps & { variant: HeroMetricVariant }) {
  const observed = hasObservedDisplayPrice(coinData);
  const pegCurrency = coin.flags.pegCurrency ?? "USD";
  const price = formatHeroNativePrice(observed ? coinData.price : null, pegCurrency, pegRef);
  // The label names the unit the formatter actually used: a "$" peg symbol or an
  // unusable reference falls back to the observed USD price, never a native one.
  const priceUnit = pegCurrencySymbol(pegCurrency) === "$"
    || pegRef == null || !Number.isFinite(pegRef) || pegRef <= 0
    ? "USD"
    : pegCurrency;
  const priceLabel = pegCurrency === "USD" ? "Price" : `Price (${priceUnit})`;
  // A frozen archive's price is its last observation, not a live peg reading.
  const frozenAt = coin.status === "frozen" ? coin.frozenAt ?? null : null;
  const referenceLine = !observed
    ? "Observed price unavailable"
    : frozenAt
      ? `Last observed · ${frozenAt}`
      : formatPriceReferenceLine({ deviationBps, pegReferenceUnavailable, referenceMarketClosed, isNavToken });
  // Only a peg deviation is a risk reading; every other reference line is neutral.
  const referenceClass = !observed || pegReferenceUnavailable || referenceMarketClosed || frozenAt || isNavToken || deviationBps == null
    ? "text-muted-foreground"
    : deviationColorClass(Math.abs(deviationBps));

  if (variant === "cell") {
    return (
      <CompactMetricCell
        label={priceLabel}
        subline={<span className={referenceClass}><FigureLeadText text={referenceLine} /></span>}
        note={limitedDepegCoverageNote ? (
          <p className="mt-2 max-w-[24ch] text-2xs leading-snug text-state-warn">
            {limitedDepegCoverageNote}
          </p>
        ) : null}
      >
        <p
          className={`pharos-numeric text-[2rem] font-semibold leading-none tracking-tight ${confidenceClass(observed ? coinData.priceConfidence : null)}`}
        >
          {price}
        </p>
      </CompactMetricCell>
    );
  }

  return (
    <div className="min-w-0 pharos-inset px-3 py-2.5">
      <p className={HERO_METRIC_LABEL_CLASS}>
        {priceLabel}
      </p>
      <p className={`break-words font-extrabold pharos-numeric tracking-tight ${confidenceClass(observed ? coinData.priceConfidence : null)} text-xl`}>
        {price}
      </p>
      <p className={`mt-1 text-xs ${referenceClass}`}>{referenceLine}</p>
      {limitedDepegCoverageNote ? (
        <p className="mt-1 text-2xs text-state-warn">{limitedDepegCoverageNote}</p>
      ) : null}
    </div>
  );
}

interface HeroMarketCapMetricProps {
  variant: HeroMetricVariant;
  coin: StablecoinMeta;
  coinData?: Pick<DetailQuote, "supplyRestored" | "supplyObservedAt" | "supplyExcludedChains">;
  mcap: number | null;
  safePrevDay: number | null;
  prevDayTrendClass: string;
}

function HeroMarketCapMetric({
  variant,
  coin,
  coinData,
  mcap,
  safePrevDay,
  prevDayTrendClass,
}: HeroMarketCapMetricProps) {
  // A non-dollar coin's cap is still counted in USD; the label says so, as the
  // price label names its unit.
  const label = coin.flags.pegCurrency === "USD" ? "Market cap" : "Market cap (USD)";
  if (variant === "cell") {
    return (
      <CompactMetricCell
        label={label}
        subline={
          <span className={`pharos-numeric ${prevDayTrendClass}`}>
            {formatTrendPercent(mcap, safePrevDay)} <span className="text-muted-foreground">24H</span>
          </span>
        }
        note={<SupplyRestoredNotice coinData={coinData} className="mt-2 text-2xs text-state-warn" />}
      >
        <p className="pharos-numeric text-[2rem] font-semibold leading-none tracking-tight">{mcap != null ? formatCurrency(mcap) : "—"}</p>
      </CompactMetricCell>
    );
  }

  return (
    <div className="min-w-0 pharos-inset px-3 py-2.5">
      <p className={HERO_METRIC_LABEL_CLASS}>{label}</p>
      <p className="font-bold pharos-numeric tracking-tight text-lg">{mcap != null ? formatCurrency(mcap) : "—"}</p>
      <p className={`mt-1 text-xs pharos-numeric ${prevDayTrendClass}`}>
        {formatTrendPercent(mcap, safePrevDay)} <span className="text-muted-foreground">24h</span>
      </p>
      <SupplyRestoredNotice coinData={coinData} className="mt-0.5 text-2xs text-state-warn" />
    </div>
  );
}

export function HeroSupplyMetric({
  variant = "cell",
  supply,
  supplyTrend: { current, safePrevWeek, prevWeekTrendClass, hasPrevMonth, safePrevMonth, prevMonthTrendClass },
  coinSymbol,
  wide = false,
}: HeroSupplyFields & {
  coinSymbol: string;
  variant?: HeroMetricVariant;
  /** Card variant: span two of the row's four tracks from sm (see `HeroMarketMetricGrid`). */
  wide?: boolean;
}) {
  if (variant === "cell") {
    return (
      <CompactMetricCell
        label="Supply"
        subline={
          <span className="pharos-numeric">
            <span className={prevWeekTrendClass}>{formatTrendPercent(current, safePrevWeek)}</span>
            <span className="text-muted-foreground"> 7D</span>
            {hasPrevMonth ? (
              <>
                <span className="text-muted-foreground"> · </span>
                <span className={prevMonthTrendClass}>{formatTrendPercent(current, safePrevMonth)}</span>
                <span className="text-muted-foreground"> 30D</span>
              </>
            ) : null}
          </span>
        }
      >
        <p className="pharos-numeric text-[2rem] font-semibold leading-none tracking-tight">
          {supply != null ? formatSupply(supply) : "—"}{" "}
          <span className="text-sm text-muted-foreground">{coinSymbol}</span>
        </p>
      </CompactMetricCell>
    );
  }

  // Same inset cell as Price and Market cap: one figure, its deltas under it.
  return (
    <div className={cn("col-span-2 min-w-0 pharos-inset px-3 py-2.5", !wide && "sm:col-span-1")}>
      <p className={HERO_METRIC_LABEL_CLASS}>Supply</p>
      <p className="break-words text-lg font-bold pharos-numeric tracking-tight">
        {supply != null ? formatSupply(supply) : "—"}{" "}
        <span className="text-xs font-semibold text-muted-foreground">{coinSymbol}</span>
      </p>
      <p className="mt-1 text-xs pharos-numeric">
        <span className={prevWeekTrendClass}>{formatTrendPercent(current, safePrevWeek)}</span>
        <span className="text-muted-foreground"> 7d</span>
        {hasPrevMonth ? (
          <>
            <span className="text-muted-foreground"> · </span>
            <span className={prevMonthTrendClass}>{formatTrendPercent(current, safePrevMonth)}</span>
            <span className="text-muted-foreground"> 30d</span>
          </>
        ) : null}
      </p>
    </div>
  );
}

function HeroCompactTertiaryCell({ metric }: { metric: HeroTertiaryMetricConfig }) {
  return (
    <CompactMetricCell
      label={metric.label}
      subline={metric.subValue ? <span><FigureLeadText text={metric.subValue} /></span> : null}
    >
      <p
        className={`pharos-numeric text-[2rem] font-semibold leading-none tracking-tight ${metric.colorClass ?? "text-foreground"}`}
      >
        {metric.value}
      </p>
    </CompactMetricCell>
  );
}
interface HeroMarketMetricGridProps extends HeroPriceMetricProps {
  variant: HeroMetricVariant;
  market: HeroCardViewModel["market"];
  tertiaryMetric?: HeroTertiaryMetricConfig;
  /** Card variant: how many signal tiles sit under this row, so both rows share column edges. */
  tertiaryCount?: number;
  coinData: HeroPriceMetricProps["coinData"] & Pick<DetailQuote, "supplyRestored" | "supplyObservedAt" | "supplyExcludedChains">;
}

export function HeroMarketMetricGrid({
  variant,
  coin,
  coinData,
  price,
  market,
  tertiaryMetric,
  tertiaryCount = 0,
}: HeroMarketMetricGridProps) {
  const supplyFields: HeroSupplyFields = { supply: market.supply, supplyTrend: market.supplyTrend };

  if (variant === "card") {
    // Phone: Price · Market cap, then Supply across. From sm one row on the
    // signal row's column edges: thirds over three signals, quarters (Supply
    // spanning two) over two or four.
    const quarters = tertiaryCount === 2 || tertiaryCount === 4;
    return (
      <div className={quarters ? "grid grid-cols-2 gap-2.5 sm:grid-cols-4 sm:gap-3" : "grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3"}>
        <HeroPriceMetric variant="card" coin={coin} coinData={coinData} price={price} />
        <HeroMarketCapMetric
          variant="card"
          coin={coin}
          coinData={coinData}
          mcap={market.mcap}
          safePrevDay={market.safePrevDay}
          prevDayTrendClass={market.prevDayTrendClass}
        />
        <HeroSupplyMetric variant="card" coinSymbol={coin.symbol} wide={quarters} {...supplyFields} />
      </div>
    );
  }

  return (
    <div className={`grid ${tertiaryMetric ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
      <HeroPriceMetric variant="cell" coin={coin} coinData={coinData} price={price} />
      <HeroMarketCapMetric
        variant="cell"
        coin={coin}
        coinData={coinData}
        mcap={market.mcap}
        safePrevDay={market.safePrevDay}
        prevDayTrendClass={market.prevDayTrendClass}
      />
      <HeroSupplyMetric variant="cell" coinSymbol={coin.symbol} {...supplyFields} />
      {tertiaryMetric ? <HeroCompactTertiaryCell metric={tertiaryMetric} /> : null}
    </div>
  );
}

/**
 * A signal tile. Label, figure and sub-line sit in the same place on every
 * tile (the label line has a fixed height, so a help glyph never pushes its
 * figure down); only a risk reading tints its figure.
 */
function MetricChip({
  label,
  value,
  subValue,
  colorClass = "text-foreground",
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  subValue?: string;
  colorClass?: string;
}) {
  return (
    // Passive stat tile — deliberately NOT .pharos-control-pill, which is
    // reserved for interactive controls.
    <div className="flex min-h-16 min-w-0 flex-col rounded-lg border border-border/60 bg-background/45 px-3 py-2">
      <span className="pharos-label flex h-6 min-w-0 items-center whitespace-nowrap">{label}</span>
      <span className={`text-lg font-bold leading-tight pharos-numeric ${colorClass}`}>{value}</span>
      {subValue ? <span className="mt-0.5 text-2xs text-muted-foreground">{subValue}</span> : null}
    </div>
  );
}

// Signal-row columns by tile count: never a lone tile across the row. From sm
// the edges match the market row above (thirds or quarters).
const TERTIARY_GRID_COLUMNS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-2 sm:grid-cols-4",
};

export function HeroTertiaryMetrics({
  metrics,
  activeDepeg,
}: {
  metrics: HeroTertiaryMetricConfig[];
  activeDepeg: boolean;
}) {
  return (
    <>
      {metrics.length > 0 ? (
        <div className={cn("mt-2.5 grid gap-2.5 sm:mt-3 sm:gap-3", TERTIARY_GRID_COLUMNS[metrics.length])}>
          {metrics.map((metric) => (
            <MetricChip
              key={metric.key}
              label={metric.mobileLabel ?? metric.label}
              value={metric.value}
              subValue={metric.subValue}
              colorClass={metric.colorClass}
            />
          ))}
        </div>
      ) : null}

      {activeDepeg && (
        <div className="mt-3 rounded-lg border border-state-danger-solid/20 bg-state-danger-solid/8 px-3 py-2 text-xs text-state-danger">
          Active depeg detected
        </div>
      )}
    </>
  );
}

interface HeroPriceMetricProps {
  coin: StablecoinMeta;
  coinData: Pick<DetailQuote, "price" | "priceSource" | "priceObservedAtMode" | "priceConfidence">;
  price: HeroCardViewModel["price"];
}


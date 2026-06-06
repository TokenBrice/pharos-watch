import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { PharosIcon } from "@/components/pharos-icon";
import { useFlashOnChange } from "@/hooks/use-flash-on-change";
import { PSI_HEX_COLORS, type ConditionBand } from "@shared/lib/psi-colors";
import { CHART_GREEN, CHART_RED, CHART_SLATE } from "@/lib/chart-colors";

type TrendDirection = "up" | "down" | "flat";

const KPI_CHIP_BASE =
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] shadow-[inset_0_1px_0_oklch(1_0_0_/0.2)] transition-colors";
const SNAPSHOT_PILL_BASE =
  "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium text-muted-foreground sm:px-3 sm:py-1 sm:text-xs" +
  " border-[var(--control-pill-border)] bg-[var(--control-pill-bg)] shadow-[inset_0_1px_0_oklch(1_0_0_/0.08)]";
const CHIP_TONE_CLASSES = {
  positive: "border-green-500/25 bg-green-500/10 text-green-700 dark:text-green-400",
  negative: "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-400",
  warning: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  neutral: "border-border bg-muted/40 text-muted-foreground",
} as const;

export function trendDirection(value: number): TrendDirection {
  if (value === 0) return "flat";
  return value > 0 ? "up" : "down";
}

export function trendTextClass(value: number): string {
  if (value > 0) return "text-[var(--severity-healthy)]";
  if (value < 0) return "text-[var(--severity-severe)]";
  return "text-muted-foreground";
}

export function TrendChip({ label, value, direction }: { label: ReactNode; value: string; direction: TrendDirection }) {
  const toneClasses =
    direction === "up"
      ? CHIP_TONE_CLASSES.positive
      : direction === "down"
        ? CHIP_TONE_CLASSES.negative
        : CHIP_TONE_CLASSES.neutral;
  const Icon = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : Minus;

  return (
    <span className={`${KPI_CHIP_BASE} font-medium ${toneClasses}`}>
      <PharosIcon icon={Icon} size="micro" aria-hidden />
      <span>{label}</span>
      <span className="font-mono tabular-nums">{value}</span>
    </span>
  );
}

export function InfoChip({
  label,
  value,
  tone = "neutral",
}: {
  label: ReactNode;
  value: string | number;
  tone?: "neutral" | "positive" | "negative" | "warning";
}) {
  const toneClasses =
    tone === "positive"
      ? CHIP_TONE_CLASSES.positive
      : tone === "negative"
        ? CHIP_TONE_CLASSES.negative
        : tone === "warning"
          ? CHIP_TONE_CLASSES.warning
          : CHIP_TONE_CLASSES.neutral;

  return (
    <span className={`${KPI_CHIP_BASE} ${toneClasses}`}>
      <span>{label}</span>
      <span className="font-mono tabular-nums">{value}</span>
    </span>
  );
}

/**
 * Tiny inline-SVG sparkline (D2): area fill at low opacity beneath a hairline stroke.
 * Renders nothing when there are fewer than 2 points so we never fabricate a chart.
 */
export function KpiSparkline({
  values,
  ariaLabel,
  tone = "auto",
  className = "",
}: {
  values: number[];
  ariaLabel: string;
  tone?: "auto" | "signed" | "neutral";
  className?: string;
}) {
  if (!values || values.length < 2) return null;
  const width = 100;
  const height = 28;
  const padY = 2;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  const range = Math.max(max - min, Math.abs(max) * 1e-6, 1e-9);
  const plotH = height - padY * 2;
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;
  const yFor = (v: number) => padY + (1 - (v - min) / range) * plotH;
  const linePts = values.map((v, i) => `${(i * stepX).toFixed(2)},${yFor(v).toFixed(2)}`).join(" ");
  const areaPts = `0,${(height).toFixed(2)} ${linePts} ${width.toFixed(2)},${(height).toFixed(2)}`;
  const first = values[0]!;
  const last = values[values.length - 1]!;
  const delta = last - first;
  const stroke =
    tone === "neutral"
      ? CHART_SLATE
      : tone === "signed"
        ? last >= 0
          ? CHART_GREEN
          : CHART_RED
        : delta > 0
          ? CHART_GREEN
          : delta < 0
            ? CHART_RED
            : CHART_SLATE;

  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      width="100%"
      height={height}
      className={`block motion-reduce:[&_polyline]:!transition-none ${className}`}
    >
      <polygon points={areaPts} fill={stroke} fillOpacity={0.18} stroke="none" />
      <polyline
        points={linePts}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/**
 * 30-cell PSI band history strip (D9). Each cell colored by `PSI_HEX_COLORS`;
 * empty days render as a muted placeholder cell. `<title>` provides hover/focus
 * date+band readout without a tooltip dependency.
 */
export function PsiBandHistoryStrip({
  series,
  windowDays = 30,
  height = 16,
  ariaLabel,
  className = "",
}: {
  series: Array<{ date: number; band: string }>;
  windowDays?: number;
  height?: number;
  ariaLabel?: string;
  className?: string;
}) {
  const cells = Array.from({ length: windowDays }, (_, i) => series[i]);
  return (
    <div
      className={`flex w-full gap-[1px] overflow-hidden rounded-[3px] ${className}`}
      style={{ height }}
      role="img"
      aria-label={
        ariaLabel ??
        `Last ${windowDays} days of PSI band history; ${series.length} cells populated`
      }
    >
      {cells.map((cell, i) => {
        const fill = cell ? PSI_HEX_COLORS[cell.band as ConditionBand] : null;
        const title = cell
          ? `${new Date(cell.date * 1000).toISOString().slice(0, 10)} · ${cell.band}`
          : "no data";
        return (
          <span
            key={i}
            className="flex-1"
            style={{ backgroundColor: fill ?? "var(--muted-foreground, #94a3b8)", opacity: fill ? 1 : 0.18 }}
            title={title}
          />
        );
      })}
    </div>
  );
}

export function KpiCell({
  label,
  value,
  sublabel,
  sparkline,
  valueClassName,
  centered = false,
  className = "",
}: {
  label: ReactNode;
  value: ReactNode;
  sublabel?: ReactNode;
  sparkline?: ReactNode;
  valueClassName?: string;
  centered?: boolean;
  className?: string;
}) {
  if (centered) {
    return (
      <div className={`flex h-full flex-col items-center justify-center gap-1.5 px-4 py-3 text-center ${className}`}>
        <span className="pharos-kicker">{label}</span>
        <span aria-live="polite" className={`text-xl font-extrabold font-mono tabular-nums leading-tight ${valueClassName ?? ""}`}>
          {value}
        </span>
        {sparkline && <div className="w-full max-w-[140px] px-1">{sparkline}</div>}
        {sublabel && <div className="flex flex-wrap items-center justify-center gap-1 pt-0.5 text-xs">{sublabel}</div>}
      </div>
    );
  }
  return (
    <div className={`flex min-h-[92px] flex-col justify-between gap-2 px-4 py-3 ${className}`}>
      <span className="pharos-kicker">{label}</span>
      <span aria-live="polite" className={`text-xl font-extrabold font-mono tabular-nums leading-tight ${valueClassName ?? ""}`}>
        {value}
      </span>
      {sparkline && <div className="-mt-1">{sparkline}</div>}
      {sublabel && <div className="flex flex-wrap items-center gap-1 pb-1 text-xs">{sublabel}</div>}
    </div>
  );
}

export function KpiSkeleton() {
  return (
    <div className="flex min-h-[92px] flex-col justify-between gap-2 px-4 py-3">
      <Skeleton className="h-3.5 w-20" />
      <Skeleton className="h-7 w-24" />
      <div className="flex items-center gap-1.5">
        <Skeleton className="h-5 w-24 rounded-full" />
      </div>
    </div>
  );
}

export function KpiMiniTile({
  label,
  value,
  metaPrimary,
  metaSecondary,
  sparkline,
  valueClassName,
}: {
  label: string;
  value: ReactNode;
  metaPrimary?: ReactNode;
  metaSecondary?: ReactNode;
  sparkline?: ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="pharos-card-shell flex min-h-[82px] flex-col px-2.5 py-2 sm:min-h-[96px] sm:px-3 sm:py-2.5">
      <p className="pharos-kicker tracking-[0.08em]">{label}</p>
      <p className={`mt-1 text-base font-extrabold font-mono tabular-nums leading-tight sm:text-lg ${valueClassName ?? ""}`}>
        {value}
      </p>
      {sparkline && <div className="-mt-0.5">{sparkline}</div>}
      {(metaPrimary || metaSecondary) && (
        <div className="mt-auto space-y-0.5 pt-1.5 text-[10px] font-mono leading-snug sm:pt-2 sm:text-[11px]">
          {metaPrimary && <div>{metaPrimary}</div>}
          {metaSecondary && <div>{metaSecondary}</div>}
        </div>
      )}
    </div>
  );
}

export interface KpiMetricDefinition {
  key: string;
  mobileLabel: string;
  desktopLabel: ReactNode;
  value: ReactNode;
  mobileMetaPrimary?: ReactNode;
  mobileMetaSecondary?: ReactNode;
  desktopSublabel?: ReactNode;
  mobileValueClassName?: string;
  desktopValueClassName?: string;
  sparkline?: ReactNode;
}

function SnapshotDeltaPill({ label, value }: { label: string; value: string | null }) {
  return (
    <span className={`${SNAPSHOT_PILL_BASE} whitespace-nowrap`}>
      {label} {value ?? "—"}
    </span>
  );
}

export function PrimarySnapshotCard({
  value,
  flashValue,
  band,
  delta24h,
  delta7d,
  delta30d,
  valueClassName,
  scoreSeries,
  bandSeries,
}: {
  value: string;
  flashValue?: number | null;
  band: string;
  delta24h: string | null;
  delta7d: string | null;
  delta30d: string | null;
  valueClassName?: string;
  scoreSeries?: number[];
  bandSeries?: Array<{ date: number; band: string }>;
}) {
  // Detect crisis/meltdown bands for alert styling
  const isCrisis = band.toLowerCase().includes("crisis") || band.toLowerCase().includes("meltdown");
  const isTremor = band.toLowerCase().includes("tremor") || band.toLowerCase().includes("fracture");
  const isElevated = isCrisis || isTremor;
  // Flash only the lead PSI number when its live score changes (skips mount).
  const flashClass = useFlashOnChange(flashValue);

  return (
    <div
      className={`@container rounded-xl border px-3 py-2.5 transition-all duration-500 sm:rounded-[1.4rem] sm:px-4 sm:py-3.5 @sm:px-5 @sm:py-4 ${
        isCrisis ? "animate-pulse" : ""
      }`}
      style={{
        background: isElevated
          ? "var(--surface-featured-gradient), linear-gradient(135deg, oklch(0.7 0.15 25 / 0.08) 0%, transparent 50%)"
          : "var(--surface-featured-gradient)",
        borderColor: isCrisis ? "var(--p-red-400)" : isTremor ? "var(--p-amber-400)" : "var(--surface-featured-border)",
        boxShadow: isCrisis
          ? "var(--surface-featured-shadow), 0 0 30px oklch(0.7 0.2 25 / 0.35)"
          : isTremor
            ? "var(--surface-featured-shadow), 0 0 20px oklch(0.75 0.15 85 / 0.25)"
            : "var(--surface-featured-shadow)",
      }}
    >
      <div className="grid grid-cols-1 items-center gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0 space-y-1.5 sm:space-y-2">
          <div className="flex w-fit flex-col items-center gap-1 sm:gap-1.5">
            <div className="flex items-center gap-1.5">
              <p className="text-center text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-600 dark:text-primary/80 sm:text-[14px] @sm:text-[13px]">
                PSI
              </p>
              <span className="relative flex h-2 w-2">
                <span className={`animate-breathe absolute inline-flex h-full w-full rounded-full ${isElevated ? "bg-red-400" : "bg-green-400"}`}></span>
                <span className={`relative inline-flex rounded-full h-2 w-2 ${isElevated ? "bg-red-500" : "bg-green-500"}`}></span>
              </span>
            </div>
            <div
              aria-live="polite"
              className={`rounded-md font-mono text-[2.45rem] font-extrabold leading-none tabular-nums sm:text-[3.2rem] @sm:text-[3.4rem] ${valueClassName ?? ""} ${flashClass}`}
            >
              {value}
            </div>
          </div>
          {/* Enhanced band display for stress states */}
          <div className={`flex items-center gap-1.5 ${isElevated ? "rounded-lg bg-red-500/10 px-2 py-1 -mx-1" : ""}`}>
            {isCrisis && (
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
              </span>
            )}
            <p className={`font-semibold whitespace-nowrap ${isElevated ? "text-sm sm:text-base" : "text-xs sm:text-sm"} ${valueClassName ?? "text-foreground"}`}>
              {band || "No current PSI band"}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-start justify-center gap-2 sm:items-end">
          <div className="flex flex-wrap items-center gap-1.5 sm:flex-col sm:items-end sm:gap-2">
            <SnapshotDeltaPill label="24h" value={delta24h} />
            <SnapshotDeltaPill label="7d" value={delta7d} />
            <SnapshotDeltaPill label="30d" value={delta30d} />
          </div>
        </div>
      </div>
      {(scoreSeries && scoreSeries.length >= 2) || (bandSeries && bandSeries.length > 0) ? (
        <div className="mt-2.5 space-y-1.5 sm:mt-3">
          {scoreSeries && scoreSeries.length >= 2 ? (
            <KpiSparkline
              values={scoreSeries}
              tone="auto"
              ariaLabel={`30-day PSI trajectory; ${scoreSeries.length} points`}
              className="opacity-90"
            />
          ) : null}
          {bandSeries && bandSeries.length > 0 ? (
            <div className="space-y-1">
              <PsiBandHistoryStrip
                series={bandSeries}
                ariaLabel={`Last 30 days of PSI band classifications`}
              />
              <div className="flex justify-between text-[10px] font-mono text-muted-foreground">
                <span>30d ago</span>
                <span>today</span>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

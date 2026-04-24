import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

type TrendDirection = "up" | "down" | "flat";

const KPI_CHIP_BASE =
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] shadow-[inset_0_1px_0_oklch(1_0_0_/0.2)] transition-colors";
const SNAPSHOT_PILL_BASE =
  "inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground" +
  " border-[var(--control-pill-border)] bg-[var(--control-pill-bg)] shadow-[inset_0_1px_0_oklch(1_0_0_/0.08)]";

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
      ? "border-green-500/25 bg-green-500/10 text-green-700 dark:text-green-400"
      : direction === "down"
        ? "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-400"
        : "border-border bg-muted/40 text-muted-foreground";
  const Icon = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : Minus;

  return (
    <span className={`${KPI_CHIP_BASE} font-medium ${toneClasses}`}>
      <Icon className="size-3" aria-hidden />
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
      ? "border-green-500/25 bg-green-500/10 text-green-700 dark:text-green-400"
      : tone === "negative"
        ? "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-400"
        : tone === "warning"
          ? "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400"
          : "border-border bg-muted/40 text-muted-foreground";

  return (
    <span className={`${KPI_CHIP_BASE} ${toneClasses}`}>
      <span>{label}</span>
      <span className="font-mono tabular-nums">{value}</span>
    </span>
  );
}

export function KpiCell({
  label,
  value,
  sublabel,
  valueClassName,
  centered = false,
  className = "",
}: {
  label: ReactNode;
  value: ReactNode;
  sublabel?: ReactNode;
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
  valueClassName,
}: {
  label: string;
  value: ReactNode;
  metaPrimary?: ReactNode;
  metaSecondary?: ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="pharos-card-shell flex min-h-[96px] flex-col px-3 py-2.5">
      <p className="pharos-kicker tracking-[0.08em]">{label}</p>
      <p className={`mt-1 text-lg font-extrabold font-mono tabular-nums leading-tight ${valueClassName ?? ""}`}>
        {value}
      </p>
      {(metaPrimary || metaSecondary) && (
        <div className="mt-auto space-y-0.5 pt-2 text-[11px] font-mono leading-snug">
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
}

export function PrimarySnapshotCard({
  value,
  band,
  delta24h,
  delta7d,
  delta30d,
  valueClassName,
}: {
  value: string;
  band: string;
  delta24h: string | null;
  delta7d: string | null;
  delta30d: string | null;
  valueClassName?: string;
}) {
  // Detect crisis/meltdown bands for alert styling
  const isCrisis = band.toLowerCase().includes("crisis") || band.toLowerCase().includes("meltdown");
  const isTremor = band.toLowerCase().includes("tremor") || band.toLowerCase().includes("fracture");
  const isElevated = isCrisis || isTremor;

  return (
    <div
      className={`@container rounded-[1.4rem] border px-4 py-3.5 transition-all duration-500 @sm:px-5 @sm:py-4 ${
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
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2">
        <div className="min-w-0 space-y-2">
          <div className="flex w-fit flex-col items-center gap-1.5">
            <div className="flex items-center gap-1.5">
              <p className="text-center text-[14px] font-semibold uppercase tracking-[0.14em] text-slate-600 dark:text-primary/80 @sm:text-[13px]">
                PSI
              </p>
              <span className="relative flex h-2 w-2">
                <span className={`animate-breathe absolute inline-flex h-full w-full rounded-full ${isElevated ? "bg-red-400" : "bg-green-400"}`}></span>
                <span className={`relative inline-flex rounded-full h-2 w-2 ${isElevated ? "bg-red-500" : "bg-green-500"}`}></span>
              </span>
            </div>
            <div
              aria-live="polite"
              className={`font-mono text-[3.2rem] font-extrabold leading-none tabular-nums @sm:text-[3.4rem] ${valueClassName ?? ""}`}
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
            <p className={`font-semibold whitespace-nowrap ${isElevated ? "text-base" : "text-sm"} ${valueClassName ?? "text-foreground"}`}>
              {band || "No current PSI band"}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end justify-center gap-2">
          <div className="flex flex-col items-end gap-2">
            <span
              className={`${SNAPSHOT_PILL_BASE} whitespace-nowrap`}
            >
              24h {delta24h ?? "—"}
            </span>
            <span
              className={`${SNAPSHOT_PILL_BASE} whitespace-nowrap`}
            >
              7d {delta7d ?? "—"}
            </span>
            <span
              className={`${SNAPSHOT_PILL_BASE} whitespace-nowrap`}
            >
              30d {delta30d ?? "—"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

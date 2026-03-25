import type { ReactNode } from "react";
import Image from "next/image";
import { formatCurrency } from "@shared/lib/format";

export interface BreakdownEntry {
  key: string;
  label: string;
  value: number;
  colorClass: string;
  logoPath?: string;
  darkInvert?: boolean;
}

interface BreakdownLogo {
  path: string;
  darkInvert?: boolean;
}

interface BuildBreakdownEntriesOptions {
  labelForKey: (key: string) => string;
  colorForKey: (key: string, index: number) => string;
  logoForKey?: (key: string) => BreakdownLogo | null;
  maxVisibleItems?: number;
  otherKey?: string;
  otherLabel?: string;
  otherColorClass?: string;
}

interface BreakdownBarProps {
  entries: BreakdownEntry[];
  total: number;
  minPercent: number;
  className: string;
  titleFormatter?: (entry: BreakdownEntry, percent: number) => string;
}

interface BreakdownLegendProps {
  entries: BreakdownEntry[];
  total: number;
  minPercent: number;
  variant: "inline" | "stacked";
  className: string;
  itemClassName: string;
  markerClassName: string;
  logoClassName?: string;
  logoSize: number;
  valueFormatter: (entry: BreakdownEntry, percent: number) => ReactNode;
  nameClassName?: string;
  valueClassName?: string;
}

export function buildBreakdownEntries(
  values: Record<string, number>,
  options: BuildBreakdownEntriesOptions,
): { entries: BreakdownEntry[]; total: number } {
  const sorted = Object.entries(values).sort((a, b) => b[1] - a[1]) as [string, number][];
  const total = sorted.reduce((sum, [, value]) => sum + value, 0);
  const maxVisibleItems = options.maxVisibleItems ?? sorted.length;
  const visible = sorted.slice(0, maxVisibleItems);
  const groupedRemainder = sorted.slice(maxVisibleItems).reduce((sum, [, value]) => sum + value, 0);
  const entries: BreakdownEntry[] = visible.map(([key, value], index) => {
    const logo = options.logoForKey?.(key);
    return {
      key,
      label: options.labelForKey(key),
      value,
      colorClass: options.colorForKey(key, index),
      logoPath: logo?.path,
      darkInvert: logo?.darkInvert,
    };
  });

  if (groupedRemainder > 0) {
    entries.push({
      key: options.otherKey ?? "_other",
      label: options.otherLabel ?? "Other",
      value: groupedRemainder,
      colorClass: options.otherColorClass ?? "bg-muted-foreground",
      logoPath: undefined,
      darkInvert: undefined,
    });
  }

  return { entries, total };
}

export function BreakdownBar({ entries, total, minPercent, className, titleFormatter }: BreakdownBarProps) {
  if (total === 0) return null;

  const summaryLabel = entries
    .filter((e) => (e.value / total) * 100 >= minPercent)
    .map((e) => `${e.label} ${((e.value / total) * 100).toFixed(0)}%`)
    .join(", ");

  return (
    <div className={className} role="img" aria-label={`Breakdown: ${summaryLabel}`}>
      {entries.map((entry) => {
        const percent = (entry.value / total) * 100;
        if (percent < minPercent) return null;
        return (
          <div
            key={entry.key}
            className={entry.colorClass}
            style={{ width: `${percent}%` }}
            title={titleFormatter?.(entry, percent) ?? `${entry.label}: ${formatCurrency(entry.value)} (${percent.toFixed(1)}%)`}
          />
        );
      })}
    </div>
  );
}

export function BreakdownLegend({
  entries,
  total,
  minPercent,
  variant,
  className,
  itemClassName,
  markerClassName,
  logoClassName,
  logoSize,
  valueFormatter,
  nameClassName = "text-sm font-medium",
  valueClassName = "text-xs text-muted-foreground font-mono tabular-nums",
}: BreakdownLegendProps) {
  const visibleEntries = entries.filter((entry) => total > 0 && (entry.value / total) * 100 >= minPercent);
  if (visibleEntries.length === 0) return null;

  return (
    <div className={className} role="list">
      {visibleEntries.map((entry) => {
        const percent = (entry.value / total) * 100;
        const marker = <span className={`inline-block shrink-0 rounded-sm ${markerClassName} ${entry.colorClass}`} />;
        const logo = entry.logoPath ? (
          <Image
            src={entry.logoPath}
            alt=""
            width={logoSize}
            height={logoSize}
            className={logoClassName ?? `shrink-0 rounded-full${entry.darkInvert ? " dark:invert" : ""}`}
          />
        ) : null;

        if (variant === "inline") {
          return (
            <span key={entry.key} role="listitem" className={itemClassName}>
              {marker}
              {logo}
              <span className={nameClassName}>{entry.label}</span>
              <span className={valueClassName}>{valueFormatter(entry, percent)}</span>
            </span>
          );
        }

        return (
          <div key={entry.key} role="listitem" className={itemClassName}>
            {marker}
            {logo}
            <div>
              <p className={nameClassName}>{entry.label}</p>
              <p className={valueClassName}>{valueFormatter(entry, percent)}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

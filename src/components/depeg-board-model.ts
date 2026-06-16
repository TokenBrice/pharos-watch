import type { DepegTrackerRow } from "@/lib/depeg-sort";

// ---------------------------------------------------------------------------
// Pure status / tone helpers
// ---------------------------------------------------------------------------

export function statusLabel(row: DepegTrackerRow): string {
  if (row.coin.activeDepeg) return "live";
  if (row.pendingIncident) return "pending";
  if (row.coin.depegEventCoverageLimited) return "floor";
  if (row.dews?.band === "DANGER" || row.dews?.band === "WARNING") return row.dews.band.toLowerCase();
  return "clear";
}

export function statusClassName(row: DepegTrackerRow): string {
  if (row.coin.activeDepeg) return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
  if (row.pendingIncident) return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (row.coin.depegEventCoverageLimited) return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  if (row.dews?.band === "DANGER" || row.dews?.band === "WARNING") {
    return "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300";
  }
  return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
}

export function rowToneClassName(row: DepegTrackerRow): string {
  if (row.coin.activeDepeg) return "bg-red-500/[0.07] ring-1 ring-inset ring-red-500/15";
  if (row.pendingIncident) return "bg-amber-500/[0.06]";
  if (row.dews?.band === "DANGER" || row.dews?.band === "WARNING") return "bg-orange-500/[0.05]";
  if (row.coin.depegEventCoverageLimited) return "bg-sky-500/[0.04]";
  return "";
}

export function getDeviationBarWidthPercent(abs: number): number {
  if (abs <= 200) return (abs / 200) * 35;
  if (abs <= 500) return 35 + ((abs - 200) / 300) * 25;
  const severeRatio = Math.log10(Math.min(abs, 10_000) / 500) / Math.log10(10_000 / 500);
  return 60 + severeRatio * 35;
}

export function metricTone(value: number | null | undefined, goodHigh = true): string {
  if (value == null) return "bg-muted-foreground";
  if (goodHigh) {
    if (value >= 80) return "bg-emerald-500";
    if (value >= 55) return "bg-amber-500";
    return "bg-red-500";
  }
  if (value >= 75) return "bg-red-500";
  if (value >= 36) return "bg-amber-500";
  return "bg-emerald-500";
}

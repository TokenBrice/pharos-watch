import {
  DEPEG_ROW_STATUS_CLASSES,
  DEPEG_TRACKER_UNKNOWN_STATUS,
  QUALITY_TIER_3_CLASSES,
  THREAT_BAND_ACCENT_CLASSES,
} from "@shared/lib/classification";
import type { DepegTrackerRow } from "@/lib/depeg-sort";

// ---------------------------------------------------------------------------
// Pure status / tone helpers
// ---------------------------------------------------------------------------

export function statusLabel(row: DepegTrackerRow): string {
  if (row.coin.activeDepeg) return "live";
  if (row.pendingIncident) return "pending";
  if (row.coin.depegEventCoverageLimited) return "floor";
  if (row.dews?.band === "DANGER" || row.dews?.band === "WARNING") return row.dews.band.toLowerCase();
  if (!Number.isFinite(row.coin.currentDeviationBps) || !Number.isFinite(row.dews?.score)) {
    return DEPEG_TRACKER_UNKNOWN_STATUS.label;
  }
  return "clear";
}

export function statusClassName(row: DepegTrackerRow): string {
  if (row.coin.activeDepeg) return DEPEG_ROW_STATUS_CLASSES.active.pill;
  if (row.pendingIncident) return DEPEG_ROW_STATUS_CLASSES.pending.pill;
  if (row.coin.depegEventCoverageLimited) return DEPEG_ROW_STATUS_CLASSES.coverageLimited.pill;
  if (row.dews?.band === "DANGER" || row.dews?.band === "WARNING") {
    return DEPEG_ROW_STATUS_CLASSES.watch.pill;
  }
  if (!Number.isFinite(row.coin.currentDeviationBps) || !Number.isFinite(row.dews?.score)) {
    return DEPEG_TRACKER_UNKNOWN_STATUS.cls;
  }
  return DEPEG_ROW_STATUS_CLASSES.clear.pill;
}

export function rowToneClassName(row: DepegTrackerRow): string {
  // Active depegs fill the top of the Attention sort, so a tint there marks every row;
  // the LIVE status chip and deviation bar already carry that signal.
  if (row.coin.activeDepeg) return "";
  if (row.pendingIncident) return DEPEG_ROW_STATUS_CLASSES.pending.rowTint;
  if (row.dews?.band === "DANGER" || row.dews?.band === "WARNING") return THREAT_BAND_ACCENT_CLASSES[row.dews.band].rowTint;
  if (row.coin.depegEventCoverageLimited) return DEPEG_ROW_STATUS_CLASSES.coverageLimited.rowTint;
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
    if (value >= 80) return QUALITY_TIER_3_CLASSES.good.bar;
    if (value >= 55) return QUALITY_TIER_3_CLASSES.watch.bar;
    return QUALITY_TIER_3_CLASSES.bad.bar;
  }
  if (value >= 75) return QUALITY_TIER_3_CLASSES.bad.bar;
  if (value >= 36) return QUALITY_TIER_3_CLASSES.watch.bar;
  return QUALITY_TIER_3_CLASSES.good.bar;
}

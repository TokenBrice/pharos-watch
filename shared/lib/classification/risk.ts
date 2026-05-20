// Depeg Early Warning Score (DEWS) threat bands
// ---------------------------------------------------------------------------

export type ThreatBand = "CALM" | "WATCH" | "ALERT" | "WARNING" | "DANGER";

export const THREAT_BAND_ORDER: Record<ThreatBand, number> = {
  CALM: 0,
  WATCH: 1,
  ALERT: 2,
  WARNING: 3,
  DANGER: 4,
};

const DEWS_ALERT_BANDS = ["ALERT", "WARNING", "DANGER"] as const satisfies readonly ThreatBand[];

export function isThreatBand(value: string): value is ThreatBand {
  return value in THREAT_BAND_ORDER;
}

export function isDewsAlertBand(value: string): value is (typeof DEWS_ALERT_BANDS)[number] {
  return isThreatBand(value) && DEWS_ALERT_BANDS.includes(value as (typeof DEWS_ALERT_BANDS)[number]);
}

export const THREAT_BAND_LABELS: Record<ThreatBand, string> = {
  CALM: "Calm",
  WATCH: "Watch",
  ALERT: "Alert",
  WARNING: "Warning",
  DANGER: "Danger",
};

export const THREAT_BAND_COLORS: Record<ThreatBand, string> = {
  CALM: "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20",
  WATCH: "bg-teal-500/10 text-teal-700 dark:text-teal-400 border-teal-500/20",
  ALERT: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/20",
  WARNING: "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20",
  DANGER: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20",
};

export const THREAT_BAND_TEXT_COLORS: Record<ThreatBand, string> = {
  CALM: "text-green-700 dark:text-green-400",
  WATCH: "text-teal-700 dark:text-teal-400",
  ALERT: "text-yellow-700 dark:text-yellow-400",
  WARNING: "text-orange-700 dark:text-orange-400",
  DANGER: "text-red-700 dark:text-red-400",
};

export const THREAT_BAND_HEX: Record<ThreatBand, string> = {
  CALM: "#22c55e",
  WATCH: "#14b8a6",
  ALERT: "#eab308",
  WARNING: "#f97316",
  DANGER: "#ef4444",
};

/**
 * Derive the highest DEWS risk level from an array of threat bands.
 * Returns a lowercase token suitable for UI styling: "danger" | "warning" | "alert" | "calm".
 */
export type DewsRiskLevel = "danger" | "warning" | "alert" | "calm";

export function getDewsRiskLevel(bands: ThreatBand[]): DewsRiskLevel {
  let maxOrder = 0;
  for (const band of bands) {
    const order = THREAT_BAND_ORDER[band] ?? 0;
    if (order > maxOrder) maxOrder = order;
  }
  if (maxOrder >= THREAT_BAND_ORDER.DANGER) return "danger";
  if (maxOrder >= THREAT_BAND_ORDER.WARNING) return "warning";
  if (maxOrder >= THREAT_BAND_ORDER.ALERT) return "alert";
  return "calm";
}

// ---------------------------------------------------------------------------
// Feature status badge styles
// ---------------------------------------------------------------------------

export type FeatureStatus = "mature" | "experimental" | "beta" | "testing-in-prod";

export const FEATURE_STATUS_CONFIG: Record<FeatureStatus, { label: string; cls: string }> = {
  mature: {
    label: "Mature",
    cls: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30 dark:text-emerald-400 dark:border-emerald-500/40",
  },
  experimental: {
    label: "Beta",
    cls: "bg-amber-500/15 text-amber-700 border-amber-500/30 dark:text-amber-400 dark:border-amber-500/40",
  },
  beta: {
    label: "Beta",
    cls: "bg-amber-500/15 text-amber-700 border-amber-500/30 dark:text-amber-400 dark:border-amber-500/40",
  },
  "testing-in-prod": {
    label: "Testing in Prod",
    cls: "bg-orange-500/15 text-orange-700 border-orange-500/30 dark:text-orange-400 dark:border-orange-500/40",
  },
};

// ---------------------------------------------------------------------------
// Cron status badge colors (status page cron cards)
// ---------------------------------------------------------------------------

/** Badge class strings keyed by cron run status. */
export const CRON_STATUS_COLORS: Record<"ok" | "degraded" | "skipped_locked" | "error", string> = {
  ok: "bg-green-500/15 text-green-700 dark:text-green-400",
  degraded: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  skipped_locked: "bg-muted text-muted-foreground",
  error: "bg-red-500/15 text-red-700 dark:text-red-400",
};

// ---------------------------------------------------------------------------
// Query error notice tone styles
// ---------------------------------------------------------------------------

interface NoticeToneStyle {
  readonly title: string;
  readonly message: string;
  readonly detail: string | null;
  readonly tone: string;
  readonly iconBg: string;
}

/** Style config keyed by query-error notice type.
 *  The `icon` field (a React component) is intentionally omitted — it belongs
 *  in the component layer, not in runtime-neutral shared lib. */
export const NOTICE_TONE_COLORS: Record<"stale" | "unavailable" | "network" | "error", NoticeToneStyle> = {
  stale: {
    title: "Refresh delayed",
    message: "Showing the last successful snapshot while live refresh retries.",
    detail: "The rest of this view should remain usable while the dataset catches up.",
    tone: "border-amber-500/30 bg-amber-500/8 text-amber-700 dark:text-amber-400",
    iconBg: "bg-amber-500/15",
  },
  unavailable: {
    title: "Waiting for first sync",
    message: "This dataset has not populated yet.",
    detail: "Structural parts of the route may still render while the first successful snapshot is pending.",
    tone: "border-border/60 bg-muted/40 text-muted-foreground",
    iconBg: "bg-muted",
  },
  network: {
    title: "Connection issue",
    message: "Unable to reach the Pharos data API right now.",
    detail: "Retry when your connection stabilizes.",
    tone: "border-orange-500/30 bg-orange-500/8 text-orange-700 dark:text-orange-400",
    iconBg: "bg-orange-500/15",
  },
  error: {
    title: "Failed to load this dataset",
    message: "The dataset could not be loaded right now.",
    detail: null,
    tone: "border-red-500/30 bg-red-500/8 text-red-700 dark:text-red-400",
    iconBg: "bg-red-500/15",
  },
};

// ---------------------------------------------------------------------------
// Price transparency confidence level colors
// ---------------------------------------------------------------------------

/** Text color classes keyed by price-source confidence level. */
export const CONFIDENCE_LEVEL_COLORS: Record<"high" | "single-source" | "low" | "fallback", string> = {
  high: "text-emerald-600 dark:text-emerald-400",
  "single-source": "text-amber-600 dark:text-amber-400",
  low: "text-rose-600 dark:text-rose-400",
  fallback: "text-muted-foreground",
};

// ---------------------------------------------------------------------------
// Data health banner state styles
// ---------------------------------------------------------------------------

/** Border/bg/text class strings keyed by data health state. */
export const DATA_HEALTH_COLORS: Record<"degraded" | "stale" | "unavailable" | "error", string> = {
  degraded: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  stale: "border-amber-500/50 bg-amber-500/15 text-amber-700 dark:text-amber-300",
  unavailable: "border-border/60 bg-muted/40 text-muted-foreground",
  error: "border-destructive/50 bg-destructive/10 text-destructive",
};

// ---------------------------------------------------------------------------
// Balance bar ratio quality colors
// ---------------------------------------------------------------------------

/** Background color classes for ratio quality segments in BalanceBar. */
export const RATIO_QUALITY_COLORS: Record<"healthy" | "caution" | "critical", string> = {
  healthy: "bg-emerald-500",
  caution: "bg-amber-500",
  critical: "bg-red-500",
};

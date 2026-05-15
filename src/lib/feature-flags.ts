/**
 * Feature flags for the May 2026 stablecoin detail-page improvements.
 *
 * All flags default to `false` when the env var is unset. To enable, set the
 * matching `NEXT_PUBLIC_PHAROS_*` env var to the literal string `"true"`.
 *
 * See `docs/process/feature-flags.md` for the flag table, defaults, and how
 * to toggle them in local dev and on Cloudflare Pages.
 */

function readFlag(name: string): boolean {
  return process.env[name] === "true";
}

export const FEATURE_FLAGS = {
  heroVerdict: readFlag("NEXT_PUBLIC_PHAROS_HERO_VERDICT"),
  blacklistBanner: readFlag("NEXT_PUBLIC_PHAROS_BLACKLIST_BANNER"),
  quietDeviations: readFlag("NEXT_PUBLIC_PHAROS_QUIET_DEVIATIONS"),
  mobileStickySummary: readFlag("NEXT_PUBLIC_PHAROS_MOBILE_STICKY_SUMMARY"),
  lazyCharts: readFlag("NEXT_PUBLIC_PHAROS_LAZY_CHARTS"),
  chartAnnotations: readFlag("NEXT_PUBLIC_PHAROS_CHART_ANNOTATIONS"),
} as const;

export function isHeroVerdictEnabled(): boolean {
  return FEATURE_FLAGS.heroVerdict;
}

export function isBlacklistBannerEnabled(): boolean {
  return FEATURE_FLAGS.blacklistBanner;
}

export function isQuietDeviationsEnabled(): boolean {
  return FEATURE_FLAGS.quietDeviations;
}

export function isMobileStickySummaryEnabled(): boolean {
  return FEATURE_FLAGS.mobileStickySummary;
}

export function isLazyChartsEnabled(): boolean {
  return FEATURE_FLAGS.lazyCharts;
}

export function isChartAnnotationsEnabled(): boolean {
  return FEATURE_FLAGS.chartAnnotations;
}

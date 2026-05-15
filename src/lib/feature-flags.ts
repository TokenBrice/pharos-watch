/**
 * Feature flags for the May 2026 stablecoin detail-page improvements.
 *
 * All flags default to `false` when the env var is unset. To enable, set the
 * matching `NEXT_PUBLIC_PHAROS_*` env var to the literal string `"true"`.
 *
 * See `docs/process/feature-flags.md` for the flag table, defaults, flip
 * readiness gates, and how to toggle them in local dev and on Cloudflare Pages.
 *
 * Each flag carries an `expiresAt` comment. Past that date, the flag should
 * either be flipped on permanently (and the off-path removed) or have its
 * retention rationale documented.
 */

function readFlag(name: string): boolean {
  return process.env[name] === "true";
}

export const FEATURE_FLAGS = {
  // expiresAt: 2026-09-01 — pending top-60 oneLiner + TL;DR curation
  heroVerdict: readFlag("NEXT_PUBLIC_PHAROS_HERO_VERDICT"),
  // expiresAt: 2026-08-01 — pending iOS Safari sticky check
  blacklistBanner: readFlag("NEXT_PUBLIC_PHAROS_BLACKLIST_BANNER"),
  // expiresAt: 2026-08-01 — pending WCAG AA contrast spot-check
  quietDeviations: readFlag("NEXT_PUBLIC_PHAROS_QUIET_DEVIATIONS"),
  // expiresAt: 2026-08-01 — pending real-device scrollspy QA
  mobileStickySummary: readFlag("NEXT_PUBLIC_PHAROS_MOBILE_STICKY_SUMMARY"),
  // expiresAt: 2026-08-01 — pending mobile LCP measurement
  lazyCharts: readFlag("NEXT_PUBLIC_PHAROS_LAZY_CHARTS"),
  // expiresAt: 2026-09-01 — pending curation owner + cadence
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

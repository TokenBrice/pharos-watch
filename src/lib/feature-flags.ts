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
 *
 * IMPORTANT: each flag MUST be read via direct dot-syntax (`process.env.NAME`)
 * so Next.js inlines the value into the client bundle at build time. Dynamic
 * bracket access (`process.env[name]`) leaves the lookup intact at runtime,
 * resolving against an empty polyfill object in the browser so the flag is
 * silently always-false. Verified at build time by
 * `scripts/ci/check-feature-flag-inlining.mjs`.
 */

export const FEATURE_FLAGS = {
  // expiresAt: 2026-09-01 — pending top-60 oneLiner + TL;DR curation
  heroVerdict: process.env.NEXT_PUBLIC_PHAROS_HERO_VERDICT === "true",
  // expiresAt: 2026-08-01 — pending iOS Safari sticky check
  blacklistBanner: process.env.NEXT_PUBLIC_PHAROS_BLACKLIST_BANNER === "true",
  // expiresAt: 2026-08-01 — pending WCAG AA contrast spot-check
  quietDeviations: process.env.NEXT_PUBLIC_PHAROS_QUIET_DEVIATIONS === "true",
  // expiresAt: 2026-08-01 — pending real-device scrollspy QA
  mobileStickySummary:
    process.env.NEXT_PUBLIC_PHAROS_MOBILE_STICKY_SUMMARY === "true",
  // expiresAt: 2026-08-01 — pending mobile LCP measurement
  lazyCharts: process.env.NEXT_PUBLIC_PHAROS_LAZY_CHARTS === "true",
  // expiresAt: 2026-09-01 — pending curation owner + cadence
  chartAnnotations:
    process.env.NEXT_PUBLIC_PHAROS_CHART_ANNOTATIONS === "true",
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

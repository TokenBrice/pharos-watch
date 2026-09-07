/**
 * Feature flags for the May 2026 stablecoin detail-page improvements.
 *
 * Most flags default to `false` when the env var is unset. To enable those,
 * set the matching `NEXT_PUBLIC_PHAROS_*` env var to the literal string
 * `"true"`. `heroVerdict`, `depegResolver`, and `depegResolverReviewer` are
 * default-on and disable only when explicitly set to `"false"`.
 *
 * See `docs/process/feature-flags.md` for the flag table, defaults, flip
 * readiness gates, and how to toggle them in local dev and on Cloudflare Pages.
 *
 * Each temporary flag carries an `expiresAt` comment. Past that date, the flag should
 * either be flipped on permanently (and the off-path removed) or have its
 * retention rationale documented.
 *
 * IMPORTANT: each flag MUST be read via direct dot-syntax (`process.env.NAME`)
 * so Next.js inlines the value into the client bundle at build time. Dynamic
 * bracket access (`process.env[name]`) leaves the lookup intact at runtime,
 * resolving against an empty polyfill object in the browser so the flag is
 * silently always-false. Verified at build time by
 * `scripts/ci/check-feature-flag-inlining.ts`.
 */

export const FEATURE_FLAGS = {
  // Default-enabled after W3 launch. Set
  // `NEXT_PUBLIC_PHAROS_HERO_VERDICT=false` explicitly to disable.
  // owner: tokenbrice
  // retirementCriterion: keep permanently after the W3 launch; remove only if the hero verdict is retired.
  heroVerdict: process.env.NEXT_PUBLIC_PHAROS_HERO_VERDICT !== "false",
  // owner: tokenbrice; evidence: 2026-07-29 blacklist banner and hook tests pass.
  // retirementCriterion: remove once iOS Safari sticky review passes on a coin with active freezes.
  // expiresAt: 2026-10-15 — awaiting iOS Safari sticky review on a coin with active freezes
  blacklistBanner: process.env.NEXT_PUBLIC_PHAROS_BLACKLIST_BANNER === "true",
  // owner: tokenbrice; evidence: 2026-07-29 CLI contrast review passes AA (min 4.78:1 light, 7.23:1 dark).
  // retirementCriterion: remove once human visual review passes on USDC, USDe, and an active depeg.
  // expiresAt: 2026-11-01 — awaiting human visual review on USDC, USDe, and an active depeg
  quietDeviations: process.env.NEXT_PUBLIC_PHAROS_QUIET_DEVIATIONS === "true",
  // owner: tokenbrice; evidence: 2026-07-29 sticky summary and scrollspy tests pass.
  // retirementCriterion: remove once real-device iOS Safari and Android Chrome scrollspy review passes.
  // expiresAt: 2026-11-15 — awaiting real-device iOS Safari and Android Chrome scrollspy review
  mobileStickySummary:
    process.env.NEXT_PUBLIC_PHAROS_MOBILE_STICKY_SUMMARY === "true",
  // owner: tokenbrice
  // retirementCriterion: remove once chart-annotation curation has a named owner and cadence.
  // expiresAt: 2026-12-01 — pending curation owner + cadence
  chartAnnotations:
    process.env.NEXT_PUBLIC_PHAROS_CHART_ANNOTATIONS === "true",
  // owner: tokenbrice
  // retirementCriterion: remove once DDR v2 has 30 days without rollback.
  // expiresAt: 2026-12-15 — DDR emergency rollback, retained through the 4.3 continuity release
  depegResolver: process.env.NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER !== "false",
  // owner: tokenbrice
  // retirementCriterion: remove once DDRR v2 has 30 days without rollback.
  // expiresAt: 2027-01-05 — DDRR emergency rollback, retained through the 4.3 continuity release
  depegResolverReviewer:
    process.env.NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER_REVIEWER !== "false",
} as const;

export type FeatureFlagLifecycle = {
  readonly owner: "tokenbrice";
  readonly expiresAt?: string;
  readonly retirementCriterion: string;
};

export const FEATURE_FLAG_LIFECYCLE = {
  heroVerdict: {
    owner: "tokenbrice",
    retirementCriterion: "keep permanently after the W3 launch; remove only if the hero verdict is retired",
  },
  blacklistBanner: {
    owner: "tokenbrice",
    expiresAt: "2026-10-15",
    retirementCriterion: "remove once iOS Safari sticky review passes on a coin with active freezes",
  },
  quietDeviations: {
    owner: "tokenbrice",
    expiresAt: "2026-11-01",
    retirementCriterion: "remove once human visual review passes on USDC, USDe, and an active depeg",
  },
  mobileStickySummary: {
    owner: "tokenbrice",
    expiresAt: "2026-11-15",
    retirementCriterion: "remove once real-device iOS Safari and Android Chrome scrollspy review passes",
  },
  chartAnnotations: {
    owner: "tokenbrice",
    expiresAt: "2026-12-01",
    retirementCriterion: "remove once chart-annotation curation has a named owner and cadence",
  },
  depegResolver: {
    owner: "tokenbrice",
    expiresAt: "2026-12-15",
    retirementCriterion: "remove once DDR v2 has 30 days without rollback",
  },
  depegResolverReviewer: {
    owner: "tokenbrice",
    expiresAt: "2027-01-05",
    retirementCriterion: "remove once DDRR v2 has 30 days without rollback",
  },
} satisfies Record<keyof typeof FEATURE_FLAGS, FeatureFlagLifecycle>;

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

export function isChartAnnotationsEnabled(): boolean {
  return FEATURE_FLAGS.chartAnnotations;
}

export function isDepegResolverEnabled(): boolean {
  return FEATURE_FLAGS.depegResolver;
}

export function isDepegResolverReviewerEnabled(): boolean {
  return FEATURE_FLAGS.depegResolverReviewer;
}

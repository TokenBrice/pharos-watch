/**
 * Stablecoin IDs that get their own named bucket in the homepage hero cohort
 * bar chart. Everything not listed here rolls into "others".
 *
 * `usds-sky` and `dai-makerdao` share the `sky` bucket because Sky/MakerDAO is
 * a single issuer mid-migration (DAI -> USDS): the grouping is structural, not
 * incidental, so the two IDs must stay together even after the migration
 * completes. A build-time test (homepage-cohort-config.test.ts) guards that
 * every ID below remains a valid active stablecoin in the registry.
 */
export const HOMEPAGE_COHORT_BUCKET_IDS = {
  usdt: ["usdt-tether"],
  usdc: ["usdc-circle"],
  sky: ["usds-sky", "dai-makerdao"],
} as const satisfies Record<"usdt" | "usdc" | "sky", readonly string[]>;

export type HomepageCohortBucketKey = keyof typeof HOMEPAGE_COHORT_BUCKET_IDS;

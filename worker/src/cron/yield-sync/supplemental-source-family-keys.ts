export type SupplementalSourceFamilyKey =
  | "morpho"
  | "pendle"
  | "yearnKong"
  | "beefy"
  | "vaultsFyi"
  | "compoundV3"
  | "aaveV3"
  | "roycoDawn";

/**
 * Every supplemental source family the producer runs. Lives beside the key
 * union (not in the execution module) so cache keying, state loading, and the
 * status panel can consume it without importing the family runners — and so
 * the runners can import cache helpers without a module cycle.
 */
export const SUPPLEMENTAL_SOURCE_FAMILY_KEYS: SupplementalSourceFamilyKey[] = [
  "morpho",
  "pendle",
  "yearnKong",
  "beefy",
  "vaultsFyi",
  "compoundV3",
  "aaveV3",
  "roycoDawn",
];

/** Families whose retained snapshot gates the publication lane (partial-family-cache). */
export const REQUIRED_SUPPLEMENTAL_SOURCE_FAMILY_KEYS: SupplementalSourceFamilyKey[] = [
  "morpho",
  "pendle",
  "yearnKong",
  "beefy",
  "compoundV3",
  "aaveV3",
  "roycoDawn",
];

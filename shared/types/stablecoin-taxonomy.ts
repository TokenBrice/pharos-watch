export const GOVERNANCE_TYPE_VALUES = ["centralized", "centralized-dependent", "decentralized"] as const;
export type GovernanceType = (typeof GOVERNANCE_TYPE_VALUES)[number];

export const MECHANISM_ARCHETYPE_VALUES = [
  "fiat-cash",
  "tbill",
  "cdp",
  "synthetic-delta-neutral",
  "algorithmic",
  "rwa-credit-fund",
] as const;
export type MechanismArchetype = (typeof MECHANISM_ARCHETYPE_VALUES)[number];

export const STABLECOIN_STATUS_VALUES = ["pre-launch", "active", "quarantined", "delisted", "frozen"] as const;
export type StablecoinStatus = (typeof STABLECOIN_STATUS_VALUES)[number];

export const STABLECOIN_PRICE_BASIS_VALUES = [
  "executable-market",
  "redeemable-nav",
  "oracle-corroborated",
  "contractual-par",
] as const;
export type StablecoinPriceBasis = (typeof STABLECOIN_PRICE_BASIS_VALUES)[number];

export const STABLECOIN_EXIT_MECHANISM_VALUES = [
  "secondary-market",
  "ordinary-redemption",
  "maturity-only",
  "discretionary",
] as const;
export type StablecoinExitMechanism = (typeof STABLECOIN_EXIT_MECHANISM_VALUES)[number];

export type ListingClass =
  | "core-stablecoin"
  | "cash-equivalent"
  | "stablecoin-variant"
  | "stable-value-investment"
  | "excluded";

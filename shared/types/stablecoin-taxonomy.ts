import { z } from "zod";

export const GOVERNANCE_TYPE_VALUES = ["centralized", "centralized-dependent", "decentralized"] as const;
export type GovernanceType = (typeof GOVERNANCE_TYPE_VALUES)[number];

export const MECHANISM_ARCHETYPE_VALUES = [
  "fiat-cash",
  "tbill",
  "cdp",
  "synthetic-delta-neutral",
  "algorithmic",
  "rwa-credit-fund",
  "commodity-claim",
  "ucits-trs-fund",
  "shared-reserve",
  "protocol-position",
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

export const STABLECOIN_EXIT_MECHANISM_VALUES = [
  "secondary-market",
  "ordinary-redemption",
  "maturity-only",
  "discretionary",
] as const;

export type ListingClass =
  | "core-stablecoin"
  | "cash-equivalent"
  | "stablecoin-variant"
  | "stable-value-investment"
  | "excluded";

export const MECHANISM_ARCHETYPE_REVIEW_DISPOSITION_VALUES = ["resolved", "unresolved"] as const;

const GOVERNANCE_QUALITY_VALUES = [
  "immutable-code",
  "dao-governance",
  "multisig",
  "regulated-entity",
  "single-entity",
  "wrapper",
] as const;
export type GovernanceQuality = (typeof GOVERNANCE_QUALITY_VALUES)[number];

export const INFRASTRUCTURE_VALUES = ["liquity-v1", "liquity-v2", "m0"] as const;
export type Infrastructure = (typeof INFRASTRUCTURE_VALUES)[number];

export const VARIANT_KIND_VALUES = [
  "pure-wrapper",
  "savings-passthrough",
  "strategy-vault",
  "risk-absorption",
  "bond-maturity",
] as const;
export type VariantKind = (typeof VARIANT_KIND_VALUES)[number];

export const WRAPPER_OPERATOR_VALUES = ["parent-protocol", "third-party"] as const;
export const GovernanceQualitySchema = z.enum(GOVERNANCE_QUALITY_VALUES);

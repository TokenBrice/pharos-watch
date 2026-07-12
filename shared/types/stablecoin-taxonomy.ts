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

export const STABLECOIN_STATUS_VALUES = ["pre-launch", "active", "frozen"] as const;
export type StablecoinStatus = (typeof STABLECOIN_STATUS_VALUES)[number];

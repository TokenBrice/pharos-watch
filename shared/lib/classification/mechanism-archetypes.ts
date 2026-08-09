import type { MechanismArchetype } from "../../types";

export const MECHANISM_ARCHETYPE_LABELS: Record<MechanismArchetype, string> = {
  "fiat-cash": "Custodial Cash and Cash-Equivalents",
  tbill: "Tokenized Treasury",
  cdp: "Crypto-Collateralized (CDP)",
  "synthetic-delta-neutral": "Hedged Synthetic Dollar",
  algorithmic: "Reflexive / Unbacked",
  "rwa-credit-fund": "Tokenized Credit Fund",
  "commodity-claim": "Allocated Commodity Claim",
};

/**
 * Chip-length archetype names for dense surfaces (detail-hero passport strip).
 * Values must stay short enough to never need CSS truncation inside a pill.
 */
export const MECHANISM_ARCHETYPE_SHORT_LABELS: Record<MechanismArchetype, string> = {
  "fiat-cash": "Custodial Cash",
  tbill: "Tokenized Treasury",
  cdp: "Crypto CDP",
  "synthetic-delta-neutral": "Hedged Synthetic",
  algorithmic: "Reflexive / Unbacked",
  "rwa-credit-fund": "Credit Fund",
  "commodity-claim": "Commodity Claim",
};

export const MECHANISM_ARCHETYPE_CTA_NOUNS: Record<MechanismArchetype, string> = {
  "fiat-cash": "fiat-backed",
  tbill: "tokenized Treasury",
  cdp: "CDP",
  "synthetic-delta-neutral": "delta-neutral",
  algorithmic: "algorithmic",
  "rwa-credit-fund": "credit-fund",
  "commodity-claim": "commodity-backed",
};

export const MECHANISM_ARCHETYPE_ONE_LINERS: Record<MechanismArchetype, string> = {
  "fiat-cash":
    "Centralized issuers custody dollars in bank accounts and short-term Treasuries; tokens are minted and redeemed on demand.",
  tbill:
    "Regulated funds hold short-duration Treasuries; the token is a fund share that accretes NAV instead of trading exactly at $1.",
  cdp: "Overcollateralized vaults issue stablecoin debt; positions liquidate when collateral falls below a safety ratio.",
  "synthetic-delta-neutral":
    "Offsetting economic exposures target a stable net value; implementations range from spot-plus-perp hedges to on-chain lending with matched borrow-and-stake legs.",
  algorithmic:
    "The peg is held by protocol-level mint/burn rules and arbitrage incentives rather than by 1:1 reserves.",
  "rwa-credit-fund":
    "Regulated funds hold private credit, CLO tranches, or other non-Treasury debt; the token is a fund share whose NAV reflects credit losses and quarterly redemption gates.",
  "commodity-claim":
    "The token is a title claim on specific vaulted metal rather than on dollars; it tracks the commodity price and can usually be redeemed for physical delivery in whole-bar lots.",
};

export function getMechanismArchetypeLabel(value: MechanismArchetype): string {
  return MECHANISM_ARCHETYPE_LABELS[value];
}

export function getMechanismArchetypeCtaNoun(value: MechanismArchetype): string {
  return MECHANISM_ARCHETYPE_CTA_NOUNS[value];
}

export function getMechanismArchetypeOneLiner(value: MechanismArchetype): string {
  return MECHANISM_ARCHETYPE_ONE_LINERS[value];
}

export function getMechanismExplainerPath(value: MechanismArchetype): string {
  return `/learn/mechanisms/${value}/`;
}

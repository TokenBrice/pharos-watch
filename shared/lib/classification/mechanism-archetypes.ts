import type { MechanismArchetype } from "../../types";

export const MECHANISM_ARCHETYPE_LABELS: Record<MechanismArchetype, string> = {
  "fiat-cash": "Fiat-Backed",
  tbill: "Tokenized Treasury",
  cdp: "CDP",
  "synthetic-delta-neutral": "Delta-Neutral",
  algorithmic: "Algorithmic",
};

export const MECHANISM_ARCHETYPE_ONE_LINERS: Record<MechanismArchetype, string> = {
  "fiat-cash":
    "Centralized issuers custody dollars in bank accounts and short-term Treasuries; tokens are minted and redeemed on demand.",
  tbill:
    "Regulated funds hold short-duration Treasuries; the token is a fund share that accretes NAV instead of trading exactly at $1.",
  cdp: "Overcollateralized vaults issue stablecoin debt; positions liquidate when collateral falls below a safety ratio.",
  "synthetic-delta-neutral":
    "Spot crypto plus an equal short perpetual position adds up to a roughly dollar-stable claim; yield comes from funding rates.",
  algorithmic:
    "The peg is held by protocol-level mint/burn rules and arbitrage incentives rather than by 1:1 reserves.",
};

export function getMechanismArchetypeLabel(value: MechanismArchetype): string {
  return MECHANISM_ARCHETYPE_LABELS[value];
}

export function getMechanismArchetypeOneLiner(value: MechanismArchetype): string {
  return MECHANISM_ARCHETYPE_ONE_LINERS[value];
}

export function getMechanismExplainerPath(value: MechanismArchetype): string {
  return `/learn/mechanisms/${value}/`;
}

import type { MechanismArchetype } from "../../types";
import { projectDescriptors } from "./descriptors";

export const MECHANISM_ARCHETYPE_DESCRIPTORS = {
  "fiat-cash": { label: "Custodial Cash and Cash-Equivalents", shortLabel: "Custodial Cash", ctaNoun: "fiat-backed",
    oneLiner: "Centralized issuers custody dollars in bank accounts and short-term Treasuries; tokens are minted and redeemed on demand.",
  },
  tbill: { label: "Tokenized Treasury", shortLabel: "Tokenized Treasury", ctaNoun: "tokenized Treasury",
    oneLiner: "Regulated funds hold short-duration Treasuries; the token is a fund share that accretes NAV instead of trading exactly at $1.",
  },
  cdp: { label: "Crypto-Collateralized (CDP)", shortLabel: "Crypto CDP", ctaNoun: "CDP",
    oneLiner: "Overcollateralized vaults issue stablecoin debt; positions liquidate when collateral falls below a safety ratio.",
  },
  "synthetic-delta-neutral": { label: "Hedged Synthetic Dollar", shortLabel: "Hedged Synthetic", ctaNoun: "delta-neutral",
    oneLiner: "Offsetting economic exposures target a stable net value; implementations range from spot-plus-perp hedges to on-chain lending with matched borrow-and-stake legs.",
  },
  algorithmic: { label: "Reflexive / Unbacked", shortLabel: "Reflexive / Unbacked", ctaNoun: "algorithmic",
    oneLiner: "The peg is held by protocol-level mint/burn rules and arbitrage incentives rather than by 1:1 reserves.",
  },
  "rwa-credit-fund": { label: "Tokenized Credit Fund", shortLabel: "Credit Fund", ctaNoun: "credit-fund",
    oneLiner: "Regulated funds hold private credit, CLO tranches, or other non-Treasury debt; the token is a fund share whose NAV reflects credit losses and quarterly redemption gates.",
  },
  "commodity-claim": { label: "Allocated Commodity Claim", shortLabel: "Commodity Claim", ctaNoun: "commodity-backed",
    oneLiner: "The token is a title claim on specific vaulted metal rather than on dollars; it tracks the commodity price and can usually be redeemed for physical delivery in whole-bar lots.",
  },
};

export const MECHANISM_ARCHETYPE_LABELS: Record<MechanismArchetype, string> =
  projectDescriptors(MECHANISM_ARCHETYPE_DESCRIPTORS, (descriptor) => descriptor.label);

/** Chip-length names for dense surfaces; values must fit pills without truncation. */
export const MECHANISM_ARCHETYPE_SHORT_LABELS: Record<MechanismArchetype, string> =
  projectDescriptors(MECHANISM_ARCHETYPE_DESCRIPTORS, (descriptor) => descriptor.shortLabel);

const MECHANISM_ARCHETYPE_CTA_NOUNS: Record<MechanismArchetype, string> =
  projectDescriptors(MECHANISM_ARCHETYPE_DESCRIPTORS, (descriptor) => descriptor.ctaNoun);

export const MECHANISM_ARCHETYPE_ONE_LINERS: Record<MechanismArchetype, string> =
  projectDescriptors(MECHANISM_ARCHETYPE_DESCRIPTORS, (descriptor) => descriptor.oneLiner);

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

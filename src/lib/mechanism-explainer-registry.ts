import type { MechanismArchetype } from "@shared/types";

export const MECHANISM_EXPLAINER_TITLES: Readonly<Record<MechanismArchetype, string>> = {
  "fiat-cash": "Fiat-Backed Stablecoins, Explained",
  tbill: "Tokenized Treasury Stablecoins, Explained",
  cdp: "CDP Stablecoins, Explained",
  "synthetic-delta-neutral": "Delta-Neutral Stablecoins, Explained",
  algorithmic: "Algorithmic Stablecoins, Explained",
  "rwa-credit-fund": "Tokenized Credit Fund Stablecoins, Explained",
  "commodity-claim": "Gold and Commodity Tokens, Explained",
};

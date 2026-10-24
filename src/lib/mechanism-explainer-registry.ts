import type { MechanismArchetype } from "@shared/types";

export const MECHANISM_EXPLAINER_TITLES: Readonly<Record<MechanismArchetype, string>> = {
  "fiat-cash": "Fiat-Backed Stablecoins, Explained",
  tbill: "Tokenized Treasury Stablecoins, Explained",
  cdp: "CDP Stablecoins: Collateralized Debt Positions",
  "synthetic-delta-neutral": "Delta-Neutral Stablecoins, Explained",
  algorithmic: "Algorithmic Stablecoins, Explained",
  "rwa-credit-fund": "Tokenized Credit Fund Stablecoins, Explained",
  "commodity-claim": "Gold and Commodity Tokens, Explained",
  "ucits-trs-fund": "UCITS Physical Securities and TRS Funds, Explained",
  "shared-reserve": "Shared Reserve Stablecoins, Explained",
  "protocol-position": "Protocol Position Stablecoins, Explained",
};

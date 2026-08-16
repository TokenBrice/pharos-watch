import type { MechanismArchetype } from "@shared/types";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";

export const MECHANISM_EXPLAINER_TITLES: Readonly<Record<MechanismArchetype, string>> = {
  "fiat-cash": "Fiat-Backed Stablecoins, Explained",
  tbill: "Tokenized Treasury Stablecoins, Explained",
  cdp: "CDP Stablecoins, Explained",
  "synthetic-delta-neutral": "Delta-Neutral Stablecoins, Explained",
  algorithmic: "Algorithmic Stablecoins, Explained",
  "rwa-credit-fund": "Tokenized Credit Fund Stablecoins, Explained",
  "commodity-claim": "Gold and Commodity Tokens, Explained",
};

interface MechanismExplainerEntry {
  slug: MechanismArchetype;
  title: string;
  ogFilename: `og-learn-${MechanismArchetype}.png`;
}

/** Ordered, script-safe projection for route metadata and OG generation. */
export const MECHANISM_EXPLAINER_ENTRIES: readonly MechanismExplainerEntry[] =
  MECHANISM_ARCHETYPE_VALUES.map((slug) => ({
    slug,
    title: MECHANISM_EXPLAINER_TITLES[slug],
    ogFilename: `og-learn-${slug}.png`,
  }));

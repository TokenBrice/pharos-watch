import type { CauseOfDeath } from "../../types/cause-of-death";

/**
 * Cause mark colours for the light theme (and any theme-less context).
 * Categories, not states: equal lightness (OKLCH L ~0.56), moderate chroma,
 * distinct hues, none on the risk ramp, Grade-B blue or frost-blue. Each clears
 * 4.4:1 on #fafafa; pair with `CAUSE_HEX_DARK` through CSS custom properties so
 * dark mode swaps without reading the theme in JS.
 */
export const CAUSE_HEX: Record<CauseOfDeath, string> = {
  "algorithmic-failure": "#bc484b",
  "counterparty-failure": "#936d24",
  "liquidity-drain": "#a95d3a",
  regulatory: "#6570a9",
  abandoned: "#6d7580",
};

/** Cause mark colours for the dark theme (OKLCH L ~0.70); each clears 6:1 on #171717. */
export const CAUSE_HEX_DARK: Record<CauseOfDeath, string> = {
  "algorithmic-failure": "#ed7473",
  "counterparty-failure": "#bf9752",
  "liquidity-drain": "#d78863",
  regulatory: "#8e9ad7",
  abandoned: "#969fab",
};

export const CAUSE_META: Record<
  CauseOfDeath,
  { label: string; definition: string; textColor: string; borderColor: string }
> = {
  "algorithmic-failure": {
    label: "Algorithmic Failure",
    definition:
      "The stabilizing mechanism broke: a reflexive mint, burn, or seigniorage design could not absorb selling.",
    textColor: "text-[#bc484b] dark:text-[#ed7473]",
    borderColor: "border-[#bc484b]/30",
  },
  "counterparty-failure": {
    label: "Counterparty Failure",
    definition:
      "A party the coin depended on failed: a custodian, bridge, issuer entity, fund manager, or key holder.",
    textColor: "text-[#936d24] dark:text-[#bf9752]",
    borderColor: "border-[#936d24]/30",
  },
  "liquidity-drain": {
    label: "Liquidity Drain",
    definition: "Exits outpaced the liquid backing, and the price fell below peg and stayed there.",
    textColor: "text-[#a95d3a] dark:text-[#d78863]",
    borderColor: "border-[#a95d3a]/30",
  },
  regulatory: {
    label: "Regulatory",
    definition: "A regulator or licensing regime ended issuance, whether or not the coin was solvent.",
    textColor: "text-[#6570a9] dark:text-[#8e9ad7]",
    borderColor: "border-[#6570a9]/30",
  },
  abandoned: {
    label: "Abandoned",
    definition:
      "The issuer or protocol stopped maintaining the coin: a sunset, migration, acquisition, or loss of demand.",
    textColor: "text-[#6d7580] dark:text-[#969fab]",
    borderColor: "border-[#6d7580]/30",
  },
};

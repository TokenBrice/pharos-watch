import type { CauseOfDeath } from "../types/cause-of-death";

export { CAUSE_OF_DEATH_VALUES } from "../types/cause-of-death";
export type { CauseOfDeath } from "../types/cause-of-death";

/** Canonical cause order for every UI surface (legends, strips, columns, filters). */
export const CAUSE_ORDER: readonly CauseOfDeath[] = [
  "abandoned",
  "counterparty-failure",
  "liquidity-drain",
  "algorithmic-failure",
  "regulatory",
];

/**
 * Cause mark colours for the light theme (and any theme-less context).
 * Each clears 3:1 non-text contrast on every light surface; pair with
 * `CAUSE_HEX_DARK` through CSS custom properties so dark mode swaps without
 * reading the theme in JS.
 */
export const CAUSE_HEX: Record<CauseOfDeath, string> = {
  "algorithmic-failure": "#ef4444",
  "counterparty-failure": "#a16207",
  "liquidity-drain": "#7c2d12",
  regulatory: "#1e40af",
  abandoned: "#71717a",
};

/** Cause mark colours for the dark theme; each clears 3:1 on every dark surface. */
export const CAUSE_HEX_DARK: Record<CauseOfDeath, string> = {
  "algorithmic-failure": "#ef4444",
  "counterparty-failure": "#fbbf24",
  "liquidity-drain": "#b45309",
  regulatory: "#2563eb",
  abandoned: "#71717a",
};

export const CAUSE_META: Record<
  CauseOfDeath,
  { label: string; definition: string; textColor: string; borderColor: string }
> = {
  "algorithmic-failure": {
    label: "Algorithmic Failure",
    definition:
      "The stabilizing mechanism broke: a reflexive mint, burn, or seigniorage design could not absorb selling.",
    textColor: "text-red-700 dark:text-red-400",
    borderColor: "border-red-500/30",
  },
  "counterparty-failure": {
    label: "Counterparty Failure",
    definition:
      "A party the coin depended on failed: a custodian, bridge, issuer entity, fund manager, or key holder.",
    textColor: "text-yellow-800 dark:text-amber-400",
    borderColor: "border-yellow-600/30",
  },
  "liquidity-drain": {
    label: "Liquidity Drain",
    definition: "Exits outpaced the liquid backing, and the price fell below peg and stayed there.",
    textColor: "text-orange-900 dark:text-orange-400",
    borderColor: "border-orange-700/30",
  },
  regulatory: {
    label: "Regulatory",
    definition: "A regulator or licensing regime ended issuance, whether or not the coin was solvent.",
    textColor: "text-blue-800 dark:text-blue-400",
    borderColor: "border-blue-700/30",
  },
  abandoned: {
    label: "Abandoned",
    definition:
      "The issuer or protocol stopped maintaining the coin: a sunset, migration, acquisition, or loss of demand.",
    textColor: "text-zinc-700 dark:text-zinc-400",
    borderColor: "border-zinc-500/30",
  },
};

/** Cause labels in `CAUSE_ORDER` as one prose list ("A, B, C, D, or E") for copy surfaces. */
export const CAUSE_LABEL_LIST = new Intl.ListFormat("en", { type: "disjunction" }).format(
  CAUSE_ORDER.map((cause) => CAUSE_META[cause].label),
);

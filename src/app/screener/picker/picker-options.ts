import { PEG_METADATA } from "@shared/lib/classification";
import {
  SELECTOR_ELIGIBLE_PEG_CURRENCIES,
  SELECTOR_YIELD_PEG_CURRENCIES,
} from "@shared/lib/selector";
import type { SelectorOption } from "@/components/selector/selector-question-card";
import {
  shouldSkipExitStep,
  type SelectorDepeg,
  type SelectorExit,
  type SelectorHorizon,
  type SelectorPeg,
  type SelectorProfile,
  type SelectorVenue,
} from "./selector-state";

export const PROFILE_OPTIONS: readonly SelectorOption<SelectorProfile>[] = [
  {
    value: "treasury",
    label: "Hold under Treasury constraints",
    sublabel: "Park value with peg discipline; minimal DeFi interaction.",
  },
  {
    value: "yield",
    label: "Earn yield",
    sublabel: "Compose across protocols for return on idle stablecoin exposure.",
  },
  {
    value: "trading",
    label: "Trade actively",
    sublabel: "Fast settlement, tight peg, liquid exits.",
  },
];

const PEG_SUBLABEL: Record<SelectorPeg, string> = {
  USD: "Default dollar-denominated universe.",
  EUR: "Euro-denominated stablecoin universe.",
  CHF: "Swiss franc universe with yield and trading coverage.",
  GOLD: "Tokenized gold universe with live signal coverage.",
};

export const PEG_OPTIONS: readonly SelectorOption<SelectorPeg>[] =
  SELECTOR_ELIGIBLE_PEG_CURRENCIES.map((value) => ({
    value,
    label: PEG_METADATA[value]?.filterLabel ?? value,
    sublabel: PEG_SUBLABEL[value],
  }));

export const YIELD_PEG_SET = new Set<string>(SELECTOR_YIELD_PEG_CURRENCIES);

export const HORIZON_OPTIONS: readonly SelectorOption<SelectorHorizon>[] = [
  { value: "lt24h", label: "Under 24 hours" },
  { value: "1to7d", label: "1 – 7 days" },
  { value: "1to4w", label: "1 – 4 weeks" },
  { value: "1to6m", label: "1 – 6 months" },
  { value: "6mplus", label: "6 months or more" },
];

export const DEPEG_OPTIONS: readonly SelectorOption<SelectorDepeg>[] = [
  { value: "zero", label: "Zero tolerance", sublabel: "Peg must hold without exception." },
  { value: "tight", label: "Within 0.5%", sublabel: "Brief slippage acceptable if liquidity holds." },
  { value: "moderate", label: "Moderate", sublabel: "Short depegs OK if recovery is clean." },
];

export const VENUE_OPTIONS_BY_PROFILE: Record<SelectorProfile, readonly SelectorOption<SelectorVenue>[]> = {
  yield: [
    { value: "lend", label: "Major lending protocols" },
    { value: "dex", label: "DEX liquidity pools" },
    { value: "wrap", label: "Yield-bearing wrappers" },
    { value: "all", label: "All of the above" },
  ],
  trading: [
    { value: "cex", label: "Centralized venues" },
    { value: "perps", label: "Perps DEX" },
    { value: "spot", label: "Spot DEX" },
    { value: "all", label: "All of the above" },
  ],
  treasury: [
    {
      value: "custody",
      label: "Regulated custody",
      sublabel: "Prefer issuer or custodian rails; avoid DeFi exposure.",
    },
    {
      value: "some",
      label: "Mixed rails",
      sublabel: "Custody first, with optional on-chain movement later.",
    },
    {
      value: "active",
      label: "DeFi-native / on-chain",
      sublabel: "Require on-chain custody and decentralized posture.",
    },
  ],
};

export const EXIT_OPTIONS: readonly SelectorOption<SelectorExit>[] = [
  { value: "1h", label: "Under 1 hour" },
  { value: "24h", label: "Same day" },
  { value: "any", label: "Not in a hurry" },
];

export const PROFILE_LABEL: Record<SelectorProfile, string> = {
  treasury: "Treasury",
  yield: "Yield",
  trading: "Active Trading",
};

export const LEGEND_BY_PROFILE_Q4: Record<SelectorProfile, string> = {
  yield: "Where will you put it to work?",
  trading: "Where will you trade?",
  treasury: "What custody or rail setup do you prefer?",
};

export const QUESTION_HELPER_COPY: Record<2 | 3 | 4 | 5 | 6, string> = {
  2: "Narrows the universe to this reference asset.",
  3: "Longer horizons weight resilience and history more heavily.",
  4: "Tighter tolerance raises the peg and stress thresholds.",
  5: "Shifts allowed custody, composability, and source exposure.",
  6: "Faster exits weight liquidity, DEWS, and redemption pathways.",
};

export function computeTotalSteps(
  profile: SelectorProfile | null,
  horizon: SelectorHorizon | null,
  depeg: SelectorDepeg | null,
): number {
  if (shouldSkipExitStep(profile, horizon, depeg)) return 5;
  return 6;
}

export function stepLegend(state: { step: number | "result" }): string {
  switch (state.step) {
    case 1:
      return "What are you using this stablecoin for?";
    case 2:
      return "Which peg currency should it target?";
    case 3:
      return "How long do you plan to hold this position?";
    case 4:
      return "How tight does the peg need to hold?";
    case 5:
      return "What custody or rail setup do you prefer?";
    case 6:
      return "If something goes wrong, how fast do you need to be out?";
    default:
      return "";
  }
}

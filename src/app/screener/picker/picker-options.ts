import { PEG_METADATA } from "@shared/lib/classification";
import { SELECTOR_ELIGIBLE_PEG_CURRENCIES } from "@shared/lib/selector";
import type { SelectorOption } from "@/components/selector/selector-question-card";
import {
  preHighlightForDepeg,
  shouldSkipExitStep,
  type SelectorAction,
  type SelectorDepeg,
  type SelectorExit,
  type SelectorHorizon,
  type SelectorPeg,
  type SelectorProfile,
  type SelectorVenue,
  type SelectorWizardState,
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

const PEG_OPTIONS: readonly SelectorOption<SelectorPeg>[] =
  SELECTOR_ELIGIBLE_PEG_CURRENCIES.map((value) => ({
    value,
    label: PEG_METADATA[value]?.filterLabel ?? value,
    sublabel: PEG_SUBLABEL[value],
  }));

const YIELD_PEG_SET = new Set<string>(SELECTOR_ELIGIBLE_PEG_CURRENCIES);

/** Yield is limited to pegs with benchmark and source coverage. */
function pegOptionsForProfile(profile: SelectorProfile): readonly SelectorOption<SelectorPeg>[] {
  return profile === "yield" ? PEG_OPTIONS.filter((option) => YIELD_PEG_SET.has(option.value)) : PEG_OPTIONS;
}

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
    { value: "lend", label: "Lending and structured opportunities" },
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

const VENUE_LEGEND_BY_PROFILE: Record<SelectorProfile, string> = {
  yield: "Where will you put it to work?",
  trading: "Where will you trade?",
  treasury: "What custody or rail setup do you prefer?",
};

export const PROFILE_LEGEND = "What are you using this stablecoin for?";

export type SelectorQuestionId = "q2" | "q3" | "q4" | "q5" | "q6";

/**
 * One descriptor per wizard question after the profile step (Q1). The desktop wizard
 * (`screener/picker/client.tsx`) renders the descriptor matching the active step; the mobile
 * single-form (`components/selector/selector-mobile-form.tsx`) renders every descriptor at once.
 * Both read the same legend / helper / options / value / action accessors, so the two surfaces
 * cannot drift apart again — mobile previously dropped three of the five helper strings.
 *
 * Value types are erased to `string` here so the five rows share one table; each accessor casts
 * back to its own union at the single point where it builds the reducer action.
 */
export interface SelectorQuestionDescriptor {
  questionId: SelectorQuestionId;
  step: 2 | 3 | 4 | 5 | 6;
  /** Mobile-only kicker; desktop keeps the default "Step X of Y · Profile" kicker. */
  kickerLabel: (profile: SelectorProfile) => string;
  legend: (profile: SelectorProfile) => string;
  /** Desktop-only sub-legend rendered under the question. */
  legendSubtext?: (profile: SelectorProfile) => string | undefined;
  helper: string;
  options: (profile: SelectorProfile) => readonly SelectorOption<string>[];
  multi?: (profile: SelectorProfile) => boolean;
  value: (state: SelectorWizardState, profile: SelectorProfile) => string | readonly string[] | null;
  preHighlight?: (state: SelectorWizardState, profile: SelectorProfile) => string | undefined;
  /** Selection update that does not advance the wizard. */
  setAction: (value: string | readonly string[]) => SelectorAction;
  /** Desktop "Next" commit; `null` when the current answer is not complete enough to advance. */
  answerAction: (state: SelectorWizardState) => SelectorAction | null;
}

function toVenueList(value: string | readonly string[]): readonly SelectorVenue[] {
  return (Array.isArray(value) ? value : [value]) as readonly SelectorVenue[];
}

export const SELECTOR_QUESTIONS: readonly SelectorQuestionDescriptor[] = [
  {
    questionId: "q2",
    step: 2,
    kickerLabel: () => "Question 2 — Peg currency",
    legend: () => "Which peg currency should it target?",
    legendSubtext: (profile) =>
      profile === "yield" ? "Yield is limited to pegs with benchmark and source coverage." : undefined,
    helper: "Narrows the universe to this reference asset.",
    options: (profile) => pegOptionsForProfile(profile),
    value: (state) => state.pegCurrency,
    setAction: (value) => ({ type: "set-peg", value: value as SelectorPeg }),
    answerAction: (state) => ({ type: "answer-peg", value: state.pegCurrency }),
  },
  {
    questionId: "q3",
    step: 3,
    kickerLabel: () => "Question 3 — Horizon",
    legend: () => "How long do you plan to hold this position?",
    helper: "Longer horizons weight resilience and history more heavily.",
    options: () => HORIZON_OPTIONS,
    value: (state) => state.horizon,
    setAction: (value) => ({ type: "set-horizon", value: value as SelectorHorizon }),
    answerAction: (state) => (state.horizon ? { type: "answer-horizon", value: state.horizon } : null),
  },
  {
    questionId: "q4",
    step: 4,
    kickerLabel: () => "Question 4 — Peg tolerance",
    legend: () => "How tight does the peg need to hold?",
    helper: "Tighter tolerance raises the peg and stress thresholds.",
    options: () => DEPEG_OPTIONS,
    value: (state) => state.depegTolerance,
    preHighlight: (state, profile) => preHighlightForDepeg(profile, state.horizon),
    setAction: (value) => ({ type: "set-depeg", value: value as SelectorDepeg }),
    answerAction: (state) =>
      state.depegTolerance ? { type: "answer-depeg", value: state.depegTolerance } : null,
  },
  {
    questionId: "q5",
    step: 5,
    kickerLabel: (profile) => `Question 5 — ${profile === "treasury" ? "Rails" : "Venues"}`,
    legend: (profile) => VENUE_LEGEND_BY_PROFILE[profile],
    helper: "Shifts allowed custody, composability, and source exposure.",
    options: (profile) => VENUE_OPTIONS_BY_PROFILE[profile],
    multi: (profile) => profile !== "treasury",
    value: (state, profile) => (profile === "treasury" ? (state.venue[0] ?? null) : state.venue),
    setAction: (value) => ({ type: "set-venue", value: toVenueList(value) }),
    answerAction: (state) => (state.venue.length > 0 ? { type: "answer-venue", value: state.venue } : null),
  },
  {
    questionId: "q6",
    step: 6,
    kickerLabel: () => "Question 6 — Exit speed",
    legend: () => "If something goes wrong, how fast do you need to be out?",
    helper: "Faster exits weight liquidity, DEWS, and redemption pathways.",
    options: () => EXIT_OPTIONS,
    value: (state) => state.exitSpeed,
    setAction: (value) => ({ type: "set-exit", value: value as SelectorExit }),
    answerAction: (state) => (state.exitSpeed ? { type: "answer-exit", value: state.exitSpeed } : null),
  },
];

export function computeTotalSteps(
  profile: SelectorProfile | null,
  horizon: SelectorHorizon | null,
  depeg: SelectorDepeg | null,
): number {
  if (shouldSkipExitStep(profile, horizon, depeg)) return 5;
  return 6;
}

/** Announcement copy for the live region; reads the same legends the cards render. */
export function stepLegend(state: { step: number | "result"; profile: SelectorProfile | null }): string {
  if (state.step === 1) return PROFILE_LEGEND;
  if (typeof state.step !== "number" || state.profile == null) return "";
  const question = SELECTOR_QUESTIONS.find((candidate) => candidate.step === state.step);
  return question ? question.legend(state.profile) : "";
}

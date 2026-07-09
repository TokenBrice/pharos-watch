import { PEG_METADATA } from "@shared/lib/classification";
import {
  buildScreenerUrl,
  selectorAnswersToScreenerFilters,
  type SelectorInput,
  type SelectorOutput,
} from "@shared/lib/selector";
import type { SelectorOption } from "@/components/selector/selector-question-card";
import type { SelectorResultSummaryProps } from "@/components/selector/selector-result-summary";
import { shouldSkipExitStep, type SelectorStep, type SelectorVenue, type SelectorWizardState } from "./selector-state";
import {
  DEPEG_OPTIONS,
  EXIT_OPTIONS,
  HORIZON_OPTIONS,
  PROFILE_LABEL,
  VENUE_OPTIONS_BY_PROFILE,
} from "./picker-options";

export interface ScreenerHandoffView {
  url: string;
  filterChips: Array<{ label: string; value: string }>;
}

type ResultSummaryCoordinationProps = Pick<
  SelectorResultSummaryProps,
  "answerChips" | "priorityLabels" | "filterChips" | "usedRelaxedFallback" | "relaxedReasons"
>;

export function buildScreenerHandoff(output: SelectorOutput | null): ScreenerHandoffView {
  if (!output) return { url: "/screener/", filterChips: [] };
  try {
    const { url } = buildScreenerUrl(output.input, "/screener/");
    const { filters } = selectorAnswersToScreenerFilters(output.input);
    return {
      url,
      filterChips: readableScreenerFilterChips(filters),
    };
  } catch {
    return { url: "/screener/", filterChips: [] };
  }
}

export function buildCompareWithWatchoutsHref(output: SelectorOutput, state: SelectorWizardState): string {
  const ids = [...output.recommended.map((rec) => rec.id), ...output.lowerRanked.map((entry) => entry.id)];
  return buildCompareHref(output, state, ids);
}

export function buildCompareShortlistHref(output: SelectorOutput): string {
  const params = new URLSearchParams();
  params.set("coins", output.recommended.map((rec) => rec.id).join(","));
  return `/compare/?${params.toString()}`;
}

export function buildYieldInspectionHref(output: SelectorOutput): string | null {
  if (output.profile !== "yield" || output.recommended.length === 0) return null;

  const ids = output.recommended.map((rec) => rec.id).slice(0, 4);
  const params = new URLSearchParams();
  params.set("from", "selector");
  if (ids.length > 1) {
    params.set("compare", ids.join(","));
  } else {
    const [rec] = output.recommended;
    params.set("q", rec.symbol);
    params.set("compare", rec.id);
  }
  return `/yield/?${params.toString()}`;
}

function buildCompareHref(output: SelectorOutput, state: SelectorWizardState, coinIds: readonly string[]): string {
  const input = output.input;
  const params = new URLSearchParams();
  params.set("p", input.profile);
  params.set("peg", input.pegCurrency);
  params.set("h", input.horizon);
  params.set("d", input.depegTolerance);
  params.set("v", compareVenueParam(input, state));
  params.set("u", input.exitSpeed);
  params.set("step", "result");
  params.set("coins", Array.from(new Set(coinIds)).join(","));
  return `/compare/?${params.toString()}`;
}

function compareVenueParam(input: SelectorInput, state: SelectorWizardState): string {
  const inputVenue = venuePreferencesFromInput(input);
  if (inputVenue.length > 0) return inputVenue.join(",");

  if (
    state.profile === input.profile &&
    state.pegCurrency === input.pegCurrency &&
    state.horizon === input.horizon &&
    state.depegTolerance === input.depegTolerance &&
    state.venue.length > 0
  ) {
    return state.venue.join(",");
  }

  return venueFromInput(input).join(",");
}

export function venueFromInput(input: SelectorInput): readonly SelectorVenue[] {
  const venue = venuePreferencesFromInput(input);
  if (venue.length > 0) return venue;

  if (input.profile === "treasury") {
    if (input.composability === "none") return ["custody"];
    if (input.composability === "high") return ["active"];
    return ["some"];
  }
  if (input.composability === "high") return ["all"];
  return input.profile === "yield" ? ["lend"] : ["cex"];
}

function venuePreferencesFromInput(input: SelectorInput): readonly SelectorVenue[] {
  const allowed = new Set(VENUE_OPTIONS_BY_PROFILE[input.profile].map((option) => option.value));
  return (input.venuePreferences ?? []).filter((value): value is SelectorVenue => allowed.has(value as SelectorVenue));
}

export function buildResultSummaryCoordinationProps({
  output,
  state,
  screenerHandoff,
}: {
  output: SelectorOutput;
  state: SelectorWizardState;
  screenerHandoff: ScreenerHandoffView;
}): ResultSummaryCoordinationProps {
  const relaxed = output as SelectorOutput & {
    usedRelaxedFallback?: boolean;
    relaxedReasons?: readonly string[];
  };
  return {
    answerChips: answerChipsFor(output.input, state),
    priorityLabels: priorityLabelsFor(output.input),
    filterChips: screenerHandoff.filterChips,
    usedRelaxedFallback: relaxed.usedRelaxedFallback ?? false,
    relaxedReasons: relaxed.relaxedReasons ?? [],
  };
}

function answerChipsFor(
  input: SelectorInput,
  state: SelectorWizardState,
): Array<{ key: string; label: string; value: string }> {
  const chips = [
    { key: "profile", label: "Profile", value: PROFILE_LABEL[input.profile] },
    { key: "peg", label: "Peg", value: PEG_METADATA[input.pegCurrency]?.filterLabel ?? input.pegCurrency },
    { key: "horizon", label: "Horizon", value: labelForOption(HORIZON_OPTIONS, input.horizon) },
    { key: "depeg", label: "Peg tolerance", value: labelForOption(DEPEG_OPTIONS, input.depegTolerance) },
    {
      key: "venue",
      label: input.profile === "treasury" ? "Rail" : "Venue",
      value: venueLabelFor(input, state),
    },
  ];
  if (!shouldSkipExitStep(input.profile, input.horizon, input.depegTolerance)) {
    chips.push({ key: "exit", label: "Exit", value: labelForOption(EXIT_OPTIONS, input.exitSpeed) });
  }
  return chips;
}

function labelForOption<T extends string>(options: readonly SelectorOption<T>[], value: T): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

function venueLabelFor(input: SelectorInput, state: SelectorWizardState): string {
  const venue = venuePreferencesFromInput(input);
  const values = venue.length > 0 ? venue : compareVenueParam(input, state).split(",");
  const options = VENUE_OPTIONS_BY_PROFILE[input.profile];
  return values.map((value) => options.find((option) => option.value === value)?.label ?? value).join(", ");
}

function priorityLabelsFor(input: SelectorInput): string[] {
  if (input.profile === "treasury") {
    return ["Safety", "Resilience", "Dependency risk", "Peg discipline"];
  }
  if (input.profile === "yield") {
    return ["Yield score", "Source risk", "Variance", "Safety", "Peg discipline"];
  }
  return ["Liquidity", "Current peg quality", "DEWS", "Exit speed", "Market depth"];
}

function readableScreenerFilterChips(filters: Record<string, unknown>): Array<{ label: string; value: string }> {
  const labels: Record<string, string> = {
    safetyGrades: "Safety grades",
    lifecycle: "Lifecycle",
    pegs: "Peg",
    safetyPegStabilityMin: "Peg stability min",
    safetyResilienceMin: "Resilience min",
    safetyDependencyRiskMin: "Dependency risk min",
    safetyLiquidityMin: "Liquidity min",
    dewsMax: "DEWS max",
    types: "Type",
    blacklistable: "Blacklistable",
    mintAuthority: "Mint authority route",
    mintAuthorityScoreMin: "Mint Authority Score min",
    mintAuthorityScores: "Mint Authority Score bands",
    mechanisms: "Mechanism",
  };
  return Object.entries(filters).map(([key, value]) => {
    const label = labels[key] ?? key;
    const formatted = Array.isArray(value) ? value.join(", ") : String(value);
    return { label, value: formatted };
  });
}

export function stepForAnswerKey(key: string): SelectorStep {
  switch (key) {
    case "profile":
      return 1;
    case "peg":
      return 2;
    case "horizon":
      return 3;
    case "depeg":
      return 4;
    case "venue":
      return 5;
    case "exit":
      return 6;
    default:
      return 1;
  }
}

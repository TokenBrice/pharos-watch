export type PegCohortKey = "USD" | "EUR" | "GBP" | "GOLD" | "OTHER";

export interface PegCohortDef {
  key: PegCohortKey;
  label: string;
}

export const PEG_COHORTS: readonly PegCohortDef[] = [
  { key: "USD", label: "USD" },
  { key: "EUR", label: "EUR" },
  { key: "GBP", label: "GBP" },
  { key: "GOLD", label: "Gold" },
  { key: "OTHER", label: "Other Fiat" },
] as const;

const PEG_COHORT_BY_KEY = new Map<PegCohortKey, PegCohortDef>(
  PEG_COHORTS.map((cohort) => [cohort.key, cohort]),
);

export function classifyPegCohort(pegCurrency: string): PegCohortDef {
  if (pegCurrency === "USD") return PEG_COHORT_BY_KEY.get("USD")!;
  if (pegCurrency === "EUR") return PEG_COHORT_BY_KEY.get("EUR")!;
  if (pegCurrency === "GBP") return PEG_COHORT_BY_KEY.get("GBP")!;
  if (pegCurrency === "GOLD" || pegCurrency === "SILVER") {
    return PEG_COHORT_BY_KEY.get("GOLD")!;
  }
  return PEG_COHORT_BY_KEY.get("OTHER")!;
}

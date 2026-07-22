export type FxSourceCadence = "intraday" | "calendar-daily" | "business-daily";
type FxRateSourceModeForCadence = "live" | "cached" | "hardcoded";
type NaturalFxSourceCadence = Exclude<FxSourceCadence, "intraday">;

export const BUSINESS_DAILY_FX_PEGS: ReadonlySet<string> = new Set([
  "peggedEUR",
  "peggedGBP",
  "peggedCHF",
  "peggedREAL",
  "peggedJPY",
  "peggedIDR",
  "peggedSGD",
  "peggedTRY",
  "peggedAUD",
  "peggedZAR",
  "peggedCAD",
  "peggedCNY",
  "peggedPHP",
  "peggedMXN",
  "peggedMYR",
  "peggedKRW",
  "peggedHKD",
  "peggedINR",
]);

export const CALENDAR_DAILY_FX_PEGS: ReadonlySet<string> = new Set([
  "peggedCNH",
  "peggedRUB",
  "peggedUAH",
  "peggedARS",
  "peggedKGS",
  "peggedNGN",
  "peggedXOF",
  "peggedVND",
]);

export function getNaturalFxCadence(pegKey: string): NaturalFxSourceCadence | null {
  if (CALENDAR_DAILY_FX_PEGS.has(pegKey)) return "calendar-daily";
  if (BUSINESS_DAILY_FX_PEGS.has(pegKey)) return "business-daily";
  return null;
}

export function inferFxSourceCadence(
  pegKey: string,
  mode: FxRateSourceModeForCadence | undefined,
  explicitCadence?: FxSourceCadence,
): FxSourceCadence {
  if (explicitCadence) return explicitCadence;
  if (mode === "hardcoded") return "intraday";
  return getNaturalFxCadence(pegKey) ?? "intraday";
}

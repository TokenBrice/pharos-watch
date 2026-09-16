import { PRIMARY_CURRENCY_TO_PEG, SECONDARY_FX_CURRENCY_TO_PEG } from "./fx-config";

export type FxSourceCadence = "intraday" | "calendar-daily" | "business-daily";
type FxRateSourceModeForCadence = "live" | "cached" | "hardcoded";
type NaturalFxSourceCadence = Exclude<FxSourceCadence, "intraday">;

export const BUSINESS_DAILY_FX_PEGS: ReadonlySet<string> = new Set(
  Object.values(PRIMARY_CURRENCY_TO_PEG),
);

export const CALENDAR_DAILY_FX_PEGS: ReadonlySet<string> = new Set(
  Object.values(SECONDARY_FX_CURRENCY_TO_PEG),
);

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

import { logWorkerEventArgs } from "./structured-log";
import { FX_RATE_BOUNDS } from "@shared/lib/peg-price-bounds";

export const PRIMARY_PEG_TYPE_TO_CURRENCY_PAIRS = [
  ["peggedEUR", "EUR"],
  ["peggedGBP", "GBP"],
  ["peggedCHF", "CHF"],
  ["peggedREAL", "BRL"],
  ["peggedJPY", "JPY"],
  ["peggedIDR", "IDR"],
  ["peggedSGD", "SGD"],
  ["peggedTRY", "TRY"],
  ["peggedAUD", "AUD"],
  ["peggedZAR", "ZAR"],
  ["peggedCAD", "CAD"],
  ["peggedCNY", "CNY"],
  ["peggedPHP", "PHP"],
  ["peggedMXN", "MXN"],
  ["peggedMYR", "MYR"],
  ["peggedKRW", "KRW"],
  ["peggedHKD", "HKD"],
  ["peggedINR", "INR"],
] as const;

export const PRIMARY_FX_CURRENCIES = PRIMARY_PEG_TYPE_TO_CURRENCY_PAIRS.map(([, currency]) => currency);

export const PRIMARY_CURRENCY_TO_PEG: Record<string, string> = Object.fromEntries(
  PRIMARY_PEG_TYPE_TO_CURRENCY_PAIRS.map(([pegType, currency]) => [currency, pegType]),
);

// Keys are lowercase ISO codes as returned by the fawazahmed0 currency API.
// Peg values must match REALTIME_FX_CURRENCY_TO_PEG below for the same currencies
// (asserted by fx-config.test.ts); only the key casing differs by source format.
export const SECONDARY_PEG_TYPE_TO_CURRENCY_PAIRS = [
  ["peggedCNH", "CNH"],
  ["peggedRUB", "RUB"],
  ["peggedUAH", "UAH"],
  ["peggedARS", "ARS"],
  ["peggedKGS", "KGS"],
  ["peggedNGN", "NGN"],
  ["peggedXOF", "XOF"],
  ["peggedVND", "VND"],
  ["peggedKES", "KES"],
  ["peggedGHS", "GHS"],
  ["peggedCOP", "COP"],
  ["peggedCLP", "CLP"],
  ["peggedPEN", "PEN"],
] as const;

export const SECONDARY_FX_CURRENCY_TO_PEG: Record<string, string> = Object.fromEntries(
  SECONDARY_PEG_TYPE_TO_CURRENCY_PAIRS.map(([pegType, currency]) => [currency.toLowerCase(), pegType]),
);

// Keys are uppercase ISO codes (the realtime source's response format). The
// secondary block mirrors SECONDARY_FX_CURRENCY_TO_PEG above with uppercased keys;
// the two must agree on peg values after casing (asserted by fx-config.test.ts).
export const REALTIME_FX_CURRENCY_TO_PEG: Record<string, string> = {
  ...PRIMARY_CURRENCY_TO_PEG,
  ...Object.fromEntries(
    SECONDARY_PEG_TYPE_TO_CURRENCY_PAIRS.map(([pegType, currency]) => [currency, pegType]),
  ),
};

export const EXPECTED_FX_PEG_KEYS = [
  ...Object.values(PRIMARY_CURRENCY_TO_PEG),
  ...Object.values(SECONDARY_FX_CURRENCY_TO_PEG),
];

const MAX_FX_RATE_DELTA_PCT = 0.20;

export function invertUnitsPerUsd(unitsPerUsd: number): number {
  if (!Number.isFinite(unitsPerUsd) || unitsPerUsd <= 0) {
    throw new RangeError("unitsPerUsd must be a positive finite number");
  }
  return 1 / unitsPerUsd;
}

export function isValidFxRate(
  pegKey: string,
  rate: number,
  prevRate?: number,
  logPrefix = "[fx]",
): boolean {
  const bounds = FX_RATE_BOUNDS[pegKey];
  if (bounds && (rate < bounds[0] || rate > bounds[1])) {
    logWorkerEventArgs("lib", "warn", `${logPrefix} Rejected ${pegKey}=${rate}: outside bounds [${bounds[0]}, ${bounds[1]}]`);
    return false;
  }
  if (prevRate != null && prevRate > 0) {
    const delta = Math.abs(rate - prevRate) / prevRate;
    if (delta > MAX_FX_RATE_DELTA_PCT) {
      logWorkerEventArgs("lib", "warn", `${logPrefix} Rejected ${pegKey}=${rate}: ${(delta * 100).toFixed(1)}% change from prev ${prevRate}`);
      return false;
    }
  }
  return true;
}

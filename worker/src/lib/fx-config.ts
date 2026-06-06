import { FX_RATE_BOUNDS } from "@shared/lib/peg-price-bounds";

export const PRIMARY_FX_CURRENCIES = [
  "EUR",
  "GBP",
  "CHF",
  "BRL",
  "JPY",
  "IDR",
  "SGD",
  "TRY",
  "AUD",
  "ZAR",
  "CAD",
  "CNY",
  "PHP",
  "MXN",
  "MYR",
  "KRW",
] as const;

export const PRIMARY_CURRENCY_TO_PEG: Record<string, string> = {
  EUR: "peggedEUR",
  GBP: "peggedGBP",
  CHF: "peggedCHF",
  BRL: "peggedREAL",
  JPY: "peggedJPY",
  IDR: "peggedIDR",
  SGD: "peggedSGD",
  TRY: "peggedTRY",
  AUD: "peggedAUD",
  ZAR: "peggedZAR",
  CAD: "peggedCAD",
  CNY: "peggedCNY",
  PHP: "peggedPHP",
  MXN: "peggedMXN",
  MYR: "peggedMYR",
  KRW: "peggedKRW",
};

export const SECONDARY_FX_CURRENCY_TO_PEG: Record<string, string> = {
  cnh: "peggedCNH",
  rub: "peggedRUB",
  uah: "peggedUAH",
  ars: "peggedARS",
  kgs: "peggedKGS",
  ngn: "peggedNGN",
  xof: "peggedXOF",
  vnd: "peggedVND",
};

export const REALTIME_FX_CURRENCY_TO_PEG: Record<string, string> = {
  ...PRIMARY_CURRENCY_TO_PEG,
  CNH: "peggedCNH",
  RUB: "peggedRUB",
  UAH: "peggedUAH",
  ARS: "peggedARS",
  KGS: "peggedKGS",
  NGN: "peggedNGN",
  XOF: "peggedXOF",
  VND: "peggedVND",
};

export const EXPECTED_FX_PEG_KEYS = [
  ...Object.values(PRIMARY_CURRENCY_TO_PEG),
  ...Object.values(SECONDARY_FX_CURRENCY_TO_PEG),
];

const MAX_FX_RATE_DELTA_PCT = 0.20;

export function isValidFxRate(
  pegKey: string,
  rate: number,
  prevRate?: number,
  logPrefix = "[fx]",
): boolean {
  const bounds = FX_RATE_BOUNDS[pegKey];
  if (bounds && (rate < bounds[0] || rate > bounds[1])) {
    console.warn(`${logPrefix} Rejected ${pegKey}=${rate}: outside bounds [${bounds[0]}, ${bounds[1]}]`);
    return false;
  }
  if (prevRate != null && prevRate > 0) {
    const delta = Math.abs(rate - prevRate) / prevRate;
    if (delta > MAX_FX_RATE_DELTA_PCT) {
      console.warn(`${logPrefix} Rejected ${pegKey}=${rate}: ${(delta * 100).toFixed(1)}% change from prev ${prevRate}`);
      return false;
    }
  }
  return true;
}

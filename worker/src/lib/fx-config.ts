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
};

export const SECONDARY_FX_CURRENCY_TO_PEG: Record<string, string> = {
  cnh: "peggedCNH",
  rub: "peggedRUB",
  uah: "peggedUAH",
  ars: "peggedARS",
};

export const REALTIME_FX_CURRENCY_TO_PEG: Record<string, string> = {
  ...PRIMARY_CURRENCY_TO_PEG,
  CNH: "peggedCNH",
  RUB: "peggedRUB",
  UAH: "peggedUAH",
  ARS: "peggedARS",
};

export const EXPECTED_FX_PEG_KEYS = [
  ...Object.values(PRIMARY_CURRENCY_TO_PEG),
  ...Object.values(SECONDARY_FX_CURRENCY_TO_PEG),
];

const FX_RATE_BOUNDS: Record<string, [number, number]> = {
  peggedEUR: [0.50, 2.50],
  peggedGBP: [0.50, 3.00],
  peggedCHF: [0.40, 2.50],
  peggedREAL: [0.05, 0.60],
  peggedJPY: [0.003, 0.03],
  peggedIDR: [0.00003, 0.0003],
  peggedSGD: [0.30, 1.50],
  peggedTRY: [0.01, 0.20],
  peggedAUD: [0.30, 1.50],
  peggedZAR: [0.02, 0.20],
  peggedRUB: [0.003, 0.10],
  peggedCAD: [0.40, 1.50],
  peggedCNY: [0.05, 0.40],
  peggedCNH: [0.05, 0.40],
  peggedPHP: [0.01, 0.06],
  peggedMXN: [0.02, 0.15],
  peggedUAH: [0.01, 0.10],
  peggedARS: [0.0001, 0.01],
  peggedSILVER: [5, 500],
  peggedGOLD: [500, 10000],
};

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

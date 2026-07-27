export type PegClass = "usd" | "fiat_fx" | "commodity" | "nav" | "variable" | "unknown";

export const HARDCODED_PRICE_BOUNDS: Record<string, [min: number, max: number]> = {
  USD: [0.01, 1.19],
  EUR: [0.01, 2],
  GBP: [0.01, 2],
  CHF: [0.01, 2],
  BRL: [0.01, 2],
  REAL: [0.01, 2],
  JPY: [0.001, 0.05],
  IDR: [0.00001, 0.001],
  SGD: [0.2, 5],
  TRY: [0.005, 0.5],
  AUD: [0.2, 5],
  RUB: [0.005, 0.5],
  ZAR: [0.01, 0.5],
  CAD: [0.3, 2],
  CNY: [0.01, 0.5],
  CNH: [0.01, 0.5],
  PHP: [0.002, 0.1],
  MXN: [0.005, 0.2],
  MYR: [0.18, 0.3],
  KRW: [0.0005, 0.001],
  HKD: [0.01, 0.5],
  INR: [0.001, 0.1],
  UAH: [0.002, 0.15],
  ARS: [0.000001, 0.05],
  KGS: [0.005, 0.05],
  NGN: [0.0002, 0.005],
  XOF: [0.001, 0.005],
  VND: [0.00002, 0.00006],
  // 2026-07 spots (fawazahmed0 currency-api / open.er-api.com): KES ~129,
  // GHS ~11.6, COP ~3210, CLP ~948, PEN ~3.40 per USD. Bounds cover the
  // published multi-year ranges (CBK ~100-165; BoG ~6-16; BanRep ~2500-5000;
  // BCCh ~600-1100; BCRP ~3.0-4.1 per USD) with headroom on both sides.
  KES: [0.005, 0.012],
  GHS: [0.02, 0.25],
  COP: [0.00015, 0.0006],
  CLP: [0.0007, 0.002],
  PEN: [0.2, 0.4],
  GOLD: [100, 100_000],
  SILVER: [5, 500],
};

export const FX_RATE_BOUNDS: Record<string, [min: number, max: number]> = {
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
  peggedMYR: [0.18, 0.30],
  peggedKRW: [0.0005, 0.0010],
  peggedHKD: [0.05, 0.25],
  peggedINR: [0.005, 0.05],
  peggedUAH: [0.01, 0.10],
  peggedARS: [0.0001, 0.01],
  peggedKGS: [0.005, 0.05],
  peggedNGN: [0.0002, 0.005],
  peggedXOF: [0.001, 0.005],
  peggedVND: [0.00002, 0.00006],
  // Same reference ranges as the HARDCODED_PRICE_BOUNDS entries above
  // (2026-07 secondary/tertiary FX spots vs multi-year central-bank ranges).
  peggedKES: [0.005, 0.012],
  peggedGHS: [0.02, 0.25],
  peggedCOP: [0.00015, 0.0006],
  peggedCLP: [0.0007, 0.002],
  peggedPEN: [0.2, 0.4],
  peggedSILVER: [5, 500],
  peggedGOLD: [500, 10000],
};

/** Normalize the legacy "peggedBRL" alias to "peggedREAL" used by DefiLlama. */
export function normalizeLegacyPegType(pegType: string): string {
  return pegType === "peggedBRL" ? "peggedREAL" : pegType;
}

export function normalizePegTypeFromCurrency(pegCurrency: string | undefined): string | undefined {
  if (!pegCurrency || pegCurrency === "VAR" || pegCurrency === "OTHER") {
    return undefined;
  }
  if (pegCurrency === "BRL") {
    return "peggedREAL";
  }
  return `pegged${pegCurrency}`;
}

export function classifyPegClass(pegCurrency: string | undefined, pegType: string | undefined, navToken: boolean): PegClass {
  if (navToken) return "nav";
  if (pegCurrency === "VAR" || pegCurrency === "OTHER") return "variable";
  if (!pegType) return "unknown";
  if (pegType.includes("USD")) return "usd";
  if (pegType.includes("GOLD") || pegType.includes("SILVER")) return "commodity";
  if (
    pegType.includes("EUR") ||
    pegType.includes("GBP") ||
    pegType.includes("CHF") ||
    pegType.includes("REAL") ||
    pegType.includes("BRL") ||
    pegType.includes("JPY") ||
    pegType.includes("IDR") ||
    pegType.includes("SGD") ||
    pegType.includes("TRY") ||
    pegType.includes("AUD") ||
    pegType.includes("RUB") ||
    pegType.includes("ZAR") ||
    pegType.includes("CAD") ||
    pegType.includes("CNY") ||
    pegType.includes("CNH") ||
    pegType.includes("PHP") ||
    pegType.includes("MXN") ||
    pegType.includes("MYR") ||
    pegType.includes("KRW") ||
    pegType.includes("HKD") ||
    pegType.includes("INR") ||
    pegType.includes("KGS") ||
    pegType.includes("NGN") ||
    pegType.includes("XOF") ||
    pegType.includes("UAH") ||
    pegType.includes("ARS") ||
    pegType.includes("VND") ||
    pegType.includes("KES") ||
    pegType.includes("GHS") ||
    pegType.includes("COP") ||
    pegType.includes("CLP") ||
    pegType.includes("PEN")
  ) {
    return "fiat_fx";
  }
  return "unknown";
}

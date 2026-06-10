import type { MechanismArchetype } from "@shared/types";

export interface HeroPassportMrzInput {
  /** Coin display name. */
  name: string;
  /** Ticker. */
  symbol: string;
  /** PegCurrency enum value (USD, EUR, ..., GOLD, SILVER, VAR, OTHER). */
  pegCurrency: string;
  /** Jurisdiction display string, e.g. "United States". */
  jurisdictionCountry: string | null;
  /** ISO YYYY-MM-DD launch date. */
  launchDate: string | null;
  /** ReportCard grade, e.g. "B+", "A", "C-". */
  overallGrade: string | null;
  /** 0-100. */
  overallScore: number | null;
  /** 0-100. */
  pegScore: number | null;
  /** 0-100. */
  liquidityScore: number | null;
  /** 0-100. */
  dewsScore: number | null;
  /** DEWS band, e.g. "Watch" — copyText only. */
  dewsBandLabel: string | null;
  chainCount: number;
  blacklistStatus: true | "possible" | "inherited" | null;
  /** MechanismArchetype value. */
  mechanismArchetype: string | null;
  /** Human mechanism label — copyText only. */
  mechanismLabel: string | null;
  /** Absolute canonical page URL — copyText only. */
  url: string;
}

export interface HeroPassportMrzViewModel {
  /** Two TD3-style lines, each exactly 44 chars of `A–Z 0–9 <`. */
  lines: [string, string];
  /** Human-readable research citation written to the clipboard. */
  copyText: string;
  /** Button accessible name — no MRZ glyphs. */
  ariaLabel: string;
}

const MRZ_LINE_LENGTH = 44;

/**
 * Jurisdiction display string (`jurisdiction.country` in `coins/*.json`) →
 * ISO-3166 alpha-3 code for the MRZ nationality slot. Bounded to countries
 * actually present in the dataset; unmapped or undisclosed → `XXX` (ICAO
 * "unspecified"). "Cyprus / Lithuania" (dual-jurisdiction display string) is
 * deliberately unmapped — XXX is the honest single-code encoding.
 */
export const COUNTRY_MRZ_CODES: Record<string, string> = {
  "Antigua and Barbuda": "ATG",
  Argentina: "ARG",
  Australia: "AUS",
  Bermuda: "BMU",
  Brazil: "BRA",
  "British Virgin Islands": "VGB",
  Canada: "CAN",
  "Cayman Islands": "CYM",
  Chile: "CHL",
  Colombia: "COL",
  Croatia: "HRV",
  Dominica: "DMA",
  "El Salvador": "SLV",
  Finland: "FIN",
  France: "FRA",
  Georgia: "GEO",
  Germany: "DEU",
  "Hong Kong": "HKG",
  Iceland: "ISL",
  India: "IND",
  Indonesia: "IDN",
  Japan: "JPN",
  Kazakhstan: "KAZ",
  "Kyrgyz Republic": "KGZ",
  Kyrgyzstan: "KGZ",
  Liechtenstein: "LIE",
  Luxembourg: "LUX",
  Malaysia: "MYS",
  Malta: "MLT",
  "Marshall Islands": "MHL",
  Mexico: "MEX",
  Netherlands: "NLD",
  Nigeria: "NGA",
  Norway: "NOR",
  Panama: "PAN",
  Peru: "PER",
  Seychelles: "SYC",
  Singapore: "SGP",
  "South Africa": "ZAF",
  "South Korea": "KOR",
  Sweden: "SWE",
  Switzerland: "CHE",
  Turkey: "TUR",
  UAE: "ARE",
  "Union of Comoros": "COM",
  "United Arab Emirates": "ARE",
  "United Kingdom": "GBR",
  "United States": "USA",
};

/** Mnemonic 5-char A–Z MRZ code per mechanism archetype. */
export const MECHANISM_MRZ_CODES: Record<MechanismArchetype, string> = {
  "fiat-cash": "CCASH",
  tbill: "TBILL",
  cdp: "CRCDP",
  "synthetic-delta-neutral": "DNEUT",
  algorithmic: "ALGOR",
  "rwa-credit-fund": "CREDF",
};

function mrzCharValue(char: string): number {
  if (char === "<") return 0;
  if (char >= "0" && char <= "9") return char.charCodeAt(0) - 48;
  return char.charCodeAt(0) - 55; // A=10 … Z=35
}

/**
 * ICAO 9303 7-3-1 check digit: char values (digits face value, A=10…Z=35,
 * `<`=0) weighted 7,3,1 cycling, summed mod 10.
 */
export function computeMrzCheckDigit(value: string): string {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < value.length; i++) {
    sum += mrzCharValue(value[i]) * weights[i % 3];
  }
  return String(sum % 10);
}

/** Truncate to `width` and `<`-pad — every MRZ slot is fixed-width. */
function padSlot(value: string, width: number): string {
  return value.slice(0, width).padEnd(width, "<");
}

/**
 * MRZ transliteration: strip diacritics (NFD + combining-mark removal),
 * uppercase, collapse each run of non-[A-Z0-9] (spaces, punctuation) to a
 * single `<`, and trim boundary fillers.
 */
function transliterateMrz(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "<")
    .replace(/^</, "")
    .replace(/<$/, "");
}

/** Uppercase and drop non-[A-Z0-9] outright (no `<` separators). */
function sanitizeAlphanumeric(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// GOLD/SILVER take their ISO-4217 metal codes; 3-char fiat codes pass through.
const PEG_MRZ_OVERRIDES: Record<string, string> = {
  GOLD: "XAU",
  SILVER: "XAG",
  OTHER: "OTH",
  VAR: "VAR",
};

function pegSlot(pegCurrency: string): string {
  return PEG_MRZ_OVERRIDES[pegCurrency] ?? padSlot(sanitizeAlphanumeric(pegCurrency), 3);
}

/** Letter + modifier: `+`→P, `-`→M, plain→`<` (B+→BP, A→A<, C-→CM). */
function gradeSlot(grade: string | null): string {
  if (!grade) return "<<";
  const modifier = grade[1] === "+" ? "P" : grade[1] === "-" ? "M" : "<";
  return grade[0].toUpperCase() + modifier;
}

function scoreSlot(score: number | null): string {
  if (score === null) return "<<<";
  return String(Math.round(score)).padStart(3, "0");
}

function freezeSlot(blacklistStatus: HeroPassportMrzInput["blacklistStatus"]): string {
  switch (blacklistStatus) {
    case true:
      return "Y";
    case "possible":
      return "P";
    case "inherited":
      return "U";
    default:
      return "N";
  }
}

/** `YYMMDD` by string-slicing the ISO date — never via a Date object. */
function launchDateSlot(launchDate: string | null): string {
  if (!launchDate || !/^\d{4}-\d{2}-\d{2}$/.test(launchDate)) return "<<<<<<";
  return launchDate.slice(2, 4) + launchDate.slice(5, 7) + launchDate.slice(8, 10);
}

function mechanismSlot(mechanismArchetype: string | null): string {
  if (!mechanismArchetype || !(mechanismArchetype in MECHANISM_MRZ_CODES)) return "<<<<<";
  return MECHANISM_MRZ_CODES[mechanismArchetype as MechanismArchetype];
}

const FREEZE_COPY_LABELS: Record<string, string> = {
  true: "yes",
  possible: "possible",
  inherited: "upstream",
};

function buildCopyText(input: HeroPassportMrzInput): string {
  const launchYear = input.launchDate && /^\d{4}-\d{2}-\d{2}$/.test(input.launchDate) ? input.launchDate.slice(0, 4) : null;
  const head = launchYear
    ? `${input.symbol} (${input.name}, launched ${launchYear})`
    : `${input.symbol} (${input.name})`;

  const clauses: string[] = [];
  if (input.overallGrade && input.overallScore !== null) {
    clauses.push(`Pharos Safety ${input.overallGrade} (${input.overallScore}/100)`);
  } else if (input.overallGrade) {
    clauses.push(`Pharos Safety ${input.overallGrade}`);
  } else if (input.overallScore !== null) {
    clauses.push(`Pharos Safety ${input.overallScore}/100`);
  }
  if (input.pegScore !== null) clauses.push(`Peg ${input.pegScore}`);
  if (input.liquidityScore !== null) clauses.push(`Liquidity ${input.liquidityScore}`);
  if (input.dewsScore !== null) {
    clauses.push(
      input.dewsBandLabel ? `DEWS ${input.dewsScore}/100 (${input.dewsBandLabel})` : `DEWS ${input.dewsScore}/100`,
    );
  }
  if (input.mechanismLabel) clauses.push(input.mechanismLabel);
  if (input.jurisdictionCountry) clauses.push(`${input.jurisdictionCountry} jurisdiction`);
  clauses.push(`Freeze: ${FREEZE_COPY_LABELS[String(input.blacklistStatus)] ?? "no"}`);
  if (input.chainCount > 0) {
    clauses.push(`${input.chainCount} chain${input.chainCount === 1 ? "" : "s"}`);
  }

  return `${head} — ${clauses.join(" · ")} — ${input.url}`;
}

function buildAriaLabel(input: HeroPassportMrzInput): string {
  const recap: string[] = [];
  if (input.overallGrade && input.overallScore !== null) {
    recap.push(`Safety ${input.overallGrade} ${input.overallScore} of 100`);
  } else if (input.overallGrade) {
    recap.push(`Safety ${input.overallGrade}`);
  } else if (input.overallScore !== null) {
    recap.push(`Safety ${input.overallScore} of 100`);
  }
  if (input.pegScore !== null) recap.push(`peg ${input.pegScore}`);
  if (input.liquidityScore !== null) recap.push(`liquidity ${input.liquidityScore}`);
  if (input.dewsScore !== null) recap.push(`DEWS ${input.dewsScore} of 100`);

  const base = `Copy ${input.symbol} research summary`;
  return recap.length > 0 ? `${base}: ${recap.join(", ")}` : base;
}

/**
 * The hero machine-readable zone: a TD3-style 2 × 44-char encoding of the
 * passport facts (charset `A–Z 0–9 <`), plus the human-readable research
 * citation the zone copies and the button's accessible name.
 *
 * Line 1 (identity): `PW<` (Pharos Watch dossier) + ISO-3166 alpha-3
 * jurisdiction + `<` + transliterated coin name, `<`-filled to 44.
 *
 * Line 2 (vitals): fixed slots — symbol(7) peg(3) grade(2) safety(3) peg
 * score(3) liquidity(3) DEWS(3) chains(3) freeze(1) mechanism(5) launch
 * YYMMDD(6) — then the ICAO 7-3-1 check digit over those 39 chars, `<`-filled
 * to 44. Missing data fills its slot with `<`.
 */
export function buildHeroPassportMrz(input: HeroPassportMrzInput): HeroPassportMrzViewModel {
  const countryCode = (input.jurisdictionCountry && COUNTRY_MRZ_CODES[input.jurisdictionCountry]) || "XXX";
  const line1 = padSlot(`PW<${countryCode}<${transliterateMrz(input.name)}`, MRZ_LINE_LENGTH);

  const vitals =
    padSlot(sanitizeAlphanumeric(input.symbol), 7) +
    pegSlot(input.pegCurrency) +
    gradeSlot(input.overallGrade) +
    scoreSlot(input.overallScore) +
    scoreSlot(input.pegScore) +
    scoreSlot(input.liquidityScore) +
    scoreSlot(input.dewsScore) +
    String(Math.min(input.chainCount, 999)).padStart(3, "0") +
    freezeSlot(input.blacklistStatus) +
    mechanismSlot(input.mechanismArchetype) +
    launchDateSlot(input.launchDate);
  const line2 = (vitals + computeMrzCheckDigit(vitals)).padEnd(MRZ_LINE_LENGTH, "<");

  return {
    lines: [line1, line2],
    copyText: buildCopyText(input),
    ariaLabel: buildAriaLabel(input),
  };
}

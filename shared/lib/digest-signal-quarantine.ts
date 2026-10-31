import { escapeRegExp } from "./escape-regexp";

export type DigestSignalFamily = "liquidity" | "depeg" | "yield" | "flow";

export interface DigestSignalQuarantine {
  stablecoinId: string;
  family: DigestSignalFamily;
  /** Legacy digest inputs identify liquidity rows by symbol only. */
  symbols: readonly string[];
  /**
   * Clock the window below is measured on. `ingestion` (default) is the daily
   * input's `dataQuality.generatedAt`; `edition` is the published edition's
   * `generatedAt` (the web edition's JSON-LD `datePublished`).
   */
  timestampBasis?: "ingestion" | "edition";
  /** Inclusive Unix-second window for the contaminated signal ingestion. */
  startAt: number;
  endAt: number;
  reason: string;
  incidentReference: string;
  /** Normalized copy fragments that identify the retracted claim. */
  claimMarkers: readonly string[];
  /**
   * Flow incidents only: rounded renderings of the retracted amount (decimal
   * digits before the M suffix). Any one of them, in the same clause as the
   * coin and an asserted burn or negative pressure, repeats the claim.
   */
  flowAmounts?: readonly string[];
}

export interface DigestSignalClocks {
  ingestion: number;
  edition: number;
}

const DIGEST_SIGNAL_QUARANTINES: readonly DigestSignalQuarantine[] = [
  {
    stablecoinId: "usds-sky",
    family: "liquidity",
    symbols: ["USDS"],
    startAt: 1_787_299_523,
    endAt: 1_787_299_523,
    reason: "A partial upstream pool inventory made USDS DEX TVL appear to fall from $162.28M to $13.72M.",
    incidentReference: "digest-edition-179:2026-08-21",
    claimMarkers: ["13.72m"],
  },
  {
    // Edition #242 (2026-10-24) published an inventory burn as -$36.85M / -100 USG
    // pressure. Live JSON-LD for https://pharos.watch/digest/2026-10-24/ carried
    // `"datePublished":"2026-10-24T08:05:25.000Z"` (= 1792829125), the edition clock.
    stablecoinId: "usg-tangent",
    family: "flow",
    timestampBasis: "edition",
    symbols: ["USG"],
    startAt: 1_792_829_125,
    endAt: 1_792_829_125,
    reason: "An inventory burn was published as -$36.85M of USG mint/burn pressure.",
    incidentReference: "digest-edition-242:2026-10-24 / #1672",
    claimMarkers: [],
    flowAmounts: ["36.85", "36.8", "36.9"],
  },
];

export function isDigestSignalQuarantined(
  stablecoinId: string,
  family: DigestSignalFamily,
  timestamp: number,
): boolean {
  const normalizedId = stablecoinId.trim().toLowerCase();
  return DIGEST_SIGNAL_QUARANTINES.some((entry) =>
    entry.stablecoinId === normalizedId &&
    entry.family === family &&
    timestamp >= entry.startAt &&
    timestamp <= entry.endAt,
  );
}

/** Registry entries of a family whose basis clock falls inside the incident window. */
export function findDigestSignalQuarantines(
  family: DigestSignalFamily,
  clocks: DigestSignalClocks,
): DigestSignalQuarantine[] {
  return DIGEST_SIGNAL_QUARANTINES.filter((entry) => {
    const timestamp = (entry.timestampBasis ?? "ingestion") === "edition" ? clocks.edition : clocks.ingestion;
    return entry.family === family && timestamp >= entry.startAt && timestamp <= entry.endAt;
  });
}

export function findDigestSignalQuarantineBySymbol(
  symbol: string,
  family: DigestSignalFamily,
  timestamp: number,
): DigestSignalQuarantine | undefined {
  const normalizedSymbol = symbol.trim().toUpperCase();
  return DIGEST_SIGNAL_QUARANTINES.find((entry) =>
    entry.family === family &&
    entry.symbols.includes(normalizedSymbol) &&
    timestamp >= entry.startAt &&
    timestamp <= entry.endAt,
  );
}

const LIQUIDITY_COLLAPSE_PATTERN = /\b(?:collaps(?:e|es|ed|ing)|drain(?:s|ed|ing)?|fell|fall(?:s|ing)?|los(?:e|es|t)|sheds?)\b/i;

/**
 * Symbol word-boundary matchers, built once at module load. The registry is
 * static, so constructing these per call would allocate a RegExp for every
 * symbol of every entry on every validated edition.
 */
const QUARANTINE_SYMBOL_PATTERNS: ReadonlyMap<DigestSignalQuarantine, readonly RegExp[]> = new Map(
  DIGEST_SIGNAL_QUARANTINES.map((entry) => [
    entry,
    // Symbols come from the checked-in registry above, never from user or model
    // input, and are escaped with escapeRegExp before interpolation.
    // eslint-disable-next-line security/detect-non-literal-regexp
    entry.symbols.map((symbol) => new RegExp(`\\b${escapeRegExp(symbol)}\\b`, "i")),
  ]),
);

const FLOW_CLAUSE_SPLIT = /[.!?;\n]+(?=\s|$)|\s+(?:while|whereas|but)\s+/i;
const FLOW_BURN_PATTERN = /\b(?:burn(?:ed|s|ing|t)?|redeem(?:ed|s)?|redemptions?|outflows?|net[- ]negative|negative(?: mint\/burn)? pressure|pressure)\b|[-\u2212\u2013]\s*\$?\d/i;
const FLOW_CORRECTION_PATTERN = /\b(?:inventory[- ]burns?|retract(?:ed|ion)?|corrections?|corrected|erroneous|no (?:net )?(?:burn|redemption|pressure)|not (?:a |an )?(?:real |genuine )?(?:burn|redemption|pressure))\b/i;

const FLOW_AMOUNT_PATTERNS: ReadonlyMap<DigestSignalQuarantine, RegExp> = new Map(
  DIGEST_SIGNAL_QUARANTINES.filter((entry) => entry.flowAmounts?.length).map((entry) => [
    entry,
    // Amounts come from the checked-in registry above and are escaped before interpolation.
    // eslint-disable-next-line security/detect-non-literal-regexp
    new RegExp(`(?<![\\d.])(?:${(entry.flowAmounts ?? []).map(escapeRegExp).join("|")})\\s*(?:m\\b|million\\b)`, "i"),
  ]),
);

/** True when one clause ties the coin, an asserted burn/negative pressure and the retracted amount together. */
function repeatsFlowClaim(copy: string, entry: DigestSignalQuarantine): boolean {
  const amount = FLOW_AMOUNT_PATTERNS.get(entry);
  const symbols = QUARANTINE_SYMBOL_PATTERNS.get(entry) ?? [];
  if (!amount) return false;
  return copy.split(FLOW_CLAUSE_SPLIT).some((clause) =>
    symbols.some((pattern) => pattern.test(clause)) &&
    amount.test(clause) &&
    FLOW_BURN_PATTERN.test(clause) &&
    !FLOW_CORRECTION_PATTERN.test(clause),
  );
}

export function findQuarantinedDigestSignalClaims(
  copy: string,
  family: DigestSignalFamily,
  period: { startAt: number; endAt: number },
): DigestSignalQuarantine[] {
  if (family === "flow") {
    return DIGEST_SIGNAL_QUARANTINES.filter((entry) =>
      entry.family === "flow" &&
      entry.startAt <= period.endAt &&
      entry.endAt >= period.startAt &&
      repeatsFlowClaim(copy, entry),
    );
  }
  const normalizedCopy = copy.toLowerCase().replace(/[,\s]+/g, "");
  if (family === "liquidity" && !LIQUIDITY_COLLAPSE_PATTERN.test(copy)) return [];

  return DIGEST_SIGNAL_QUARANTINES.filter((entry) =>
    entry.family === family &&
    entry.startAt <= period.endAt &&
    entry.endAt >= period.startAt &&
    (QUARANTINE_SYMBOL_PATTERNS.get(entry) ?? []).some((pattern) => pattern.test(copy)) &&
    entry.claimMarkers.every((marker) => normalizedCopy.includes(marker)),
  );
}

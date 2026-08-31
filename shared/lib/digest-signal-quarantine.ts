export type DigestSignalFamily = "liquidity" | "depeg" | "yield" | "flow";

export interface DigestSignalQuarantine {
  stablecoinId: string;
  family: DigestSignalFamily;
  /** Legacy digest inputs identify liquidity rows by symbol only. */
  symbols: readonly string[];
  /** Inclusive Unix-second window for the contaminated signal ingestion. */
  startAt: number;
  endAt: number;
  reason: string;
  incidentReference: string;
  /** Normalized copy fragments that identify the retracted claim. */
  claimMarkers: readonly string[];
}

export const DIGEST_SIGNAL_QUARANTINES: readonly DigestSignalQuarantine[] = [
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

const LIQUIDITY_COLLAPSE_PATTERN = /\b(?:collaps(?:e|ed|ing)|drain(?:ed|ing)?|fell|fall(?:ing)?|lost|shed)\b/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

export function findQuarantinedDigestSignalClaims(
  copy: string,
  family: DigestSignalFamily,
  period: { startAt: number; endAt: number },
): DigestSignalQuarantine[] {
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

export interface SymbolPatternOptions {
  prefixPattern?: string;
  suffixPattern?: string;
  flags?: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildDelimitedSymbolPattern(
  symbol: string,
  options: SymbolPatternOptions = {},
): RegExp {
  const escaped = escapeRegExp(symbol);
  const prefixPattern = options.prefixPattern ?? "";
  const suffixPattern = options.suffixPattern ?? "";
  const flags = options.flags ?? "i";
  // eslint-disable-next-line security/detect-non-literal-regexp -- symbol is escaped and affixes come from curated callers.
  return new RegExp(
    `(?:^|[^a-z0-9])${prefixPattern}${escaped}${suffixPattern}(?=$|[^a-z0-9])`,
    flags,
  );
}

export function buildReserveSymbolMatcher(
  symbol: string,
  options: SymbolPatternOptions = {},
): (text: string) => boolean {
  const pattern = buildDelimitedSymbolPattern(symbol, options);
  return (text) => pattern.test(text);
}

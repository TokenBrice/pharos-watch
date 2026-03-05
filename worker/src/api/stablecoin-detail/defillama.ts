interface PegMeta {
  flags: {
    pegCurrency: string;
  };
}

function isNonUsdPeg(meta: PegMeta | undefined): boolean {
  return (
    !!meta &&
    meta.flags.pegCurrency !== "USD" &&
    meta.flags.pegCurrency !== "GOLD" &&
    meta.flags.pegCurrency !== "SILVER"
  );
}

/**
 * Validates upstream JSON and normalizes non-USD circulating values into USD.
 * Throws on invalid JSON to preserve existing upstream-parse error behavior.
 */
export function normalizeDefiLlamaDetailBody(
  body: string,
  meta: PegMeta | undefined,
): string {
  const parsed = JSON.parse(body) as {
    price?: unknown;
    tokens?: Array<{
      totalCirculatingUSD?: Record<string, number>;
      circulating?: Record<string, number>;
    }>;
  };

  if (
    isNonUsdPeg(meta) &&
    typeof parsed.price === "number" &&
    parsed.price > 0 &&
    Array.isArray(parsed.tokens)
  ) {
    const price = parsed.price;
    for (const entry of parsed.tokens) {
      if (entry.totalCirculatingUSD) {
        for (const key of Object.keys(entry.totalCirculatingUSD)) {
          if (key !== "peggedUSD") {
            entry.totalCirculatingUSD[key] *= price;
          }
        }
      }
      if (entry.circulating) {
        for (const key of Object.keys(entry.circulating)) {
          if (key !== "peggedUSD") {
            entry.circulating[key] *= price;
          }
        }
      }
    }
    return JSON.stringify(parsed);
  }

  return body;
}

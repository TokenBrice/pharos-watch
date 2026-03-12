interface PegMeta {
  flags: {
    pegCurrency: string;
  };
}

type PegBuckets = Record<string, number>;

function isNonUsdPeg(meta: PegMeta | undefined): boolean {
  return (
    !!meta &&
    meta.flags.pegCurrency !== "USD" &&
    meta.flags.pegCurrency !== "GOLD" &&
    meta.flags.pegCurrency !== "SILVER"
  );
}

function toPegBuckets(value: unknown): PegBuckets | undefined {
  if (!value || typeof value !== "object") return undefined;
  const buckets: PegBuckets = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      buckets[key] = raw;
    }
  }
  return Object.keys(buckets).length > 0 ? buckets : undefined;
}

function scalePegBuckets(buckets: PegBuckets, multiplier: number): PegBuckets {
  const scaled: PegBuckets = {};
  for (const [key, value] of Object.entries(buckets)) {
    scaled[key] = value * multiplier;
  }
  return scaled;
}

/**
 * Validates upstream JSON and materializes consistent chart fields:
 * - totalCirculating: native units
 * - totalCirculatingUSD: USD market cap
 *
 * Raw upstream fields such as `circulating` are preserved for compatibility.
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
      totalCirculating?: Record<string, number>;
      circulating?: Record<string, number>;
      [key: string]: unknown;
    }>;
  };

  if (!Array.isArray(parsed.tokens)) {
    return body;
  }

  const isNonUsd = isNonUsdPeg(meta);
  const price =
    typeof parsed.price === "number" && Number.isFinite(parsed.price) && parsed.price > 0
      ? parsed.price
      : null;

  for (const entry of parsed.tokens) {
    const rawTotalCirculating = toPegBuckets(entry.totalCirculating);
    const rawCirculating = toPegBuckets(entry.circulating);
    const rawTotalCirculatingUsd = toPegBuckets(entry.totalCirculatingUSD);

    if (isNonUsd && price != null) {
      const nativeBuckets = rawTotalCirculating ?? rawCirculating;
      if (nativeBuckets) {
        entry.totalCirculating = nativeBuckets;
        entry.totalCirculatingUSD = scalePegBuckets(nativeBuckets, price);
        continue;
      }

      if (rawTotalCirculatingUsd) {
        entry.totalCirculatingUSD = rawTotalCirculatingUsd;
        entry.totalCirculating = scalePegBuckets(rawTotalCirculatingUsd, 1 / price);
      }
      continue;
    }

    const nativeOrUsdBuckets = rawTotalCirculating ?? rawCirculating ?? rawTotalCirculatingUsd;
    if (nativeOrUsdBuckets) {
      entry.totalCirculating = rawTotalCirculating ?? rawCirculating ?? nativeOrUsdBuckets;
      entry.totalCirculatingUSD = rawTotalCirculatingUsd ?? nativeOrUsdBuckets;
    }
  }

  return JSON.stringify(parsed);
}

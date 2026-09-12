import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { YIELD_BENCHMARK_SCORE_TTL_SEC } from "@shared/lib/status-thresholds";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import type {
  YieldBenchmarkKey,
  YieldBenchmarkMeta,
  YieldBenchmarkRegistry,
  YieldBenchmarkSelectionMode,
} from "@shared/types/yield";
import { RISK_FREE_RATE_FALLBACK } from "../../lib/constants";

// Canonical definition lives in shared/lib/status-thresholds.ts, where the
// legacy `yieldHealth.benchmark` threshold consumes the same number.
export { YIELD_BENCHMARK_SCORE_TTL_SEC };
export type YieldBenchmarkFreshness = "healthy" | "degraded" | "stale";

/**
 * Per-key bound on the age of a benchmark's own observation (`recordDate`).
 * A fetch that just succeeded says nothing about the data it carried: a frozen
 * or rewound upstream keeps returning an old CSV, and the fetch-age TTL alone
 * would stamp it as current market data forever. Daily/overnight series get five
 * days (a long weekend plus one failed run); CAD is the Bank of Canada's monthly
 * announced Bank rate and CHF's public SAR3MC download is delayed by one
 * business day, so those carry their own publication cadence.
 */
export const YIELD_BENCHMARK_RECORD_MAX_AGE_SEC: Record<YieldBenchmarkKey, number> = {
  USD: 5 * DAY_SECONDS,
  USD_EFFR: 5 * DAY_SECONDS,
  EUR: 5 * DAY_SECONDS,
  CHF: 5 * DAY_SECONDS,
  GBP: 5 * DAY_SECONDS,
  JPY: 5 * DAY_SECONDS,
  MXN: 5 * DAY_SECONDS,
  BRL: 5 * DAY_SECONDS,
  AUD: 5 * DAY_SECONDS,
  CAD: 45 * DAY_SECONDS,
  RUB: 5 * DAY_SECONDS,
  TRY: 5 * DAY_SECONDS,
  SGD: 5 * DAY_SECONDS,
};

/**
 * Classify a registry entry from its own evidence: the hard 48h fetch-age TTL,
 * plus — when the caller supplies the key's observation bound — the age of the
 * observation the fetch carried. Both are `max`-combined; a future-dated
 * observation clamps to zero age here because the fetch-time guard
 * (`tbill-sources/fred.ts`) already rejects those rows before they are stored.
 */
export function classifyYieldBenchmarkFreshness(meta: {
  ageSeconds: number | null;
  isFallback: boolean;
  fallbackMode: string | null;
}, options?: {
  selectionMode?: YieldBenchmarkSelectionMode | null;
  /** The benchmark's own observation date, as published on the registry entry. */
  recordDate?: string | null;
  /** Per-key bound, normally `YIELD_BENCHMARK_RECORD_MAX_AGE_SEC[key]`. */
  maxRecordAgeSec?: number | null;
}): YieldBenchmarkFreshness {
  if (
    meta.ageSeconds == null ||
    !Number.isFinite(meta.ageSeconds) ||
    meta.ageSeconds < 0 ||
    meta.ageSeconds > YIELD_BENCHMARK_SCORE_TTL_SEC
  ) {
    return "stale";
  }
  const maxRecordAgeSec = options?.maxRecordAgeSec;
  const recordDate = options?.recordDate;
  if (maxRecordAgeSec != null && Number.isFinite(maxRecordAgeSec) && recordDate) {
    const recordTimestampMs = Date.parse(`${recordDate}T00:00:00Z`);
    if (Number.isFinite(recordTimestampMs)) {
      const recordAgeSec = Math.max(
        0,
        Math.floor(Date.now() / 1000) - Math.floor(recordTimestampMs / 1000),
      );
      if (recordAgeSec > maxRecordAgeSec) {
        return "stale";
      }
    }
  }
  if (
    meta.isFallback ||
    meta.fallbackMode != null ||
    options?.selectionMode === "fallback-usd"
  ) {
    return "degraded";
  }
  return "healthy";
}

export interface ParsedYieldBenchmarkMeta extends YieldBenchmarkMeta {
  lastMarketRate: number | null;
  lastMarketRecordDate: string | null;
  lastMarketFetchedAt: number | null;
  lastMarketSource: string | null;
}

export interface ParsedYieldBenchmarkRegistry {
  USD: ParsedYieldBenchmarkMeta;
  USD_EFFR?: ParsedYieldBenchmarkMeta | null;
  EUR: ParsedYieldBenchmarkMeta | null;
  CHF: ParsedYieldBenchmarkMeta | null;
  GBP: ParsedYieldBenchmarkMeta | null;
  JPY: ParsedYieldBenchmarkMeta | null;
  MXN: ParsedYieldBenchmarkMeta | null;
  BRL: ParsedYieldBenchmarkMeta | null;
  AUD: ParsedYieldBenchmarkMeta | null;
  CAD: ParsedYieldBenchmarkMeta | null;
  RUB: ParsedYieldBenchmarkMeta | null;
  TRY: ParsedYieldBenchmarkMeta | null;
  SGD: ParsedYieldBenchmarkMeta | null;
}

const BENCHMARK_META_BY_KEY: Record<YieldBenchmarkKey, { label: string; currency: string; isProxy: boolean }> = {
  USD: {
    label: "USD 3M T-Bill",
    currency: "USD",
    isProxy: false,
  },
  USD_EFFR: {
    label: "USD effective federal funds rate",
    currency: "USD",
    isProxy: false,
  },
  EUR: {
    label: "EUR 3M compounded €STR",
    currency: "EUR",
    isProxy: false,
  },
  CHF: {
    label: "CHF 3M compounded SARON",
    currency: "CHF",
    isProxy: false,
  },
  GBP: {
    // Bank of England IADB IUDZOS2 SONIA Compounded Index, annualized over a trailing 3M window.
    label: "GBP 3M compounded SONIA",
    currency: "GBP",
    isProxy: false,
  },
  JPY: {
    // Bank of Japan STRDCLUCON uncollateralized overnight call rate (TONA-equivalent proxy).
    label: "JPY overnight call (TONA proxy)",
    currency: "JPY",
    isProxy: true,
  },
  MXN: {
    // Banxico SF43936 — CETES 28-day primary auction yield.
    label: "MXN CETES 28d",
    currency: "MXN",
    isProxy: false,
  },
  BRL: {
    // BCB SGS series 11 — SELIC over daily rate, annualized over 252 business days.
    label: "BRL SELIC over",
    currency: "BRL",
    isProxy: false,
  },
  AUD: {
    // Reserve Bank of Australia F1 cash-rate target.
    label: "AUD cash-rate target",
    currency: "AUD",
    isProxy: false,
  },
  CAD: {
    // BoC Valet V122530 is the Bank of Canada's administered Bank rate, announced
    // monthly on a policy-decision date — not a daily overnight repo (CORRA)
    // series. Its monthly print is why CAD carries a 45-day observation bound in
    // YIELD_BENCHMARK_RECORD_MAX_AGE_SEC.
    label: "CAD Bank rate (policy, monthly)",
    currency: "CAD",
    isProxy: true,
  },
  RUB: {
    // CBR DailyInfo KeyRateXML — Central Bank of Russia key rate.
    label: "RUB CBR key rate",
    currency: "RUB",
    isProxy: false,
  },
  TRY: {
    // CBRT EVDS TP.BISTTLREF.ORAN — BIST Turkish Lira Overnight Reference Rate.
    label: "TRY BIST TLREF overnight",
    currency: "TRY",
    isProxy: false,
  },
  SGD: {
    // TODO: wire MAS SORA feed when a stable public endpoint is identified.
    label: "SGD SORA (unavailable)",
    currency: "SGD",
    isProxy: false,
  },
};

export function getYieldBenchmarkStaticMeta(key: YieldBenchmarkKey) {
  return BENCHMARK_META_BY_KEY[key];
}

export function withYieldBenchmarkStaticMeta(
  key: YieldBenchmarkKey,
  meta: Omit<YieldBenchmarkMeta, "key" | "label" | "currency" | "isProxy">,
): YieldBenchmarkMeta {
  return {
    key,
    ...BENCHMARK_META_BY_KEY[key],
    ...meta,
  };
}

export function buildHardcodedUsdBenchmark(fallbackMode: string): ParsedYieldBenchmarkMeta {
  return {
    ...withYieldBenchmarkStaticMeta("USD", {
      rate: RISK_FREE_RATE_FALLBACK,
      recordDate: null,
      fetchedAt: null,
      ageSeconds: null,
      source: "hardcoded-fallback",
      isFallback: true,
      fallbackMode,
    }),
    lastMarketRate: null,
    lastMarketRecordDate: null,
    lastMarketFetchedAt: null,
    lastMarketSource: null,
  };
}

// Pegs supported by a native benchmark fetcher. SGD is intentionally excluded — its fetcher is
// a TODO and SGD-pegged rows fall back to USD until a stable SORA feed is wired.
const NATIVE_BENCHMARK_PEG_CURRENCIES = new Set<YieldBenchmarkKey>([
  "USD",
  "EUR",
  "CHF",
  "GBP",
  "JPY",
  "MXN",
  "BRL",
  "AUD",
  "CAD",
  "RUB",
  "TRY",
]);

export function getBenchmarkKeyForPegCurrency(
  pegCurrency: string | null | undefined,
): YieldBenchmarkKey | null {
  if (pegCurrency && NATIVE_BENCHMARK_PEG_CURRENCIES.has(pegCurrency as YieldBenchmarkKey)) {
    return pegCurrency as YieldBenchmarkKey;
  }
  return null;
}

export function resolveBenchmarkForStablecoin(params: {
  stablecoinId: string;
  benchmarks: ParsedYieldBenchmarkRegistry;
  benchmarkCurrency?: YieldBenchmarkKey | null;
}): {
  key: YieldBenchmarkKey;
  meta: ParsedYieldBenchmarkMeta;
  selectionMode: YieldBenchmarkSelectionMode;
} {
  const { stablecoinId, benchmarks, benchmarkCurrency } = params;
  const pegCurrency = TRACKED_META_BY_ID.get(stablecoinId)?.flags.pegCurrency ?? null;
  const pegBenchmarkKey = getBenchmarkKeyForPegCurrency(pegCurrency);

  if (benchmarkCurrency) {
    const explicitMeta = benchmarks[benchmarkCurrency];
    if (explicitMeta) {
      return {
        key: benchmarkCurrency,
        meta: explicitMeta,
        selectionMode: "manual-override",
      };
    }
    return {
      key: "USD",
      meta: benchmarks.USD,
      selectionMode: "fallback-usd",
    };
  }

  if (pegBenchmarkKey) {
    const nativeMeta = benchmarks[pegBenchmarkKey];
    if (nativeMeta) {
      return {
        key: pegBenchmarkKey,
        meta: nativeMeta,
        selectionMode: "native",
      };
    }
  }

  return {
    key: "USD",
    meta: benchmarks.USD,
    selectionMode: "fallback-usd",
  };
}

export function toYieldBenchmarkRegistry(
  parsed: ParsedYieldBenchmarkRegistry,
): YieldBenchmarkRegistry {
  return {
    USD: parsed.USD,
    USD_EFFR: parsed.USD_EFFR ?? null,
    EUR: parsed.EUR,
    CHF: parsed.CHF,
    GBP: parsed.GBP,
    JPY: parsed.JPY,
    MXN: parsed.MXN,
    BRL: parsed.BRL,
    AUD: parsed.AUD,
    CAD: parsed.CAD,
    RUB: parsed.RUB,
    TRY: parsed.TRY,
    SGD: parsed.SGD,
  };
}

import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type {
  YieldBenchmarkKey,
  YieldBenchmarkMeta,
  YieldBenchmarkRegistry,
  YieldBenchmarkSelectionMode,
} from "@shared/types/yield";
import { RISK_FREE_RATE_FALLBACK } from "../../lib/constants";

export const YIELD_BENCHMARK_SCORE_TTL_SEC = 48 * 60 * 60;
export type YieldBenchmarkFreshness = "healthy" | "degraded" | "stale";

export function classifyYieldBenchmarkFreshness(meta: {
  ageSeconds: number | null;
  isFallback: boolean;
  fallbackMode: string | null;
}, options?: {
  selectionMode?: YieldBenchmarkSelectionMode | null;
}): YieldBenchmarkFreshness {
  if (
    meta.ageSeconds == null ||
    !Number.isFinite(meta.ageSeconds) ||
    meta.ageSeconds < 0 ||
    meta.ageSeconds > YIELD_BENCHMARK_SCORE_TTL_SEC
  ) {
    return "stale";
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
    // BoC Valet V122530 — overnight repo (CORRA-equivalent).
    label: "CAD overnight repo (CORRA proxy)",
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

import { YIELD_BENCHMARK_DEFINITIONS, YIELD_BENCHMARK_KEY_VALUES } from "@shared/types/yield-vocabulary";
import {
  TRACKED_META_BY_ID,
} from "@shared/lib/stablecoins/registry";
import {
  YIELD_BENCHMARK_SCORE_TTL_SEC,
} from "@shared/lib/status-thresholds";
import type {
  YieldBenchmarkKey,
  YieldBenchmarkMeta,
  YieldBenchmarkRegistry,
  YieldBenchmarkSelectionMode,
} from "@shared/types/yield";
import {
  RISK_FREE_RATE_FALLBACK,
} from "../../lib/yield-config/policy";

// Canonical definition lives in shared/lib/status-thresholds.ts.
export { YIELD_BENCHMARK_SCORE_TTL_SEC };

export interface ParsedYieldBenchmarkMeta extends YieldBenchmarkMeta {
  lastMarketRate: number | null;
  lastMarketRecordDate: string | null;
  lastMarketFetchedAt: number | null;
  lastMarketSource: string | null;
  /** Out-of-band level retained by the previous run; the next identical level confirms a shift. */
  lastRejectedMarketRate?: number | null;
  lastRejectedMarketRecordDate?: string | null;
  lastRejectedMarketFetchedAt?: number | null;
}

export type ParsedYieldBenchmarkRegistry = {
  USD: ParsedYieldBenchmarkMeta;
  USD_EFFR?: ParsedYieldBenchmarkMeta | null;
} & Record<Exclude<YieldBenchmarkKey, "USD" | "USD_EFFR">, ParsedYieldBenchmarkMeta | null>;

const BENCHMARK_META_BY_KEY = Object.fromEntries(
  YIELD_BENCHMARK_KEY_VALUES.map((key) => {
    const { label, currency, isProxy } = YIELD_BENCHMARK_DEFINITIONS[key];
    return [key, { label, currency, isProxy }];
  }),
) as Record<YieldBenchmarkKey, { label: string; currency: string; isProxy: boolean }>;

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
    ...(key === "AUD" && meta.source === "rba-interbank-overnight" ? {
      label: "AUD interbank overnight (cash-rate proxy)",
      isProxy: true,
      isFallback: true,
      fallbackMode: meta.fallbackMode ?? "aud-interbank-overnight-proxy",
    } : {}),
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
    lastRejectedMarketRate: null,
    lastRejectedMarketRecordDate: null,
    lastRejectedMarketFetchedAt: null,
  };
}

// Pegs supported by a native benchmark fetcher. SGD is intentionally excluded — its fetcher is
// a TODO and SGD-pegged rows fall back to USD until a stable SORA feed is wired.
const NATIVE_BENCHMARK_PEG_CURRENCIES = new Set<YieldBenchmarkKey>(
  YIELD_BENCHMARK_KEY_VALUES.filter((key) => YIELD_BENCHMARK_DEFINITIONS[key].nativePeg),
);

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
    ...Object.fromEntries(YIELD_BENCHMARK_KEY_VALUES
      .filter((key) => key !== "USD")
      .map((key) => [key, key === "USD_EFFR" ? parsed[key] ?? null : parsed[key]])),
  };
}

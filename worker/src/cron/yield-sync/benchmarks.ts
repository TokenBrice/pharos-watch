import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type {
  YieldBenchmarkKey,
  YieldBenchmarkMeta,
  YieldBenchmarkRegistry,
  YieldBenchmarkSelectionMode,
} from "@shared/types/yield";
import { RISK_FREE_RATE_FALLBACK } from "../../lib/constants";

export interface ParsedYieldBenchmarkMeta extends YieldBenchmarkMeta {
  lastMarketRate: number | null;
  lastMarketRecordDate: string | null;
  lastMarketFetchedAt: number | null;
  lastMarketSource: string | null;
}

export interface ParsedYieldBenchmarkRegistry {
  USD: ParsedYieldBenchmarkMeta;
  EUR: ParsedYieldBenchmarkMeta | null;
  CHF: ParsedYieldBenchmarkMeta | null;
}

const BENCHMARK_META_BY_KEY: Record<YieldBenchmarkKey, { label: string; currency: string; isProxy: boolean }> = {
  USD: {
    label: "USD 3M T-Bill",
    currency: "USD",
    isProxy: false,
  },
  EUR: {
    label: "EUR €STR",
    currency: "EUR",
    isProxy: false,
  },
  CHF: {
    label: "CHF SNB policy rate (proxy)",
    currency: "CHF",
    isProxy: true,
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

function getBenchmarkKeyForPegCurrency(pegCurrency: string | null | undefined): YieldBenchmarkKey | null {
  if (pegCurrency === "USD" || pegCurrency === "EUR" || pegCurrency === "CHF") {
    return pegCurrency;
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
    EUR: parsed.EUR,
    CHF: parsed.CHF,
  };
}

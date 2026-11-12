import { YIELD_BENCHMARK_RECORD_MAX_AGE_SEC, benchmarkRecordAgeSeconds, classifyYieldBenchmarkFreshness } from "@shared/lib/yield-benchmark-freshness";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { YieldBenchmarkKey } from "@shared/types/yield";
import { YIELD_BENCHMARK_DEFINITIONS, YIELD_BENCHMARK_KEY_VALUES } from "@shared/types/yield-vocabulary";
import { throwIfAborted } from "../../lib/abort";
import { FRED_EFFR_CSV_URL, FRED_TBILL_CSV_URL } from "./shared";
import type {
  BenchmarkFetchResult,
  BenchmarkProviderAttemptDiagnostic,
  BenchmarkResponseDiagnostic,
  BenchmarkProviderFetchOutcome,
  BenchmarkProviderKey,
} from "./shared";
import { tryAlfredSoniaCompoundedIndex, tryFredCsv, tryFredSoniaCompoundedIndex } from "./fred";
import { tryNyFedEffr } from "./nyfed";
import { tryTreasuryXml } from "./treasury";
import { tryEcbCompoundedEstrCsv } from "./ecb";
import { tryBoeSoniaCompoundedIndex } from "./boe";
import { tryBojCallRate } from "./boj";
import { tryRbaCashRateTarget } from "./rba";
import { trySixSar3mcCsv } from "./six";
import { tryBanxicoCetes } from "./banxico";
import { tryBcbSelic, tryBcbSelicAnnualized } from "./bcb";
import { tryBocCorra } from "./boc";
import { tryCbrtTlref } from "./cbrt";
import { tryCbrKeyRate } from "./cbr";


const USD_EFFR_FRED_MAX_OBSERVATION_AGE_DAYS = YIELD_BENCHMARK_RECORD_MAX_AGE_SEC.USD_EFFR / DAY_SECONDS;

async function tryUsdEffrBenchmark(
  signal?: AbortSignal,
  onDiagnostic?: (diagnostic: BenchmarkResponseDiagnostic & { provider?: string }) => void,
): Promise<BenchmarkFetchResult | null> {
  const nyFed = await tryNyFedEffr(signal, diagnostic => onDiagnostic?.({ ...diagnostic, provider: "nyfed-effr" }));
  if (nyFed) {
    const recordAgeSec = benchmarkRecordAgeSeconds(nyFed.recordDate, Math.floor(Date.now() / 1000));
    if (recordAgeSec != null && recordAgeSec >= 0 && recordAgeSec <= YIELD_BENCHMARK_RECORD_MAX_AGE_SEC.USD_EFFR) {
      return nyFed;
    }
  }

  const fred = await tryFredCsv(FRED_EFFR_CSV_URL, signal, USD_EFFR_FRED_MAX_OBSERVATION_AGE_DAYS,
    diagnostic => onDiagnostic?.({ ...diagnostic, provider: "fred-dff" }));
  return fred ? { ...fred, source: "fred-dff" } : null;
}

async function tryGbpBenchmark({ signal }: { signal?: AbortSignal }) {
  const responseDiagnostics: BenchmarkProviderAttemptDiagnostic[] = [];
  const observe = (provider: string) => (diagnostic: Omit<BenchmarkProviderAttemptDiagnostic, "provider">) => {
    responseDiagnostics.push({ provider, ...diagnostic });
  };
  const fred = await tryFredSoniaCompoundedIndex(signal, observe("fred-sonia-compounded-index"));
  if (fred) return { ...fred, source: "fred-sonia-compounded-index", responseDiagnostics };
  const alfred = await tryAlfredSoniaCompoundedIndex(signal, observe("alfred-sonia-compounded-index"));
  if (alfred) return { ...alfred, source: "alfred-sonia-compounded-index", responseDiagnostics };
  const boe = await tryBoeSoniaCompoundedIndex(signal, observe("boe-sonia-compounded-index"));
  return boe
    ? { ...boe, source: "boe-sonia-compounded-index", responseDiagnostics }
    : { result: null, responseDiagnostics };
}

async function tryBrlBenchmark({ signal }: { signal?: AbortSignal }) {
  const responseDiagnostics: BenchmarkProviderAttemptDiagnostic[] = [];
  // Same authority and instrument, different authored units. Never parallelize
  // these or let a reachable but stale SGS11 observation suppress SGS1178.
  for (const [source, fetchCandidate] of [
    ["bcb-selic", tryBcbSelic],
    ["bcb-selic-1178", tryBcbSelicAnnualized],
  ] as const) {
    throwIfAborted(signal);
    const parsed = await fetchCandidate(signal, diagnostic => {
      responseDiagnostics.push({ provider: source, ...diagnostic });
    });
    throwIfAborted(signal);
    if (!parsed) continue;
    const nowSec = Math.floor(Date.now() / 1000);
    if (classifyYieldBenchmarkFreshness(
      { ageSeconds: 0, isFallback: false, fallbackMode: null },
      { recordDate: parsed.recordDate, maxRecordAgeSec: YIELD_BENCHMARK_RECORD_MAX_AGE_SEC.BRL, nowSec },
    ) === "healthy") {
      return { ...parsed, source, responseDiagnostics };
    }
    const diagnostic = responseDiagnostics[responseDiagnostics.length - 1];
    diagnostic.failure = (benchmarkRecordAgeSeconds(parsed.recordDate, nowSec) ?? -1) < 0
      ? "future-record" : "stale-record";
  }
  return { result: null, responseDiagnostics };
}

export interface BenchmarkResolutionPolicy {
  credentials: {
    binding: "none" | "BANXICO_TOKEN";
    missingFallbackMode: string | null;
    missingOutcome: "record-failure" | "skip";
  };
  orderedProviders: readonly {
    fetch: (params: {
      signal?: AbortSignal;
      credential: string | null;
      onDiagnostic: (diagnostic: BenchmarkResponseDiagnostic & { provider?: string }) => void;
    }) => Promise<BenchmarkProviderFetchOutcome | null>;
    source: string;
    sourceSelection: "observation" | "fixed";
    rejectionDiagnostic: "record" | "silent";
  }[];
  failureMode: string;
  terminalFallback: "unavailable" | "hardcoded-usd";
  outcomeTiming: "before-meta" | "after-meta";
}

const NO_CREDENTIALS: BenchmarkResolutionPolicy["credentials"] = {
  binding: "none", missingFallbackMode: null, missingOutcome: "record-failure",
};
const BANXICO_CREDENTIALS: BenchmarkResolutionPolicy["credentials"] = {
  binding: "BANXICO_TOKEN", missingFallbackMode: "banxico-token-missing", missingOutcome: "skip",
};

function standardBenchmarkPolicy(
  fetch: BenchmarkResolutionPolicy["orderedProviders"][number]["fetch"],
  source: string,
  failureMode: string,
): BenchmarkResolutionPolicy {
  return {
    credentials: NO_CREDENTIALS,
    orderedProviders: [{ fetch, source, sourceSelection: "observation", rejectionDiagnostic: "record" }],
    failureMode,
    terminalFallback: "unavailable",
    outcomeTiming: "before-meta",
  };
}

// These differences are publication policy, including the silent Treasury rejection
// and the absence of a failed outcome when Banxico credentials are missing.
export const BENCHMARK_RESOLUTION_POLICIES: Record<Exclude<YieldBenchmarkKey, "SGD">, BenchmarkResolutionPolicy> = {
  USD: {
    credentials: NO_CREDENTIALS,
    orderedProviders: [
      {
        fetch: ({ signal, onDiagnostic }) => tryFredCsv(FRED_TBILL_CSV_URL, signal, YIELD_BENCHMARK_RECORD_MAX_AGE_SEC.USD / DAY_SECONDS, onDiagnostic),
        source: "fred-dgs3mo", sourceSelection: "fixed", rejectionDiagnostic: "record",
      },
      {
        fetch: ({ signal, onDiagnostic }) => tryTreasuryXml(signal, onDiagnostic),
        source: "treasury-yield-xml", sourceSelection: "fixed", rejectionDiagnostic: "silent",
      },
    ],
    failureMode: "all-sources-failed",
    terminalFallback: "hardcoded-usd",
    outcomeTiming: "after-meta",
  },
  USD_EFFR: standardBenchmarkPolicy(({ signal, onDiagnostic }) => tryUsdEffrBenchmark(signal, onDiagnostic), "nyfed-effr", "usd-effr-sources-failed"),
  EUR: standardBenchmarkPolicy(({ signal, onDiagnostic }) => tryEcbCompoundedEstrCsv(signal, onDiagnostic), "ecb-estr-3m", "ecb-failed"),
  CHF: standardBenchmarkPolicy(({ signal, onDiagnostic }) => trySixSar3mcCsv(signal, onDiagnostic), "six-sar3mc", "six-saron-failed"),
  GBP: standardBenchmarkPolicy(tryGbpBenchmark, "fred-sonia-compounded-index", "gbp-sonia-compounded-index-failed"),
  JPY: standardBenchmarkPolicy(({ signal, onDiagnostic }) => tryBojCallRate(signal, onDiagnostic), "boj-call-rate", "jpy-call-rate-failed"),
  MXN: {
    credentials: BANXICO_CREDENTIALS,
    orderedProviders: [{
      fetch: ({ signal, credential, onDiagnostic }) => tryBanxicoCetes(credential!, signal, onDiagnostic),
      source: "banxico-cetes-28d", sourceSelection: "fixed", rejectionDiagnostic: "record",
    }],
    failureMode: "banxico-cetes-failed",
    terminalFallback: "unavailable",
    outcomeTiming: "before-meta",
  },
  BRL: standardBenchmarkPolicy(tryBrlBenchmark, "bcb-selic", "bcb-selic-failed"),
  AUD: standardBenchmarkPolicy(({ signal, onDiagnostic }) => tryRbaCashRateTarget(signal, onDiagnostic), "rba-cash-rate-target", "aud-cash-rate-failed"),
  CAD: standardBenchmarkPolicy(({ signal, onDiagnostic }) => tryBocCorra(signal, onDiagnostic), "boc-valet-v122530", "boc-corra-failed"),
  RUB: standardBenchmarkPolicy(({ signal, onDiagnostic }) => tryCbrKeyRate(signal, onDiagnostic), "cbr-key-rate", "cbr-key-rate-failed"),
  TRY: standardBenchmarkPolicy(({ signal, onDiagnostic }) => tryCbrtTlref(signal, onDiagnostic), "cbrt-evds-tlref", "cbrt-tlref-failed"),
};

type BenchmarkDescriptor = {
  key: YieldBenchmarkKey;
  metadataPrefix: string | null;
  fetchOrder: number | null;
  degradationOrder: number | null;
  includeInCache: boolean;
  policy: BenchmarkResolutionPolicy | null;
};

// Registry order differs deliberately from fetch/degradation order (notably AUD).
export const BENCHMARK_DESCRIPTORS: readonly BenchmarkDescriptor[] = YIELD_BENCHMARK_KEY_VALUES.map((key) => {
  const { metadataPrefix, fetchOrder, degradationOrder, includeInCache } = YIELD_BENCHMARK_DEFINITIONS[key];
  return { key, metadataPrefix, fetchOrder, degradationOrder, includeInCache, policy: key === "SGD" ? null : BENCHMARK_RESOLUTION_POLICIES[key] };
});

type MetadataBenchmarkDescriptor = BenchmarkDescriptor & {
  metadataPrefix: string;
};
type FetchBenchmarkDescriptor = BenchmarkDescriptor & {
  key: BenchmarkProviderKey;
  fetchOrder: number;
  policy: BenchmarkResolutionPolicy;
};

export const BENCHMARK_METADATA_DESCRIPTORS = BENCHMARK_DESCRIPTORS.filter(
  (descriptor): descriptor is MetadataBenchmarkDescriptor => descriptor.metadataPrefix != null,
);
export const BENCHMARK_FETCH_DESCRIPTORS = BENCHMARK_DESCRIPTORS
  .filter((descriptor): descriptor is FetchBenchmarkDescriptor => (
    descriptor.fetchOrder != null && descriptor.key !== "USD" && descriptor.policy != null
  ))
  .sort((a, b) => a.fetchOrder - b.fetchOrder);
export const BENCHMARK_DEGRADATION_DESCRIPTORS = BENCHMARK_DESCRIPTORS
  .filter((descriptor) => descriptor.degradationOrder != null)
  .sort((a, b) => a.degradationOrder! - b.degradationOrder!);
